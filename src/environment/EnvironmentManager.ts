import * as THREE from 'three';
import { assets, type PrefabNode } from '../core/AssetManager';
import { FOG_FAR, FOG_NEAR, PARALLAX_RATIO } from '../core/consts';
import type { ThemeData, TrackManager } from '../track/TrackManager';

const DEFAULT_SKY_TRANSFORM = {
  pos: [0, -7.1, 0] as [number, number, number],
  rot: [0, 0, 0, 1] as [number, number, number, number],
  scale: [2.8936646, 0.96334445, 2.8936641] as [number, number, number],
};

interface CloudTemplate {
  name: string;
  create: () => THREE.Object3D;
}

function legacyCloudPath(themeKey: string, name: string): string {
  const match = name.match(/(\d+)$/);
  const number = match?.[1] ?? '01';
  return themeKey === 'night'
    ? `models/NightTime/Cloud${number}Night`
    : `models/Daytime/Cloud${number}`;
}

/** Owns the Unity-authored sky mesh and recyclable parallax cloud field. */
export class EnvironmentManager {
  private readonly skyRoot = new THREE.Group();
  private readonly parallaxRoot = new THREE.Group();
  private cloudTemplates: CloudTemplate[] = [];
  private theme?: ThemeData;
  private themeKey = 'day';
  private revision = 0;
  private runnerPosition = new THREE.Vector3();

  /**
   * The Unity themes ship a flat vertex-coloured sky mesh. It reads as a pale
   * lavender wall behind the night theme and adds nothing to the day theme, so
   * the renderer's own gradient dome replaces it by default; pass true to
   * restore the authored mesh.
   */
  constructor(
    private readonly scene: THREE.Scene,
    track: TrackManager,
    private readonly random: () => number = Math.random,
    private readonly useThemeSky = false
  ) {
    this.skyRoot.name = 'SkyEnvironment';
    this.parallaxRoot.name = 'CloudParallaxRoot';
    scene.add(this.skyRoot, this.parallaxRoot);

    track.events.addEventListener('runnerMoved', ((event: CustomEvent) => {
      const { travelDelta, recenterOffset, position } = event.detail as {
        travelDelta: THREE.Vector3;
        recenterOffset: THREE.Vector3;
        position: THREE.Vector3;
      };
      this.moveClouds(travelDelta, recenterOffset, position);
    }) as EventListener);
    track.events.addEventListener('reset', ((event: CustomEvent) => {
      this.runnerPosition.copy((event.detail as { position: THREE.Vector3 }).position);
      this.skyRoot.position.copy(this.runnerPosition);
      this.resetClouds();
    }) as EventListener);
  }

  get state(): Readonly<{ theme: string; clouds: number; skyLoaded: boolean }> {
    return {
      theme: this.themeKey,
      clouds: this.parallaxRoot.children.length,
      skyLoaded: this.skyRoot.children.length > 0,
    };
  }

  async setTheme(themeKey: string, theme: ThemeData): Promise<void> {
    const revision = ++this.revision;
    this.theme = theme;
    this.themeKey = themeKey;
    this.skyRoot.clear();
    this.parallaxRoot.clear();
    this.cloudTemplates = [];

    const color = new THREE.Color(...theme.fogColor);
    this.scene.background = color;
    this.scene.fog = new THREE.Fog(color, theme.fogStart ?? FOG_NEAR, theme.fogEnd ?? FOG_FAR);

    const work: Promise<void>[] = [];
    if (theme.skyModel && this.useThemeSky) {
      work.push(assets.loadModel(theme.skyModel).then(() => undefined));
    }
    for (const cloud of theme.cloudPrefabs ?? []) {
      work.push(assets.preloadTree(cloud.root));
    }
    const legacyCloudPaths = (theme.cloudModels ?? []).map((name) => ({
      name,
      path: legacyCloudPath(themeKey, name),
    }));
    for (const cloud of legacyCloudPaths) {
      work.push(assets.loadModel(cloud.path).then(() => undefined));
    }
    await Promise.all(work);
    if (revision !== this.revision) return;

    if (theme.skyModel && this.useThemeSky) {
      const source = assets.getLoadedModel(theme.skyModel);
      if (source) {
        const sky = source.clone(true);
        sky.name = `${themeKey}-sky`;
        assets.applyMaterials(sky, ['Sky']);
        sky.traverse((child) => {
          if (child instanceof THREE.Mesh) child.frustumCulled = false;
        });
        const transform = theme.skyTransform ?? DEFAULT_SKY_TRANSFORM;
        sky.position.set(...transform.pos);
        sky.quaternion.set(...transform.rot);
        sky.scale.set(...transform.scale);
        this.skyRoot.add(sky);
      }
    }
    // In Main.unity the gameplay Sky prefab is parented to the character
    // controller, so its authored transform is local to the runner.
    this.skyRoot.position.copy(this.runnerPosition);

    for (const cloud of theme.cloudPrefabs ?? []) {
      this.cloudTemplates.push({
        name: cloud.name,
        create: () => assets.instantiateTree(cloud.root),
      });
    }
    // Compatibility with themes generated before full prefab extraction.
    if (this.cloudTemplates.length === 0) {
      for (const cloud of legacyCloudPaths) {
        this.cloudTemplates.push({
          name: cloud.name,
          create: () => {
            const object = assets.getLoadedModel(cloud.path)?.clone(true) ?? new THREE.Group();
            assets.applyMaterials(object, ['CloudMaterial']);
            return object;
          },
        });
      }
    }
    this.resetClouds();
  }

  private resetClouds(): void {
    this.parallaxRoot.clear();
    if (!this.theme || this.cloudTemplates.length === 0) return;
    const target = this.theme.cloudNumber ?? 20;
    while (this.parallaxRoot.children.length < target) this.spawnCloud();
  }

  private spawnCloud(): void {
    if (!this.theme || this.cloudTemplates.length === 0) return;
    const minimum = this.theme.cloudMinimumDistance ?? [0, 10, 10];
    const spread = this.theme.cloudSpread ?? [20, 1, 20];
    const template = this.cloudTemplates[Math.floor(this.random() * this.cloudTemplates.length)];
    const cloud = template.create();
    cloud.name = template.name;
    const lastZ = this.parallaxRoot.children.reduce(
      (furthest, child) => Math.max(furthest, child.position.z),
      this.runnerPosition.z
    );
    cloud.position.set(
      this.runnerPosition.x + minimum[0] + (this.random() - 0.5) * spread[0],
      minimum[1] + (this.random() - 0.5) * spread[1],
      lastZ + minimum[2] + (this.random() - 0.5) * spread[2]
    );
    cloud.scale.multiplyScalar(1 + (this.random() - 0.5) * 0.5);
    cloud.rotation.y += this.random() * Math.PI * 2;
    this.parallaxRoot.add(cloud);
  }

  private moveClouds(travelDelta: THREE.Vector3, recenterOffset: THREE.Vector3, position: THREE.Vector3): void {
    if (!this.theme) return;
    const delta = travelDelta
      .clone()
      .multiplyScalar(this.theme.parallaxRatio ?? PARALLAX_RATIO)
      .add(recenterOffset);
    for (const cloud of [...this.parallaxRoot.children]) {
      cloud.position.add(delta);
      if (cloud.position.z - position.z < -50) this.parallaxRoot.remove(cloud);
    }
    this.runnerPosition.copy(position);
    this.skyRoot.position.copy(position);
    const target = this.theme.cloudNumber ?? 20;
    while (this.parallaxRoot.children.length < target) this.spawnCloud();
  }
}

// Used by schema authors without requiring a runtime AssetManager dependency.
export type CloudPrefabData = { name: string; root: PrefabNode };
