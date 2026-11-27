import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { BoundingBox, Mat4, Vec3 } from 'playcanvas';

import {
    buildPropertyIndexMaps,
    clampPointToBox,
    computeLocalCropPlanes,
    computeOrbitPoseForBound,
    extractPreviewPropertyId,
    fetchPropertyAssemblyPreview,
    fetchPublicShare,
    loadRealEstateBootstrap,
    normalizePropertyPayload,
    normalizeRoomsToScenes,
    normalizeSceneConfig,
    runBoundedConcurrency
} from '../dist/realestate.js';

describe('RealEstate3D Multi-Room Assembly Engine', () => {
    it('normalizes multi-room PublicRoomDto transforms, local cropBounds, spawnPose, and hotspots', () => {
        const rawShare = {
            propertyId: 'prop-1',
            title: 'شقة بالتجمع',
            district: 'التجمع الخامس',
            city: 'القاهرة',
            listingType: 'Sale',
            price: 3500000,
            currency: 'EGP',
            areaSqm: 160,
            floorNumber: 2,
            roomsCount: 3,
            bathroomsCount: 2,
            finishingType: 'SuperLux',
            dollhouseSupported: true,
            assemblyMode: 'MultiRoom',
            defaultInstanceId: 'inst-living',
            eyeHeightMeters: 1.65,
            officeContactName: 'مكتب النخبة',
            officeContactPhone: '+201011223344',
            rooms: [
                {
                    instanceId: 'inst-living',
                    sourceScanId: 'scan-1',
                    roomId: 'room-1',
                    roomLabel: 'الريسبشن',
                    sortOrder: 0,
                    modelUrl: 'https://r2.example.com/scan1/room1.glb',
                    gaussianCount: 320000,
                    transform: { position: [0, 0, 0], rotationEulerDeg: [0, 90, 0], scale: 1.05 },
                    cropBounds: [-4, 4, -1, 3, -5, 5],
                    spawnPose: { position: [0, 1.6, 2], target: [0, 1.5, 0], fov: 55 },
                    hotspots: [
                        {
                            id: 'hs-1',
                            label: 'المطبخ',
                            position: [2.2, 1.4, -0.5],
                            targetInstanceId: 'inst-kitchen',
                            targetPose: { position: [4, 1.6, 1], target: [4, 1.5, -1], fov: 50 }
                        }
                    ]
                },
                {
                    instanceId: 'inst-kitchen',
                    sourceScanId: 'scan-2',
                    roomId: 'room-1', // Duplicate roomId across sessions, disambiguated by instanceId
                    roomLabel: 'المطبخ',
                    sortOrder: 1,
                    modelUrl: 'https://r2.example.com/scan2/room1.glb',
                    gaussianCount: 180000,
                    transform: { position: [4.5, 0, 0], rotationEulerDeg: [0, 0, 0], scale: 1 },
                    cropBounds: [-3, 3, -1, 3, -3, 3],
                    spawnPose: { position: [4.5, 1.6, 1.5], target: [4.5, 1.5, 0], fov: 50 },
                    hotspots: []
                }
            ],
            sceneConfig: null
        };

        const normalized = normalizePropertyPayload(rawShare);
        assert.strictEqual(normalized.assemblyMode, 'MultiRoom');
        assert.strictEqual(normalized.scenes.length, 2);
        assert.strictEqual(normalized.scenes[0].instanceId, 'inst-living');
        assert.strictEqual(normalized.scenes[1].instanceId, 'inst-kitchen');
        assert.deepStrictEqual(normalized.scenes[0].transform, {
            position: [0, 0, 0],
            rotationEulerDeg: [0, 90, 0],
            scale: 1.05
        });
        assert.deepStrictEqual(normalized.scenes[0].cropBounds, {
            min: [-4, -1, -5],
            max: [4, 3, 5]
        });
        assert.deepStrictEqual(normalized.scenes[0].spawnPose, {
            position: [0, 1.6, 2],
            lookAt: [0, 1.5, 0],
            fov: 55
        });

        // MED-01 O(1) Map indexing by instanceId
        assert.ok(normalized.scenesByKey instanceof Map);
        assert.ok(normalized.sceneItemsByKey instanceof Map);
        assert.strictEqual(normalized.scenesByKey.get('inst-kitchen')?.sourceScanId, 'scan-2');
        assert.strictEqual(normalized.sceneItemsByKey.get('inst-living')?.hotspots?.[0]?.targetInstanceId, 'inst-kitchen');
        assert.strictEqual(normalized.sceneConfig.defaultSceneId, 'inst-living');
    });

    it('synthesizes SceneConfigurationDto from normalizeRoomsToScenes & buildPropertyIndexMaps', () => {
        const scenes = normalizeRoomsToScenes([
            {
                instanceId: 'a1',
                roomId: 'r1',
                displayLabel: 'غرفة 1',
                signedModelUrl: 'https://r2.example.com/a1.glb',
                visible: true
            },
            {
                instanceId: 'a2',
                roomId: 'r1',
                displayLabel: 'مخفية',
                signedModelUrl: 'https://r2.example.com/a2.glb',
                visible: false
            }
        ]);
        assert.strictEqual(scenes.length, 1);
        const cfg = normalizeSceneConfig(null, scenes, 'a1', 1.7);
        assert.strictEqual(cfg.defaultSceneId, 'a1');
        assert.strictEqual(cfg.eyeHeightMeters, 1.7);
        const maps = buildPropertyIndexMaps({
            propertyId: 'p',
            title: 't',
            district: '',
            city: '',
            listingType: 'Sale',
            price: 0,
            currency: 'EGP',
            areaSqm: 0,
            floorNumber: 0,
            roomsCount: 1,
            bathroomsCount: 1,
            finishingType: '',
            officeContactName: '',
            officeContactPhone: '',
            captureMode: 'RoomByRoom',
            dollhouseSupported: true,
            scenes,
            sceneConfig: cfg
        });
        assert.strictEqual(maps.scenesByKey.get('a1')?.displayLabel, 'غرفة 1');
        assert.strictEqual(maps.sceneItemsByKey.get('a1')?.label, 'غرفة 1');
    });

    it('fetches authenticated property assembly preview from /api/v1/properties/{id}/assembly', async () => {
        const url = new URL('https://app.test/viewer.html?previewPropertyId=prop-99&jwt=tok_99&apiBaseUrl=https://api.test');
        assert.strictEqual(extractPreviewPropertyId(url), 'prop-99');

        let seenAuth = '';
        global.fetch = mock.fn(async (reqUrl, opts) => {
            seenAuth = opts?.headers?.Authorization || '';
            assert.strictEqual(reqUrl, 'https://api.test/api/v1/properties/prop-99/assembly');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    propertyId: 'prop-99',
                    propertyTitle: 'شقة المعاينة',
                    district: 'المعادي',
                    city: 'القاهرة',
                    assembly: {
                        propertyId: 'prop-99',
                        status: 'Draft',
                        version: 3,
                        defaultInstanceId: 'inst-1',
                        eyeHeightMeters: 1.6,
                        rooms: [
                            {
                                instanceId: 'inst-1',
                                sourceScanId: 's1',
                                roomId: 'r1',
                                displayLabel: 'الصالة',
                                sortOrder: 0,
                                signedModelUrl: 'https://r2.example.com/r1.glb',
                                transform: { position: [1, 0, 2], rotationEulerDeg: [0, 45, 0], scale: 1 },
                                cropBounds: [-5, 5, -2, 4, -5, 5],
                                spawnPose: { position: [1, 1.6, 5], target: [1, 1.5, 2], fov: 50 },
                                hotspots: [],
                                visible: true
                            }
                        ]
                    }
                })
            };
        });

        const result = await loadRealEstateBootstrap(url);
        assert.strictEqual(seenAuth, 'Bearer tok_99');
        assert.strictEqual(result.mode, 'preview');
        assert.strictEqual(result.property.assemblyMode, 'MultiRoom');
        assert.strictEqual(result.activeSceneId, 'inst-1');

        // Direct fetchPublicShare backward-compatibility check
        global.fetch = mock.fn(async (reqUrl) => {
            if (reqUrl.includes('/view')) return { ok: true, status: 204 };
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    propertyId: 'p-legacy',
                    title: 'Legacy',
                    assemblyMode: 'SingleScan',
                    rooms: [{ roomId: 'r1', roomLabel: 'R1', modelUrl: 'https://r2/r1.sog' }],
                    sceneConfig: { defaultSceneId: 'r1', eyeHeightMeters: 1.6, scenes: [{ roomId: 'r1', roomLabel: 'R1' }] }
                })
            };
        });
        const legacy = await fetchPublicShare('tok_leg', 'https://api.test');
        assert.strictEqual(legacy.assemblyMode, 'SingleScan');

        // Direct fetchPropertyAssemblyPreview sanity
        global.fetch = mock.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ propertyId: 'prop-99', assembly: { rooms: [] } })
        }));
        const emptyAssembly = await fetchPropertyAssemblyPreview('prop-99', 'https://api.test', null);
        assert.strictEqual(emptyAssembly.assemblyMode, 'MultiRoom');
        assert.strictEqual(emptyAssembly.scenes.length, 0);
    });

    it('enforces CRIT-03 bounded concurrency (<= 3 active tasks) while preserving order', async () => {
        const items = [0, 1, 2, 3, 4, 5, 6, 7];
        let active = 0;
        let peakActive = 0;

        const results = await runBoundedConcurrency(items, 3, async (item) => {
            active++;
            if (active > peakActive) peakActive = active;
            await new Promise((r) => setTimeout(r, 15 - (item % 3) * 3));
            active--;
            return item * 10;
        });

        assert.ok(peakActive <= 3, `Expected peak concurrency <= 3, got ${peakActive}`);
        assert.ok(peakActive >= 2, `Expected concurrent execution, got peak ${peakActive}`);
        assert.deepStrictEqual(results, [0, 10, 20, 30, 40, 50, 60, 70]);
    });

    it('transforms local-space 6-DOF crop planes accurately under 90-deg yaw rotation and translation', () => {
        // Local bounds: x in [-2, 3], y in [0, 4], z in [-1, 1]
        const localBounds = [-2, 3, 0, 4, -1, 1];
        const worldMat = new Mat4();
        // Rotate +90 deg around Y (local +X maps to world -Z, local +Z maps to world +X), translate by (10, 0, 5)
        const rotMat = new Mat4().setFromAxisAngle(Vec3.UP, 90);
        worldMat.setTranslate(10, 0, 5);
        worldMat.mul2(worldMat, rotMat);

        const planes = computeLocalCropPlanes(worldMat, localBounds);
        assert.strictEqual(planes.length, 6);

        // Local point (0, 2, 0) -> world (10, 2, 5) must be strictly inside all 6 planes
        const insideWorld = new Vec3(10, 2, 5);
        for (const p of planes) {
            assert.ok(
                p.normal.dot(insideWorld) + p.distance > 0,
                `Expected center point to be inside plane, got signed dist ${p.normal.dot(insideWorld) + p.distance}`
            );
        }

        // Local X = 2.5 (inside [-2, 3]) -> rotated +90 deg around Y is world (10, 2, 5 - 2.5) = (10, 2, 2.5) -> INSIDE
        const insideLocalX = new Vec3(10, 2, 2.5);
        for (const p of planes) {
            assert.ok(p.normal.dot(insideLocalX) + p.distance > 0);
        }

        // Local X = 3.5 (outside maxX = 3) -> world (10, 2, 1.5) -> OUTSIDE
        const outsideLocalX = new Vec3(10, 2, 1.5);
        const minSignedDist = Math.min(...planes.map((p) => p.normal.dot(outsideLocalX) + p.distance));
        assert.ok(minSignedDist < 0, `Expected outsideLocalX to be clipped, minSignedDist=${minSignedDist}`);
    });

    it('clamps camera position softly within apartment bounding box (clampPointToBox)', () => {
        const inside = new Vec3(1.5, 2.0, -0.5);
        const wasInsideClamped = clampPointToBox(inside, -5, 0, -5, 5, 4, 5);
        assert.strictEqual(wasInsideClamped, false);
        assert.deepStrictEqual([inside.x, inside.y, inside.z], [1.5, 2.0, -0.5]);

        const outside = new Vec3(-9.5, 8.2, 12.0);
        const wasOutsideClamped = clampPointToBox(outside, -5, 0, -5, 5, 4, 5);
        assert.strictEqual(wasOutsideClamped, true);
        assert.deepStrictEqual([outside.x, outside.y, outside.z], [-5, 4, 5]);
    });

    it('frames rooms comfortably on portrait mobile as well as desktop (computeOrbitPoseForBound)', () => {
        const roomBox = new BoundingBox(new Vec3(0, 1.5, 0), new Vec3(3, 1.5, 3));
        const desktopPose = computeOrbitPoseForBound(roomBox, 16 / 9);
        const mobilePose = computeOrbitPoseForBound(roomBox, 9 / 20);
        assert.ok(desktopPose && mobilePose);

        const desktopDist = new Vec3(...desktopPose.position).distance(new Vec3(...desktopPose.target));
        const mobileDist = new Vec3(...mobilePose.position).distance(new Vec3(...mobilePose.target));
        assert.ok(desktopDist >= 2.0);
        assert.ok(
            mobileDist > desktopDist * 1.5,
            `Expected portrait mobile orbit distance (${mobileDist}) to pull back farther than desktop (${desktopDist})`
        );
    });
});
