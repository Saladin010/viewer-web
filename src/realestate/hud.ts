import { Vec3 } from 'playcanvas';
import type { HotspotDto, PropertyPublicShareDto, SceneItemDto } from './types';

export interface RealEstateHUDCallbacks {
    onSelectRoom: (roomId: string) => void;
    onToggleMode: (targetMode: 'walk' | 'orbit') => void;
    onHotspotClicked: (targetSceneId: string, targetPose?: { position: number[]; lookAt: number[] }) => void;
}

export class RealEstateHUD {
    private container: HTMLElement;
    private property: PropertyPublicShareDto;
    private activeSceneId: string;
    private callbacks: RealEstateHUDCallbacks;
    private rootElement: HTMLElement | null = null;
    private currentMode: 'walk' | 'orbit' = 'walk';
    private hotspotElements: Map<string, HTMLElement> = new Map();
    private cameraEntity: any = null;

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

    public setCameraEntity(camera: any) {
        this.cameraEntity = camera;
    }

    public setActiveScene(sceneId: string) {
        this.activeSceneId = sceneId;
        this.updatePillActiveStates();
        this.renderHotspots();
    }

    public setMode(mode: 'walk' | 'orbit') {
        this.currentMode = mode;
        const toggleBtn = this.rootElement?.querySelector('.re-mode-toggle-btn');
        if (toggleBtn) {
            const isDollhouse = this.property.dollhouseSupported;
            if (isDollhouse) {
                toggleBtn.textContent = mode === 'walk' ? 'منزل ثلاثي الأبعاد 🏠' : 'جولة افتراضية 🚶';
            } else {
                toggleBtn.textContent = mode === 'walk' ? 'مدار الغرفة 🔄' : 'جولة الغرفة 🚶';
            }
        }
    }

    public updateHotspotScreenPositions(camera: any) {
        if (!camera?.camera) return;
        const scene = this.getCurrentSceneItem();
        if (!scene?.hotspots) return;

        const screen = { x: 0, y: 0 };
        for (const hs of scene.hotspots) {
            const el = this.hotspotElements.get(hs.id);
            if (!el) continue;

            const pos = hs.position;
            // PlayCanvas worldToScreen conversion
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

    public showFallbackCard(reason: string) {
        if (!this.rootElement) return;
        let fallback = this.rootElement.querySelector<HTMLElement>('.re-fallback-overlay');
        if (!fallback) {
            fallback = document.createElement('div');
            fallback.className = 're-fallback-overlay';
            this.rootElement.appendChild(fallback);
        }

        const thumb = this.property.thumbnailUrl || '';
        const phone = (this.property.officeContactPhone || '').replace(/[^0-9+]/g, '');
        const waLink = `https://wa.me/${phone}?text=${encodeURIComponent(`السلام عليكم، استفسار بخصوص عقار: ${this.property.title}`)}`;

        fallback.innerHTML = `
            <div class="re-fallback-card" dir="rtl">
                <div class="re-fallback-header">
                    <h3>معاينة العقار (الوضع السريع)</h3>
                    <p class="re-fallback-sub">${reason}</p>
                </div>
                ${thumb ? `<img class="re-fallback-img" src="${thumb}" alt="${this.property.title}" />` : ''}
                <div class="re-fallback-info">
                    <h4>${this.property.title}</h4>
                    <p><strong>المنطقة:</strong> ${this.property.district} - ${this.property.city}</p>
                    <p><strong>السعر:</strong> ${this.property.price > 0 ? this.property.price.toLocaleString() + ' ' + this.property.currency : 'عند التواصل'}</p>
                    <p><strong>المساحة:</strong> ${this.property.areaSqm} م² | <strong>الغرف:</strong> ${this.property.roomsCount} | <strong>الحمامات:</strong> ${this.property.bathroomsCount}</p>
                </div>
                <div class="re-fallback-actions">
                    <a class="re-whatsapp-btn" href="${waLink}" target="_blank" rel="noopener">
                        <span>💬 تواصل مع المكتب عبر واتساب</span>
                    </a>
                </div>
            </div>
        `;
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
                <span class="re-hotspot-label">${hs.label}</span>
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

        const phone = (this.property.officeContactPhone || '').replace(/[^0-9+]/g, '');
        const waText = encodeURIComponent(`السلام عليكم، أرغب بالاستفسار عن العقار: ${this.property.title} (${this.property.district})`);
        const waUrl = `https://wa.me/${phone}?text=${waText}`;

        const isDollhouse = this.property.dollhouseSupported;
        const modeLabel = isDollhouse
            ? (this.currentMode === 'walk' ? 'منزل ثلاثي الأبعاد 🏠' : 'جولة افتراضية 🚶')
            : (this.currentMode === 'walk' ? 'مدار الغرفة 🔄' : 'جولة الغرفة 🚶');

        root.innerHTML = `
            <!-- Top Property Specs Header -->
            <header class="re-top-header">
                <div class="re-header-main">
                    <h1 class="re-prop-title">${this.property.title}</h1>
                    <div class="re-prop-meta">
                        <span class="re-badge re-location">${this.property.district} - ${this.property.city}</span>
                        ${this.property.price > 0 ? `<span class="re-badge re-price">${this.property.price.toLocaleString()} ${this.property.currency}</span>` : ''}
                        ${this.property.areaSqm > 0 ? `<span class="re-badge">${this.property.areaSqm} م²</span>` : ''}
                        ${this.property.roomsCount > 0 ? `<span class="re-badge">${this.property.roomsCount} غرف</span>` : ''}
                        ${this.property.bathroomsCount > 0 ? `<span class="re-badge">${this.property.bathroomsCount} حمام</span>` : ''}
                    </div>
                </div>
                <div class="re-header-actions">
                    <a class="re-whatsapp-btn" href="${waUrl}" target="_blank" rel="noopener noreferrer">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                            <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-5.46-4.45-9.92-9.91-9.92zM12.04 20.14c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31c-.82-1.31-1.26-2.83-1.26-4.38 0-4.54 3.7-8.24 8.24-8.24 4.54 0 8.24 3.7 8.24 8.24s-3.7 8.24-8.24 8.24zm4.52-6.17c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.12-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.43s-.56-1.34-.76-1.84c-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.87.85-.87 2.07s.89 2.4 1.01 2.57c.12.17 1.75 2.67 4.24 3.74.59.26 1.05.41 1.41.53.6.19 1.14.16 1.57.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.11-.22-.17-.46-.3z"/>
                        </svg>
                        <span>تواصل واتساب</span>
                    </a>
                    <button class="re-mode-toggle-btn" type="button">
                        ${modeLabel}
                    </button>
                </div>
            </header>

            <div class="re-hotspots-layer"></div>

            <nav class="re-bottom-pills-bar">
                <div class="re-pills-scroll">
                    ${this.property.scenes.map((s) => `
                        <button class="re-room-pill ${s.sceneId === this.activeSceneId ? 'active' : ''}" 
                                data-room-id="${s.sceneId}" 
                                type="button">
                            ${s.label}
                        </button>
                    `).join('')}
                </div>
            </nav>
        `;

        // Attach event listeners
        const toggleBtn = root.querySelector('.re-mode-toggle-btn');
        toggleBtn?.addEventListener('click', () => {
            const nextMode = this.currentMode === 'walk' ? 'orbit' : 'walk';
            this.setMode(nextMode);
            this.callbacks.onToggleMode(nextMode);
        });

        const pills = root.querySelectorAll('.re-room-pill');
        pills.forEach((p) => {
            p.addEventListener('click', () => {
                const rid = p.getAttribute('data-room-id');
                if (rid && rid !== this.activeSceneId) {
                    this.setActiveScene(rid);
                    this.callbacks.onSelectRoom(rid);
                }
            });
        });

        const mount = this.container.classList.contains('sse-viewer')
            ? this.container
            : (this.container.querySelector('.sse-viewer') || this.container);
        mount.appendChild(root);
        this.rootElement = root;
        this.renderHotspots();
    }

    public destroy() {
        if (this.rootElement && this.rootElement.parentNode) {
            this.rootElement.parentNode.removeChild(this.rootElement);
        }
        this.hotspotElements.clear();
        this.rootElement = null;
    }
}
