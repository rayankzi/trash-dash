import * as THREE from 'three';
import { Character } from './Character';
import { TrackManager } from '../track/TrackManager';
import {
  LANE_OFFSET,
  LANE_CHANGE_SPEED,
  JUMP_LENGTH,
  JUMP_HEIGHT,
  SLIDE_LENGTH,
  GROUNDING_SPEED,
  TRACK_SPEED_TO_JUMP_ANIM_RATIO,
} from '../core/consts';

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
  inputEnabled = false;
  onJump: () => void = () => {};
  onSlide: () => void = () => {};

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
          this.changeLane(1);
          break;
        case 'ArrowRight':
        case 'd':
          this.changeLane(-1);
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

    // Swipe: 1% of screen width threshold, dominant axis wins (Unity parity).
    let startX = 0;
    let startY = 0;
    let swiping = false;
    const onDown = (e: PointerEvent) => {
      startX = e.clientX;
      startY = e.clientY;
      swiping = true;
    };
    const onMove = (e: PointerEvent) => {
      if (!swiping || !this.inputEnabled) return;
      const dx = (e.clientX - startX) / window.innerWidth;
      const dy = (e.clientY - startY) / window.innerWidth;
      if (Math.hypot(dx, dy) < 0.01) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        if (dy < 0) this.jump();
        else this.slide();
      } else {
        this.changeLane(dx < 0 ? 1 : -1); // mirrored world: screen-left = +1
      }
      swiping = false;
    };
    const onUp = () => {
      swiping = false;
    };
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    this.cleanupInput.push(() => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    });
  }

  dispose(): void {
    for (const fn of this.cleanupInput) fn();
  }

  reset(): void {
    this.currentLane = 1;
    this.targetPosition.set(0, 0, 0);
    this.holder.position.set(0, 0, 0);
    this.isJumping = false;
    this.isSliding = false;
  }

  changeLane(direction: number): void {
    const target = this.currentLane + direction;
    if (target < 0 || target > 2) return;
    this.currentLane = target;
    this.targetPosition.x = (target - 1) * LANE_OFFSET;
  }

  jump(): void {
    if (this.isJumping) return;
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
    if (this.isJumping || this.isSliding) return;
    this.isSliding = true;
    this.slideStart = this.trackManager.worldDistance;
    const correctSlideLength = SLIDE_LENGTH * (1 + this.trackManager.speedRatio);
    const animSpeed = TRACK_SPEED_TO_JUMP_ANIM_RATIO * (this.trackManager.speed / correctSlideLength);
    this.character.play('slide', 0.1, animSpeed);
    this.onSlide();
  }

  private stopJumping(): void {
    this.isJumping = false;
    this.character.play('run', 0.15);
  }

  private stopSliding(): void {
    this.isSliding = false;
    this.character.play('run', 0.15);
  }

  update(dt: number): void {
    const tm = this.trackManager;

    // Lane: MoveTowards at laneChangeSpeed.
    const delta = this.targetPosition.x - this.holder.position.x;
    const maxStep = LANE_CHANGE_SPEED * dt;
    if (Math.abs(delta) <= maxStep) this.holder.position.x = this.targetPosition.x;
    else this.holder.position.x += Math.sign(delta) * maxStep;

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
