import * as THREE from 'three';
import { makeCurvedMaterial } from './CurvedMaterial';

/**
 * The authored segments only model the street itself, so at wide aspect ratios
 * the camera sees past their edges into empty background colour — buildings
 * appear to float over a white hole. This is a large disc that rides with the
 * runner just under the road, filling everything below the horizon with a
 * ground tone that the scene fog then blends into the sky.
 */
export class GroundHaze {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(parent: THREE.Object3D, radius = 400) {
    this.material = makeCurvedMaterial({ color: 0xb4bac6 });
    this.material.depthWrite = true;
    // Subdivided rather than a single fan: linear fog is interpolated between
    // vertices, so a disc whose triangles span hundreds of units reads as fully
    // fogged right next to the camera.
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2, 64, 64), this.material);
    this.mesh.name = 'GroundHaze';
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = -0.6;
    // Drawn before the street so the road, kerbs and props always win the
    // depth test at the edges where they overlap it.
    this.mesh.renderOrder = -200;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.material.color.set(color);
  }
}
