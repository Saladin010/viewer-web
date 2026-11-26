import { Asset, Entity } from 'playcanvas';
import type { CreateViewerOptions } from '../options';
import { defaultSettings } from '../schemas/defaults';
import type { ViewerHandle } from '../types';
import {
    applyCropBoundsToEntity,
    computeStudioOrbitPose,
    disposeRoomEntities,
    extractFilename,
    GLB_ENTITY_NAME,
    isGlbUrl,
    loadGlbEntity
} from './glb-utils';
import { RealEstateHUD } from './hud';
import { loadRealEstateBootstrap } from './loader';
import type { PropertyPublicShareDto, RealEstateBootstrapResult } from './types';
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
 * clean 3D-first Arabic RTL HUD + Details modal, Studio-matched orbit navigation,
 * 1-finger rotate / 2-finger pinch+pan mobile touch gestures, and WebGL2 fallback.
 */
export async function initRealEstateViewer(
    createViewerFn: CreateViewerFn,
    options: RealEstateViewerOptions = {}
): Promise<RealEstateViewerHandle> {
    const container = options.container || document.body;
    const currentUrl =
        options.url || (typeof window !== 'undefined' ? new URL(window.location.href) : new URL('http://localhost'));

    // 1. WebGL2 capability detection
    const isWebGL2Supported = checkWebGL2Support();

    // 2. Fetch bootstrap data (public share or authenticated preview)
    const bootstrap: RealEstateBootstrapResult = await loadRealEstateBootstrap(currentUrl);
    const { property } = bootstrap;
    let activeSceneId = bootstrap.activeSceneId || property.sceneConfig?.defaultSceneId || property.scenes[0]?.sceneId;

    const activeSceneModel = property.scenes.find((s) => s.sceneId === activeSceneId) || property.scenes[0];
    if (!activeSceneModel) {
        throw new Error('No 3D scenes found for this property.');
    }

    let viewerHandle: ViewerHandle | null = null;
    let cleanupContextLoss: (() => void) | null = null;
    let currentGsplatEntity: Entity | null = null;
    let currentGsplatAsset: Asset | null = null;

    const applyStudioOrbitForScene = (sceneId: string, targetEntity?: Entity | null, immediate = false) => {
        if (!viewerHandle) return;
        viewerHandle.state.gamingControls = false;
        viewerHandle.state.animationPaused = true;
        viewerHandle.state.cameraMode = 'orbit';

        const sceneItem = property.sceneConfig?.scenes?.find((s) => s.sceneId === sceneId);
        const saved = sceneItem?.defaultSpawnPose;
        if (saved?.position?.length >= 3 && saved?.lookAt?.length >= 3) {
            viewerHandle.events.fire('realestate:gotoPose', {
                position: saved.position,
                target: saved.lookAt,
                fov: 50,
                immediate
            });
            return;
        }

        const app = viewerHandle.app;
        const glb = targetEntity ?? (app.root.findByName(GLB_ENTITY_NAME) as Entity | null);
        const computed = computeStudioOrbitPose(glb);
        if (computed) {
            viewerHandle.events.fire('realestate:gotoPose', {
                position: computed.position,
                target: computed.target,
                fov: computed.fov,
                immediate
            });
        } else {
            viewerHandle.frameScene();
        }
    };

    // Callbacks for HUD
    const callbacks = {
        onSelectRoom: async (roomId: string) => {
            await switchRoom(roomId);
        },
        onResetCamera: () => {
            applyStudioOrbitForScene(activeSceneId, null, false);
        },
        onHotspotClicked: async (targetSceneId: string, targetPose?: { position: number[]; lookAt: number[] }) => {
            await switchRoom(targetSceneId, targetPose);
        }
    };

    // 3. Initialize clean 3D-first HUD
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

    // 4. Create PlayCanvas Viewer instance in pure Studio-matched Orbit mode (no built-in SuperSplat UI clutter)
    try {
        const initialFilename = extractFilename(
            activeSceneModel.signedModelUrl,
            isGlbUrl(activeSceneModel.signedModelUrl) ? 'scene.glb' : 'scene.sog'
        );
        const contentFilename = initialFilename.toLowerCase().endsWith('.glb')
            ? initialFilename
            : initialFilename.toLowerCase().endsWith('.sog') || initialFilename.toLowerCase().endsWith('.ply')
                ? initialFilename
                : isGlbUrl(activeSceneModel.signedModelUrl)
                    ? 'scene.glb'
                    : 'scene.sog';

        const initialSceneItem = property.sceneConfig?.scenes?.find((s) => s.sceneId === activeSceneId);
        const initialSpawn = initialSceneItem?.defaultSpawnPose;
        const viewerSettings = defaultSettings('environment');
        if (initialSpawn?.position?.length >= 3 && initialSpawn?.lookAt?.length >= 3) {
            viewerSettings.cameras = [
                {
                    initial: {
                        position: [
                            Number(initialSpawn.position[0]) || 0,
                            Number(initialSpawn.position[1]) || 1.6,
                            Number(initialSpawn.position[2]) || 0
                        ],
                        target: [
                            Number(initialSpawn.lookAt[0]) || 0,
                            Number(initialSpawn.lookAt[1]) || 1.6,
                            Number(initialSpawn.lookAt[2]) || 0
                        ],
                        fov: 50
                    }
                }
            ];
            viewerSettings.startMode = 'default';
        }

        viewerHandle = await createViewerFn({
            container,
            settings: viewerSettings,
            contentUrl: activeSceneModel.signedModelUrl,
            contentFilename,
            renderer: 'webgl',
            ui: false,
            noanim: true,
            exposeGlobals: true
        });

        // Re-mount HUD inside .sse-viewer so canvas fills 100% cleanly behind it
        hud.attachToContainer(container);

        // Lock mobile gestures to pure Orbit (1-finger rotate, 2-finger pinch zoom + 2-finger pan)
        viewerHandle.state.gamingControls = false;
        viewerHandle.state.animationPaused = true;

        const app = viewerHandle.app;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        const applySceneTransforms = (entity: Entity | null, sceneId: string) => {
            if (!entity) return;
            const sceneItem = property.sceneConfig?.scenes?.find((s) => s.sceneId === sceneId);
            if (sceneItem?.floorEulerDeg && sceneItem.floorEulerDeg.length >= 3) {
                entity.setLocalEulerAngles(
                    sceneItem.floorEulerDeg[0],
                    sceneItem.floorEulerDeg[1],
                    sceneItem.floorEulerDeg[2]
                );
            }
            applyCropBoundsToEntity(entity, sceneItem?.cropBounds ?? null);
            app.renderNextFrame = true;
        };

        let initialFramed = false;
        const finalizeInitialRoom = () => {
            const glbEntity = app.root.findByName(GLB_ENTITY_NAME) as Entity | null;
            if (glbEntity) {
                applySceneTransforms(glbEntity, activeSceneId);
            }
            if (!initialFramed && (viewerHandle?.state.loaded || glbEntity)) {
                initialFramed = true;
                applyStudioOrbitForScene(activeSceneId, glbEntity, true);
            }
        };

        viewerHandle.events.once('firstFrame', finalizeInitialRoom);
        viewerHandle.events.on('loaded:changed', (loaded: boolean) => {
            if (loaded) finalizeInitialRoom();
        });

        // Context loss handling
        cleanupContextLoss = attachContextLossListeners(canvas, () => {
            hud.showFallbackCard('تم فقدان سياق الرسوميات WebGL.');
        });

        // Track active camera entity for HUD 3D hotspot projection
        const cameraEntity = app.root.findByName('camera');
        if (cameraEntity) {
            hud.setCameraEntity(cameraEntity);
        }

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

        // Prevent mobile OOM: destroy previous room's WebGL2 buffers & assets before loading next room
        try {
            if (currentGsplatAsset) {
                app.assets.remove(currentGsplatAsset);
                currentGsplatAsset.unload();
                currentGsplatAsset = null;
            }
            if (currentGsplatEntity) {
                currentGsplatEntity.destroy();
                currentGsplatEntity = null;
            }
            disposeRoomEntities(app);

            if (isGlbUrl(nextModel.signedModelUrl)) {
                const glbFilename = extractFilename(nextModel.signedModelUrl, 'scene.glb');
                const { entity, asset } = await loadGlbEntity(app, nextModel.signedModelUrl, glbFilename);
                currentGsplatEntity = entity;
                currentGsplatAsset = asset;
                const sceneItem = property.sceneConfig?.scenes?.find((s) => s.sceneId === roomId);
                if (sceneItem?.floorEulerDeg && sceneItem.floorEulerDeg.length >= 3) {
                    entity.setLocalEulerAngles(
                        sceneItem.floorEulerDeg[0],
                        sceneItem.floorEulerDeg[1],
                        sceneItem.floorEulerDeg[2]
                    );
                }
                applyCropBoundsToEntity(entity, sceneItem?.cropBounds ?? null);
            } else {
                const rawName = extractFilename(nextModel.signedModelUrl, 'scene.sog');
                const filename =
                    rawName.toLowerCase().endsWith('.ply') || rawName.toLowerCase().endsWith('.sog')
                        ? rawName
                        : 'scene.sog';
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
            }

            if (targetPose?.position?.length >= 3 && targetPose?.lookAt?.length >= 3) {
                viewerHandle.events.fire('realestate:gotoPose', {
                    position: targetPose.position,
                    target: targetPose.lookAt,
                    fov: 50,
                    immediate: false
                });
            } else {
                applyStudioOrbitForScene(roomId, currentGsplatEntity, false);
            }

            app.renderNextFrame = true;
        } catch (err: any) {
            console.error('[RealEstate3D] Failed to switch room:', err);
        }
    }

    const destroy = () => {
        if (cleanupContextLoss) {
            cleanupContextLoss();
            cleanupContextLoss = null;
        }
        if (viewerHandle) {
            viewerHandle.destroy();
            viewerHandle = null;
        }
        hud.destroy();
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
