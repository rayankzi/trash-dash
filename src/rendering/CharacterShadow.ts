import * as THREE from 'three';

/**
 * Soft contact shadow under the runner. The world is drawn with unlit
 * materials, so a real shadow map has nothing to receive it — this is a
 * procedurally generated blob that tightens and darkens near the ground and
 * spreads out as the character rises, which is what sells the jump height.
 */
export class CharacterShadow {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private baseOpacity = 0.42;

  constructor(parent: THREE.Object3D) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2 - 2);
    gradient.addColorStop(0, 'rgba(10,10,30,1)');
    gradient.addColorStop(0.45, 'rgba(10,10,30,0.7)');
    gradient.addColorStop(1, 'rgba(10,10,30,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: this.baseOpacity,
      fog: false,
    });
    // Slightly wider than deep, matching the character's stance.
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.05), this.material);
    this.mesh.name = 'CharacterShadow';
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.03;
    this.mesh.renderOrder = 1;
    parent.add(this.mesh);
  }

  setOpacity(opacity: number): void {
    this.baseOpacity = opacity;
    this.material.opacity = opacity;
  }

  /** `height` is the character's local Y (0 on the ground). */
  update(laneX: number, height: number): void {
    this.mesh.position.x = laneX;
    const rise = THREE.MathUtils.clamp(height, 0, 2);
    this.mesh.scale.setScalar(1 + rise * 0.35);
    this.material.opacity = this.baseOpacity * Math.max(0.18, 1 - rise * 0.55);
  }
}
