import type { BoundingBox } from 'playcanvas';
import { Asset, Entity } from 'playcanvas';

import type { CreateViewerOptions } from '../options';
import { defaultSettings } from '../schemas/defaults';
import type { ViewerHandle } from '../types';

import {
    applyLocalCropBoundsToEntity,
    applyTransformToEntity,
    computeOrbitPoseForBound,
    computeStudioOrbitPose,
    computeUnifiedBoundingBox,
    disposeRoomEntities,
    extractFilename,
    GLB_ENTITY_NAME,
    isGlbUrl,
    loadGlbEntity,
    loadGlbEntityWithTransform,
    runBoundedConcurrency
} from './glb-utils';
import { RealEstateHUD } from './hud';
import { buildPropertyIndexMaps, loadRealEstateBootstrap } from './loader';
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

interface LoadedRoom {
    key: string;
    model: SceneModelDto;
    entity: Entity;
    asset: Asset | null;
}

const MULTI_ROOM_CONCURRENCY = 3;
const ROOM_FLY_DURATION_SEC = 0.8;

/**
 * Initializes the RealEstate3D experience with dual public/preview bootstrap,
 * progressive MultiRoom .glb assembly loading (bounded concurrency = 3),
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

    // MED-01: Build O(1) lookup maps keyed by instanceId || sceneId
    const indexedMaps = buildPropertyIndexMaps(property);
    const scenesByKey: Map<string, SceneModelDto> = property.scenesByKey ?? indexedMaps.scenesByKey;
    const sceneItemsByKey: Map<string, SceneItemDto> = property.sceneItemsByKey ?? indexedMaps.sceneItemsByKey;

    const getSceneKey = (s?: SceneModelDto | null): string => (s ? s.instanceId || s.sceneId : '');

    let activeSceneId =
        bootstrap.activeSceneId ||
        property.defaultInstanceId ||
        property.sceneConfig?.defaultSceneId ||
        getSceneKey(property.scenes[0]);

    const activeSceneModel = scenesByKey.get(activeSceneId) || property.scenes[0];
    if (!activeSceneModel) {
        throw new Error('No 3D scenes found for this property.');
    }
    activeSceneId = getSceneKey(activeSceneModel);

    const isMultiRoom =
        property.assemblyMode === 'MultiRoom' &&
        property.scenes.length > 0 &&
        property.scenes.every((s) => s.format === 'glb' || isGlbUrl(s.signedModelUrl));

    let viewerHandle: ViewerHandle | null = null;
    let cleanupContextLoss: (() => void) | null = null;
    let currentGsplatEntity: Entity | null = null;
    let currentGsplatAsset: Asset | null = null;
    let destroyed = false;

    // MultiRoom runtime registries (O(1) lookup)
    const loadedRooms = new Map<string, LoadedRoom>();
    const pendingRoomLoads = new Map<string, Promise<LoadedRoom | null>>();
    let apartmentBbox: BoundingBox | null = null;

    const refreshApartmentBounds = () => {
        if (!viewerHandle || loadedRooms.size === 0) return;
        const entities: Entity[] = [];
        for (const room of loadedRooms.values()) {
            entities.push(room.entity);
        }
        apartmentBbox = computeUnifiedBoundingBox(entities);
        if (apartmentBbox) {
            viewerHandle.events.fire('realestate:setAssemblyBbox', apartmentBbox);
        }
    };

    const resolvePoseForRoom = (
        roomKey: string,
        targetEntity?: Entity | null,
        explicitPose?: { position: number[]; lookAt: number[]; fov?: number }
    ): { position: number[]; target: number[]; fov: number } | null => {
        if (explicitPose?.position?.length >= 3 && explicitPose?.lookAt?.length >= 3) {
            return {
                position: explicitPose.position,
                target: explicitPose.lookAt,
                fov: explicitPose.fov ?? 50
            };
        }

        const sceneItem = sceneItemsByKey.get(roomKey);
        const sceneModel = scenesByKey.get(roomKey);
        const saved = sceneItem?.spawnPose ?? sceneItem?.defaultSpawnPose ?? sceneModel?.spawnPose;
        if (saved?.position?.length >= 3 && saved?.lookAt?.length >= 3) {
            return {
                position: saved.position,
                target: saved.lookAt,
                fov: saved.fov ?? 50
            };
        }

        const entity = targetEntity ?? loadedRooms.get(roomKey)?.entity ?? null;
        return computeStudioOrbitPose(entity);
    };

    const applyStudioOrbitForScene = (sceneId: string, targetEntity?: Entity | null, immediate = false) => {
        if (!viewerHandle) return;
        viewerHandle.state.gamingControls = false;
        viewerHandle.state.animationPaused = true;
        viewerHandle.state.cameraMode = 'orbit';

        const resolved = resolvePoseForRoom(sceneId, targetEntity);
        if (resolved) {
            viewerHandle.events.fire('realestate:gotoPose', {
                position: resolved.position,
                target: resolved.target,
                fov: resolved.fov,
                duration: ROOM_FLY_DURATION_SEC,
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
                duration: ROOM_FLY_DURATION_SEC,
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
            if (isMultiRoom && apartmentBbox && viewerHandle) {
                const overview = computeOrbitPoseForBound(apartmentBbox);
                if (overview) {
                    viewerHandle.state.gamingControls = false;
                    viewerHandle.state.animationPaused = true;
                    viewerHandle.state.cameraMode = 'orbit';
                    viewerHandle.events.fire('realestate:gotoPose', {
                        position: overview.position,
                        target: overview.target,
                        fov: overview.fov,
                        duration: ROOM_FLY_DURATION_SEC,
                        immediate: false
                    });
                    return;
                }
            }
            applyStudioOrbitForScene(activeSceneId, loadedRooms.get(activeSceneId)?.entity ?? null, false);
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
            switchRoom: async () => undefined,
            destroy: () => hud.destroy()
        };
    }

    // 4. Create PlayCanvas Viewer instance in pure Studio-matched Orbit mode
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

        const initialSceneItem = sceneItemsByKey.get(activeSceneId);
        const initialSpawn =
            initialSceneItem?.spawnPose ?? initialSceneItem?.defaultSpawnPose ?? activeSceneModel.spawnPose;
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
                        fov: initialSpawn.fov ?? 50
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

        const applySceneTransforms = (entity: Entity | null, sceneKey: string) => {
            if (!entity) return;
            const sceneItem = sceneItemsByKey.get(sceneKey);
            const sceneModel = scenesByKey.get(sceneKey);
            const transform = sceneItem?.transform ?? sceneModel?.transform;
            if (transform) {
                applyTransformToEntity(entity, transform);
            } else if (sceneItem?.floorEulerDeg && sceneItem.floorEulerDeg.length >= 3) {
                entity.setLocalEulerAngles(
                    sceneItem.floorEulerDeg[0],
                    sceneItem.floorEulerDeg[1],
                    sceneItem.floorEulerDeg[2]
                );
            }
            applyLocalCropBoundsToEntity(entity, sceneItem?.cropBounds ?? sceneModel?.cropBounds ?? null);
            app.renderNextFrame = true;
        };

        const loadRemainingRoomsProgressively = async () => {
            if (!isMultiRoom || !viewerHandle || destroyed) return;

            const remaining = property.scenes.filter((s) => getSceneKey(s) !== activeSceneId);
            const totalRooms = property.scenes.length;
            let loadedCount = loadedRooms.size;

            if (remaining.length === 0) {
                hud.setLoadingProgress(totalRooms, totalRooms);
                return;
            }

            hud.setLoadingProgress(loadedCount, totalRooms);

            await runBoundedConcurrency(remaining, MULTI_ROOM_CONCURRENCY, async (roomModel) => {
                if (destroyed || !viewerHandle) return;
                const key = getSceneKey(roomModel);
                const sceneItem = sceneItemsByKey.get(key);
                const filename = extractFilename(roomModel.signedModelUrl, `${key}.glb`);

                const loadPromise: Promise<LoadedRoom | null> = loadGlbEntityWithTransform(
                    app,
                    roomModel.signedModelUrl,
                    sceneItem?.transform ?? roomModel.transform ?? null,
                    key,
                    filename,
                    undefined,
                    () => destroyed
                )
                    .then(({ entity, asset }): LoadedRoom | null => {
                        if (destroyed) {
                            app.assets.remove(asset);
                            asset.unload();
                            entity.destroy();
                            return null;
                        }
                        applyLocalCropBoundsToEntity(entity, sceneItem?.cropBounds ?? roomModel.cropBounds ?? null);
                        const loaded: LoadedRoom = { key, model: roomModel, entity, asset };
                        loadedRooms.set(key, loaded);
                        loadedCount = loadedRooms.size;
                        hud.setLoadingProgress(loadedCount, totalRooms);
                        refreshApartmentBounds();
                        app.renderNextFrame = true;
                        return loaded;
                    })
                    .catch((err): LoadedRoom | null => {
                        console.warn(`[RealEstate3D] Failed to load room ${key}:`, err);
                        loadedCount++;
                        hud.setLoadingProgress(Math.min(loadedCount, totalRooms), totalRooms);
                        return null;
                    })
                    .finally(() => {
                        pendingRoomLoads.delete(key);
                    });

                pendingRoomLoads.set(key, loadPromise);
                await loadPromise;
            });

            hud.setLoadingProgress(totalRooms, totalRooms);
            refreshApartmentBounds();
        };

        let initialFramed = false;
        let progressiveStarted = false;
        const finalizeInitialRoom = () => {
            const glbEntity = app.root.findByName(GLB_ENTITY_NAME) as Entity | null;
            if (glbEntity) {
                applySceneTransforms(glbEntity, activeSceneId);
                if (isMultiRoom && !loadedRooms.has(activeSceneId)) {
                    loadedRooms.set(activeSceneId, {
                        key: activeSceneId,
                        model: activeSceneModel,
                        entity: glbEntity,
                        asset: null
                    });
                    refreshApartmentBounds();
                }
            }
            if (!initialFramed && (viewerHandle?.state.loaded || glbEntity)) {
                initialFramed = true;
                applyStudioOrbitForScene(activeSceneId, glbEntity, true);
            }
            if (isMultiRoom && !progressiveStarted && (viewerHandle?.state.loaded || glbEntity)) {
                progressiveStarted = true;
                void loadRemainingRoomsProgressively();
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

        // Update 3D hotspot projection on each render frame (MED-01: O(1) lookup inside HUD)
        app.on('update', () => {
            if (cameraEntity) {
                hud.updateHotspotScreenPositions(cameraEntity);
            }
        });
    } catch (err: unknown) {
        console.error('[RealEstate3D] Error creating viewer:', err);
        const msg = err instanceof Error ? err.message : 'خطأ غير معروف';
        hud.showFallbackCard(`تعذر تشغيل المشهد ثلاثي الأبعاد: ${msg}`);
    }

    // Switch rooms: smooth 0.8s fly-to in MultiRoom mode; memory-safe disposal in SingleScan mode
    async function switchRoom(roomId: string, targetPose?: { position: number[]; lookAt: number[] }) {
        if (!viewerHandle) return;
        const nextModel = scenesByKey.get(roomId);
        if (!nextModel) return;

        if (isMultiRoom) {
            activeSceneId = roomId;
            hud.setActiveScene(roomId);

            // If room is still downloading in background queue, wait for it cleanly
            const pending = pendingRoomLoads.get(roomId);
            if (pending) {
                await pending;
            }

            const loaded = loadedRooms.get(roomId);
            const pose = resolvePoseForRoom(roomId, loaded?.entity ?? null, targetPose);
            if (pose) {
                viewerHandle.state.gamingControls = false;
                viewerHandle.state.animationPaused = true;
                viewerHandle.state.cameraMode = 'orbit';
                viewerHandle.events.fire('realestate:gotoPose', {
                    position: pose.position,
                    target: pose.target,
                    fov: pose.fov,
                    duration: ROOM_FLY_DURATION_SEC,
                    immediate: false
                });
            }
            viewerHandle.app.renderNextFrame = true;
            return;
        }

        if (roomId === activeSceneId) return;

        activeSceneId = roomId;
        hud.setActiveScene(roomId);

        const app = viewerHandle.app;

        // Legacy SingleScan path: destroy previous room's WebGL2 buffers & assets before loading next room
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
                const sceneItem = sceneItemsByKey.get(roomId);
                if (sceneItem?.floorEulerDeg && sceneItem.floorEulerDeg.length >= 3) {
                    entity.setLocalEulerAngles(
                        sceneItem.floorEulerDeg[0],
                        sceneItem.floorEulerDeg[1],
                        sceneItem.floorEulerDeg[2]
                    );
                }
                applyLocalCropBoundsToEntity(entity, sceneItem?.cropBounds ?? null);
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
                    duration: ROOM_FLY_DURATION_SEC,
                    immediate: false
                });
            } else {
                applyStudioOrbitForScene(roomId, currentGsplatEntity, false);
            }

            app.renderNextFrame = true;
        } catch (err: unknown) {
            console.error('[RealEstate3D] Failed to switch room:', err);
        }
    }

    const destroy = () => {
        destroyed = true;
        if (cleanupContextLoss) {
            cleanupContextLoss();
            cleanupContextLoss = null;
        }
        if (viewerHandle) {
            const app = viewerHandle.app;
            for (const room of loadedRooms.values()) {
                if (room.asset) {
                    app.assets.remove(room.asset);
                    room.asset.unload();
                }
                room.entity.destroy();
            }
            loadedRooms.clear();
            pendingRoomLoads.clear();
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

export { clampPointToBox } from '../camera-manager';
export {
    applyLocalCropBoundsToEntity,
    computeLocalCropPlanes,
    computeOrbitPoseForBound,
    computeUnifiedBoundingBox,
    runBoundedConcurrency
} from './glb-utils';
