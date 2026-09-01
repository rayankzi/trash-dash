import * as THREE from 'three';
import { CharacterController } from './CharacterController';
import { TrackManager } from '../track/TrackManager';
import { coinPool } from '../coins/CoinPool';
import { globalBlink } from '../rendering/CurvedMaterial';
import {
  MAX_LIVES,
  INVINCIBILITY_TIME,
  BLINK_PERIOD,
  COLLIDER_CENTER_STANDING,
  COLLIDER_SIZE_STANDING,
  COLLIDER_CENTER_SLIDING,
  COLLIDER_SIZE_SLIDING,
} from '../core/consts';

/**
 * Port of CharacterCollider.cs: one AABB around the character tested against
 * nearby segment colliders. Handles coins, obstacle hits, lives, and the
 * post-hit invincibility blink.
 */
export class CharacterCollider {
  readonly events = new EventTarget();
  lives = MAX_LIVES;
  coins = 0;
  premium = 0;
  private invincibleTime = 0;
  private blinkTimer = 0;
  private explicitInvincible = false;

  private box = new THREE.Box3();
  private center = new THREE.Vector3();
  private size = new THREE.Vector3();

  constructor(
    private controller: CharacterController,
    private trackManager: TrackManager
  ) {}

  reset(): void {
    this.lives = MAX_LIVES;
    this.coins = 0;
    this.premium = 0;
    this.invincibleTime = 0;
    this.explicitInvincible = false;
    globalBlink.value = 0;
  }

  get invincible(): boolean {
    return this.invincibleTime > 0 || this.explicitInvincible;
  }

  setInvincibleExplicit(on: boolean): void {
    this.explicitInvincible = on;
  }

  setInvincible(duration = INVINCIBILITY_TIME): void {
    this.invincibleTime = duration;
  }

  update(dt: number): void {
    // Character world AABB, shrunk while sliding (from the top, like Unity).
    const sliding = this.controller.isSliding;
    this.center.fromArray(sliding ? COLLIDER_CENTER_SLIDING : COLLIDER_CENTER_STANDING);
    this.size.fromArray(sliding ? COLLIDER_SIZE_SLIDING : COLLIDER_SIZE_STANDING);
    const holder = this.controller.holder;
    holder.updateMatrixWorld(true);
    this.center.applyMatrix4(holder.matrixWorld);
    this.box.setFromCenterAndSize(this.center, this.size);

    for (const segment of this.trackManager.nearbySegments()) {
      for (let i = 0; i < segment.colliders.length; i++) {
        const c = segment.colliders[i];
        // Barrier-jump mission: while airborne, count obstacles passing under us.
        if (
          c.kind === 'obstacle' &&
          this.controller.isJumping &&
          !(c as { jumped?: boolean }).jumped &&
          c.box.min.x <= this.center.x &&
          this.center.x <= c.box.max.x &&
          c.box.min.z <= this.center.z &&
          this.center.z <= c.box.max.z &&
          this.box.min.y > c.box.max.y - 0.1
        ) {
          (c as { jumped?: boolean }).jumped = true;
          this.events.dispatchEvent(new CustomEvent('barrierJumped'));
        }
        if (!this.box.intersectsBox(c.box)) continue;
        if (c.kind === 'coin') {
          coinPool.free(c.obj);
          segment.colliders.splice(i, 1);
          i--;
          this.coins++;
          this.events.dispatchEvent(new CustomEvent('coin'));
        } else if (c.kind === 'premium') {
          c.obj.removeFromParent();
          segment.colliders.splice(i, 1);
          i--;
          this.premium++;
          this.events.dispatchEvent(new CustomEvent('premium'));
        } else if (c.kind === 'powerup') {
          c.obj.removeFromParent();
          segment.colliders.splice(i, 1);
          i--;
          this.events.dispatchEvent(new CustomEvent('powerup', { detail: c.data }));
        } else if (c.kind === 'obstacle') {
          if (this.invincible) continue;
          this.lives--;
          this.events.dispatchEvent(new CustomEvent('hit', { detail: { obstacle: c.obj } }));
          if (this.lives > 0) {
            this.setInvincible();
          } else {
            this.events.dispatchEvent(new CustomEvent('death'));
          }
        }
      }
    }

    // Invincibility blink (Shader.SetGlobalFloat("_BlinkingValue") equivalent).
    if (this.invincibleTime > 0) {
      this.invincibleTime -= dt;
      this.blinkTimer += dt;
      if (this.blinkTimer > BLINK_PERIOD) {
        this.blinkTimer = 0;
        globalBlink.value = globalBlink.value > 0 ? 0 : 0.6;
      }
      if (this.invincibleTime <= 0) {
        globalBlink.value = 0;
        // The hit reaction owns the character's pose until the blink ends, so
        // this is the cue to hand the animation back to the run cycle.
        this.events.dispatchEvent(new CustomEvent('recovered'));
      }
    } else if (!this.explicitInvincible && globalBlink.value !== 0) {
      globalBlink.value = 0;
    }
  }
}
