import type { PropertyPublicShareDto, RealEstateBootstrapResult, ScanPreviewDto } from './types';

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

    return 'https://api.realestate3d.local';
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

    const data = (await response.json()) as PropertyPublicShareDto;

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

    const preview = (await response.json()) as ScanPreviewDto;

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
        roomsCount: preview.scenes.length,
        bathroomsCount: 1,
        finishingType: 'جاهز للمعاينة',
        publicDescription: 'معاينة داخلية قبل النشر',
        officeContactName: preview.officeContactName || 'المكتب الرئيسي',
        officeContactPhone: preview.officeContactPhone || '+201000000000',
        captureMode: preview.captureMode || 'RoomByRoom',
        dollhouseSupported: preview.dollhouseSupported ?? false,
        scenes: preview.scenes || [],
        thumbnailUrl: preview.thumbnailUrl,
        sceneConfig: preview.sceneConfig
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
