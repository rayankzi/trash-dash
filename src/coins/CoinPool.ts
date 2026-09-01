import * as THREE from 'three';
import { assets } from '../core/AssetManager';
import { makeCurvedMaterial } from '../rendering/CurvedMaterial';
import { COIN_POOL_SIZE } from '../core/consts';

/**
 * Pooled fishbone coins, mirroring Unity's Pooler.cs (256 pre-instantiated).
 * Coins spin in place; collection just frees them back to the pool.
 */
export class CoinPool {
  private pool: THREE.Object3D[] = [];
  private active = new Set<THREE.Object3D>();
  private template!: THREE.Object3D;

  async init(scene: THREE.Scene): Promise<void> {
    const model = await assets.loadModel('models/Fishbone');
    const material = makeCurvedMaterial({ map: assets.getTexture('FishboneAlbedo') });
    this.template = model.clone();
    this.template.traverse((c) => {
      if (c instanceof THREE.Mesh) c.material = material;
    });
    for (let i = 0; i < COIN_POOL_SIZE; i++) {
      const coin = this.template.clone();
      coin.visible = false;
      scene.add(coin);
      this.pool.push(coin);
    }
  }

  get(pos: THREE.Vector3, rot: THREE.Quaternion): THREE.Object3D | null {
    const coin = this.pool.pop();
    if (!coin) return null;
    coin.position.copy(pos);
    coin.quaternion.copy(rot);
    coin.visible = true;
    this.active.add(coin);
    return coin;
  }

  free(coin: THREE.Object3D): void {
    if (!this.active.delete(coin)) return;
    coin.visible = false;
    this.pool.push(coin);
  }

  /** Spin all active coins. */
  tick(dt: number): void {
    for (const coin of this.active) coin.rotateY(dt * 3);
  }

  /** Keep scene-root pooled coins with their owning segments on recenter. */
  translateActive(offset: THREE.Vector3): void {
    for (const coin of this.active) coin.position.add(offset);
  }
}

export const coinPool = new CoinPool();
