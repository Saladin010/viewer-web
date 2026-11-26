import { Vec3 } from 'playcanvas';
import type { PropertyPublicShareDto, SceneItemDto } from './types';

export interface RealEstateHUDCallbacks {
    onSelectRoom: (roomId: string) => void;
    onResetCamera?: () => void;
    onHotspotClicked: (targetSceneId: string, targetPose?: { position: number[]; lookAt: number[] }) => void;
}

const escapeHtml = (value: unknown): string => {
    const str = value == null ? '' : String(value);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

export class RealEstateHUD {
    private container: HTMLElement;
    private property: PropertyPublicShareDto;
    private activeSceneId: string;
    private callbacks: RealEstateHUDCallbacks;
    private rootElement: HTMLElement | null = null;
    private hotspotElements: Map<string, HTMLElement> = new Map();
    private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(
        container: HTMLElement,
        property: PropertyPublicShareDto,
        initialSceneId: string,
        callbacks: RealEstateHUDCallbacks
    ) {
        this.container = container;
        this.property = property;
        this.activeSceneId = initialSceneId;
        this.callbacks = callbacks;
        this.render();
    }

    public setCameraEntity(_camera: any) {
        // Maintained for backwards compatibility with callers
    }

    public setActiveScene(sceneId: string) {
        this.activeSceneId = sceneId;
        this.updatePillActiveStates();
        this.renderHotspots();
    }

    public updateHotspotScreenPositions(camera: any) {
        if (!camera?.camera) return;
        const scene = this.getCurrentSceneItem();
        if (!scene?.hotspots) return;

        for (const hs of scene.hotspots) {
            const el = this.hotspotElements.get(hs.id);
            if (!el) continue;

            const pos = hs.position;
            const worldVec = new Vec3(pos[0], pos[1], pos[2]);
            const screenVec = camera.camera.worldToScreen(worldVec);

            if (screenVec.z > 0) {
                el.style.display = 'flex';
                el.style.left = `${screenVec.x}px`;
                el.style.top = `${screenVec.y}px`;
            } else {
                el.style.display = 'none';
            }
        }
    }

    public toggleDetailsModal(open?: boolean) {
        const modal = this.rootElement?.querySelector<HTMLElement>('.re-details-overlay');
        if (!modal) return;
        const nextOpen = open !== undefined ? open : !modal.classList.contains('is-open');
        modal.classList.toggle('is-open', nextOpen);
        modal.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
    }

    public showFallbackCard(reason: string) {
        if (!this.rootElement) return;
        let fallback = this.rootElement.querySelector<HTMLElement>('.re-fallback-overlay');
        if (!fallback) {
            fallback = document.createElement('div');
            fallback.className = 're-fallback-overlay';
            this.rootElement.appendChild(fallback);
        }

        const thumb = this.property.thumbnailUrl || '';

        fallback.innerHTML = `
            <div class="re-fallback-card" dir="rtl">
                <div class="re-fallback-header">
                    <h3>تعذر عرض المجسم ثلاثي الأبعاد</h3>
                    <p class="re-fallback-sub">${escapeHtml(reason)}</p>
                </div>
                ${thumb ? `<img class="re-fallback-img" src="${escapeHtml(thumb)}" alt="${escapeHtml(this.property.title)}" />` : ''}
                <div class="re-fallback-info">
                    <h4>${escapeHtml(this.property.title)}</h4>
                    <p><strong>المدينة:</strong> ${escapeHtml([this.property.city, this.property.district].filter(Boolean).join(' - ') || '—')}</p>
                    <p><strong>السعر المطلوب:</strong> ${this.property.price > 0 ? `${escapeHtml(this.property.price.toLocaleString())} ${escapeHtml(this.property.currency || '')}` : 'عند التواصل'}</p>
                    <p><strong>المساحة:</strong> ${this.property.areaSqm > 0 ? `${this.property.areaSqm} م²` : '—'} | <strong>الدور:</strong> ${this.formatFloor(this.property.floorNumber)}</p>
                    <p><strong>الغرف:</strong> ${this.property.roomsCount || '—'} | <strong>الحمامات:</strong> ${this.property.bathroomsCount || '—'} | <strong>التشطيب:</strong> ${escapeHtml(this.property.finishingType || '—')}</p>
                </div>
            </div>
        `;
    }

    private formatFloor(floor?: number): string {
        if (floor === null || floor === undefined || Number.isNaN(floor)) return '—';
        if (floor === 0) return 'الأرضي';
        return String(floor);
    }

    private getCurrentSceneItem(): SceneItemDto | undefined {
        return this.property.sceneConfig?.scenes?.find((s) => s.sceneId === this.activeSceneId);
    }

    private updatePillActiveStates() {
        if (!this.rootElement) return;
        const pills = this.rootElement.querySelectorAll('.re-room-pill');
        pills.forEach((p) => {
            const rid = p.getAttribute('data-room-id');
            p.classList.toggle('active', rid === this.activeSceneId);
        });
    }

    private renderHotspots() {
        if (!this.rootElement) return;
        const container = this.rootElement.querySelector<HTMLElement>('.re-hotspots-layer');
        if (!container) return;

        container.innerHTML = '';
        this.hotspotElements.clear();

        const scene = this.getCurrentSceneItem();
        if (!scene?.hotspots || !scene.hotspots.length) return;

        for (const hs of scene.hotspots) {
            const pin = document.createElement('div');
            pin.className = 're-hotspot-pin';
            pin.setAttribute('data-target-scene', hs.targetSceneId);
            pin.innerHTML = `
                <div class="re-hotspot-dot"></div>
                <span class="re-hotspot-label">${escapeHtml(hs.label)}</span>
            `;

            pin.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.onHotspotClicked(hs.targetSceneId, hs.targetPose);
            });

            container.appendChild(pin);
            this.hotspotElements.set(hs.id, pin);
        }
    }

    private render() {
        const root = document.createElement('div');
        root.className = 're-hud-container';
        root.setAttribute('dir', 'rtl');

        const priceText =
            this.property.price > 0
                ? `${this.property.price.toLocaleString()} ${this.property.currency || ''}`.trim()
                : 'عند التواصل';
        const areaText = this.property.areaSqm > 0 ? `${this.property.areaSqm} م²` : '—';
        const cityText = [this.property.city, this.property.district].filter(Boolean).join(' - ') || '—';
        const floorText = this.formatFloor(this.property.floorNumber);
        const roomsText = this.property.roomsCount > 0 ? String(this.property.roomsCount) : '—';
        const bathsText = this.property.bathroomsCount > 0 ? String(this.property.bathroomsCount) : '—';
        const finishingText = this.property.finishingType || '—';

        root.innerHTML = `
            <!-- Minimal Corner Controls (keep 3D model completely unobstructed) -->
            <div class="re-top-bar">
                <button class="re-pill-btn re-details-btn" type="button" aria-label="عرض تفاصيل العقار">
                    <span class="re-btn-icon">ℹ</span>
                    <span>تفاصيل</span>
                </button>
                <button class="re-pill-btn re-reset-btn" type="button" title="إعادة ضبط الكاميرا" aria-label="إعادة ضبط الكاميرا">
                    <span>⌖ إعادة ضبط</span>
                </button>
            </div>

            <!-- Interactive Room Transition Hotspots -->
            <div class="re-hotspots-layer"></div>

            <!-- Compact Bottom Room Switcher -->
            <nav class="re-bottom-pills-bar" aria-label="غرف العقار">
                <div class="re-pills-scroll">
                    ${this.property.scenes
                        .map(
                            (s) => `
                        <button class="re-room-pill ${s.sceneId === this.activeSceneId ? 'active' : ''}"
                                data-room-id="${escapeHtml(s.sceneId)}"
                                type="button">
                            ${escapeHtml(s.label)}
                        </button>
                    `
                        )
                        .join('')}
                </div>
            </nav>

            <!-- Details Drawer / Modal (hidden until user clicks "تفاصيل") -->
            <div class="re-details-overlay" aria-hidden="true">
                <div class="re-details-card" role="dialog" aria-modal="true" aria-label="تفاصيل العقار">
                    <div class="re-details-top">
                        <div>
                            <span class="re-details-eyebrow">${escapeHtml(this.property.listingType || 'تفاصيل العقار')}</span>
                            <h2 class="re-details-title">${escapeHtml(this.property.title)}</h2>
                        </div>
                        <button class="re-back-btn" type="button">
                            <span>← رجوع للمجسم</span>
                        </button>
                    </div>

                    <div class="re-details-grid">
                        <div class="re-detail-item re-detail-highlight">
                            <span class="re-detail-label">السعر المطلوب</span>
                            <strong class="re-detail-val">${escapeHtml(priceText)}</strong>
                        </div>
                        <div class="re-detail-item">
                            <span class="re-detail-label">المساحة</span>
                            <strong class="re-detail-val">${escapeHtml(areaText)}</strong>
                        </div>
                        <div class="re-detail-item">
                            <span class="re-detail-label">المدينة</span>
                            <strong class="re-detail-val">${escapeHtml(cityText)}</strong>
                        </div>
                        <div class="re-detail-item">
                            <span class="re-detail-label">الدور</span>
                            <strong class="re-detail-val">${escapeHtml(floorText)}</strong>
                        </div>
                        <div class="re-detail-item">
                            <span class="re-detail-label">عدد الغرف</span>
                            <strong class="re-detail-val">${escapeHtml(roomsText)}</strong>
                        </div>
                        <div class="re-detail-item">
                            <span class="re-detail-label">عدد الحمامات</span>
                            <strong class="re-detail-val">${escapeHtml(bathsText)}</strong>
                        </div>
                        <div class="re-detail-item re-detail-wide">
                            <span class="re-detail-label">التشطيب</span>
                            <strong class="re-detail-val">${escapeHtml(finishingText)}</strong>
                        </div>
                    </div>

                    ${
                        this.property.publicDescription
                            ? `<div class="re-details-desc">${escapeHtml(this.property.publicDescription)}</div>`
                            : ''
                    }

                    <div class="re-details-footer">
                        <button class="re-back-primary-btn" type="button">رجوع للمجسم ثلاثي الأبعاد</button>
                    </div>
                </div>
            </div>
        `;

        // Details open/close handlers
        const detailsBtn = root.querySelector('.re-details-btn');
        const detailsOverlay = root.querySelector<HTMLElement>('.re-details-overlay');
        const backBtn = root.querySelector('.re-back-btn');
        const backPrimaryBtn = root.querySelector('.re-back-primary-btn');
        const resetBtn = root.querySelector('.re-reset-btn');

        detailsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDetailsModal(true);
        });
        backBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDetailsModal(false);
        });
        backPrimaryBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDetailsModal(false);
        });
        detailsOverlay?.addEventListener('click', (e) => {
            if (e.target === detailsOverlay) {
                this.toggleDetailsModal(false);
            }
        });
        resetBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.callbacks.onResetCamera?.();
        });

        this.keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.toggleDetailsModal(false);
            }
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this.keydownHandler);
        }

        // Room switching pills
        const pills = root.querySelectorAll('.re-room-pill');
        pills.forEach((p) => {
            p.addEventListener('click', (e) => {
                e.stopPropagation();
                const rid = p.getAttribute('data-room-id');
                if (rid && rid !== this.activeSceneId) {
                    this.setActiveScene(rid);
                    this.callbacks.onSelectRoom(rid);
                }
            });
        });

        const mount = this.container.classList.contains('sse-viewer')
            ? this.container
            : this.container.querySelector('.sse-viewer') || this.container;
        mount.appendChild(root);
        this.rootElement = root;
        this.renderHotspots();
    }

    public attachToContainer(container: HTMLElement) {
        if (!this.rootElement) return;
        const mount = container.classList.contains('sse-viewer')
            ? container
            : container.querySelector('.sse-viewer') || container;
        if (this.rootElement.parentElement !== mount) {
            mount.appendChild(this.rootElement);
        }
    }

    public destroy() {
        if (this.keydownHandler && typeof window !== 'undefined') {
            window.removeEventListener('keydown', this.keydownHandler);
            this.keydownHandler = null;
        }
        if (this.rootElement && this.rootElement.parentElement) {
            this.rootElement.parentElement.removeChild(this.rootElement);
            this.rootElement = null;
        }
        this.hotspotElements.clear();
    }
}
