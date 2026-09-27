import * as THREE from 'three';
import { TrackSegment, type SegmentData } from './TrackSegment';
import {
  spawnObstacle,
  preloadObstacles,
  obstacleDifficulty,
  type ObstacleDifficulty,
} from '../obstacles/Obstacles';
import { coinPool } from '../coins/CoinPool';
import { assets } from '../core/AssetManager';
import {
  MIN_SPEED,
  MAX_SPEED,
  ACCELERATION,
  SPEED_STEP,
  DESIRED_SEGMENT_COUNT,
  STARTING_SAFE_DISTANCE,
  OBSTACLE_GAPS,
  SEGMENT_REMOVAL_DISTANCE,
  FLOATING_ORIGIN_THRESHOLD_SQ,
  COIN_STEP,
  LANE_OFFSET,
  POWERUP_CHANCE_RATE,
  PREMIUM_CHANCE_RATE,
  STARTING_SEGMENT_DISTANCE,
} from '../core/consts';
import { THEMES, isThemeKey, type ThemeData, type ThemeKey } from '../data/themes';


export interface TrackManagerOptions {
  random?: () => number;
  segment?: string;
  mirror?: boolean;
}

// Segment JSONs are bundled eagerly via Vite glob import.
const segmentModules = import.meta.glob('../data/segments/*/*.json', { eager: true }) as Record<
  string,
  { default: SegmentData }
>;

function segmentData(theme: string, name: string): SegmentData | undefined {
  return segmentModules[`../data/segments/${theme}/${name}.json`]?.default;
}

const tmpPos = new THREE.Vector3();
const tmpRot = new THREE.Quaternion();
const right = new THREE.Vector3();
const travelDelta = new THREE.Vector3();
const recenterOffset = new THREE.Vector3();
const COIN_BOX_SIZE = new THREE.Vector3(0.8, 0.8, 0.8);
/** Street length stitched on behind the start line for the menu camera. */
const BACKDROP_LENGTH = 45;

/**
 * Port of TrackManager.cs: owns speed/score, the rolling segment queue,
 * character placement along the path, floating origin, and pickup spawning.
 */
export class TrackManager {
  readonly events = new EventTarget();

  speed = MIN_SPEED;
  isMoving = false;
  worldDistance = 0;
  score = 0;
  private scoreAccum = 0;
  multiplier = 1;
  /** External multiplier modifiers (score x2 consumable). */
  modifyMultiply: ((m: number) => number)[] = [];

  private theme: ThemeData = THEMES.day;
  private themeKey: ThemeKey = 'day';
  private currentZone = 0;
  private zoneDistance = 0;
  private segments: TrackSegment[] = [];
  private pastSegments: TrackSegment[] = [];
  private currentSegmentDistance = 0;
  /** Total path length generated this run; the next segment starts here. */
  private generatedLength = 0;
  /** Where along that path the last obstacle went, and how hard it was. */
  private lastObstacleDistance = -Infinity;
  private lastObstacleDifficulty: ObstacleDifficulty | null = null;
  private previousSegmentIndex = -1;
  private timeSincePowerup = 0;
  private timeSinceLastPremium = 0;

  /** Character root that follows the path (controller adds lane/jump locally). */
  readonly characterRoot = new THREE.Object3D();

  private readonly random: () => number;

  constructor(private scene: THREE.Scene, private readonly options: TrackManagerOptions = {}) {
    this.random = options.random ?? Math.random;
    scene.add(this.characterRoot);
  }

  get speedRatio(): number {
    return (this.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  }

  get currentSegment(): TrackSegment | undefined {
    return this.segments[0];
  }

  async begin(themeKey: string): Promise<void> {
    this.themeKey = isThemeKey(themeKey) ? themeKey : 'day';
    this.theme = THEMES[this.themeKey];
    await preloadObstacles(this.themeKey);
    // Preload every segment model of the theme up front (day theme is ~4MB of GLB).
    const names = new Set(this.theme.zones.flatMap((z) => z.segments));
    await Promise.all(
      [...names].map(async (n) => {
        const data = segmentData(this.themeKey, n);
        if (data) await assets.preloadTree(data.root);
      })
    );
    this.reset();
  }

  reset(): void {
    for (const s of [...this.segments, ...this.pastSegments]) this.removeSegment(s);
    this.segments = [];
    this.pastSegments = [];
    this.speed = MIN_SPEED;
    this.worldDistance = 0;
    this.score = 0;
    this.scoreAccum = 0;
    this.multiplier = 1;
    this.currentZone = 0;
    this.zoneDistance = 0;
    this.currentSegmentDistance = STARTING_SEGMENT_DISTANCE;
    this.generatedLength = 0;
    this.lastObstacleDistance = -Infinity;
    this.lastObstacleDifficulty = null;
    this.previousSegmentIndex = -1;
    this.timeSincePowerup = 0;
    this.timeSinceLastPremium = 0;
    this.isMoving = false;
    this.characterRoot.position.set(0, 0, 0);
    this.characterRoot.quaternion.identity();
    while (this.segments.length < DESIRED_SEGMENT_COUNT) this.spawnNewSegment();
    this.spawnBackdrop();
    this.segments[0]?.getPointAtInWorldUnit(this.currentSegmentDistance, tmpPos, tmpRot);
    this.characterRoot.position.copy(tmpPos);
    this.characterRoot.quaternion.copy(tmpRot);
    this.characterRoot.updateMatrixWorld(true);
    coinPool.sync();
    this.events.dispatchEvent(new CustomEvent('reset', { detail: { position: tmpPos.clone() } }));
  }

  startMove(): void {
    this.isMoving = true;
  }

  stopMove(): void {
    this.isMoving = false;
  }

  update(dt: number): void {
    while (this.segments.length < DESIRED_SEGMENT_COUNT) this.spawnNewSegment();

    if (!this.isMoving) return;

    this.speed = Math.min(this.speed + ACCELERATION * dt, MAX_SPEED);
    this.multiplier = 1 + Math.floor(this.speedRatio * SPEED_STEP);

    const scaledSpeed = this.speed * dt;
    this.scoreAccum += scaledSpeed;
    this.zoneDistance += scaledSpeed;
    this.worldDistance += scaledSpeed;
    this.currentSegmentDistance += scaledSpeed;
    this.timeSincePowerup += dt;
    this.timeSinceLastPremium += dt;

    const intScore = Math.floor(this.scoreAccum);
    if (intScore !== 0) this.addScore(intScore);
    this.scoreAccum -= intScore;

    if (this.currentSegmentDistance > this.segments[0].worldLength) {
      this.currentSegmentDistance -= this.segments[0].worldLength;
      const passed = this.segments.shift()!;
      passed.playerNearby = false;
      this.pastSegments.push(passed);
      if (this.segments.length > 0) this.segments[0].playerNearby = true;
    }
    if (this.segments.length > 0) {
      this.segments[0].playerNearby = true;
      if (this.segments.length > 1) this.segments[1].playerNearby = true;
    }

    this.segments[0].getPointAtInWorldUnit(this.currentSegmentDistance, tmpPos, tmpRot);
    travelDelta.subVectors(tmpPos, this.characterRoot.position);
    recenterOffset.set(0, 0, 0);

    // Floating origin: recentre the world when the character strays too far.
    if (tmpPos.lengthSq() > FLOATING_ORIGIN_THRESHOLD_SQ) {
      recenterOffset.copy(tmpPos).negate();
      for (const s of this.segments) s.translate(recenterOffset);
      for (const s of this.pastSegments) s.translate(recenterOffset);
      coinPool.translateActive(recenterOffset);
      this.segments[0].getPointAtInWorldUnit(this.currentSegmentDistance, tmpPos, tmpRot);
      this.events.dispatchEvent(new CustomEvent('recenter', { detail: { offset: recenterOffset.clone() } }));
    }

    this.characterRoot.position.copy(tmpPos);
    this.characterRoot.quaternion.copy(tmpRot);
    this.events.dispatchEvent(
      new CustomEvent('runnerMoved', { detail: { travelDelta, recenterOffset, position: tmpPos } })
    );

    // Retire segments far behind the player.
    for (let i = 0; i < this.pastSegments.length; i++) {
      const s = this.pastSegments[i];
      if (s.group.position.z - tmpPos.z < SEGMENT_REMOVAL_DISTANCE) {
        this.removeSegment(s);
        this.pastSegments.splice(i, 1);
        i--;
      }
    }

    // Animated obstacles on nearby segments.
    for (const s of this.segments) {
      if (s.playerNearby) for (const fn of s.tickers) fn(dt);
    }
    coinPool.tick(dt);
  }

  private addScore(amount: number): void {
    let mult = this.multiplier;
    for (const mod of this.modifyMultiply) mult = mod(mult);
    this.score += amount * mult;
  }

  private spawnNewSegment(): void {
    const zone = this.theme.zones[this.currentZone];
    if (zone.length < this.zoneDistance) this.changeZone();

    const list = this.theme.zones[this.currentZone].segments;
    let index = Math.floor(this.random() * list.length);
    if (index === this.previousSegmentIndex) index = (index + 1) % list.length;
    this.previousSegmentIndex = index;

    const selectedName = this.options.segment && segmentData(this.themeKey, this.options.segment)
      ? this.options.segment
      : list[index];
    const data = segmentData(this.themeKey, selectedName);
    if (!data) return;

    const segment = new TrackSegment(data);

    // Stitch: rotation first, then position so entry aligns with previous exit.
    let exitPoint: THREE.Vector3;
    let exitRotation: THREE.Quaternion;
    if (this.segments.length > 0) {
      exitPoint = new THREE.Vector3();
      exitRotation = new THREE.Quaternion();
      this.segments[this.segments.length - 1].getPointAt(1.0, exitPoint, exitRotation);
    } else {
      exitPoint = new THREE.Vector3();
      exitRotation = new THREE.Quaternion();
    }

    this.scene.add(segment.group);
    segment.group.quaternion.copy(exitRotation);
    segment.updatePath();
    const entry = segment.entryPoint();
    segment.group.position.add(exitPoint.clone().sub(entry));
    segment.setMirror(this.options.mirror ?? this.random() > 0.5);
    segment.updatePath();

    const segmentStart = this.generatedLength;
    this.generatedLength += segment.worldLength;
    this.spawnObstacles(segment, segmentStart);
    this.spawnCoins(segment);

    this.segments.push(segment);
  }

  /**
   * The menu camera looks back down the street at the runner, which starts
   * only a couple of units into the first segment. Stitch obstacle-free
   * segments on *behind* the start so that view has scenery all the way into
   * the fog; they sit in `pastSegments` and retire as soon as the run leaves
   * them behind.
   */
  private spawnBackdrop(): void {
    const first = this.segments[0];
    if (!first) return;
    const list = this.theme.zones[0].segments;
    const entryPos = new THREE.Vector3();
    const entryRot = new THREE.Quaternion();
    const exitPos = new THREE.Vector3();
    const exitRot = new THREE.Quaternion();
    first.getPointAt(0, entryPos, entryRot);

    let covered = 0;
    while (covered < BACKDROP_LENGTH) {
      const name = this.options.segment && segmentData(this.themeKey, this.options.segment)
        ? this.options.segment
        : list[Math.floor(this.random() * list.length)];
      const data = segmentData(this.themeKey, name);
      if (!data) return;
      const segment = new TrackSegment(data);
      this.scene.add(segment.group);
      // Rotate so this segment's exit heading matches the next one's entry,
      // then translate its exit onto that entry point.
      segment.updatePath();
      segment.getPointAt(1, exitPos, exitRot);
      segment.group.quaternion.copy(entryRot).multiply(exitRot.invert());
      segment.updatePath();
      segment.getPointAt(1, exitPos, exitRot);
      segment.group.position.add(entryPos.clone().sub(exitPos));
      segment.updatePath();
      this.pastSegments.push(segment);
      covered += segment.worldLength;
      segment.getPointAt(0, entryPos, entryRot);
    }
  }

  private changeZone(): void {
    this.currentZone = (this.currentZone + 1) % this.theme.zones.length;
    this.zoneDistance = 0;
  }

  /**
   * Fill a segment's authored obstacle slots, but only with obstacles the
   * player can actually reach in time. Each slot's distance along the whole
   * generated path is compared against the previous obstacle: a slot too close
   * behind a wall (or too close for the kinds of obstacle this segment offers)
   * is simply left empty rather than becoming an unavoidable hit.
   */
  private spawnObstacles(segment: TrackSegment, segmentStart: number): void {
    const possible = segment.data.possibleObstacles;
    if (possible.length === 0) return;
    const theme = segment.data.theme;

    for (const t of segment.data.obstaclePositions) {
      const distance = segmentStart + t * segment.worldLength;
      if (distance < STARTING_SEGMENT_DISTANCE + STARTING_SAFE_DISTANCE) continue;

      const gap = distance - this.lastObstacleDistance;
      const allowed = possible.filter((name) => {
        const difficulty = obstacleDifficulty(theme, name);
        return difficulty !== undefined && gap >= this.requiredGap(difficulty);
      });
      if (allowed.length === 0) continue;

      const name = allowed[Math.floor(this.random() * allowed.length)];
      const spawned = spawnObstacle(segment, t, name, this.random);
      if (!spawned) continue;
      this.lastObstacleDistance = distance;
      this.lastObstacleDifficulty = spawned;
    }
  }

  /** Clearance the previous obstacle demands before `next` may follow it. */
  private requiredGap(next: ObstacleDifficulty): number {
    const previous = this.lastObstacleDifficulty;
    if (!previous) return 0;
    const gaps = OBSTACLE_GAPS[previous];
    if (next === 'wall') return gaps.wall;
    if (next === 'moving') return gaps.moving;
    return gaps.barricade;
  }

  /** Port of SpawnCoinAndPowerup: walk the segment in 1.5-unit steps. */
  private spawnCoins(segment: TrackSegment): void {
    let worldPos = 0;
    let currentLane = Math.floor(this.random() * 3);
    let powerupChance = Math.min(1, Math.floor(this.timeSincePowerup) * POWERUP_CHANCE_RATE);
    const premiumChance = Math.min(1, Math.floor(this.timeSinceLastPremium) * PREMIUM_CHANCE_RATE);

    while (worldPos < segment.worldLength) {
      segment.getPointAtInWorldUnit(worldPos, tmpPos, tmpRot);
      right.set(1, 0, 0).applyQuaternion(tmpRot);

      // Find a lane not blocked by an obstacle (CheckSphere radius 0.4 equivalent).
      let laneValid = true;
      let testedLane = currentLane;
      while (this.laneBlocked(segment, tmpPos, right, testedLane)) {
        testedLane = (testedLane + 1) % 3;
        if (testedLane === currentLane) {
          laneValid = false;
          break;
        }
      }
      currentLane = testedLane;

      if (laneValid) {
        const pos = tmpPos.clone().addScaledVector(right, (currentLane - 1) * LANE_OFFSET);
        if (this.random() < powerupChance) {
          this.timeSincePowerup = 0;
          powerupChance = 0;
          this.events.dispatchEvent(new CustomEvent('spawnPowerup', { detail: { pos: pos.clone(), rot: tmpRot.clone(), segment } }));
        } else if (this.random() < premiumChance) {
          this.timeSinceLastPremium = 0;
          this.events.dispatchEvent(new CustomEvent('spawnPremium', { detail: { pos: pos.clone(), rot: tmpRot.clone(), segment } }));
        } else {
          pos.y += 0.5;
          const coin = coinPool.get(pos, tmpRot);
          if (coin) {
            const box = new THREE.Box3().setFromCenterAndSize(pos, COIN_BOX_SIZE);
            segment.colliders.push({ box, kind: 'coin', obj: coin });
          }
        }
      }
      worldPos += COIN_STEP;
    }
  }

  private laneBlocked(segment: TrackSegment, center: THREE.Vector3, rightDir: THREE.Vector3, lane: number): boolean {
    const p = center.clone().addScaledVector(rightDir, (lane - 1) * LANE_OFFSET);
    for (const c of segment.colliders) {
      if (c.kind === 'obstacle' && c.box.distanceToPoint(p) < 0.4) return true;
    }
    return false;
  }

  private removeSegment(segment: TrackSegment): void {
    for (const c of segment.colliders) {
      if (c.kind === 'coin') coinPool.free(c.obj);
    }
    segment.colliders.length = 0;
    segment.tickers.length = 0;
    this.scene.remove(segment.group);
  }

  /** Segments whose colliders are close enough to matter for the character. */
  nearbySegments(): TrackSegment[] {
    return this.segments.slice(0, 2);
  }
}
