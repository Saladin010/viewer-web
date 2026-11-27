import { MultiTouchSource, Vec3 } from 'playcanvas';

import type { Global } from '../../types';
import { DISPLACEMENT_SCALE, TAP_EPSILON, screenToWorld } from '../shared';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';

const tmpV = new Vec3();
const orbitMove = new Vec3();
const pinchMoveTmp = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();

class TouchDevice implements InputDevice {
    orbitSpeed = 18;

    pinchSpeed = 0.9;

    touchRotateSensitivity = 0.7;

    private _source = new MultiTouchSource();

    private _global: Global | null = null;

    private _canvas: HTMLCanvasElement | null = null;

    /** Touches currently active (running count from .read() deltas). */
    private _touchCount = 0;

    /** Tap-detection state — touch count, max touches, and accumulated movement. */
    private _tapTouches = 0;

    private _tapMaxTouches = 0;

    private _tapDelta = 0;

    /** True for one frame after a tap is detected during gaming controls. */
    private _tapJump = false;

    private _resetTouchState = () => {
        this._touchCount = 0;
        this._tapTouches = 0;
        this._tapMaxTouches = 0;
        this._tapDelta = 0;
        this._tapJump = false;
    };

    private _onTouchEnd = (event: TouchEvent) => {
        if (event.touches && event.touches.length === 0) {
            this._touchCount = 0;
            this._tapTouches = 0;
        }
    };

    get touchCount(): number {
        return this._touchCount;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._canvas = canvas;
        this._source.attach(canvas);
        canvas.addEventListener('touchcancel', this._resetTouchState);
        canvas.addEventListener('touchend', this._onTouchEnd);
        window.addEventListener('blur', this._resetTouchState);
    }

    detach(): void {
        window.removeEventListener('blur', this._resetTouchState);
        if (this._canvas) {
            this._canvas.removeEventListener('touchcancel', this._resetTouchState);
            this._canvas.removeEventListener('touchend', this._onTouchEnd);
            this._canvas = null;
        }
        this._source.detach();
        this._global = null;
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { touch, pinch, count } = this._source.read();
        const { isFly, isWalk, isFirstPerson, isOrbit, gamingControls, distance, cameraComponent } = ctx;

        // running touch count
        this._touchCount = Math.max(0, this._touchCount + count[0]);

        // tap detection for click/tap target and focus modes
        if (isWalk || isFly || isOrbit) {
            const prevTaps = this._tapTouches;
            this._tapTouches = Math.max(0, this._tapTouches + count[0]);

            if (prevTaps === 0 && this._tapTouches > 0) {
                this._tapDelta = 0;
            }
            if (this._tapTouches > 0) {
                this._tapMaxTouches = Math.max(this._tapMaxTouches, this._tapTouches);
            }

            if (this._tapTouches > 0) {
                const prevDelta = this._tapDelta;
                this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]) + Math.abs(pinch[0]);
                if (prevDelta < TAP_EPSILON && this._tapDelta >= TAP_EPSILON) {
                    if ((isWalk && !gamingControls) || isFly) {
                        this._global!.events.fire('navigateCancel');
                    }
                }
            }

            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON && this._tapMaxTouches === 1) {
                    if (isWalk && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else if (isWalk) {
                        this._tapJump = true;
                    } else if (isFly && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else if (isOrbit) {
                        // Walk-interaction listens for this and sets orbit focus
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    }
                }
                this._tapMaxTouches = 0;
            }
        } else {
            this._tapTouches = 0;
            this._tapMaxTouches = 0;
        }

        const orbit = isOrbit ? 1 : 0;
        const fly = isFirstPerson ? 1 : 0;
        const double = this._touchCount > 1 ? 1 : 0;
        const fingerReleasedToSingle = count[0] < 0 && this._touchCount === 1 ? 0 : 1;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const dragInvert = isFirstPerson && !gamingControls ? -1 : 1;
        // First-person modes (fly and walk) opt into the direct two-finger
        // model only outside gaming controls (gaming uses the joystick).
        const directFirstPerson = fly * (gamingControls ? 0 : 1);

        const { deltas } = frame;

        // move
        const v = tmpV.set(0, 0, 0);
        // Two-finger pan: orbit pans the target; fly strafes/rises in the
        // camera basis; walk strafes along the ground plane. Keep pan responsive
        // even when zoomed all the way inside a room (distance = 0.01m).
        screenToWorld(cameraComponent, touch[0], touch[1], Math.max(1.5, distance), orbitMove);
        if (isWalk) {
            orbitMove.y = 0;
        }
        v.add(orbitMove.mulScalar((orbit + directFirstPerson) * double));
        // Two-finger pinch z: orbit interprets +z as "farther from target"
        // (close-pinch = +pinch[0] = zoom out). First-person modes interpret
        // +z as "forward", so spreading (pinch[0] < 0) should move forward —
        // flip the sign there.
        pinchMoveTmp.set(0, 0, (orbit - directFirstPerson) * pinch[0]);
        v.add(pinchMoveTmp.mulScalar(double * this.pinchSpeed * DISPLACEMENT_SCALE));
        // tap-to-jump in walk + gaming controls
        if (isWalk && this._tapJump) {
            v.y = 1;
            this._tapJump = false;
        }
        deltas.move.append([v.x, v.y, v.z]);

        // rotate
        v.set(0, 0, 0);
        // single-touch orbit rotate (masked when 2+ touches or on 2->1 finger release transition)
        orbitRotate.set(touch[0], touch[1], 0);
        v.add(
            orbitRotate.mulScalar(
                orbit * (1 - double) * fingerReleasedToSingle * this.orbitSpeed * this.touchRotateSensitivity * DISPLACEMENT_SCALE
            )
        );
        // single-touch fly look (inverted in non-gaming first-person)
        flyRotate.set(touch[0] * dragInvert, touch[1] * dragInvert, 0);
        v.add(
            flyRotate.mulScalar(
                fly *
                    (1 - double) *
                    fingerReleasedToSingle *
                    this.orbitSpeed *
                    orbitFactor *
                    this.touchRotateSensitivity *
                    DISPLACEMENT_SCALE
            )
        );
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

export { TouchDevice };
