export interface CropBoundsDto {
    min: number[];
    max: number[];
}

export interface RoomTransformDto {
    position: [number, number, number];
    rotationEulerDeg: [number, number, number];
    scale: number;
}

export interface CameraPoseDto {
    position: number[];
    lookAt: number[];
    target?: number[];
    fov?: number;
}

export interface HotspotDto {
    id: string;
    label: string;
    position: number[];
    targetSceneId: string;
    targetInstanceId?: string;
    targetPose?: CameraPoseDto;
}

export interface SceneItemDto {
    sceneId: string;
    instanceId?: string;
    sourceScanId?: string;
    label: string;
    displayLabel?: string;
    scaleFactor?: number;
    floorEulerDeg?: number[];
    transform?: RoomTransformDto;
    cropBounds?: CropBoundsDto;
    defaultSpawnPose?: CameraPoseDto;
    spawnPose?: CameraPoseDto;
    hotspots?: HotspotDto[];
    visible?: boolean;
}

export interface SceneConfigurationDto {
    expectedVersion?: number;
    defaultSceneId: string;
    eyeHeightMeters: number;
    scenes: SceneItemDto[];
}

export interface SceneModelDto {
    sceneId: string;
    instanceId?: string;
    sourceScanId?: string;
    roomId?: string;
    label: string;
    displayLabel?: string;
    signedModelUrl: string;
    format: string;
    sizeBytes?: number;
    gaussianCount?: number;
    transform?: RoomTransformDto;
    cropBounds?: CropBoundsDto;
    spawnPose?: CameraPoseDto;
    hotspots?: HotspotDto[];
    visible?: boolean;
}

export type AssemblyMode = 'MultiRoom' | 'SingleScan';

export interface PropertyPublicShareDto {
    scanId?: string;
    propertyId: string;
    title: string;
    district: string;
    city: string;
    listingType: string;
    price: number;
    currency: string;
    areaSqm: number;
    floorNumber: number;
    roomsCount: number;
    bathroomsCount: number;
    finishingType: string;
    publicDescription?: string;
    officeContactName: string;
    officeContactPhone: string;
    captureMode: 'Walkthrough' | 'RoomByRoom';
    dollhouseSupported: boolean;
    assemblyMode?: AssemblyMode;
    defaultInstanceId?: string | null;
    eyeHeightMeters?: number | null;
    scenes: SceneModelDto[];
    thumbnailUrl?: string;
    sceneConfig: SceneConfigurationDto;
    scenesByKey?: Map<string, SceneModelDto>;
    sceneItemsByKey?: Map<string, SceneItemDto>;
}

export interface ScanPreviewDto {
    scanId: string;
    propertyId: string;
    propertyTitle: string;
    district: string;
    city: string;
    captureMode: 'Walkthrough' | 'RoomByRoom';
    dollhouseSupported: boolean;
    scenes: SceneModelDto[];
    sceneConfig: SceneConfigurationDto;
    thumbnailUrl?: string;
    officeContactName: string;
    officeContactPhone: string;
}

export interface RealEstateBootstrapResult {
    mode: 'public' | 'preview';
    property: PropertyPublicShareDto;
    activeSceneId: string;
}
