import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  isPlanarGeometry,
  makeCharacterMaterial,
  makeCurvedMaterial,
  makeStandardMaterial,
  makeVertexColorMaterial,
  normalizeShaderFamily,
  type ShaderFamily,
} from '../rendering/CurvedMaterial';
import materialsJson from '../data/materials.json';

type MaterialInfo = {
  shader?: string;
  shaderFamily?: ShaderFamily | string;
  /** Public-assets-relative URL, e.g. `textures/BinAlbedo.webp`. */
  texture?: string | null;
  tint?: [number, number, number] | null;
};

const MATERIALS = materialsJson as unknown as Record<string, MaterialInfo>;

export interface MeshIdentity {
  guid: string;
  fileID: string;
  asset: string;
  /** Optional when the converter can preserve the FBX mesh/node name. */
  name?: string;
}

/** Node tree extracted from Unity prefabs by tools/extract-segments.mjs. */
export interface PrefabNode {
  name: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
  model?: string; // path under assets/models, no extension
  mesh?: MeshIdentity;
  rendererEnabled?: boolean;
  /** Unity material slots in exact renderer order. */
  materials?: string[];
  prefab?: string;
  children?: PrefabNode[];
}

/**
 * Loads and caches GLB models / textures, and instantiates Unity prefab node
 * trees as three.js object hierarchies using the original shader families.
 */
export class AssetManager {
  private gltfLoader = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private models = new Map<string, THREE.Group>();
  private modelLoads = new Map<string, Promise<THREE.Group>>();
  private animations = new Map<string, THREE.AnimationClip[]>();
  private textures = new Map<string, THREE.Texture>();
  private textureLoads: Promise<void>[] = [];
  private materialCache = new Map<string, THREE.Material>();

  async loadModel(path: string): Promise<THREE.Group> {
    const cached = this.models.get(path);
    if (cached) return cached;
    const pending = this.modelLoads.get(path);
    if (pending) return pending;
    const loading = this.loadModelOnce(path);
    this.modelLoads.set(path, loading);
    try {
      return await loading;
    } finally {
      this.modelLoads.delete(path);
    }
  }

  private async loadModelOnce(path: string): Promise<THREE.Group> {
    const gltf: GLTF = await this.gltfLoader.loadAsync(`assets/${path}.glb`);
    // Unity is left-handed and negates X when it imports an FBX; glTF and
    // three.js are right-handed, so the converted meshes arrive mirrored
    // relative to the prefab transforms the extractor read out of Unity.
    // Reflecting each model root once puts its geometry back in Unity's frame.
    // Without this, every mesh is mirrored about its own pivot rather than the
    // world: harmless for a symmetric bin, but it throws garages, houses,
    // warehouses and background buildings — whose pivots sit at one end — onto
    // the opposite side of the street, straight through the player's lane.
    const root = new THREE.Group();
    root.name = gltf.scene.name || path;
    root.scale.x = -1;
    root.add(gltf.scene);
    this.models.set(path, root);
    this.animations.set(path, gltf.animations);
    return root;
  }

  getAnimations(path: string): THREE.AnimationClip[] {
    return this.animations.get(path) ?? [];
  }

  getLoadedModel(path: string): THREE.Group | undefined {
    return this.models.get(path);
  }

  /** `reference` is public-assets-relative with its extension (`textures/X.webp`). */
  getTexture(reference: string): THREE.Texture {
    const url = `assets/${reference}`;
    let texture = this.textures.get(url);
    if (!texture) {
      this.textureLoads.push(new Promise<void>((resolve, reject) => {
        texture = this.texLoader.load(url, () => resolve(), undefined, reject);
      }));
      texture = texture!;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false; // glTF UV convention
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      this.textures.set(url, texture);
    }
    return texture;
  }

  async ready(): Promise<void> {
    await Promise.all(this.textureLoads);
  }

  private materialInfo(name: string): {
    info: MaterialInfo | undefined;
    family: ShaderFamily;
    texture: THREE.Texture | null;
    color: THREE.Color;
  } {
    const info = MATERIALS[name];
    const family = normalizeShaderFamily(info?.shaderFamily ?? info?.shader);
    const texture = info?.texture ? this.getTexture(info.texture) : null;

    // The custom Unity unlit shaders do not declare or consume `_Color`; they
    // sample the texture and multiply only by baked vertex colour. `_Color`
    // remains meaningful for Unity Standard materials.
    const tint = family === 'standard' ? info?.tint : null;
    const color = tint ? new THREE.Color(...tint) : new THREE.Color(0xffffff);
    return { info, family, texture, color };
  }

  /**
   * Material matching the normalized shader family from Unity. `doubleSided`
   * is decided per mesh (see isPlanarGeometry) rather than per material,
   * because the same Unity material is shared between flat wall panels and
   * closed building volumes.
   */
  getMaterial(unityMatName: string, doubleSided = false): THREE.Material {
    const key = `${unityMatName}:${doubleSided ? 1 : 0}`;
    let material = this.materialCache.get(key);
    if (material) return material;

    const { info, family, texture, color } = this.materialInfo(unityMatName);
    switch (family) {
      case 'curvedAlpha':
        material = makeCurvedMaterial({
          map: texture,
          color,
          vertexColors: !texture,
          transparent: true,
          depthWrite: false,
          doubleSided,
        });
        break;
      case 'curvedCloud':
        material = makeCurvedMaterial({
          map: texture,
          color,
          vertexColors: !texture,
          depthWrite: false,
          doubleSided,
        });
        break;
      case 'blinking':
        material = makeCharacterMaterial(texture, color, doubleSided);
        break;
      case 'vertexColor':
        material = makeVertexColorMaterial(doubleSided);
        break;
      case 'standard':
        material = makeStandardMaterial(texture, color, !texture, doubleSided);
        break;
      case 'curvedOpaque':
        material = makeCurvedMaterial({ map: texture, color, vertexColors: !texture, doubleSided });
        break;
    }

    material.name = unityMatName;
    material.userData.shaderFamily = family;
    material.userData.sourceShader = info?.shader;
    this.materialCache.set(key, material);
    return material;
  }

  /** Replace loaded GLB materials while preserving Unity's ordered slots. */
  applyMaterials(obj: THREE.Object3D, unityMaterials: string[] | undefined): void {
    // FBX2glTF represents a Unity mesh with multiple material slots in either
    // of two ways: one Three mesh with geometry groups, or one child mesh per
    // glTF primitive. Preserve the converter's original material name when it
    // is available, and use primitive order only as a fallback. Assigning slot
    // zero to every split primitive makes the textured brick/plaster faces of
    // buildings render with VCOL instead, which appears as a flat white hole.
    let primitiveIndex = 0;
    const materialKey = (name: string) => name.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
    const authoredByName = new Map(
      (unityMaterials ?? []).map((name) => [materialKey(name), name] as const)
    );

    obj.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const hasVertexColor = !!child.geometry.getAttribute('color');
      const flat = isPlanarGeometry(child.geometry);
      if (unityMaterials?.length) {
        const sourceSlots = Array.isArray(child.material) ? child.material : [child.material];
        let assignedNames: string[];

        if (child.geometry.groups.length > 1 && sourceSlots.length === 1) {
          // Some loaders keep grouped primitives in one mesh even when the
          // placeholder source material array has been collapsed.
          assignedNames = unityMaterials;
          primitiveIndex += unityMaterials.length;
        } else {
          assignedNames = sourceSlots.map((sourceMaterial) => {
            const sourceName = sourceMaterial?.name ?? '';
            const matched = authoredByName.get(materialKey(sourceName));
            const fallback = unityMaterials[Math.min(primitiveIndex, unityMaterials.length - 1)];
            primitiveIndex += 1;
            return matched ?? fallback;
          });
        }

        const slots = assignedNames.map((name) => this.getMaterial(name, flat));
        child.material = Array.isArray(child.material) || child.geometry.groups.length > 1
          ? slots
          : slots[0];
        if (slots.some((slot) => slot.userData.shaderFamily === 'curvedCloud')) {
          child.renderOrder = -1;
        }
      } else {
        // Missing metadata is kept visible and follows the curved-world path.
        child.material = makeCurvedMaterial({ vertexColors: hasVertexColor, doubleSided: flat });
      }
      const assigned = Array.isArray(child.material) ? child.material : [child.material];
      // Curved wall sheets move downward in the vertex shader, outside their
      // CPU-side bounds. Disable frustum culling for those sheets so a wall
      // cannot pop out for a frame and expose the clear colour beside the road.
      if (
        flat &&
        assigned.some((slot) =>
          ['curvedOpaque', 'curvedAlpha', 'curvedCloud'].includes(slot.userData.shaderFamily)
        )
      ) {
        child.frustumCulled = false;
      }
      // The port deliberately does not enable Unity's real-time shadows.
      child.castShadow = false;
      child.receiveShadow = false;
    });
  }

  /** Pre-load every enabled model referenced by a prefab node tree. */
  async preloadTree(node: PrefabNode): Promise<void> {
    const paths: string[] = [];
    const walk = (current: PrefabNode) => {
      if (current.model && current.rendererEnabled !== false) paths.push(current.model);
      if (current.rendererEnabled !== false) {
        for (const name of current.materials ?? []) {
          const texture = MATERIALS[name]?.texture;
          if (texture) this.getTexture(texture);
        }
      }
      current.children?.forEach(walk);
    };
    walk(node);
    await Promise.all([...new Set(paths)].map((path) => this.loadModel(path)));
  }

  private selectAuthoredMesh(root: THREE.Object3D, node: PrefabNode): void {
    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => {
      if (child instanceof THREE.Mesh) meshes.push(child);
    });
    if (!node.mesh) return;

    // Match the extracted mesh name, falling back to the FBX asset basename,
    // which the converter commonly uses as the node name.
    const assetName = node.mesh.asset
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '');
    const requestedNames = [node.mesh.name, assetName].filter(
      (name): name is string => !!name
    );
    const byName = requestedNames.flatMap((requestedName) => {
      const exact = meshes.filter((mesh) => mesh.name === requestedName);
      if (exact.length) return exact;
      return meshes.filter(
        (mesh) => mesh.name.toLocaleLowerCase() === requestedName.toLocaleLowerCase()
      );
    });
    const selected = [...new Set(byName)];
    // A failed name match should not make the renderer silently disappear.
    // Extraction validation owns unresolved-reference failures.
    if (!selected.length) return;
    const selectedSet = new Set(selected);
    for (const mesh of meshes) mesh.visible = selectedSet.has(mesh);
  }

  /**
   * Sibling nodes that pull *distinct* meshes out of one model file are the
   * parts of a single imported FBX (a car body plus its two wheel sets, say).
   * FBX2glTF bakes each part's pivot into the exported node/vertices, so the
   * GLB already assembles itself correctly at the parent's origin — replaying
   * Unity's per-part transforms on top of that flings the parts apart. Repeated
   * instances of the *same* mesh (the night themes' light-glow quads) are real
   * separate placements and keep their transforms.
   */
  private multiPartInstances(children: PrefabNode[]): Map<string, PrefabNode[]> {
    const byModel = new Map<string, PrefabNode[]>();
    for (const child of children) {
      if (!child.model || child.children?.length) continue;
      const list = byModel.get(child.model) ?? [];
      list.push(child);
      byModel.set(child.model, list);
    }
    for (const [model, parts] of [...byModel]) {
      const meshNames = new Set(
        parts.map((p) => p.mesh?.name).filter((name): name is string => !!name)
      );
      if (parts.length < 2 || meshNames.size < 2) byModel.delete(model);
    }
    return byModel;
  }

  /** Instantiate every part of a multi-part FBX instance from one clone. */
  private instantiateWholeModel(model: string, parts: PrefabNode[]): THREE.Object3D | null {
    const source = this.models.get(model);
    if (!source) return null;
    const whole = cloneSkinned(source);
    whole.name = model.split('/').pop() ?? model;
    const hidden = new Set(
      parts
        .filter((p) => p.rendererEnabled === false)
        .map((p) => p.mesh?.name)
        .filter((name): name is string => !!name)
    );
    if (hidden.size) {
      whole.traverse((child) => {
        if (child instanceof THREE.Mesh && hidden.has(child.name)) child.visible = false;
      });
    }
    const materials = [...new Set(parts.flatMap((p) => p.materials ?? []))];
    this.applyMaterials(whole, materials.length ? materials : undefined);
    return whole;
  }

  /** Instantiate a prefab node tree (models must be preloaded). */
  instantiateTree(node: PrefabNode): THREE.Object3D {
    const object = new THREE.Group();
    object.name = node.name;
    object.position.set(...node.pos);
    object.quaternion.set(...node.rot);
    object.scale.set(...node.scale);
    object.userData.unityMesh = node.mesh;

    if (node.model && node.rendererEnabled !== false) {
      const source = this.models.get(node.model);
      if (source) {
        const mesh = cloneSkinned(source);
        this.selectAuthoredMesh(mesh, node);
        this.applyMaterials(mesh, node.materials);
        object.add(mesh);
      }
    }
    const children = node.children ?? [];
    const multiPart = this.multiPartInstances(children);
    const absorbed = new Set<PrefabNode>();
    for (const [model, parts] of multiPart) {
      const whole = this.instantiateWholeModel(model, parts);
      if (!whole) continue;
      object.add(whole);
      for (const part of parts) absorbed.add(part);
    }
    for (const child of children) {
      if (absorbed.has(child)) continue;
      object.add(this.instantiateTree(child));
    }
    return object;
  }
}

export const assets = new AssetManager();
