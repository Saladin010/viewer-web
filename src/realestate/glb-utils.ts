import type { AppBase, ContainerResource, RenderComponent, StandardMaterial } from 'playcanvas';
import { Asset, BoundingBox, Color, Entity, Plane, Vec3 } from 'playcanvas';
import type { CropBoundsDto } from './types';

export const GLB_ENTITY_NAME = 'glbModel';

/**
 * Apply 6-DOF axis-aligned clipping planes to every MeshInstance under rootEntity
 * using PlayCanvas's native MeshInstance#clippingPlanes (works in WebGL2 & WebGPU).
 */
export const applyCropBoundsToEntity = (
    rootEntity: Entity | null | undefined,
    bounds?: CropBoundsDto | number[] | null
): void => {
    if (!rootEntity) return;

    let planes: Plane[] = [];
    if (Array.isArray(bounds) && bounds.length === 6 && bounds.every((n) => Number.isFinite(n))) {
        const [minX, maxX, minY, maxY, minZ, maxZ] = bounds;
        planes = [
            new Plane().setFromPointNormal(new Vec3(minX, 0, 0), new Vec3(1, 0, 0)),
            new Plane().setFromPointNormal(new Vec3(maxX, 0, 0), new Vec3(-1, 0, 0)),
            new Plane().setFromPointNormal(new Vec3(0, minY, 0), new Vec3(0, 1, 0)),
            new Plane().setFromPointNormal(new Vec3(0, maxY, 0), new Vec3(0, -1, 0)),
            new Plane().setFromPointNormal(new Vec3(0, 0, minZ), new Vec3(0, 0, 1)),
            new Plane().setFromPointNormal(new Vec3(0, 0, maxZ), new Vec3(0, 0, -1))
        ];
    } else if (bounds && !Array.isArray(bounds) && bounds.min?.length === 3 && bounds.max?.length === 3) {
        const [minX, minY, minZ] = bounds.min;
        const [maxX, maxY, maxZ] = bounds.max;
        planes = [
            new Plane().setFromPointNormal(new Vec3(minX, 0, 0), new Vec3(1, 0, 0)),
            new Plane().setFromPointNormal(new Vec3(maxX, 0, 0), new Vec3(-1, 0, 0)),
            new Plane().setFromPointNormal(new Vec3(0, minY, 0), new Vec3(0, 1, 0)),
            new Plane().setFromPointNormal(new Vec3(0, maxY, 0), new Vec3(0, -1, 0)),
            new Plane().setFromPointNormal(new Vec3(0, 0, minZ), new Vec3(0, 0, 1)),
            new Plane().setFromPointNormal(new Vec3(0, 0, maxZ), new Vec3(0, 0, -1))
        ];
    }

    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            mi.clippingPlanes = planes;
        }
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

/**
 * Compute an external Studio-style orbit camera pose framing a loaded GLB mesh.
 */
export const computeStudioOrbitPose = (
    rootEntity: Entity | null | undefined
): { position: number[]; target: number[]; fov: number } | null => {
    if (!rootEntity) return null;
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    const bound = new BoundingBox();
    let valid = false;
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            if (!mi.aabb) continue;
            if (!valid) {
                bound.copy(mi.aabb);
                valid = true;
            } else {
                bound.add(mi.aabb);
            }
        }
    }
    if (!valid) return null;

    const distance = Math.max(1.5, Math.min(50, bound.halfExtents.length() * 1.6));
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
        fov: 50
    };
};
