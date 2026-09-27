import * as THREE from 'three';
import { assets } from '../core/AssetManager';
import { makeCurvedMaterial } from '../rendering/CurvedMaterial';
import { COIN_POOL_SIZE } from '../core/consts';

const tmpMatrix = new THREE.Matrix4();

/**
 * Pooled fishbone coins, mirroring Unity's Pooler.cs (256 pre-allocated).
 *
 * Gameplay code works with lightweight proxy objects (position, rotation,
 * `visible`), which never enter the scene graph. Every frame the active
 * proxies are packed into one InstancedMesh per fishbone mesh, so the whole
 * coin field is a single draw call instead of one per coin.
 */
export class CoinPool {
  private pool: THREE.Object3D[] = [];
  private active = new Set<THREE.Object3D>();
  private parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }[] = [];

  async init(scene: THREE.Scene): Promise<void> {
    const model = await assets.loadModel('models/Fishbone');
    // The model root carries the handedness mirror (scale.x = -1), which flips
    // the winding of every instance; draw both faces rather than re-winding.
    const material = makeCurvedMaterial({
      map: assets.getTexture('textures/FishboneAlbedo.webp'),
      doubleSided: true,
    });
    model.updateMatrixWorld(true);
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mesh = new THREE.InstancedMesh(child.geometry, material, COIN_POOL_SIZE);
      mesh.name = 'FishboneCoins';
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
      this.parts.push({ mesh, local: child.matrixWorld.clone() });
    });
    for (let i = 0; i < COIN_POOL_SIZE; i++) {
      const coin = new THREE.Object3D();
      coin.name = 'Fishbone';
      coin.visible = false;
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

  /** Spin every active coin and upload the instance matrices. */
  tick(dt: number): void {
    for (const coin of this.active) coin.rotateY(dt * 3);
    this.sync();
  }

  /** Pack active coins into the instanced meshes (also used after resets). */
  sync(): void {
    for (const { mesh, local } of this.parts) {
      let index = 0;
      for (const coin of this.active) {
        coin.updateMatrix();
        mesh.setMatrixAt(index++, tmpMatrix.multiplyMatrices(coin.matrix, local));
      }
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Keep pooled coins with their owning segments on recenter. */
  translateActive(offset: THREE.Vector3): void {
    for (const coin of this.active) coin.position.add(offset);
  }
}

export const coinPool = new CoinPool();
