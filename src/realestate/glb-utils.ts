import type { AppBase, ContainerResource, RenderComponent, StandardMaterial } from 'playcanvas';
import { Asset, BoundingBox, Color, Entity, Mat4, Plane, Vec3 } from 'playcanvas';

import type { CropBoundsDto, RoomTransformDto } from './types';

export const GLB_ENTITY_NAME = 'glbModel';

const LOCAL_CLIP_SPECS: [number, number, number, number][] = [
    [0, 1, 0, 0], // minX -> +X
    [1, -1, 0, 0], // maxX -> -X
    [2, 0, 1, 0], // minY -> +Y
    [3, 0, -1, 0], // maxY -> -Y
    [4, 0, 0, 1], // minZ -> +Z
    [5, 0, 0, -1] // maxZ -> -Z
];

const tmpNormalMat = new Mat4();
const tmpLocalPt = new Vec3();
const tmpLocalN = new Vec3();
const tmpWorldPt = new Vec3();
const tmpWorldN = new Vec3();

const toSixTupleBounds = (
    bounds?: CropBoundsDto | number[] | null
): [number, number, number, number, number, number] | null => {
    if (!bounds) return null;
    if (Array.isArray(bounds) && bounds.length === 6 && bounds.every((n) => Number.isFinite(n))) {
        return [bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]];
    }
    if (!Array.isArray(bounds) && bounds.min?.length >= 3 && bounds.max?.length >= 3) {
        const tuple: [number, number, number, number, number, number] = [
            Number(bounds.min[0]),
            Number(bounds.max[0]),
            Number(bounds.min[1]),
            Number(bounds.max[1]),
            Number(bounds.min[2]),
            Number(bounds.max[2])
        ];
        if (tuple.every((n) => Number.isFinite(n))) {
            return tuple;
        }
    }
    return null;
};

/**
 * Compute world-space clipping planes from local-space 6-DOF crop bounds
 * transformed by the entity's world matrix.
 */
export const computeLocalCropPlanes = (
    worldTransform: Mat4,
    bounds?: CropBoundsDto | number[] | null
): Plane[] => {
    const tuple = toSixTupleBounds(bounds);
    if (!tuple) return [];

    tmpNormalMat.copy(worldTransform).invert().transpose();

    return LOCAL_CLIP_SPECS.map(([idx, nx, ny, nz]) => {
        const coord = tuple[idx];
        if (idx < 2) {
            tmpLocalPt.set(coord, 0, 0);
        } else if (idx < 4) {
            tmpLocalPt.set(0, coord, 0);
        } else {
            tmpLocalPt.set(0, 0, coord);
        }
        tmpLocalN.set(nx, ny, nz);

        worldTransform.transformPoint(tmpLocalPt, tmpWorldPt);
        tmpNormalMat.transformVector(tmpLocalN, tmpWorldN);
        if (tmpWorldN.lengthSq() > 1e-12) {
            tmpWorldN.normalize();
        } else {
            tmpWorldN.copy(tmpLocalN);
        }
        return new Plane().setFromPointNormal(tmpWorldPt.clone(), tmpWorldN.clone());
    });
};

/**
 * Apply 6-DOF local-space clipping planes to every MeshInstance under rootEntity
 * using rootEntity's world transform.
 */
export const applyLocalCropBoundsToEntity = (
    rootEntity: Entity | null | undefined,
    bounds?: CropBoundsDto | number[] | null
): void => {
    if (!rootEntity) return;

    const planes = computeLocalCropPlanes(rootEntity.getWorldTransform(), bounds);
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            mi.clippingPlanes = planes;
        }
    }
};

export const applyCropBoundsToEntity = applyLocalCropBoundsToEntity;

export const applyTransformToEntity = (
    entity: Entity | null | undefined,
    transform?: Partial<RoomTransformDto> | null
): void => {
    if (!entity || !transform) return;
    if (Array.isArray(transform.position) && transform.position.length >= 3) {
        entity.setLocalPosition(
            Number(transform.position[0]) || 0,
            Number(transform.position[1]) || 0,
            Number(transform.position[2]) || 0
        );
    }
    if (Array.isArray(transform.rotationEulerDeg) && transform.rotationEulerDeg.length >= 3) {
        entity.setLocalEulerAngles(
            Number(transform.rotationEulerDeg[0]) || 0,
            Number(transform.rotationEulerDeg[1]) || 0,
            Number(transform.rotationEulerDeg[2]) || 0
        );
    }
    if (typeof transform.scale === 'number' && Number.isFinite(transform.scale)) {
        const s = Math.max(0.01, transform.scale);
        entity.setLocalScale(s, s, s);
    }
};

export const isGlbUrl = (url: string): boolean => {
    try {
        const pathname = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost').pathname.toLowerCase();
        return pathname.endsWith('.glb');
    } catch {
        return url.split(/[?#]/)[0].toLowerCase().endsWith('.glb');
    }
};

export const extractFilename = (url: string, fallback: string): string => {
    try {
        const pathname = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost').pathname;
        return pathname.split('/').pop() || fallback;
    } catch {
        const clean = url.split(/[?#]/)[0];
        return clean.split('/').pop() || fallback;
    }
};

/**
 * Convert Meshroom baked PBR mesh materials to Unlit so wall/floor textures
 * render at full true brightness without dark synthetic lighting.
 */
export const applyUnlitMaterials = (rootEntity: Entity): void => {
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            const mat = mi.material as StandardMaterial | null;
            if (!mat) continue;

            mat.useLighting = false;
            if (mat.diffuseMap) {
                mat.emissiveMap = mat.diffuseMap;
                mat.emissiveMapUv = mat.diffuseMapUv;
                mat.emissiveMapChannel = mat.diffuseMapChannel;
                mat.emissiveMapTiling.copy(mat.diffuseMapTiling);
                mat.emissiveMapOffset.copy(mat.diffuseMapOffset);
                mat.emissive = new Color(1, 1, 1);
            } else if (mat.diffuse) {
                mat.emissive = mat.diffuse.clone();
            } else {
                mat.emissive = new Color(1, 1, 1);
            }

            mat.diffuse = new Color(0, 0, 0);
            mat.update();
        }
    }
};

export const loadGlbEntity = (
    app: AppBase,
    url: string,
    filename?: string | null,
    progressCallback?: (progress: number) => void,
    cancelled?: () => boolean
): Promise<{ entity: Entity; asset: Asset }> => {
    const baseName = filename || extractFilename(url, 'scene.glb');
    const assetName = baseName.toLowerCase().endsWith('.glb') ? baseName : `${baseName}.glb`;
    const asset = new Asset(assetName, 'container', { url, filename: assetName });

    return new Promise<{ entity: Entity; asset: Asset }>((resolve, reject) => {
        asset.on('load', () => {
            if (cancelled?.()) {
                app.assets.remove(asset);
                asset.unload();
                reject(new Error('loadGlbEntity: the viewer was destroyed while loading'));
                return;
            }
            const resource = asset.resource as ContainerResource;
            const containerEntity = resource.instantiateRenderEntity();
            containerEntity.name = assetName;
            applyUnlitMaterials(containerEntity);

            const wrapper = new Entity(GLB_ENTITY_NAME, app);
            wrapper.addChild(containerEntity);
            (wrapper as Entity & { __containerAsset?: Asset }).__containerAsset = asset;
            app.root.addChild(wrapper);
            resolve({ entity: wrapper, asset });
        });

        let watermark = 0;
        if (progressCallback) {
            asset.on('progress', (received: number, length: number) => {
                if (!length) return;
                const progress = Math.min(1, received / length) * 100;
                if (progress > watermark) {
                    watermark = progress;
                    progressCallback(Math.trunc(watermark));
                }
            });
        }

        asset.on('error', (err) => {
            console.log(err);
            reject(typeof err === 'string' ? new Error(err) : err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

export const loadGlbEntityWithTransform = async (
    app: AppBase,
    url: string,
    transform?: Partial<RoomTransformDto> | null,
    instanceId?: string,
    filename?: string | null,
    progressCallback?: (progress: number) => void,
    cancelled?: () => boolean
): Promise<{ entity: Entity; asset: Asset }> => {
    const { entity, asset } = await loadGlbEntity(app, url, filename, progressCallback, cancelled);
    if (instanceId) {
        (entity as Entity & { __instanceId?: string }).__instanceId = instanceId;
    }
    if (transform) {
        applyTransformToEntity(entity, transform);
    }
    return { entity, asset };
};

export const disposeRoomEntities = (app: AppBase): void => {
    const targets = app.root.children.filter(
        (child) => child.name === 'gsplat' || child.name === GLB_ENTITY_NAME
    );

    for (const entity of targets) {
        const gsplatComp = (entity as Entity & { gsplat?: { asset?: Asset } }).gsplat;
        if (gsplatComp?.asset) {
            app.assets.remove(gsplatComp.asset);
            gsplatComp.asset.unload();
        }
        const containerAsset = (entity as Entity & { __containerAsset?: Asset }).__containerAsset;
        if (containerAsset) {
            app.assets.remove(containerAsset);
            containerAsset.unload();
        }
        entity.destroy();
    }
};

export const computeEntityBoundingBox = (
    rootEntity: Entity | null | undefined,
    target = new BoundingBox()
): BoundingBox | null => {
    if (!rootEntity || !rootEntity.enabled) return null;
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    let valid = false;
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            if (!mi.aabb) continue;
            if (!valid) {
                target.copy(mi.aabb);
                valid = true;
            } else {
                target.add(mi.aabb);
            }
        }
    }
    return valid ? target : null;
};

export const computeUnifiedBoundingBox = (entities: Iterable<Entity | null | undefined>): BoundingBox | null => {
    const unified = new BoundingBox();
    const roomBox = new BoundingBox();
    let valid = false;
    for (const entity of entities) {
        if (!entity || !entity.enabled) continue;
        if (!computeEntityBoundingBox(entity, roomBox)) continue;
        if (!valid) {
            unified.copy(roomBox);
            valid = true;
        } else {
            unified.add(roomBox);
        }
    }
    return valid ? unified : null;
};

/**
 * CRIT-03: Bounded concurrency queue using an atomic cursor (zero Array.shift()).
 */
export const runBoundedConcurrency = async <T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
    if (items.length === 0) return [];
    const limit = Math.max(1, Math.floor(concurrency));
    const results = new Array<R>(items.length);
    let cursor = 0;

    const runWorker = async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
        }
    };

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
};

/**
 * Compute an external Studio-style orbit camera pose framing a loaded GLB mesh or BoundingBox.
 * Adapts distance for narrow portrait viewports so rooms never appear oversized on mobile.
 */
export const computeOrbitPoseForBound = (
    bound: BoundingBox | null | undefined,
    aspect = 16 / 9
): { position: number[]; target: number[]; fov: number } | null => {
    if (!bound) return null;
    const fov = 50;
    const halfV = (fov * Math.PI) / 180 / 2;
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? Math.max(0.35, aspect) : 16 / 9;
    const effectiveHalf = Math.min(halfV, Math.atan(Math.tan(halfV) * safeAspect));
    const distance = Math.max(2.0, Math.min(50, (bound.halfExtents.length() * 1.1) / Math.tan(effectiveHalf)));
    const az = (35 * Math.PI) / 180;
    const el = (-20 * Math.PI) / 180;
    const cosEl = Math.cos(el);
    return {
        position: [
            bound.center.x + distance * cosEl * Math.sin(az),
            bound.center.y - distance * Math.sin(el),
            bound.center.z + distance * cosEl * Math.cos(az)
        ],
        target: [bound.center.x, bound.center.y, bound.center.z],
        fov
    };
};

export const computeStudioOrbitPose = (
    rootEntity: Entity | null | undefined,
    aspect = 16 / 9
): { position: number[]; target: number[]; fov: number } | null => {
    return computeOrbitPoseForBound(computeEntityBoundingBox(rootEntity), aspect);
};
