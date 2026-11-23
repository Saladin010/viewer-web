export interface CropBoundsDto {
    min: number[];
    max: number[];
}

export interface CameraPoseDto {
    position: number[];
    lookAt: number[];
}

export interface HotspotDto {
    id: string;
    label: string;
    position: number[];
    targetSceneId: string;
    targetPose?: CameraPoseDto;
}

export interface SceneItemDto {
    sceneId: string;
    label: string;
    scaleFactor?: number;
    floorEulerDeg?: number[];
    cropBounds?: CropBoundsDto;
    defaultSpawnPose?: CameraPoseDto;
    hotspots?: HotspotDto[];
}

export interface SceneConfigurationDto {
    expectedVersion?: number;
    defaultSceneId: string;
    eyeHeightMeters: number;
    scenes: SceneItemDto[];
}

export interface SceneModelDto {
    sceneId: string;
    label: string;
    signedModelUrl: string;
    format: string;
    sizeBytes?: number;
}

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
    scenes: SceneModelDto[];
    thumbnailUrl?: string;
    sceneConfig: SceneConfigurationDto;
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
