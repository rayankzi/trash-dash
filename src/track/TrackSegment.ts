import * as THREE from 'three';
import { assets, type PrefabNode } from '../core/AssetManager';
import { makeCurvedMaterial } from '../rendering/CurvedMaterial';
import { ROAD_RIBBON_HALF_WIDTH, ROAD_RIBBON_Y_OFFSET } from '../core/consts';

export interface SegmentData {
  name: string;
  theme: string;
  path: {
    parentPos: [number, number, number];
    parentRot: [number, number, number, number];
    nodes: { pos: [number, number, number]; rot: [number, number, number, number] }[];
  };
  obstaclePositions: number[];
  possibleObstacles: string[];
  root: PrefabNode;
}

const tmpV = new THREE.Vector3();
const ribbonGeometries = new Map<string, THREE.BufferGeometry>();
const ribbonMaterials = new Map<string, THREE.Material>();

/**
 * A live track segment: instantiated visuals plus the path sampling used to
 * position the character. Port of TrackSegment.cs — GetPointAt lerps between
 * consecutive path-node world positions.
 */
export class TrackSegment {
  readonly data: SegmentData;
  readonly group: THREE.Group; // root transform (mirroring lives here)
  readonly objectRoot: THREE.Group; // inverse-scaled child holding obstacles/coins
  private pathWorld: { pos: THREE.Vector3; rot: THREE.Quaternion }[] = [];
  worldLength = 0;
  /** True while the runner is on this segment or the next; gates obstacle ticks. */
  playerNearby = false;

  /** Obstacles/coins register their AABBs here for collision. */
  readonly colliders: {
    box: THREE.Box3;
    kind: 'obstacle' | 'coin' | 'premium' | 'powerup';
    obj: THREE.Object3D;
    data?: unknown;
    /** Rebuild a moving collider from its authored gameplay bounds. */
    refresh?: () => void;
  }[] = [];
  /** Per-frame tick hooks for animated obstacles (patrolling, missile). */
  readonly tickers: ((dt: number) => void)[] = [];

  constructor(data: SegmentData) {
    this.data = data;
    this.group = assets.instantiateTree(data.root) as THREE.Group;
    // Original prefab root's own transform is authored identity; keep it so.
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);

    this.objectRoot = new THREE.Group();
    this.objectRoot.name = 'objectRoot';
    this.group.add(this.objectRoot);
    this.group.add(this.createRoadRibbon());
  }

  /**
   * Thin underlay beneath the three playable lanes. This is deliberately much
   * narrower than the road models: it hides rasterization cracks without
   * masking missing sidewalks, buildings, or extraction failures.
   */
  private createRoadRibbon(): THREE.Mesh {
    const { parentPos, parentRot, nodes } = this.data.path;
    const geometryKey = JSON.stringify({ parentPos, parentRot, nodes });
    let geometry = ribbonGeometries.get(geometryKey);
    if (!geometry) {
      geometry = new THREE.BufferGeometry();
      ribbonGeometries.set(geometryKey, geometry);
    }
    const materialKey = this.data.theme === 'night' ? 'night' : 'day';
    let material = ribbonMaterials.get(materialKey);
    if (!material) {
      material = makeCurvedMaterial({ color: materialKey === 'night' ? 0x343542 : 0x65616b });
      ribbonMaterials.set(materialKey, material);
    }

    if (!geometry.getAttribute('position')) {
      const parentQ = new THREE.Quaternion(...parentRot);
      const parentP = new THREE.Vector3(...parentPos);
      const positions: number[] = [];
      const indices: number[] = [];

      for (const node of nodes) {
        const center = new THREE.Vector3(...node.pos).applyQuaternion(parentQ).add(parentP);
        center.y -= ROAD_RIBBON_Y_OFFSET;
        const rotation = new THREE.Quaternion(...node.rot).premultiply(parentQ);
        const laneRight = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).normalize();
        const left = center.clone().addScaledVector(laneRight, -ROAD_RIBBON_HALF_WIDTH);
        const rightEdge = center.clone().addScaledVector(laneRight, ROAD_RIBBON_HALF_WIDTH);
        positions.push(left.x, left.y, left.z, rightEdge.x, rightEdge.y, rightEdge.z);
      }
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }

      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
    }
    const ribbon = new THREE.Mesh(geometry, material);
    ribbon.name = 'PlayableLaneSeamGuard';
    ribbon.renderOrder = -100;
    return ribbon;
  }

  /** Apply Unity's random mirroring: root x = ±1, objectRoot compensates. */
  setMirror(mirrored: boolean): void {
    this.group.scale.x = mirrored ? -1 : 1;
    this.objectRoot.scale.x = mirrored ? -1 : 1;
  }

  /** Recompute cached world-space path points; call after transform changes. */
  updatePath(): void {
    this.group.updateMatrixWorld(true);
    const { parentPos, parentRot, nodes } = this.data.path;
    const parentQ = new THREE.Quaternion(...parentRot);
    this.pathWorld = nodes.map((n) => {
      const local = new THREE.Vector3(...n.pos).applyQuaternion(parentQ).add(new THREE.Vector3(...parentPos));
      const pos = local.applyMatrix4(this.group.matrixWorld);
      const rot = new THREE.Quaternion(...n.rot)
        .premultiply(parentQ)
        .premultiply(this.group.getWorldQuaternion(new THREE.Quaternion()));
      return { pos, rot };
    });
    this.worldLength = 0;
    for (let i = 1; i < this.pathWorld.length; i++) {
      this.worldLength += this.pathWorld[i].pos.distanceTo(this.pathWorld[i - 1].pos);
    }
  }

  getPointAt(t: number, outPos: THREE.Vector3, outRot: THREE.Quaternion): void {
    const nodes = this.pathWorld;
    const clamped = THREE.MathUtils.clamp(t, 0, 1);
    const scaled = (nodes.length - 1) * clamped;
    const index = Math.floor(scaled);
    if (index >= nodes.length - 1) {
      outPos.copy(nodes[nodes.length - 1].pos);
      outRot.copy(nodes[nodes.length - 1].rot);
      return;
    }
    const segT = scaled - index;
    outPos.lerpVectors(nodes[index].pos, nodes[index + 1].pos, segT);
    outRot.slerpQuaternions(nodes[index].rot, nodes[index + 1].rot, segT);
  }

  getPointAtInWorldUnit(worldUnits: number, outPos: THREE.Vector3, outRot: THREE.Quaternion): void {
    this.getPointAt(worldUnits / this.worldLength, outPos, outRot);
  }

  /** World position of the entry point (t = 0). */
  entryPoint(): THREE.Vector3 {
    const q = new THREE.Quaternion();
    this.getPointAt(0, tmpV, q);
    return tmpV.clone();
  }

  translate(offset: THREE.Vector3): void {
    this.group.position.add(offset);
    for (const p of this.pathWorld) p.pos.add(offset);
    for (const c of this.colliders) c.box.translate(offset);
  }
}
