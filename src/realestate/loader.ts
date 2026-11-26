import type {
    CameraPoseDto,
    CropBoundsDto,
    HotspotDto,
    PropertyPublicShareDto,
    RealEstateBootstrapResult,
    ScanPreviewDto,
    SceneConfigurationDto,
    SceneItemDto,
    SceneModelDto
} from './types';

function inferModelFormat(url: string): string {
    const clean = (url || '').split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith('.glb')) return 'glb';
    if (clean.endsWith('.ply')) return 'ply';
    return 'sog';
}

function normalizeRoomsToScenes(rawRooms: any[]): SceneModelDto[] {
    if (!Array.isArray(rawRooms)) return [];
    return rawRooms
        .filter((r) => Boolean(r?.signedModelUrl || r?.modelUrl))
        .sort((a, b) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0))
        .map((r) => {
            const url = r.signedModelUrl || r.modelUrl || '';
            return {
                sceneId: r.sceneId || r.roomId || '',
                label: r.label || r.roomLabel || r.roomId || 'غرفة',
                signedModelUrl: url,
                format: r.format || inferModelFormat(url),
                sizeBytes: r.sizeBytes ?? undefined
            };
        });
}

function normalizeSceneConfig(rawConfig: any, fallbackScenes: SceneModelDto[]): SceneConfigurationDto {
    const rawItems: any[] = Array.isArray(rawConfig?.scenes) ? rawConfig.scenes : [];
    const scenes: SceneItemDto[] = rawItems.map((item) => {
        const sceneId = item.sceneId || item.roomId || '';
        const label = item.label || item.roomLabel || sceneId;

        let defaultSpawnPose: CameraPoseDto | undefined = item.defaultSpawnPose;
        if (!defaultSpawnPose && Array.isArray(item.cameraPosition) && item.cameraPosition.length >= 3) {
            defaultSpawnPose = {
                position: item.cameraPosition.slice(0, 3),
                lookAt: Array.isArray(item.cameraTarget) && item.cameraTarget.length >= 3
                    ? item.cameraTarget.slice(0, 3)
                    : [0, item.cameraPosition[1] ?? 1.6, 0]
            };
        }

        let cropBounds: CropBoundsDto | undefined = item.cropBounds;
        let floorEulerDeg: number[] | undefined = item.floorEulerDeg;
        let hotspots: HotspotDto[] = [];

        if (Array.isArray(item.hotspots)) {
            hotspots = item.hotspots.map((hs: any) => ({
                id: hs.id || `hs_${Math.random().toString(36).slice(2, 8)}`,
                label: hs.label || hs.title || 'انتقال',
                position: Array.isArray(hs.position) ? hs.position : [0, 1.5, 0],
                targetSceneId: hs.targetSceneId || hs.targetRoomId || '',
                targetPose: hs.targetPose
            }));
        } else if (item.hotspots && typeof item.hotspots === 'object') {
            const hsObj = item.hotspots;
            if (!cropBounds && Array.isArray(hsObj.cropBounds) && hsObj.cropBounds.length === 6) {
                cropBounds = {
                    min: [hsObj.cropBounds[0], hsObj.cropBounds[2], hsObj.cropBounds[4]],
                    max: [hsObj.cropBounds[1], hsObj.cropBounds[3], hsObj.cropBounds[5]]
                };
            }
            if (!floorEulerDeg && typeof hsObj.floorTiltDegrees === 'number' && hsObj.floorTiltDegrees !== 0) {
                floorEulerDeg = [hsObj.floorTiltDegrees, 0, 0];
            }
            if (Array.isArray(hsObj.links)) {
                hotspots = hsObj.links.map((hs: any) => ({
                    id: hs.id || `hs_${Math.random().toString(36).slice(2, 8)}`,
                    label: hs.label || hs.title || 'انتقال',
                    position: Array.isArray(hs.position) ? hs.position : [0, 1.5, 0],
                    targetSceneId: hs.targetSceneId || hs.targetRoomId || '',
                    targetPose: hs.targetPose
                }));
            }
        }

        return {
            sceneId,
            label,
            scaleFactor: item.scaleFactor,
            floorEulerDeg,
            cropBounds,
            defaultSpawnPose,
            hotspots
        };
    });

    return {
        expectedVersion: rawConfig?.expectedVersion ?? rawConfig?.version,
        defaultSceneId: rawConfig?.defaultSceneId || fallbackScenes[0]?.sceneId || '',
        eyeHeightMeters: rawConfig?.eyeHeightMeters ?? 1.6,
        scenes
    };
}

export function resolveApiBaseUrl(url: URL): string {
    const fromQuery = url.searchParams.get('apiBaseUrl') || url.searchParams.get('api');
    if (fromQuery) {
        return fromQuery.replace(/\/+$/, '');
    }

    if (typeof window !== 'undefined' && (window as any).REALESTATE3D_API_BASE) {
        return (window as any).REALESTATE3D_API_BASE.replace(/\/+$/, '');
    }

    // Default to current host or dev API origin
    if (typeof window !== 'undefined' && window.location) {
        return window.location.origin;
    }

    return 'https://orcaz.runasp.net';
}

export function extractShareToken(url: URL): string | null {
    // 1. Path match: /v/{token} or /share/{token}
    const pathMatch = url.pathname.match(/\/(?:v|share)\/([a-zA-Z0-9_-]+)/);
    if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
    }

    // 2. Query param match: ?token=... or ?shareToken=...
    return url.searchParams.get('token') || url.searchParams.get('shareToken') || null;
}

export function extractPreviewScanId(url: URL): string | null {
    return url.searchParams.get('previewScanId') || url.searchParams.get('scanId') || null;
}

export async function getPreviewJwtToken(url: URL): Promise<string | null> {
    // 1. Check window.FlutterBridge
    if (typeof window !== 'undefined' && (window as any).FlutterBridge?.getJwtToken) {
        try {
            const token = await (window as any).FlutterBridge.getJwtToken();
            if (token) return token;
        } catch (e) {
            console.warn('[RealEstate3D] FlutterBridge.getJwtToken() failed:', e);
        }
    }

    // 2. Check query params ?jwt=... or ?auth=...
    const fromQuery = url.searchParams.get('jwt') || url.searchParams.get('auth');
    if (fromQuery) return fromQuery;

    // 3. Check sessionStorage / localStorage
    if (typeof window !== 'undefined' && window.localStorage) {
        const stored = localStorage.getItem('jwt') || localStorage.getItem('access_token');
        if (stored) return stored;
    }

    // 4. Wait briefly for postMessage handshake from parent iframe/Angular Studio
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        const tokenFromMessage = await new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 500);
            const listener = (event: MessageEvent) => {
                if (event.data && typeof event.data === 'object' && event.data.type === 'REALESTATE3D_AUTH_TOKEN') {
                    clearTimeout(timer);
                    window.removeEventListener('message', listener);
                    resolve(event.data.token || null);
                }
            };
            window.addEventListener('message', listener);
            window.parent.postMessage({ type: 'REALESTATE3D_REQUEST_TOKEN' }, '*');
        });

        if (tokenFromMessage) return tokenFromMessage;
    }

    return null;
}

export async function fetchPublicShare(token: string, apiBaseUrl: string): Promise<PropertyPublicShareDto> {
    const shareUrl = `${apiBaseUrl}/api/v1/public/share/${token}`;
    const response = await fetch(shareUrl, {
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to load public share (HTTP ${response.status}): ${response.statusText}`);
    }

    const raw = (await response.json()) as any;
    const scenes = Array.isArray(raw.scenes) && raw.scenes.length > 0
        ? normalizeRoomsToScenes(raw.scenes)
        : normalizeRoomsToScenes(raw.rooms || []);
    const sceneConfig = normalizeSceneConfig(raw.sceneConfig, scenes);

    const data: PropertyPublicShareDto = {
        ...raw,
        scenes,
        sceneConfig
    };

    // Fire-and-forget view count analytics beacon per Section 3.2 (M2)
    const beaconUrl = `${apiBaseUrl}/api/v1/public/share/${token}/view`;
    try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            navigator.sendBeacon(beaconUrl);
        } else {
            fetch(beaconUrl, { method: 'POST', keepalive: true }).catch(() => {});
        }
    } catch {
        // Beacon failures must never disrupt viewer experience
    }

    return data;
}

export async function fetchAuthenticatedPreview(
    scanId: string,
    apiBaseUrl: string,
    jwtToken: string | null
): Promise<PropertyPublicShareDto> {
    const previewUrl = `${apiBaseUrl}/api/v1/scans/${scanId}/preview`;
    const headers: Record<string, string> = {
        Accept: 'application/json'
    };
    if (jwtToken) {
        headers.Authorization = `Bearer ${jwtToken}`;
    }

    const response = await fetch(previewUrl, { headers });

    if (!response.ok) {
        throw new Error(`Failed to load scan preview (HTTP ${response.status}): ${response.statusText}`);
    }

    const preview = (await response.json()) as any;
    const scenes = Array.isArray(preview.scenes) && preview.scenes.length > 0
        ? normalizeRoomsToScenes(preview.scenes)
        : normalizeRoomsToScenes(preview.rooms || []);
    const sceneConfig = normalizeSceneConfig(preview.sceneConfig, scenes);

    // Adapt to uniform PropertyPublicShareDto representation
    return {
        scanId: preview.scanId,
        propertyId: preview.propertyId,
        title: preview.propertyTitle || 'معاينة العقار',
        district: preview.district || '',
        city: preview.city || '',
        listingType: 'Sale',
        price: 0,
        currency: 'EGP',
        areaSqm: 0,
        floorNumber: 0,
        roomsCount: scenes.length,
        bathroomsCount: 1,
        finishingType: 'جاهز للمعاينة',
        publicDescription: 'معاينة داخلية قبل النشر',
        officeContactName: preview.officeContactName || 'المكتب الرئيسي',
        officeContactPhone: preview.officeContactPhone || '+201000000000',
        captureMode: preview.captureMode || 'RoomByRoom',
        dollhouseSupported: preview.dollhouseSupported ?? false,
        scenes,
        thumbnailUrl: preview.thumbnailUrl,
        sceneConfig
    };
}

export async function loadRealEstateBootstrap(rawUrl?: string | URL): Promise<RealEstateBootstrapResult> {
    const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl || (typeof window !== 'undefined' ? window.location.href : 'http://localhost'));
    const apiBaseUrl = resolveApiBaseUrl(url);

    // 1. Check Public Share Mode
    const shareToken = extractShareToken(url);
    if (shareToken) {
        console.log(`[RealEstate3D] Bootstrapping in Public Mode for token: ${shareToken}`);
        const property = await fetchPublicShare(shareToken, apiBaseUrl);
        const activeSceneId = property.sceneConfig?.defaultSceneId || property.scenes[0]?.sceneId || '';
        return {
            mode: 'public',
            property,
            activeSceneId
        };
    }

    // 2. Check Authenticated Preview Mode
    const previewScanId = extractPreviewScanId(url);
    if (previewScanId) {
        console.log(`[RealEstate3D] Bootstrapping in Authenticated Preview Mode for scan: ${previewScanId}`);
        const jwt = await getPreviewJwtToken(url);
        const property = await fetchAuthenticatedPreview(previewScanId, apiBaseUrl, jwt);
        const activeSceneId = property.sceneConfig?.defaultSceneId || property.scenes[0]?.sceneId || '';
        return {
            mode: 'preview',
            property,
            activeSceneId
        };
    }

    throw new Error('No valid public share token or preview scan ID found in URL.');
}
