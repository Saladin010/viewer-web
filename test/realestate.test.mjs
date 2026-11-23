import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
    extractShareToken,
    extractPreviewScanId,
    resolveApiBaseUrl,
    getPreviewJwtToken,
    fetchPublicShare,
    fetchAuthenticatedPreview,
    loadRealEstateBootstrap,
    checkWebGL2Support,
    attachContextLossListeners
} from '../dist/realestate.js';

describe('RealEstate3D Dual Bootstrap Loader', () => {
    describe('Token & ScanId URL extraction', () => {
        it('extracts share token from path /v/{token}', () => {
            const url = new URL('https://example.com/v/shar_a1b2c3d4e5f6');
            assert.strictEqual(extractShareToken(url), 'shar_a1b2c3d4e5f6');
        });

        it('extracts share token from path /share/{token}', () => {
            const url = new URL('https://example.com/share/tok_99887766');
            assert.strictEqual(extractShareToken(url), 'tok_99887766');
        });

        it('extracts share token from query ?token=...', () => {
            const url = new URL('https://example.com/viewer.html?token=tok_from_param');
            assert.strictEqual(extractShareToken(url), 'tok_from_param');
        });

        it('extracts share token from query ?shareToken=...', () => {
            const url = new URL('https://example.com/viewer.html?shareToken=tok_alt_param');
            assert.strictEqual(extractShareToken(url), 'tok_alt_param');
        });

        it('returns null when no token is present', () => {
            const url = new URL('https://example.com/viewer.html');
            assert.strictEqual(extractShareToken(url), null);
        });

        it('extracts previewScanId from ?previewScanId=...', () => {
            const url = new URL('https://example.com/viewer.html?previewScanId=scan_uuid_123');
            assert.strictEqual(extractPreviewScanId(url), 'scan_uuid_123');
        });

        it('extracts previewScanId from fallback ?scanId=...', () => {
            const url = new URL('https://example.com/viewer.html?scanId=scan_uuid_fallback');
            assert.strictEqual(extractPreviewScanId(url), 'scan_uuid_fallback');
        });

        it('returns null when no previewScanId is present', () => {
            const url = new URL('https://example.com/viewer.html');
            assert.strictEqual(extractPreviewScanId(url), null);
        });
    });

    describe('API Base URL & JWT resolution', () => {
        it('resolves API base URL from ?apiBaseUrl= query', () => {
            const url = new URL('https://example.com?apiBaseUrl=https://backend.api.com/');
            assert.strictEqual(resolveApiBaseUrl(url), 'https://backend.api.com');
        });

        it('extracts JWT token from ?jwt= query parameter', async () => {
            const url = new URL('https://example.com?previewScanId=s1&jwt=secret_jwt_token_123');
            const token = await getPreviewJwtToken(url);
            assert.strictEqual(token, 'secret_jwt_token_123');
        });

        it('extracts JWT token from ?auth= query parameter', async () => {
            const url = new URL('https://example.com?previewScanId=s1&auth=auth_token_456');
            const token = await getPreviewJwtToken(url);
            assert.strictEqual(token, 'auth_token_456');
        });
    });

    describe('Public Share & Beacon Analytics', () => {
        it('fetches public share metadata and sends view beacon', async () => {
            const mockProperty = {
                propertyId: 'p-1',
                title: 'شقة فاخرة للبيع بالشيخ زايد',
                district: 'الشيخ زايد',
                city: 'الجيزة',
                listingType: 'Sale',
                price: 4500000,
                currency: 'EGP',
                areaSqm: 185,
                floorNumber: 3,
                roomsCount: 3,
                bathroomsCount: 2,
                finishingType: 'UltraSuperLux',
                officeContactName: 'مكتب زايد للعقارات',
                officeContactPhone: '+201012345678',
                captureMode: 'Walkthrough',
                dollhouseSupported: true,
                scenes: [
                    {
                        sceneId: 'room-1',
                        label: 'الريسبشن',
                        signedModelUrl: 'https://r2.example.com/reception.sog',
                        format: 'sog'
                    }
                ],
                sceneConfig: {
                    defaultSceneId: 'room-1',
                    eyeHeightMeters: 1.6,
                    scenes: [
                        {
                            sceneId: 'room-1',
                            label: 'الريسبشن',
                            defaultSpawnPose: { position: [0, 1.6, 0], lookAt: [0, 1.6, -1] }
                        }
                    ]
                }
            };

            const calls = [];
            global.fetch = mock.fn(async (url, opts) => {
                calls.push({ url, opts });
                if (url.includes('/view')) {
                    return { ok: true, status: 204 };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => mockProperty
                };
            });

            const data = await fetchPublicShare('tok_test_123', 'https://api.test');
            assert.strictEqual(data.propertyId, 'p-1');
            assert.strictEqual(data.title, 'شقة فاخرة للبيع بالشيخ زايد');
            assert.strictEqual(data.dollhouseSupported, true);

            // Assert share fetch call was made
            const getShareCall = calls.find(c => c.url === 'https://api.test/api/v1/public/share/tok_test_123');
            assert.ok(getShareCall);

            // Assert view beacon was dispatched
            const beaconCall = calls.find(c => c.url === 'https://api.test/api/v1/public/share/tok_test_123/view');
            assert.ok(beaconCall);
            assert.strictEqual(beaconCall.opts.method, 'POST');
        });
    });

    describe('Authenticated Preview Mode', () => {
        it('fetches authenticated preview with Bearer token', async () => {
            const mockPreview = {
                scanId: 'scan-1',
                propertyId: 'p-1',
                propertyTitle: 'معاينة فيلا التجمع',
                district: 'التجمع الخامس',
                city: 'القاهرة الجديدة',
                captureMode: 'RoomByRoom',
                dollhouseSupported: false,
                officeContactName: 'مكتب التجمع',
                officeContactPhone: '+201099887766',
                scenes: [
                    {
                        sceneId: 'room-living',
                        label: 'غرفة المعيشة',
                        signedModelUrl: 'https://r2.example.com/living.sog',
                        format: 'sog'
                    }
                ],
                sceneConfig: {
                    defaultSceneId: 'room-living',
                    eyeHeightMeters: 1.6,
                    scenes: [{ sceneId: 'room-living', label: 'غرفة المعيشة' }]
                }
            };

            let capturedHeaders = null;
            global.fetch = mock.fn(async (url, opts) => {
                capturedHeaders = opts?.headers;
                return {
                    ok: true,
                    status: 200,
                    json: async () => mockPreview
                };
            });

            const data = await fetchAuthenticatedPreview('scan-1', 'https://api.test', 'jwt_test_token_abc');
            assert.strictEqual(data.scanId, 'scan-1');
            assert.strictEqual(data.title, 'معاينة فيلا التجمع');
            assert.strictEqual(data.dollhouseSupported, false);
            assert.strictEqual(capturedHeaders?.['Authorization'], 'Bearer jwt_test_token_abc');
        });
    });

    describe('loadRealEstateBootstrap integration', () => {
        it('routes to public share when /v/{token} is present', async () => {
            const url = new URL('https://api.test/v/pub_tok_123?apiBaseUrl=https://api.test');
            global.fetch = mock.fn(async (url) => {
                if (url.includes('/view')) return { ok: true };
                return {
                    ok: true,
                    json: async () => ({
                        propertyId: 'prop-public',
                        title: 'عقار عام',
                        dollhouseSupported: true,
                        scenes: [{ sceneId: 's1', signedModelUrl: 'https://r2/s1.sog', format: 'sog' }],
                        sceneConfig: { defaultSceneId: 's1', eyeHeightMeters: 1.6, scenes: [] }
                    })
                };
            });

            const result = await loadRealEstateBootstrap(url);
            assert.strictEqual(result.mode, 'public');
            assert.strictEqual(result.property.propertyId, 'prop-public');
            assert.strictEqual(result.activeSceneId, 's1');
        });

        it('routes to preview when ?previewScanId is present', async () => {
            const url = new URL('https://api.test/viewer.html?previewScanId=scan_priv_456&jwt=my_jwt&apiBaseUrl=https://api.test');
            global.fetch = mock.fn(async () => {
                return {
                    ok: true,
                    json: async () => ({
                        scanId: 'scan_priv_456',
                        propertyId: 'prop-preview',
                        propertyTitle: 'عقار للمعاينة',
                        dollhouseSupported: false,
                        scenes: [{ sceneId: 'room-a', signedModelUrl: 'https://r2/a.sog', format: 'sog' }],
                        sceneConfig: { defaultSceneId: 'room-a', eyeHeightMeters: 1.6, scenes: [] }
                    })
                };
            });

            const result = await loadRealEstateBootstrap(url);
            assert.strictEqual(result.mode, 'preview');
            assert.strictEqual(result.property.title, 'عقار للمعاينة');
            assert.strictEqual(result.activeSceneId, 'room-a');
        });
    });

    describe('WebGL2 Capability and Context Loss Fallback', () => {
        it('checkWebGL2Support returns boolean', () => {
            const isSupported = checkWebGL2Support();
            assert.strictEqual(typeof isSupported, 'boolean');
        });

        it('attachContextLossListeners registers webglcontextlost event listener', () => {
            const listeners = {};
            const fakeCanvas = {
                addEventListener: (event, handler) => {
                    listeners[event] = handler;
                },
                removeEventListener: (event) => {
                    delete listeners[event];
                }
            };

            let lostCalled = false;
            let restoredCalled = false;
            const cleanup = attachContextLossListeners(
                fakeCanvas,
                (e) => { lostCalled = true; },
                (e) => { restoredCalled = true; }
            );

            assert.strictEqual(typeof listeners['webglcontextlost'], 'function');
            assert.strictEqual(typeof listeners['webglcontextrestored'], 'function');

            // Trigger fake context lost
            const fakeEvent = { preventDefault: () => {} };
            listeners['webglcontextlost'](fakeEvent);
            assert.strictEqual(lostCalled, true);

            // Trigger fake context restored
            listeners['webglcontextrestored'](fakeEvent);
            assert.strictEqual(restoredCalled, true);

            cleanup();
            assert.strictEqual(listeners['webglcontextlost'], undefined);
            assert.strictEqual(listeners['webglcontextrestored'], undefined);
        });
    });
});
