import * as THREE from 'three';
import {
  CAMERA_FOLLOW_DAMPING,
  CAMERA_FOV,
  CAMERA_FOV_SPEED_KICK,
  CAMERA_LANE_FOLLOW,
  CAMERA_OFFSET,
  CAMERA_PITCH_DEG,
  CAMERA_REFERENCE_ASPECT,
  CAMERA_SHAKE_AMOUNT,
  CAMERA_SHAKE_TIME,
} from '../core/consts';

export type Shot = 'menu' | 'follow' | 'death';

/** Vertical FOV that holds the reference-aspect horizontal FOV on wide screens. */
export function verticalFov(baseFov: number, aspect: number): number {
  if (aspect <= CAMERA_REFERENCE_ASPECT) return baseFov;
  const halfBase = THREE.MathUtils.degToRad(baseFov) * 0.5;
  const halfHorizontal = Math.atan(Math.tan(halfBase) * CAMERA_REFERENCE_ASPECT);
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfHorizontal) / aspect));
}

// Main.unity's chase camera looks along +Z, pitched down CAMERA_PITCH_DEG.
const PITCH = THREE.MathUtils.degToRad(-CAMERA_PITCH_DEG);
const FOLLOW_LOOK = new THREE.Vector3(0, -Math.sin(PITCH), Math.cos(PITCH)).multiplyScalar(10);
const MENU_FOV = 42;
const DEATH_FOV = 46;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * Interpolate two camera positions as a crane move: an arc in the vertical
 * plane through a pivot at the runner's chest. A straight line from the
 * front showcase to the chase view passes through the character, and a
 * horizontal orbit swings into the alley walls; arcing over the top stays
 * inside the street.
 */
function craneLerp(
  out: THREE.Vector3,
  from: THREE.Vector3,
  to: THREE.Vector3,
  pivot: THREE.Vector3,
  t: number
): THREE.Vector3 {
  const a0 = Math.atan2(from.y - pivot.y, from.z - pivot.z);
  const a1 = Math.atan2(to.y - pivot.y, to.z - pivot.z);
  const r0 = Math.hypot(from.y - pivot.y, from.z - pivot.z);
  const r1 = Math.hypot(to.y - pivot.y, to.z - pivot.z);
  const angle = THREE.MathUtils.lerp(a0, a1, t);
  const radius = THREE.MathUtils.lerp(r0, r1, t);
  return out.set(
    THREE.MathUtils.lerp(from.x, to.x, t),
    pivot.y + Math.sin(angle) * radius,
    pivot.z + Math.cos(angle) * radius
  );
}

/**
 * Drives the one gameplay camera through three shots, all expressed in the
 * runner's local frame so they ride the track's curves:
 * - `menu`: a low three-quarter showcase in front of the idle character,
 *   framed to leave room for the loadout card;
 * - `follow`: Unity's chase camera with lane drift, jump lift, a speed-driven
 *   FOV kick and hit shake;
 * - `death`: swings round to the front to watch the fall.
 * Switching shots blends position, aim and FOV with an ease-in-out.
 */
export class CameraDirector {
  private shot: Shot = 'menu';
  private blend = 1;
  private blendDuration = 1;
  private readonly fromPosition = new THREE.Vector3();
  private readonly fromTarget = new THREE.Vector3();
  private fromFov = MENU_FOV;
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private fov = MENU_FOV;
  private readonly followRig = new THREE.Vector3(...CAMERA_OFFSET);
  private readonly shotPosition = new THREE.Vector3();
  private readonly shotTarget = new THREE.Vector3();
  private readonly worldTarget = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private shakeLeft = 0;
  /** Seconds since the current shot was chosen (drives sway / orbit). */
  private shotTime = 0;
  private landingTime = 0;
  private bank = 0;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly runner: THREE.Object3D,
    /** The character's lane/jump holder, local to `runner`. */
    private readonly holder: THREE.Object3D
  ) {
    runner.add(camera);
    this.computeShot(0);
    this.position.copy(this.shotPosition);
    this.target.copy(this.shotTarget);
    this.apply();
  }

  get current(): Shot {
    return this.shot;
  }

  /** Cut (duration 0, which always restarts the shot) or blend to a new shot. */
  setShot(shot: Shot, duration = 1.2): void {
    if (shot === this.shot && this.blend >= 1 && duration > 0) return;
    this.shot = shot;
    this.fromPosition.copy(this.position);
    this.fromTarget.copy(this.target);
    this.fromFov = this.fov;
    this.blendDuration = duration;
    this.blend = duration > 0 ? 0 : 1;
    if (duration === 0) this.fov = this.shotFov(0);
    this.shotTime = 0;
    this.landingTime = 0;
    this.bank = 0;
    if (shot === 'follow') this.followRig.set(...CAMERA_OFFSET);
  }

  shake(): void {
    if (!this.reducedMotion.matches) this.shakeLeft = CAMERA_SHAKE_TIME;
  }

  land(): void {
    if (!this.reducedMotion.matches) this.landingTime = 0.32;
  }

  update(dt: number, speedRatio: number): void {
    this.shotTime += dt;
    this.landingTime = Math.max(0, this.landingTime - dt);
    this.computeShot(dt);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.blendDuration);
      const t = smoothstep(this.blend);
      this.pivot.set(this.holder.position.x, 1, 0);
      craneLerp(this.position, this.fromPosition, this.shotPosition, this.pivot, t);
      this.target.lerpVectors(this.fromTarget, this.shotTarget, t);
      this.fov = THREE.MathUtils.lerp(this.fromFov, this.shotFov(speedRatio), t);
    } else {
      this.position.copy(this.shotPosition);
      this.target.copy(this.shotTarget);
      // FOV eases even inside a shot so the speed kick never snaps.
      this.fov += (this.shotFov(speedRatio) - this.fov) * Math.min(1, dt * 3);
    }
    this.apply(dt);
  }

  private shotFov(speedRatio: number): number {
    if (this.shot === 'follow') return CAMERA_FOV + CAMERA_FOV_SPEED_KICK * speedRatio;
    return this.shot === 'menu' ? MENU_FOV : DEATH_FOV;
  }

  private computeShot(dt: number): void {
    const holder = this.holder.position;
    switch (this.shot) {
      case 'follow': {
        const follow = 1 - Math.exp(-dt * CAMERA_FOLLOW_DAMPING);
        const bankTarget = this.reducedMotion.matches ? 0 : (holder.x * CAMERA_LANE_FOLLOW - this.followRig.x) * 0.035;
        this.bank += (bankTarget - this.bank) * (1 - Math.exp(-dt * 10));
        this.followRig.x += (holder.x * CAMERA_LANE_FOLLOW - this.followRig.x) * follow;
        this.followRig.y += (CAMERA_OFFSET[1] + holder.y * 0.25 - this.followRig.y) * follow;
        this.shotPosition.copy(this.followRig);
        this.shotTarget.copy(this.followRig).add(FOLLOW_LOOK);
        break;
      }
      case 'menu': {
        // Portrait screens stack the card under the runner, landscape ones put
        // it to the right: aim beside / below the cat accordingly.
        const portrait = this.camera.aspect < 0.8;
        const sway = this.reducedMotion.matches ? 0 : Math.sin(this.shotTime * 0.35) * 0.35;
        if (portrait) {
          this.shotPosition.set(holder.x + 1.1 + sway, 1.4, 7.2);
          this.shotTarget.set(holder.x, -0.65, 0);
        } else {
          this.shotPosition.set(holder.x + 1.5 + sway, 1.3, 3.9);
          this.shotTarget.set(holder.x + 1.05, 0.85, 0);
        }
        break;
      }
      case 'death': {
        // Slow drift round the fallen runner; like the menu, landscape frames
        // leave the right-hand side free for the results card.
        const portrait = this.camera.aspect < 0.8;
        const drift = this.reducedMotion.matches ? 0 : Math.min(this.shotTime * 0.12, 0.35);
        this.shotPosition.set(holder.x + 1.4 + drift, 1.7, 3.8);
        this.shotTarget.set(holder.x + (portrait ? 0 : 1.2), portrait ? -0.4 : 0.35, 0);
        break;
      }
    }
  }

  private apply(dt = 0): void {
    const camera = this.camera;
    camera.position.copy(this.position);
    if (this.shot === 'follow' && this.landingTime > 0) {
      camera.position.y -= Math.sin((1 - this.landingTime / 0.32) * Math.PI) * 0.085;
    }
    if (this.shakeLeft > 0) {
      this.shakeLeft = Math.max(0, this.shakeLeft - dt);
      const amount = CAMERA_SHAKE_AMOUNT * (this.shakeLeft / CAMERA_SHAKE_TIME);
      camera.position.x += (Math.random() - 0.5) * amount;
      camera.position.y += (Math.random() - 0.5) * amount;
    }
    this.runner.updateMatrixWorld();
    camera.lookAt(this.runner.localToWorld(this.worldTarget.copy(this.target)));
    if (this.shot === 'follow') camera.rotateZ(this.bank);

    const fov = verticalFov(this.fov, camera.aspect);
    if (Math.abs(camera.fov - fov) > 0.001) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
