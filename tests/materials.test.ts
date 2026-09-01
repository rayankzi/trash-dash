import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AssetManager } from '../src/core/AssetManager';

function primitive(sourceMaterialName: string): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial();
  material.name = sourceMaterialName;
  return new THREE.Mesh(new THREE.BufferGeometry(), material);
}

describe('Unity material-slot assignment', () => {
  it('preserves materials on FBX primitives split into child meshes', () => {
    const manager = new AssetManager();
    vi.spyOn(manager, 'getMaterial').mockImplementation((name) => {
      const material = new THREE.MeshBasicMaterial();
      material.name = name;
      return material;
    });
    const root = new THREE.Group();
    // Warehouse-style FBXs are emitted as one child mesh per material. Keep
    // source-name matching authoritative even if traversal order changes.
    root.add(
      primitive('Pipe'),
      primitive('VCOL'),
      primitive('CorrugatedMetal'),
      primitive('BrickWall'),
    );

    manager.applyMaterials(root, ['VCOL', 'BrickWall', 'CorrugatedMetal', 'Pipe']);

    expect(root.children.map((child) => ((child as THREE.Mesh).material as THREE.Material).name))
      .toEqual(['Pipe', 'VCOL', 'CorrugatedMetal', 'BrickWall']);
  });

  it('falls back to authored primitive order when converter names are unavailable', () => {
    const manager = new AssetManager();
    const root = new THREE.Group();
    root.add(primitive(''), primitive(''));

    manager.applyMaterials(root, ['VCOL', 'Obstacle']);

    expect((root.children[0] as THREE.Mesh).material).toMatchObject({ name: 'VCOL' });
    expect((root.children[1] as THREE.Mesh).material).toMatchObject({ name: 'Obstacle' });
  });

  it('keeps curved planar walls out of CPU frustum culling', () => {
    const manager = new AssetManager();
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 2));
    const root = new THREE.Group();
    root.add(wall);

    manager.applyMaterials(root, ['VCOL']);

    expect(wall.frustumCulled).toBe(false);
  });
});
