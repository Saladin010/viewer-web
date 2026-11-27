import type {
    AssemblyMode,
    CameraPoseDto,
    CropBoundsDto,
    HotspotDto,
    PropertyPublicShareDto,
    RealEstateBootstrapResult,
    RoomTransformDto,
    SceneConfigurationDto,
    SceneItemDto,
    SceneModelDto
} from './types';

type RawJson = Record<string, unknown>;

const asRecord = (val: unknown): RawJson | null =>
    val && typeof val === 'object' && !Array.isArray(val) ? (val as RawJson) : null;

const asString = (val: unknown): string => (typeof val === 'string' ? val : '');

function inferModelFormat(url: string): string {
    const clean = (url || '').split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith('.glb')) return 'glb';
    if (clean.endsWith('.ply')) return 'ply';
    return 'sog';
}

export function normalizeCropBounds(rawBounds: unknown): CropBoundsDto | undefined {
    if (!rawBounds) return undefined;
    if (Array.isArray(rawBounds) && rawBounds.length === 6 && rawBounds.every((n) => Number.isFinite(Number(n)))) {
        const nums = rawBounds.map(Number);
        return {
            min: [nums[0], nums[2], nums[4]],
            max: [nums[1], nums[3], nums[5]]
        };
    }
    const obj = asRecord(rawBounds);
    if (obj && Array.isArray(obj.min) && Array.isArray(obj.max) && obj.min.length >= 3 && obj.max.length >= 3) {
        return {
            min: obj.min.slice(0, 3).map(Number),
            max: obj.max.slice(0, 3).map(Number)
        };
    }
    return undefined;
}

export function normalizeCameraPose(rawPose: unknown): CameraPoseDto | undefined {
    const obj = asRecord(rawPose);
    if (!obj || !Array.isArray(obj.position) || obj.position.length < 3) {
        return undefined;
    }
    const targetArr =
        Array.isArray(obj.lookAt) && obj.lookAt.length >= 3
            ? obj.lookAt
            : Array.isArray(obj.target) && obj.target.length >= 3
              ? obj.target
              : null;
    if (!targetArr) return undefined;

    const position = obj.position.slice(0, 3).map(Number);
    const lookAt = targetArr.slice(0, 3).map(Number);
    const result: CameraPoseDto = {
        position,
        lookAt
    };
    if (typeof obj.fov === 'number' && Number.isFinite(obj.fov)) {
        result.fov = obj.fov;
    }
    return result;
}

export function normalizeRoomTransform(rawTransform: unknown): RoomTransformDto | undefined {
    const obj = asRecord(rawTransform);
    if (!obj) return undefined;
    const pos =
        Array.isArray(obj.position) && obj.position.length >= 3
            ? obj.position.slice(0, 3).map((n) => Number(n) || 0)
            : [0, 0, 0];
    const rot =
        Array.isArray(obj.rotationEulerDeg) && obj.rotationEulerDeg.length >= 3
            ? obj.rotationEulerDeg.slice(0, 3).map((n) => Number(n) || 0)
            : [0, 0, 0];
    const rawScale = Array.isArray(obj.scale) ? Number(obj.scale[0]) : Number(obj.scale);
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

    return {
        position: [pos[0], pos[1], pos[2]],
        rotationEulerDeg: [rot[0], rot[1], rot[2]],
        scale
    };
}

function normalizeHotspotEntry(rawHs: unknown): HotspotDto {
    const hs = asRecord(rawHs) ?? {};
    const targetInstanceId = asString(hs.targetInstanceId);
    const targetKey = targetInstanceId || asString(hs.targetSceneId) || asString(hs.targetRoomId);
    const targetPose = normalizeCameraPose(hs.targetPose);
    return {
        id: asString(hs.id) || `hs_${Math.random().toString(36).slice(2, 8)}`,
        label: asString(hs.label) || asString(hs.title) || 'انتقال',
        position: Array.isArray(hs.position) ? hs.position.slice(0, 3).map(Number) : [0, 1.5, 0],
        targetSceneId: targetKey,
        ...(targetInstanceId ? { targetInstanceId } : {}),
        ...(targetPose ? { targetPose } : {})
    };
}

export function normalizeRoomsToScenes(rawRooms: unknown[]): SceneModelDto[] {
    if (!Array.isArray(rawRooms)) return [];
    return rawRooms
        .map((r) => asRecord(r))
        .filter((r): r is RawJson => Boolean(r && (r.signedModelUrl || r.modelUrl) && r.visible !== false))
        .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
        .map((r) => {
            const url = asString(r.signedModelUrl) || asString(r.modelUrl);
            const instanceId = asString(r.instanceId);
            const roomId = asString(r.roomId);
            const key = instanceId || asString(r.sceneId) || roomId;
            const rawDisplayLabel = asString(r.displayLabel);
            const displayLabel = rawDisplayLabel || asString(r.label) || asString(r.roomLabel) || roomId || 'غرفة';
            const transform = normalizeRoomTransform(r.transform);
            const cropBounds = normalizeCropBounds(r.cropBounds);
            const spawnPose = normalizeCameraPose(r.spawnPose ?? r.defaultSpawnPose);
            const hotspots = Array.isArray(r.hotspots) ? r.hotspots.map(normalizeHotspotEntry) : undefined;
            const sourceScanId = asString(r.sourceScanId);
            const sizeBytes = r.sizeBytes ?? r.outputSizeBytes;

            return {
                sceneId: key,
                ...(instanceId ? { instanceId } : {}),
                ...(sourceScanId ? { sourceScanId } : {}),
                ...(roomId ? { roomId } : {}),
                label: displayLabel,
                ...(rawDisplayLabel ? { displayLabel: rawDisplayLabel } : {}),
                signedModelUrl: url,
                format: asString(r.format) || inferModelFormat(url),
                sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : undefined,
                ...(typeof r.gaussianCount === 'number' ? { gaussianCount: r.gaussianCount } : {}),
                ...(transform ? { transform } : {}),
                ...(cropBounds ? { cropBounds } : {}),
                ...(spawnPose ? { spawnPose } : {}),
                ...(hotspots ? { hotspots } : {}),
                ...(r.visible !== undefined ? { visible: Boolean(r.visible) } : {})
            };
        });
}

export function normalizeSceneConfig(
    rawConfigInput: unknown,
    fallbackScenes: SceneModelDto[],
    defaultInstanceId?: string | null,
    eyeHeightMeters?: number | null
): SceneConfigurationDto {
    const rawConfig = asRecord(rawConfigInput);
    const fallbackByKey = new Map<string, SceneModelDto>();
    for (const s of fallbackScenes) {
        fallbackByKey.set(s.instanceId || s.sceneId, s);
    }

    const rawItems = Array.isArray(rawConfig?.scenes) ? rawConfig.scenes : [];
    let scenes: SceneItemDto[];

    if (rawItems.length > 0) {
        scenes = rawItems.map((rawItem) => {
            const item = asRecord(rawItem) ?? {};
            const sceneId = asString(item.instanceId) || asString(item.sceneId) || asString(item.roomId);
            const modelFallback = fallbackByKey.get(sceneId);
            const rawDisplayLabel = asString(item.displayLabel);
            const label =
                rawDisplayLabel || asString(item.label) || asString(item.roomLabel) || modelFallback?.label || sceneId;

            let defaultSpawnPose: CameraPoseDto | undefined =
                normalizeCameraPose(item.spawnPose ?? item.defaultSpawnPose) ?? modelFallback?.spawnPose;
            if (!defaultSpawnPose && Array.isArray(item.cameraPosition) && item.cameraPosition.length >= 3) {
                defaultSpawnPose = {
                    position: item.cameraPosition.slice(0, 3).map(Number),
                    lookAt:
                        Array.isArray(item.cameraTarget) && item.cameraTarget.length >= 3
                            ? item.cameraTarget.slice(0, 3).map(Number)
                            : [0, Number(item.cameraPosition[1]) || 1.6, 0]
                };
            }

            let cropBounds: CropBoundsDto | undefined = normalizeCropBounds(item.cropBounds) ?? modelFallback?.cropBounds;
            let floorEulerDeg: number[] | undefined = Array.isArray(item.floorEulerDeg)
                ? item.floorEulerDeg.map(Number)
                : undefined;
            let hotspots: HotspotDto[] = modelFallback?.hotspots ? [...modelFallback.hotspots] : [];

            if (Array.isArray(item.hotspots)) {
                hotspots = item.hotspots.map(normalizeHotspotEntry);
            } else {
                const hsObj = asRecord(item.hotspots);
                if (hsObj) {
                    if (!cropBounds && Array.isArray(hsObj.cropBounds) && hsObj.cropBounds.length === 6) {
                        cropBounds = normalizeCropBounds(hsObj.cropBounds);
                    }
                    if (!floorEulerDeg && typeof hsObj.floorTiltDegrees === 'number' && hsObj.floorTiltDegrees !== 0) {
                        floorEulerDeg = [hsObj.floorTiltDegrees, 0, 0];
                    }
                    if (Array.isArray(hsObj.links)) {
                        hotspots = hsObj.links.map(normalizeHotspotEntry);
                    }
                }
            }

            const transform = normalizeRoomTransform(item.transform) ?? modelFallback?.transform;
            const itemInstanceId = asString(item.instanceId) || modelFallback?.instanceId;
            const itemSourceScanId = asString(item.sourceScanId) || modelFallback?.sourceScanId;
            const itemDisplayLabel = rawDisplayLabel || modelFallback?.displayLabel;

            return {
                sceneId,
                ...(itemInstanceId ? { instanceId: itemInstanceId } : {}),
                ...(itemSourceScanId ? { sourceScanId: itemSourceScanId } : {}),
                label,
                ...(itemDisplayLabel ? { displayLabel: itemDisplayLabel } : {}),
                scaleFactor: typeof item.scaleFactor === 'number' ? item.scaleFactor : undefined,
                floorEulerDeg,
                ...(transform ? { transform } : {}),
                cropBounds,
                defaultSpawnPose,
                ...(defaultSpawnPose ? { spawnPose: defaultSpawnPose } : {}),
                hotspots
            };
        });
    } else {
        // Synthesize SceneItemDto list from MultiRoom PublicRoomDto / AssembledRoomDto
        scenes = fallbackScenes.map((model) => ({
            sceneId: model.instanceId || model.sceneId,
            ...(model.instanceId ? { instanceId: model.instanceId } : {}),
            ...(model.sourceScanId ? { sourceScanId: model.sourceScanId } : {}),
            label: model.displayLabel || model.label,
            ...(model.displayLabel ? { displayLabel: model.displayLabel } : {}),
            ...(model.transform ? { transform: model.transform } : {}),
            ...(model.cropBounds ? { cropBounds: model.cropBounds } : {}),
            ...(model.spawnPose ? { defaultSpawnPose: model.spawnPose, spawnPose: model.spawnPose } : {}),
            hotspots: model.hotspots ?? []
        }));
    }

    const expectedVersion = rawConfig?.expectedVersion ?? rawConfig?.version;
    const rawEyeHeight = eyeHeightMeters ?? rawConfig?.eyeHeightMeters;

    return {
        expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
        defaultSceneId:
            defaultInstanceId ||
            asString(rawConfig?.defaultInstanceId) ||
            asString(rawConfig?.defaultSceneId) ||
            fallbackScenes[0]?.instanceId ||
            fallbackScenes[0]?.sceneId ||
            '',
        eyeHeightMeters: typeof rawEyeHeight === 'number' ? rawEyeHeight : 1.6,
        scenes
    };
}

export function buildPropertyIndexMaps(property: PropertyPublicShareDto): {
    scenesByKey: Map<string, SceneModelDto>;
    sceneItemsByKey: Map<string, SceneItemDto>;
} {
    const scenesByKey = new Map<string, SceneModelDto>();
    for (const model of property.scenes || []) {
        const key = model.instanceId || model.sceneId;
        if (key) scenesByKey.set(key, model);
        if (model.sceneId && model.sceneId !== key && !scenesByKey.has(model.sceneId)) {
            scenesByKey.set(model.sceneId, model);
        }
    }

    const sceneItemsByKey = new Map<string, SceneItemDto>();
    for (const item of property.sceneConfig?.scenes || []) {
        const key = item.instanceId || item.sceneId;
        if (key) sceneItemsByKey.set(key, item);
        if (item.sceneId && item.sceneId !== key && !sceneItemsByKey.has(item.sceneId)) {
            sceneItemsByKey.set(item.sceneId, item);
        }
    }

    return { scenesByKey, sceneItemsByKey };
}

function resolveAssemblyMode(rawMode: unknown, scenes: SceneModelDto[]): AssemblyMode {
    if (rawMode === 'MultiRoom' || rawMode === 'SingleScan') {
        return rawMode;
    }
    return scenes.some((s) => Boolean(s.instanceId || s.transform)) ? 'MultiRoom' : 'SingleScan';
}

export function normalizePropertyPayload(rawInput: unknown): PropertyPublicShareDto {
    const raw = asRecord(rawInput) ?? {};
    const rawScenes = Array.isArray(raw.scenes) && raw.scenes.length > 0
        ? raw.scenes
        : Array.isArray(raw.rooms)
          ? raw.rooms
          : [];
    const scenes = normalizeRoomsToScenes(rawScenes);

    const defaultInstanceId = typeof raw.defaultInstanceId === 'string' ? raw.defaultInstanceId : null;
    const eyeHeightMeters = typeof raw.eyeHeightMeters === 'number' ? raw.eyeHeightMeters : null;

    const sceneConfig = normalizeSceneConfig(raw.sceneConfig, scenes, defaultInstanceId, eyeHeightMeters);
    const assemblyMode = resolveAssemblyMode(raw.assemblyMode, scenes);

    const data: PropertyPublicShareDto = {
        ...(raw as unknown as PropertyPublicShareDto),
        assemblyMode,
        defaultInstanceId: defaultInstanceId ?? sceneConfig.defaultSceneId ?? null,
        eyeHeightMeters: eyeHeightMeters ?? sceneConfig.eyeHeightMeters ?? 1.6,
        scenes,
        sceneConfig
    };

    const { scenesByKey, sceneItemsByKey } = buildPropertyIndexMaps(data);
    data.scenesByKey = scenesByKey;
    data.sceneItemsByKey = sceneItemsByKey;

    return data;
}

export function resolveApiBaseUrl(url: URL): string {
    const fromQuery = url.searchParams.get('apiBaseUrl') || url.searchParams.get('api');
    if (fromQuery) {
        return fromQuery.replace(/\/+$/, '');
    }

    const win = typeof window !== 'undefined' ? (window as unknown as { REALESTATE3D_API_BASE?: string }) : null;
    if (win?.REALESTATE3D_API_BASE) {
        return win.REALESTATE3D_API_BASE.replace(/\/+$/, '');
    }

    if (typeof window !== 'undefined' && window.location) {
        return window.location.origin;
    }

    return 'https://orcaz.runasp.net';
}

export function extractShareToken(url: URL): string | null {
    const pathMatch = url.pathname.match(/\/(?:v|share)\/([a-zA-Z0-9_-]+)/);
    if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
    }

    return url.searchParams.get('token') || url.searchParams.get('shareToken') || null;
}

export function extractPreviewScanId(url: URL): string | null {
    return url.searchParams.get('previewScanId') || url.searchParams.get('scanId') || null;
}

export function extractPreviewPropertyId(url: URL): string | null {
    return url.searchParams.get('previewPropertyId') || url.searchParams.get('propertyId') || null;
}

export async function getPreviewJwtToken(url: URL): Promise<string | null> {
    const flutterBridge =
        typeof window !== 'undefined'
            ? (window as unknown as { FlutterBridge?: { getJwtToken?: () => Promise<string | null> } }).FlutterBridge
            : undefined;
    if (flutterBridge?.getJwtToken) {
        try {
            const token = await flutterBridge.getJwtToken();
            if (token) return token;
        } catch (e) {
            console.warn('[RealEstate3D] FlutterBridge.getJwtToken() failed:', e);
        }
    }

    const fromQuery = url.searchParams.get('jwt') || url.searchParams.get('auth');
    if (fromQuery) return fromQuery;

    if (typeof window !== 'undefined' && window.localStorage) {
        const stored = localStorage.getItem('jwt') || localStorage.getItem('access_token');
        if (stored) return stored;
    }

    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        const tokenFromMessage = await new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 500);
            const listener = (event: MessageEvent) => {
                const payload = asRecord(event.data);
                if (payload && payload.type === 'REALESTATE3D_AUTH_TOKEN') {
                    clearTimeout(timer);
                    window.removeEventListener('message', listener);
                    resolve(asString(payload.token) || null);
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

    const raw = (await response.json()) as unknown;
    const data = normalizePropertyPayload(raw);

    const beaconUrl = `${apiBaseUrl}/api/v1/public/share/${token}/view`;
    try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            navigator.sendBeacon(beaconUrl);
        } else {
            fetch(beaconUrl, { method: 'POST', keepalive: true }).catch((): void => undefined);
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

    const preview = asRecord(await response.json()) ?? {};
    const rawScenes =
        Array.isArray(preview.scenes) && preview.scenes.length > 0
            ? preview.scenes
            : Array.isArray(preview.rooms)
              ? preview.rooms
              : [];
    const scenes = normalizeRoomsToScenes(rawScenes);
    const sceneConfig = normalizeSceneConfig(preview.sceneConfig, scenes);
    const assemblyMode = resolveAssemblyMode(preview.assemblyMode, scenes);

    const adapted: PropertyPublicShareDto = {
        scanId: asString(preview.scanId),
        propertyId: asString(preview.propertyId),
        title: asString(preview.propertyTitle) || 'معاينة العقار',
        district: asString(preview.district),
        city: asString(preview.city),
        listingType: 'Sale',
        price: 0,
        currency: 'EGP',
        areaSqm: 0,
        floorNumber: 0,
        roomsCount: scenes.length,
        bathroomsCount: 1,
        finishingType: 'جاهز للمعاينة',
        publicDescription: 'معاينة داخلية قبل النشر',
        officeContactName: asString(preview.officeContactName) || 'المكتب الرئيسي',
        officeContactPhone: asString(preview.officeContactPhone) || '+201000000000',
        captureMode: preview.captureMode === 'Walkthrough' ? 'Walkthrough' : 'RoomByRoom',
        dollhouseSupported: Boolean(preview.dollhouseSupported),
        assemblyMode,
        scenes,
        thumbnailUrl: typeof preview.thumbnailUrl === 'string' ? preview.thumbnailUrl : undefined,
        sceneConfig
    };

    const { scenesByKey, sceneItemsByKey } = buildPropertyIndexMaps(adapted);
    adapted.scenesByKey = scenesByKey;
    adapted.sceneItemsByKey = sceneItemsByKey;

    return adapted;
}

export async function fetchPropertyAssemblyPreview(
    propertyId: string,
    apiBaseUrl: string,
    jwtToken: string | null
): Promise<PropertyPublicShareDto> {
    const assemblyUrl = `${apiBaseUrl}/api/v1/properties/${propertyId}/assembly`;
    const headers: Record<string, string> = {
        Accept: 'application/json'
    };
    if (jwtToken) {
        headers.Authorization = `Bearer ${jwtToken}`;
    }

    const response = await fetch(assemblyUrl, { headers });

    if (!response.ok) {
        throw new Error(`Failed to load property assembly (HTTP ${response.status}): ${response.statusText}`);
    }

    const studio = asRecord(await response.json()) ?? {};
    const assembly = asRecord(studio.assembly) ?? {};
    const rawRooms = Array.isArray(assembly.rooms) ? assembly.rooms : [];
    const scenes = normalizeRoomsToScenes(rawRooms);
    const defaultInstanceId = typeof assembly.defaultInstanceId === 'string' ? assembly.defaultInstanceId : null;
    const eyeHeightMeters = typeof assembly.eyeHeightMeters === 'number' ? assembly.eyeHeightMeters : null;
    const sceneConfig = normalizeSceneConfig(
        {
            version: assembly.version,
            defaultInstanceId,
            eyeHeightMeters,
            scenes: []
        },
        scenes,
        defaultInstanceId,
        eyeHeightMeters
    );

    const adapted: PropertyPublicShareDto = {
        propertyId: asString(studio.propertyId) || propertyId,
        title: asString(studio.propertyTitle) || 'معاينة تجميع الشقة',
        district: asString(studio.district),
        city: asString(studio.city),
        listingType: 'Sale',
        price: 0,
        currency: 'EGP',
        areaSqm: 0,
        floorNumber: 0,
        roomsCount: scenes.length,
        bathroomsCount: 1,
        finishingType: 'معاينة التجميع',
        publicDescription: 'معاينة الشقة المجمعة قبل النشر',
        officeContactName: 'المكتب الرئيسي',
        officeContactPhone: '',
        captureMode: 'RoomByRoom',
        dollhouseSupported: true,
        assemblyMode: 'MultiRoom',
        defaultInstanceId: defaultInstanceId ?? sceneConfig.defaultSceneId ?? null,
        eyeHeightMeters: eyeHeightMeters ?? sceneConfig.eyeHeightMeters ?? 1.6,
        scenes,
        sceneConfig
    };

    const { scenesByKey, sceneItemsByKey } = buildPropertyIndexMaps(adapted);
    adapted.scenesByKey = scenesByKey;
    adapted.sceneItemsByKey = sceneItemsByKey;

    return adapted;
}

export async function loadRealEstateBootstrap(rawUrl?: string | URL): Promise<RealEstateBootstrapResult> {
    const url =
        rawUrl instanceof URL
            ? rawUrl
            : new URL(rawUrl || (typeof window !== 'undefined' ? window.location.href : 'http://localhost'));
    const apiBaseUrl = resolveApiBaseUrl(url);

    // 1. Public Share Mode
    const shareToken = extractShareToken(url);
    if (shareToken) {
        console.log(`[RealEstate3D] Bootstrapping in Public Mode for token: ${shareToken}`);
        const property = await fetchPublicShare(shareToken, apiBaseUrl);
        const activeSceneId =
            property.defaultInstanceId ||
            property.sceneConfig?.defaultSceneId ||
            property.scenes[0]?.instanceId ||
            property.scenes[0]?.sceneId ||
            '';
        return {
            mode: 'public',
            property,
            activeSceneId
        };
    }

    // 2. Authenticated Property Assembly Preview Mode
    const previewPropertyId = extractPreviewPropertyId(url);
    if (previewPropertyId) {
        console.log(`[RealEstate3D] Bootstrapping in Property Assembly Preview Mode for: ${previewPropertyId}`);
        const jwt = await getPreviewJwtToken(url);
        const property = await fetchPropertyAssemblyPreview(previewPropertyId, apiBaseUrl, jwt);
        const activeSceneId =
            property.defaultInstanceId ||
            property.sceneConfig?.defaultSceneId ||
            property.scenes[0]?.instanceId ||
            property.scenes[0]?.sceneId ||
            '';
        return {
            mode: 'preview',
            property,
            activeSceneId
        };
    }

    // 3. Authenticated Single-Scan Preview Mode
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

    throw new Error('No valid public share token, previewPropertyId, or previewScanId found in URL.');
}
