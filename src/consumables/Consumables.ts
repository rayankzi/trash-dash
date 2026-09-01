import * as THREE from 'three';
import { assets } from '../core/AssetManager';
import { makeCurvedMaterial } from '../rendering/CurvedMaterial';
import { coinPool } from '../coins/CoinPool';
import { TrackManager } from '../track/TrackManager';
import { CharacterCollider } from '../character/CharacterCollider';
import { MAX_LIVES, MAGNET_SPEED, MAGNET_HALF_EXTENTS } from '../core/consts';
import type { TrackSegment } from '../track/TrackSegment';

export type ConsumableType = 'magnet' | 'score2' | 'invincibility' | 'extralife';

// Durations from the Unity powerup prefabs; models/icons from Assets/Models.
export const CONSUMABLES: Record<
  ConsumableType,
  { name: string; duration: number; model: string; texture: string; canBeSpawned: boolean }
> = {
  magnet: { name: 'Magnet', duration: 15, model: 'models/Magnet', texture: 'MagnetAlbedo', canBeSpawned: true },
  score2: { name: 'x2', duration: 10, model: 'models/Multiply', texture: 'SardinesGoldAlbedo', canBeSpawned: true },
  invincibility: { name: 'Invincible', duration: 10, model: 'models/Shield', texture: 'StarAlbedo', canBeSpawned: true },
  extralife: { name: 'Life', duration: 0.01, model: 'models/Heart', texture: 'HeartAlbedo', canBeSpawned: true },
};

export async function preloadConsumables(): Promise<void> {
  await Promise.all(
    [...Object.values(CONSUMABLES).map((c) => assets.loadModel(c.model)), assets.loadModel('models/Sardines')]
  );
}

/** Spawn a floating powerup pickup on the track (registers collider on the segment). */
export function spawnPowerupPickup(segment: TrackSegment, pos: THREE.Vector3, rot: THREE.Quaternion): void {
  const types = Object.entries(CONSUMABLES).filter(([, c]) => c.canBeSpawned);
  const [type, def] = types[Math.floor(Math.random() * types.length)];
  const src = assets.getLoadedModel(def.model);
  if (!src) return;
  const obj = src.clone();
  obj.traverse((c) => {
    if (c instanceof THREE.Mesh) c.material = makeCurvedMaterial({ map: assets.getTexture(def.texture) });
  });
  obj.position.copy(pos);
  obj.position.y += 0.8;
  obj.quaternion.copy(rot);
  segment.group.updateMatrixWorld(true);
  segment.group.attach(obj);
  segment.tickers.push((dt) => obj.rotateY(dt * 2));
  const box = new THREE.Box3().setFromCenterAndSize(pos.clone().setY(pos.y + 0.8), new THREE.Vector3(1, 1.6, 1));
  segment.colliders.push({ box, kind: 'powerup', obj, data: type });
}

/** Premium currency ("sardines") pickup. */
export function spawnPremiumPickup(segment: TrackSegment, pos: THREE.Vector3, rot: THREE.Quaternion): void {
  const src = assets.getLoadedModel('models/Sardines');
  if (!src) return;
  const obj = src.clone();
  obj.traverse((c) => {
    if (c instanceof THREE.Mesh) c.material = makeCurvedMaterial({ map: assets.getTexture('SardinesGoldAlbedo') });
  });
  obj.position.copy(pos);
  obj.position.y += 0.6;
  obj.quaternion.copy(rot);
  segment.group.updateMatrixWorld(true);
  segment.group.attach(obj);
  segment.tickers.push((dt) => obj.rotateY(dt * 2));
  const box = new THREE.Box3().setFromCenterAndSize(pos.clone().setY(pos.y + 0.6), new THREE.Vector3(0.8, 1.2, 0.8));
  segment.colliders.push({ box, kind: 'premium', obj });
}

interface ActiveConsumable {
  type: ConsumableType;
  timeLeft: number;
  duration: number;
}

/**
 * Active consumable effects, mirroring Consumable.cs subclasses:
 * magnet drags nearby coins in, score2 doubles the multiplier,
 * invincibility sets the explicit flag, extra life heals (or pays 10 coins).
 */
export class ConsumableSystem {
  readonly active: ActiveConsumable[] = [];
  private magnetCoins = new Set<THREE.Object3D>();
  readonly events = new EventTarget();

  constructor(
    private trackManager: TrackManager,
    private collider: CharacterCollider,
    private characterHolder: THREE.Object3D
  ) {
    trackManager.modifyMultiply.push((m) => (this.isActive('score2') ? m * 2 : m));
  }

  isActive(type: ConsumableType): boolean {
    return this.active.some((a) => a.type === type);
  }

  reset(): void {
    this.active.length = 0;
    this.magnetCoins.clear();
    this.collider.setInvincibleExplicit(false);
  }

  use(type: ConsumableType): void {
    if (type === 'extralife') {
      if (this.collider.lives < MAX_LIVES) this.collider.lives++;
      else this.collider.coins += 10; // Unity: k_CoinValue when already at full life
      this.events.dispatchEvent(new CustomEvent('changed'));
      return;
    }
    const existing = this.active.find((a) => a.type === type);
    if (existing) {
      existing.timeLeft = existing.duration; // reset timer instead of stacking
    } else {
      const duration = CONSUMABLES[type].duration;
      this.active.push({ type, timeLeft: duration, duration });
    }
    this.events.dispatchEvent(new CustomEvent('changed'));
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.timeLeft -= dt;
      if (a.timeLeft <= 0) {
        if (a.type === 'invincibility') this.collider.setInvincibleExplicit(false);
        this.active.splice(i, 1);
        this.events.dispatchEvent(new CustomEvent('changed'));
      }
    }

    if (this.isActive('invincibility')) this.collider.setInvincibleExplicit(true);

    if (this.isActive('magnet')) {
      // OverlapBox(20,1,1) around the character pulling coins at MAGNET_SPEED.
      this.characterHolder.updateMatrixWorld(true);
      const center = new THREE.Vector3().setFromMatrixPosition(this.characterHolder.matrixWorld);
      const magnetBox = new THREE.Box3().setFromCenterAndSize(
        center,
        new THREE.Vector3(MAGNET_HALF_EXTENTS[0] * 2, MAGNET_HALF_EXTENTS[1] * 2, MAGNET_HALF_EXTENTS[2] * 2)
      );
      for (const segment of this.trackManager.nearbySegments()) {
        for (const c of segment.colliders) {
          if (c.kind === 'coin' && magnetBox.intersectsBox(c.box)) this.magnetCoins.add(c.obj);
        }
      }
      for (const coin of this.magnetCoins) {
        if (!coin.visible) {
          this.magnetCoins.delete(coin); // collected/freed
          continue;
        }
        const step = MAGNET_SPEED * dt;
        coin.position.add(center.clone().sub(coin.position).clampLength(0, step));
        // Keep the collider box on the coin so pickup still registers.
        for (const segment of this.trackManager.nearbySegments()) {
          for (const c of segment.colliders) {
            if (c.obj === coin) c.box.setFromCenterAndSize(coin.position, new THREE.Vector3(0.8, 0.8, 0.8));
          }
        }
      }
    } else {
      this.magnetCoins.clear();
    }
  }
}

export { coinPool };
