import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assets, type PrefabNode } from '../core/AssetManager';
import type { TrackSegment } from '../track/TrackSegment';
import { LANE_OFFSET, MISSILE_SPEED } from '../core/consts';
import { makeCurvedMaterial } from '../rendering/CurvedMaterial';
import obstaclesJson from '../data/obstacles.json';

export interface ObstacleDef {
  type: 'simpleBarricade' | 'allLane' | 'patrolling' | 'missile';
  minTime?: number;
  maxTime?: number;
  root: PrefabNode;
}

const OBSTACLES = obstaclesJson as unknown as Record<string, Record<string, ObstacleDef>>;

export function obstacleDef(theme: string, name: string): ObstacleDef | undefined {
  return OBSTACLES[theme]?.[name];
}

export async function preloadObstacles(theme: string): Promise<void> {
  const barrier = theme === 'night'
    ? 'models/NightTime/RoadWorksBarrier01Night'
    : 'models/Daytime/RoadWorksBarrier01';
  await Promise.all([
    ...Object.values(OBSTACLES[theme] ?? {}).map((def) => assets.preloadTree(def.root)),
    assets.loadModel('models/Rat'),
    assets.loadModel('anim/Rat_Run'),
    assets.loadModel(barrier),
  ]);
}

const tmpPos = new THREE.Vector3();
const tmpRot = new THREE.Quaternion();
const right = new THREE.Vector3();
const colliderCenter = new THREE.Vector3();
const colliderSize = new THREE.Vector3();

export interface ObstacleColliderProfile {
  center: readonly [number, number, number];
  size: readonly [number, number, number];
}

/**
 * Gameplay volumes for obstacles whose rendered mesh bounds do not describe
 * the space that should hurt the runner. Skinned rat bounds include its bind
 * pose and shadow, making it taller than the jump. The high barrier's visual
 * AABB includes the two side supports, incorrectly filling the opening that
 * the runner is meant to slide through.
 */
const COLLIDER_PROFILES: Readonly<Record<string, ObstacleColliderProfile>> = {
  ObstacleRat: { center: [0, 0.275, 0], size: [0.75, 0.55, 0.65] },
  ObstacleHighBarrier: { center: [0, 1.32, 0], size: [4.9, 0.84, 0.5] },
  ObstacleLowBarrier: { center: [0, 0.36, 0], size: [4.1, 0.74, 0.5] },
};

export function obstacleColliderProfile(name: string): ObstacleColliderProfile | undefined {
  return COLLIDER_PROFILES[name];
}

/** Build a world AABB from an obstacle's stable, local gameplay volume. */
export function setObstacleColliderBox(
  box: THREE.Box3,
  object: THREE.Object3D,
  profile: ObstacleColliderProfile
): void {
  object.updateWorldMatrix(true, false);
  box
    .setFromCenterAndSize(
      colliderCenter.fromArray(profile.center),
      colliderSize.fromArray(profile.size)
    )
    .applyMatrix4(object.matrixWorld);
}

/** Collect every model path / material name referenced in a prefab node tree. */
function collectRefs(node: PrefabNode, models: string[] = [], materials: string[] = []) {
  if (node.model) models.push(node.model);
  for (const m of node.materials ?? []) materials.push(m);
  node.children?.forEach((c) => collectRefs(c, models, materials));
  return { models, materials };
}

function hasMesh(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.visible) found = true;
  });
  return found;
}

/** Skin the rat for the theme and loop its run cycle (ticked by the segment). */
function withRatRunCycle(root: THREE.Object3D, rat: THREE.Object3D, theme: string): THREE.Object3D {
  assets.applyMaterials(rat, [theme === 'night' ? 'RatNight' : 'Rat']);
  const clip = assets.getAnimations('anim/Rat_Run')[0];
  if (clip) {
    const mixer = new THREE.AnimationMixer(rat);
    mixer.clipAction(clip).play();
    root.userData.animationMixer = mixer;
  }
  return root;
}

function buildRat(theme: string): THREE.Object3D {
  const source = assets.getLoadedModel('models/Rat');
  if (!source) return new THREE.Group();
  const root = new THREE.Group();
  const rat = cloneSkinned(source);
  rat.rotation.y = -Math.PI / 2;
  root.add(rat);
  return withRatRunCycle(root, rat, theme);
}

function buildRoadworksBarrier(theme: string): THREE.Object3D {
  const path = theme === 'night'
    ? 'models/NightTime/RoadWorksBarrier01Night'
    : 'models/Daytime/RoadWorksBarrier01';
  const root = new THREE.Group();
  const source = assets.getLoadedModel(path);
  if (!source) return root;
  const barrier = source.clone(true);
  barrier.position.x = -0.648;
  assets.applyMaterials(barrier, ['VCOL']);
  root.add(barrier);
  return root;
}

/** Temporary low-poly stand-in used only while the Git-LFS dog mesh is absent. */
function buildDogProxy(theme: string): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'ProceduralDogProxy';
  root.scale.setScalar(1.25);
  const fur = makeCurvedMaterial({ color: theme === 'night' ? 0x5a3d32 : 0x9b633f });
  const dark = makeCurvedMaterial({ color: 0x2b201c });
  const addBox = (name: string, size: [number, number, number], pos: [number, number, number], material = fur) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...pos);
    root.add(mesh);
    return mesh;
  };
  addBox('Body', [0.55, 0.55, 1.0], [0, 0.58, 0]);
  addBox('Head', [0.55, 0.58, 0.52], [0, 0.86, -0.63]);
  addBox('Muzzle', [0.34, 0.25, 0.32], [0, 0.76, -0.98], dark);
  addBox('FrontLegL', [0.16, 0.52, 0.18], [-0.19, 0.27, -0.32]);
  addBox('FrontLegR', [0.16, 0.52, 0.18], [0.19, 0.27, -0.32]);
  addBox('BackLegL', [0.18, 0.5, 0.2], [-0.19, 0.26, 0.34]);
  addBox('BackLegR', [0.18, 0.5, 0.2], [0.19, 0.26, 0.34]);
  const earGeometry = new THREE.ConeGeometry(0.16, 0.35, 4);
  for (const x of [-0.18, 0.18]) {
    const ear = new THREE.Mesh(earGeometry, dark);
    ear.position.set(x, 1.25, -0.66);
    ear.rotation.y = Math.PI / 4;
    root.add(ear);
  }
  const tail = addBox('Tail', [0.17, 0.17, 0.8], [0, 0.7, 0.78]);
  tail.rotation.x = -0.5;
  return root;
}

function buildVisual(def: ObstacleDef, name: string, theme: string): THREE.Object3D {
  const { models, materials } = collectRefs(def.root);
  // Animated obstacles (bins etc.) nest FBX model-prefab instances that the
  // YAML extractor can't fully resolve; their anim/ GLB already contains the
  // complete assembled visual, so instantiate it whole instead of the tree.
  const animModel = models.find((m) => m.startsWith('anim/'));
  if (animModel) {
    const src = assets.getLoadedModel(animModel);
    if (src) {
      const obj = src.clone();
      assets.applyMaterials(obj, materials.length ? [...new Set(materials)] : undefined);
      if (hasMesh(obj)) return obj;
    }
  }
  const extracted = assets.instantiateTree(def.root);
  if (hasMesh(extracted)) {
    return name === 'ObstacleRat' ? withRatRunCycle(extracted, extracted, theme) : extracted;
  }
  if (name === 'ObstacleRat') return buildRat(theme);
  if (name === 'ObstacleRoadworksBarrier') return buildRoadworksBarrier(theme);
  if (name === 'ObstacleDog') return buildDogProxy(theme);
  return extracted;
}

function placeOne(segment: TrackSegment, t: number, lane: number, name: string, def: ObstacleDef): THREE.Object3D {
  const obj = buildVisual(def, name, segment.data.theme);
  // Animated GLBs often expose a generic Root_Scene name. Keep the authored
  // obstacle identity on the instance for collision, audio, and diagnostics.
  obj.name = name;
  segment.getPointAt(t, tmpPos, tmpRot);
  right.set(1, 0, 0).applyQuaternion(tmpRot);
  obj.position.copy(tmpPos).addScaledVector(right, lane * LANE_OFFSET);
  obj.quaternion.copy(tmpRot);
  // Path points are world-space; attach() re-parents under the (possibly
  // mirrored) segment root while preserving the world transform.
  segment.group.updateMatrixWorld(true);
  segment.group.attach(obj);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const profile = obstacleColliderProfile(name);
  const refresh = profile
    ? () => setObstacleColliderBox(box, obj, profile)
    : () => box.setFromObject(obj);
  refresh();
  segment.colliders.push({ box, kind: 'obstacle', obj, refresh });
  const mixer = obj.userData.animationMixer as THREE.AnimationMixer | undefined;
  if (mixer) segment.tickers.push((dt) => mixer.update(dt));
  return obj;
}

/**
 * How much room an obstacle leaves the player, used by the track generator to
 * space the next one fairly. `wall` and `moving` demand a timed reaction;
 * `narrow`/`open` only require being in the right lane.
 */
export type ObstacleDifficulty = 'wall' | 'moving' | 'narrow' | 'open';

export function obstacleDifficulty(theme: string, name: string): ObstacleDifficulty | undefined {
  const def = obstacleDef(theme, name);
  if (!def) return undefined;
  if (def.type === 'allLane') return 'wall';
  if (def.type === 'patrolling' || def.type === 'missile') return 'moving';
  // A simple barricade spawns one or two copies; assume the worst case when
  // deciding whether a candidate is allowed to follow the previous obstacle.
  return 'narrow';
}

/**
 * Port of the Obstacle.Spawn implementations. Registers visuals + AABBs on the
 * segment, and tick functions for moving obstacles. Returns the difficulty the
 * spawn actually produced (a one-lane barricade is easier than a two-lane one).
 */
export function spawnObstacle(
  segment: TrackSegment,
  t: number,
  name: string,
  random: () => number = Math.random
): ObstacleDifficulty | undefined {
  const def = obstacleDef(segment.data.theme, name);
  if (!def) return undefined;

  switch (def.type) {
    case 'allLane': {
      placeOne(segment, t, 0, name, def);
      return 'wall';
    }
    case 'patrolling': {
      const obj = placeOne(segment, t, 0, name, def);
      const collider = segment.colliders[segment.colliders.length - 1];
      const actualTime = THREE.MathUtils.lerp(def.minTime ?? 2, def.maxTime ?? 5, random());
      // Crosses all lanes (2 * laneOffset wide) back and forth in actualTime.
      const speed = (LANE_OFFSET * 2 * 2) / actualTime;
      const rightDir = new THREE.Vector3(1, 0, 0);
      let time = random() * actualTime;
      const base = obj.position.clone();
      segment.tickers.push((dt) => {
        time += dt;
        // Mathf.PingPong(time * speed, 2 * laneOffset) - laneOffset
        const ping = Math.abs((((time * speed) % (4 * LANE_OFFSET)) + 4 * LANE_OFFSET) % (4 * LANE_OFFSET) - 2 * LANE_OFFSET) - LANE_OFFSET;
        obj.position.copy(base).addScaledVector(rightDir, ping);
        collider.refresh?.();
      });
      return 'moving';
    }
    case 'missile': {
      const obj = placeOne(segment, t, Math.floor(random() * 3) - 1, name, def);
      const collider = segment.colliders[segment.colliders.length - 1];
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(obj.quaternion);
      let active = false;
      segment.tickers.push((dt) => {
        // Activates once the player is one segment away (approximated by tick order).
        active = active || segment.playerNearby;
        if (!active) return;
        obj.position.addScaledVector(forward, MISSILE_SPEED * dt);
        collider.refresh?.();
      });
      return 'moving';
    }
    default: {
      // SimpleBarricade: 1-2 copies in adjacent lanes from a random start lane.
      const count = 1 + Math.floor(random() * 2);
      let lane = Math.floor(random() * 3) - 1;
      for (let i = 0; i < count; i++) {
        placeOne(segment, t, lane, name, def);
        lane = lane + 1 > 1 ? -1 : lane + 1;
      }
      return count > 1 ? 'narrow' : 'open';
    }
  }
}
