import * as THREE from 'three';
import { assets } from '../core/AssetManager';
import { makeCurvedMaterial } from '../rendering/CurvedMaterial';
import { TrackManager } from '../track/TrackManager';
import { CharacterCollider } from '../character/CharacterCollider';
import { MAX_LIVES, MAGNET_SPEED, MAGNET_HALF_EXTENTS } from '../core/consts';
import type { TrackSegment } from '../track/TrackSegment';

export type ConsumableType = 'magnet' | 'score2' | 'invincibility' | 'extralife';

export interface ConsumableDef {
  name: string;
  duration: number;
  model: string;
  texture: string;
  /** Tint for pickup bursts, HUD timers and the runner's rim light. */
  color: number;
}

// Durations from the Unity powerup prefabs; models/albedos from Assets/Models.
export const CONSUMABLES: Record<ConsumableType, ConsumableDef> = {
  magnet: { name: 'Magnet', duration: 15, model: 'models/Magnet', texture: 'textures/MagnetAlbedo.webp', color: 0xff5a4e },
  score2: { name: 'Score x2', duration: 10, model: 'models/Multiply', texture: 'textures/SardinesGoldAlbedo.webp', color: 0x4fc3ff },
  invincibility: { name: 'Invincible', duration: 10, model: 'models/Shield', texture: 'textures/StarAlbedo.png', color: 0xffd23f },
  extralife: { name: 'Extra Life', duration: 0, model: 'models/Heart', texture: 'textures/HeartAlbedo.webp', color: 0xff4d6d },
};

const CONSUMABLE_TYPES = Object.keys(CONSUMABLES) as ConsumableType[];
const PREMIUM_MODEL = 'models/Sardines';
const PREMIUM_TEXTURE = 'textures/SardinesGoldAlbedo.webp';

export async function preloadConsumables(): Promise<void> {
  await Promise.all([...Object.values(CONSUMABLES).map((c) => assets.loadModel(c.model)), assets.loadModel(PREMIUM_MODEL)]);
}

const pickupMaterials = new Map<string, THREE.Material>();
function pickupMaterial(texture: string): THREE.Material {
  let material = pickupMaterials.get(texture);
  if (!material) {
    material = makeCurvedMaterial({ map: assets.getTexture(texture) });
    pickupMaterials.set(texture, material);
  }
  return material;
}

/**
 * Place a spinning, gently bobbing pickup on a segment and register its
 * collider. `lift` is the resting height above the lane.
 */
function spawnPickup(
  segment: TrackSegment,
  pos: THREE.Vector3,
  rot: THREE.Quaternion,
  model: string,
  texture: string,
  lift: number,
  size: THREE.Vector3
): { obj: THREE.Object3D; box: THREE.Box3 } | null {
  const src = assets.getLoadedModel(model);
  if (!src) return null;
  const obj = src.clone();
  const material = pickupMaterial(texture);
  obj.traverse((c) => {
    if (c instanceof THREE.Mesh) c.material = material;
  });
  obj.position.copy(pos);
  obj.position.y += lift;
  obj.quaternion.copy(rot);
  segment.group.updateMatrixWorld(true);
  segment.group.attach(obj);
  const restY = obj.position.y;
  let time = Math.random() * Math.PI * 2;
  segment.tickers.push((dt) => {
    time += dt;
    obj.rotateY(dt * 2);
    obj.position.y = restY + Math.sin(time * 3) * 0.08;
  });
  const center = pos.clone();
  center.y += lift;
  return { obj, box: new THREE.Box3().setFromCenterAndSize(center, size) };
}

/** Spawn a random powerup pickup on the track (registers collider on the segment). */
export function spawnPowerupPickup(
  segment: TrackSegment,
  pos: THREE.Vector3,
  rot: THREE.Quaternion,
  random: () => number = Math.random
): void {
  const type = CONSUMABLE_TYPES[Math.floor(random() * CONSUMABLE_TYPES.length)];
  const def = CONSUMABLES[type];
  const pickup = spawnPickup(segment, pos, rot, def.model, def.texture, 0.8, new THREE.Vector3(1, 1.6, 1));
  if (pickup) segment.colliders.push({ ...pickup, kind: 'powerup', data: type });
}

/** Premium currency ("sardines") pickup. */
export function spawnPremiumPickup(segment: TrackSegment, pos: THREE.Vector3, rot: THREE.Quaternion): void {
  const pickup = spawnPickup(segment, pos, rot, PREMIUM_MODEL, PREMIUM_TEXTURE, 0.6, new THREE.Vector3(0.8, 1.2, 0.8));
  if (pickup) segment.colliders.push({ ...pickup, kind: 'premium' });
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
const COIN_BOX_SIZE = new THREE.Vector3(0.8, 0.8, 0.8);
const MAGNET_SIZE = new THREE.Vector3(...MAGNET_HALF_EXTENTS).multiplyScalar(2);
const magnetCenter = new THREE.Vector3();
const magnetBox = new THREE.Box3();
const pull = new THREE.Vector3();

export class ConsumableSystem {
  readonly active: ActiveConsumable[] = [];
  /** Coins caught by the magnet, with the collider box that must follow them. */
  private magnetCoins = new Map<THREE.Object3D, THREE.Box3>();
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

  timeLeft(type: ConsumableType): number {
    return this.active.find((a) => a.type === type)?.timeLeft ?? 0;
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
      magnetCenter.setFromMatrixPosition(this.characterHolder.matrixWorld);
      magnetBox.setFromCenterAndSize(magnetCenter, MAGNET_SIZE);
      for (const segment of this.trackManager.nearbySegments()) {
        for (const c of segment.colliders) {
          if (c.kind === 'coin' && !this.magnetCoins.has(c.obj) && magnetBox.intersectsBox(c.box)) {
            this.magnetCoins.set(c.obj, c.box);
          }
        }
      }
      const step = MAGNET_SPEED * dt;
      for (const [coin, box] of this.magnetCoins) {
        if (!coin.visible) {
          this.magnetCoins.delete(coin); // collected/freed
          continue;
        }
        coin.position.add(pull.subVectors(magnetCenter, coin.position).clampLength(0, step));
        // Keep the collider on the coin so pickup still registers.
        box.setFromCenterAndSize(coin.position, COIN_BOX_SIZE);
      }
    } else {
      this.magnetCoins.clear();
    }
  }
}
