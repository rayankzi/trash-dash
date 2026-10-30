import * as THREE from 'three';
import { Character } from './Character';
import { TrackManager } from '../track/TrackManager';
import type { HorizontalDirection } from '../input/WristGesture';
import {
  LANE_OFFSET,
  LANE_CHANGE_SPEED,
  JUMP_LENGTH,
  JUMP_HEIGHT,
  SLIDE_LENGTH,
  GROUNDING_SPEED,
  TRACK_SPEED_TO_JUMP_ANIM_RATIO,
} from '../core/consts';

/** A jump/slide pressed this long before landing still fires on touchdown. */
const INPUT_BUFFER_SECONDS = 0.18;
/** Downward speed of a fast-fall (slide pressed mid-air), world units / s. */
const FAST_FALL_SPEED = 14;
/** Peak body lean while changing lanes, radians. */
const LANE_LEAN = 0.22;

/**
 * Port of CharacterInputController.cs: lane changes, jump and slide driven by
 * world distance, keyboard + swipe input. The TrackManager positions
 * `trackManager.characterRoot` on the path; this controller moves the visual
 * holder locally (lane X, jump Y).
 */
export class CharacterController {
  readonly holder = new THREE.Object3D();
  isJumping = false;
  isSliding = false;
  private currentLane = 1;
  private targetPosition = new THREE.Vector3();
  private jumpStart = 0;
  private slideStart = 0;
  private enabled = false;
  private inputGeneration = 0;
  get inputEnabled(): boolean { return this.enabled; }
  set inputEnabled(value: boolean) {
    if (value !== this.enabled) this.inputGeneration++;
    this.enabled = value;
  }
  /** Lets asynchronous input notice even a pause/resume between camera frames. */
  get inputRevision(): number { return this.inputGeneration; }
  onJump: () => void = () => {};
  onSlide: () => void = () => {};
  /** Touchdown after a jump or fast-fall. */
  onLand: () => void = () => {};
  onLaneChange: () => void = () => {};
  private buffered: 'jump' | 'slide' | null = null;
  private bufferTime = 0;
  private fastFalling = false;
  private lean = 0;

  private cleanupInput: (() => void)[] = [];

  constructor(
    readonly character: Character,
    private trackManager: TrackManager
  ) {
    this.holder.add(character.root);
    trackManager.characterRoot.add(this.holder);
  }

  attachInput(target: HTMLElement): void {
    const onKey = (e: KeyboardEvent) => {
      if (!this.inputEnabled) return;
      switch (e.key) {
        // The scene is a consistent mirror of Unity's (RH camera looking +Z puts
        // +X on screen-left), so screen-left = lane +1.
        case 'ArrowLeft':
        case 'a':
          this.moveHorizontal('left');
          break;
        case 'ArrowRight':
        case 'd':
          this.moveHorizontal('right');
          break;
        case 'ArrowUp':
        case 'w':
        case ' ':
          this.jump();
          break;
        case 'ArrowDown':
        case 's':
          this.slide();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    this.cleanupInput.push(() => window.removeEventListener('keydown', onKey));

    // Deliberate swipes only: tiny finger jitter and HUD taps are not moves.
    let startX = 0;
    let startY = 0;
    let swiping = false;
    let pointerId = -1;
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || (e.target instanceof Element && e.target.closest('button'))) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      swiping = true;
    };
    const onMove = (e: PointerEvent) => {
      if (!swiping || e.pointerId !== pointerId || !this.inputEnabled) return;
      const dx = (e.clientX - startX) / window.innerWidth;
      const dy = (e.clientY - startY) / window.innerWidth;
      const threshold = Math.max(18, Math.min(48, window.innerWidth * 0.035)) / window.innerWidth;
      if (Math.hypot(dx, dy) < threshold) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        if (dy < 0) this.jump();
        else this.slide();
      } else {
        this.changeLane(dx < 0 ? 1 : -1); // mirrored world: screen-left = +1
      }
      swiping = false;
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === pointerId) swiping = false;
    };
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
    this.cleanupInput.push(() => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    });
  }

  dispose(): void {
    for (const fn of this.cleanupInput) fn();
  }

  reset(): void {
    this.inputEnabled = false;
    this.inputGeneration++;
    this.currentLane = 1;
    this.targetPosition.set(0, 0, 0);
    this.holder.position.set(0, 0, 0);
    this.isJumping = false;
    this.isSliding = false;
    this.fastFalling = false;
    this.buffered = null;
    this.lean = 0;
    this.character.root.rotation.set(0, 0, 0);
  }

  changeLane(direction: number): void {
    const target = this.currentLane + direction;
    if (target < 0 || target > 2) return;
    this.currentLane = target;
    this.targetPosition.x = (target - 1) * LANE_OFFSET;
    this.onLaneChange();
  }

  /** Shared by arrow keys and wrist input; +X is screen-left in this world. */
  moveHorizontal(direction: HorizontalDirection): void {
    if (!this.inputEnabled) return;
    this.changeLane(direction === 'left' ? 1 : -1);
  }

  private buffer(action: 'jump' | 'slide'): void {
    this.buffered = action;
    this.bufferTime = INPUT_BUFFER_SECONDS;
  }

  jump(): void {
    if (this.isJumping || this.fastFalling) {
      this.buffer('jump');
      return;
    }
    if (this.isSliding) this.stopSliding();
    this.isJumping = true;
    const tm = this.trackManager;
    this.jumpStart = tm.worldDistance;
    const correctJumpLength = JUMP_LENGTH * (1 + tm.speedRatio);
    const animSpeed = TRACK_SPEED_TO_JUMP_ANIM_RATIO * (tm.speed / correctJumpLength);
    this.character.play('jump', 0.1, animSpeed);
    this.onJump();
  }

  slide(): void {
    if (this.isSliding) return;
    if (this.isJumping) {
      // Fast-fall: abandon the arc and drop straight into a slide.
      this.isJumping = false;
      this.fastFalling = true;
      this.buffer('slide');
      return;
    }
    if (this.fastFalling) return;
    this.startSlide();
  }

  private startSlide(): void {
    this.isSliding = true;
    this.slideStart = this.trackManager.worldDistance;
    const correctSlideLength = SLIDE_LENGTH * (1 + this.trackManager.speedRatio);
    const animSpeed = TRACK_SPEED_TO_JUMP_ANIM_RATIO * (this.trackManager.speed / correctSlideLength);
    this.character.play('slide', 0.1, animSpeed);
    this.onSlide();
  }

  private stopJumping(): void {
    this.isJumping = false;
    this.land();
  }

  /** Touchdown: consume a buffered input, or fall back into the run cycle. */
  private land(): void {
    this.holder.position.y = 0;
    this.fastFalling = false;
    this.onLand();
    const next = this.bufferTime > 0 ? this.buffered : null;
    this.buffered = null;
    if (next === 'jump') this.jump();
    else if (next === 'slide') this.startSlide();
    else this.character.play('run', 0.15);
  }

  private stopSliding(): void {
    this.isSliding = false;
    this.character.play('run', 0.15);
  }

  update(dt: number): void {
    const tm = this.trackManager;

    this.bufferTime = Math.max(0, this.bufferTime - dt);

    // Lane: MoveTowards at laneChangeSpeed.
    const delta = this.targetPosition.x - this.holder.position.x;
    const maxStep = LANE_CHANGE_SPEED * dt;
    if (Math.abs(delta) <= maxStep) this.holder.position.x = this.targetPosition.x;
    else this.holder.position.x += Math.sign(delta) * maxStep;

    // Bank into lane changes, easing back upright as the move completes.
    const targetLean = THREE.MathUtils.clamp(delta / LANE_OFFSET, -1, 1) * LANE_LEAN;
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 16);
    this.character.root.rotation.z = -this.lean;
    this.character.root.rotation.y = this.lean * 0.6;

    if (this.fastFalling) {
      this.holder.position.y = Math.max(0, this.holder.position.y - FAST_FALL_SPEED * dt);
      if (this.holder.position.y === 0) this.land();
      return;
    }

    // Jump: arc driven by world distance.
    if (this.isJumping) {
      if (tm.isMoving) {
        const correctJumpLength = JUMP_LENGTH * (1 + tm.speedRatio);
        const ratio = (tm.worldDistance - this.jumpStart) / correctJumpLength;
        if (ratio >= 1) {
          this.stopJumping();
        } else {
          this.holder.position.y = Math.sin(ratio * Math.PI) * JUMP_HEIGHT;
        }
      } else if (this.holder.position.y !== 0) {
        // Track stopped mid-jump: ease back to ground.
        this.holder.position.y = Math.max(0, this.holder.position.y - GROUNDING_SPEED * dt);
        if (this.holder.position.y === 0) this.stopJumping();
      }
    } else if (this.isSliding) {
      const correctSlideLength = SLIDE_LENGTH * (1 + tm.speedRatio);
      const ratio = (tm.worldDistance - this.slideStart) / correctSlideLength;
      if (ratio >= 1) this.stopSliding();
    }
  }
}
