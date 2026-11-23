import { Asset, Entity } from 'playcanvas';
import type { CreateViewerOptions } from '../options';
import type { ViewerHandle } from '../types';
import { RealEstateHUD } from './hud';
import { loadRealEstateBootstrap } from './loader';
import type { PropertyPublicShareDto, RealEstateBootstrapResult, SceneItemDto, SceneModelDto } from './types';
import { attachContextLossListeners, checkWebGL2Support } from './webgl';

export type CreateViewerFn = (options: CreateViewerOptions) => Promise<ViewerHandle>;

export interface RealEstateViewerOptions {
    container?: HTMLElement;
    url?: URL;
    apiBaseUrl?: string;
    token?: string;
    previewScanId?: string;
    jwtToken?: string;
}

export interface RealEstateViewerHandle {
    viewer: ViewerHandle | null;
    hud: RealEstateHUD;
    property: PropertyPublicShareDto;
    activeSceneId: string;
    switchRoom: (sceneId: string, targetPose?: { position: number[]; lookAt: number[] }) => Promise<void>;
    destroy: () => void;
}

/**
 * Initializes the RealEstate3D experience with dual public/preview bootstrap,
 * Arabic RTL HUD, canonical .sog loading, indoor touch navigation, and WebGL2 fallback.
 */
export async function initRealEstateViewer(
    createViewerFn: CreateViewerFn,
    options: RealEstateViewerOptions = {}
): Promise<RealEstateViewerHandle> {
    const container = options.container || document.body;
    const currentUrl = options.url || (typeof window !== 'undefined' ? new URL(window.location.href) : new URL('http://localhost'));

    // 1. WebGL2 capability detection
    const isWebGL2Supported = checkWebGL2Support();

    // 2. Fetch bootstrap data (public share or authenticated preview)
    const bootstrap: RealEstateBootstrapResult = await loadRealEstateBootstrap(currentUrl);
    const { property } = bootstrap;
    let activeSceneId = bootstrap.activeSceneId || property.sceneConfig?.defaultSceneId || property.scenes[0]?.sceneId;

    let activeSceneModel = property.scenes.find((s) => s.sceneId === activeSceneId) || property.scenes[0];
    if (!activeSceneModel) {
        throw new Error('No 3D scenes found for this property.');
    }

    let viewerHandle: ViewerHandle | null = null;
    let cleanupContextLoss: (() => void) | null = null;
    let currentGsplatEntity: Entity | null = null;
    let currentGsplatAsset: Asset | null = null;

    // Callbacks for HUD
    const callbacks = {
        onSelectRoom: async (roomId: string) => {
            await switchRoom(roomId);
        },
        onToggleMode: (targetMode: 'walk' | 'orbit') => {
            if (!viewerHandle) return;
            if (targetMode === 'walk') {
                viewerHandle.state.cameraMode = 'walk';
            } else {
                viewerHandle.state.cameraMode = 'orbit';
            }
            hud.setMode(targetMode);
        },
        onHotspotClicked: async (targetSceneId: string, targetPose?: { position: number[]; lookAt: number[] }) => {
            await switchRoom(targetSceneId, targetPose);
        }
    };

    // 3. Initialize HUD
    const hud = new RealEstateHUD(container, property, activeSceneId, callbacks);

    // If WebGL2 is not supported, show fallback card immediately
    if (!isWebGL2Supported) {
        hud.showFallbackCard('متصفحك لا يدعم WebGL2 لتشغيل النماذج ثلاثية الأبعاد مباشرة.');
        return {
            viewer: null,
            hud,
            property,
            activeSceneId,
            switchRoom: async () => {},
            destroy: () => hud.destroy()
        };
    }

    // 4. Create SuperSplat Viewer instance loading active room .sog
    try {
        viewerHandle = await createViewerFn({
            container,
            settings: {},
            contentUrl: activeSceneModel.signedModelUrl,
            contentFilename: 'scene.sog',
            renderer: 'webgl',
            ui: true, // provide joystick & touch navigation layer
            exposeGlobals: true
        });

        // Enable gaming controls / touch joystick
        viewerHandle.state.gamingControls = true;

        const app = viewerHandle.app;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        // Context loss handling
        cleanupContextLoss = attachContextLossListeners(canvas, () => {
            hud.showFallbackCard('تم فقدان سياق الرسوميات WebGL.');
        });

        // Track active camera entity for HUD 3D hotspot projection
        const cameraEntity = app.root.findByName('camera');
        if (cameraEntity) {
            hud.setCameraEntity(cameraEntity);
        }

        // Apply initial spawn pose and eye height
        applySceneSpawnPose(viewerHandle, property, activeSceneId);

        // Update 3D hotspot projection on each render frame
        app.on('update', () => {
            if (cameraEntity) {
                hud.updateHotspotScreenPositions(cameraEntity);
            }
        });

    } catch (err: any) {
        console.error('[RealEstate3D] Error creating viewer:', err);
        hud.showFallbackCard('تعذر تشغيل المشهد ثلاثي الأبعاد: ' + (err?.message || 'خطأ غير معروف'));
    }

    // Function to cleanly switch rooms in RoomByRoom or multi-scene walkthrough
    async function switchRoom(roomId: string, targetPose?: { position: number[]; lookAt: number[] }) {
        if (roomId === activeSceneId || !viewerHandle) return;

        const nextModel = property.scenes.find((s) => s.sceneId === roomId);
        if (!nextModel) return;

        activeSceneId = roomId;
        hud.setActiveScene(roomId);

        const app = viewerHandle.app;

        // Prevent mobile OOM: destroy previous room's WebGL2 buffers before loading next room
        try {
            const existingGsplat = app.root.findByName('gsplat');
            if (existingGsplat) {
                const gsplatComp = (existingGsplat as any).gsplat;
                if (gsplatComp?.asset) {
                    app.assets.remove(gsplatComp.asset);
                    gsplatComp.asset.unload();
                }
                existingGsplat.destroy();
            }

            // Load new room .sog
            const filename = 'scene.sog';
            const newAsset = new Asset(filename, 'gsplat', {
                url: nextModel.signedModelUrl,
                filename
            });

            await new Promise<void>((resolve, reject) => {
                newAsset.on('load', () => {
                    const entity = new Entity('gsplat', app);
                    entity.setLocalEulerAngles(0, 0, 180);
                    entity.addComponent('gsplat', {
                        unified: true,
                        asset: newAsset
                    });
                    app.root.addChild(entity);
                    currentGsplatEntity = entity;
                    currentGsplatAsset = newAsset;
                    resolve();
                });
                newAsset.on('error', (e) => reject(e));
                app.assets.add(newAsset);
                app.assets.load(newAsset);
            });

            // Set camera pose
            if (targetPose?.position) {
                const camera = app.root.findByName('camera');
                if (camera) {
                    camera.setPosition(targetPose.position[0], targetPose.position[1], targetPose.position[2]);
                    if (targetPose.lookAt) {
                        camera.lookAt(targetPose.lookAt[0], targetPose.lookAt[1], targetPose.lookAt[2]);
                    }
                }
            } else {
                applySceneSpawnPose(viewerHandle, property, roomId);
            }

            app.renderNextFrame = true;
        } catch (err: any) {
            console.error('[RealEstate3D] Failed to switch room:', err);
        }
    }

    function applySceneSpawnPose(handle: ViewerHandle, prop: PropertyPublicShareDto, sceneId: string) {
        const sceneItem = prop.sceneConfig?.scenes?.find((s) => s.sceneId === sceneId);
        const eyeHeight = prop.sceneConfig?.eyeHeightMeters || 1.6;
        const app = handle.app;
        const camera = app.root.findByName('camera');

        if (sceneItem?.defaultSpawnPose?.position && camera) {
            const pos = sceneItem.defaultSpawnPose.position;
            const lookAt = sceneItem.defaultSpawnPose.lookAt;
            // Ensure eye height ~1.6m
            const y = pos[1] > 0 ? pos[1] : eyeHeight;
            camera.setPosition(pos[0], y, pos[2]);
            if (lookAt) {
                camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
            }
        } else if (camera) {
            camera.setPosition(0, eyeHeight, 0);
        }
    }

    const destroy = () => {
        if (cleanupContextLoss) cleanupContextLoss();
        hud.destroy();
        if (viewerHandle) {
            viewerHandle.destroy();
        }
    };

    return {
        viewer: viewerHandle,
        hud,
        property,
        activeSceneId,
        switchRoom,
        destroy
    };
}
