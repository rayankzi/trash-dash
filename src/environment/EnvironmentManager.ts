import * as THREE from 'three';
import { assets } from '../core/AssetManager';
import { PARALLAX_RATIO } from '../core/consts';
import type { ThemeData } from '../data/themes';
import type { TrackManager } from '../track/TrackManager';

/** Clouds behind the runner by more than this are recycled to the front. */
const CLOUD_RECYCLE_DISTANCE = -50;

/**
 * The theme's parallax cloud field. Clouds drift at `parallaxRatio` of the
 * runner's speed, and ones that fall behind are moved back out in front
 * rather than re-instantiated. Sky and fog belong to SkyDome / ThemeLook.
 */
export class EnvironmentManager {
  private readonly parallaxRoot = new THREE.Group();
  private templates: (() => THREE.Object3D)[] = [];
  private theme?: ThemeData;
  private themeKey = 'day';
  private revision = 0;
  private readonly runnerPosition = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    track: TrackManager,
    private readonly random: () => number = Math.random
  ) {
    this.parallaxRoot.name = 'CloudParallaxRoot';
    scene.add(this.parallaxRoot);

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
      this.resetClouds();
    }) as EventListener);
  }

  get state(): Readonly<{ theme: string; clouds: number }> {
    return { theme: this.themeKey, clouds: this.parallaxRoot.children.length };
  }

  async setTheme(themeKey: string, theme: ThemeData): Promise<void> {
    const revision = ++this.revision;
    this.theme = theme;
    this.themeKey = themeKey;
    this.parallaxRoot.clear();
    this.templates = [];

    const clouds = theme.cloudPrefabs ?? [];
    await Promise.all(clouds.map((cloud) => assets.preloadTree(cloud.root)));
    // A newer theme switch started while this one was loading.
    if (revision !== this.revision) return;

    this.templates = clouds.map((cloud) => () => {
      const object = assets.instantiateTree(cloud.root);
      object.name = cloud.name;
      object.userData.authoredScale = object.scale.clone();
      return object;
    });
    this.resetClouds();
  }

  private get cloudCount(): number {
    return this.templates.length ? (this.theme?.cloudNumber ?? 20) : 0;
  }

  private resetClouds(): void {
    this.parallaxRoot.clear();
    for (let i = 0; i < this.cloudCount; i++) {
      const template = this.templates[Math.floor(this.random() * this.templates.length)];
      const cloud = template();
      this.placeCloud(cloud);
      this.parallaxRoot.add(cloud);
    }
  }

  /** Put a cloud a random step beyond the furthest one (Unity's spawn rule). */
  private placeCloud(cloud: THREE.Object3D): void {
    const theme = this.theme!;
    const minimum = theme.cloudMinimumDistance ?? [0, 10, 10];
    const spread = theme.cloudSpread ?? [20, 1, 20];
    let furthest = this.runnerPosition.z;
    for (const other of this.parallaxRoot.children) {
      if (other !== cloud) furthest = Math.max(furthest, other.position.z);
    }
    cloud.position.set(
      this.runnerPosition.x + minimum[0] + (this.random() - 0.5) * spread[0],
      minimum[1] + (this.random() - 0.5) * spread[1],
      furthest + minimum[2] + (this.random() - 0.5) * spread[2]
    );
    cloud.scale.copy(cloud.userData.authoredScale).multiplyScalar(1 + (this.random() - 0.5) * 0.5);
    cloud.rotation.y += this.random() * Math.PI * 2;
  }

  private moveClouds(travelDelta: THREE.Vector3, recenterOffset: THREE.Vector3, position: THREE.Vector3): void {
    if (!this.theme) return;
    this.delta.copy(travelDelta).multiplyScalar(this.theme.parallaxRatio ?? PARALLAX_RATIO).add(recenterOffset);
    this.runnerPosition.copy(position);
    for (const cloud of this.parallaxRoot.children) {
      cloud.position.add(this.delta);
      if (cloud.position.z - position.z < CLOUD_RECYCLE_DISTANCE) this.placeCloud(cloud);
    }
  }
}
