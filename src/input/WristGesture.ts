import type { WristAction } from './wristTypes';

export type { HorizontalDirection, VerticalDirection, WristAction } from './wristTypes';
export interface Point { x: number; y: number }
export interface Point3 { x: number; y: number; z: number }
/** side: hand seen side-on, bends tilt it across the image (left/right).
 * front: knuckles or palm toward the camera, bends tilt it in depth (up/down). */
export type WristAxis = 'horizontal' | 'vertical';
/** horizontal: negative tilts screen-left. vertical: positive is extension (up). */
export interface WristReading { axis: WristAxis; angle: number }

export const WRIST_NEUTRAL_DEGREES = 12;
/** Depth comes from a learned estimate, so up/down needs a deeper bend to fire. */
export const WRIST_VERTICAL_TRIGGER_DEGREES = 20;
export const WRIST_TRACKING_TIMEOUT_MS = 750;
const DWELL_MS = 120;
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 250;
// The knuckle line turns ~90° between the two poses; switch with a margin.
const SIDE_ENTER_DEGREES = 55;
const FRONT_ENTER_DEGREES = 35;
const AXIS_DWELL_MS = 150;
const CALIBRATION_MS = 300;
const CALIBRATION_SPREAD_DEGREES = 6;
const CALIBRATION_LIMIT_DEGREES = 45;
const BASELINE_FOLLOW_MS = 2000;
export type WristGestureState = 'disabled' | 'lost' | 'center' | 'ready' | 'aiming' | WristAction;

const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Point3, b: Point3): Point3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: Point3): number => Math.hypot(a.x, a.y, a.z);
const finite = (points: readonly Point3[], ...indices: number[]): boolean =>
  indices.every((i) => points[i] && Number.isFinite(points[i].x) && Number.isFinite(points[i].y) && Number.isFinite(points[i].z));

/** Same pixel-space vertical baseline as wrist_flexion_v2.py (landmarks 0 → 9).
 * Input coordinates must already be mirrored, just like the Python camera frame.
 */
export function signedWristAngle(wrist: Point, middle: Point): number | null {
  const dx = middle.x - wrist.x;
  const dy = middle.y - wrist.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1) return null;
  return Math.atan2(dx, -dy) * 180 / Math.PI;
}

export function classifyWrist(angle: number): 'Neutral' | 'Flexion' | 'Extension' {
  return Math.abs(angle) <= WRIST_NEUTRAL_DEGREES ? 'Neutral' : angle < 0 ? 'Flexion' : 'Extension';
}

/** How far the knuckle line (index → pinky MCP) turns from across the image
 * toward the camera, 0–90°. Flexion rotates the hand about this line, so it
 * identifies the pose without being disturbed by the bend itself.
 * Points are camera-aligned 3D (x right, y down, z away), e.g. world landmarks.
 */
export function knuckleYaw(points: readonly Point3[]): number | null {
  if (!finite(points, 5, 17)) return null;
  const knuckles = sub(points[5], points[17]);
  const flat = Math.hypot(knuckles.x, knuckles.z);
  // A knuckle line pointing up/down the image says nothing about either pose.
  if (flat < 1e-6 || flat < 0.5 * length(knuckles)) return null;
  return Math.atan2(Math.abs(knuckles.z), Math.abs(knuckles.x)) * 180 / Math.PI;
}

/** Wrist → middle knuckle tilt toward the camera, in degrees; 0 is straight up the image. */
export function depthPitch(points: readonly Point3[]): number | null {
  if (!finite(points, 0, 9)) return null;
  const hand = sub(points[9], points[0]);
  if (Math.hypot(hand.y, hand.z) < 1e-6) return null;
  return Math.atan2(-hand.z, -hand.y) * 180 / Math.PI;
}

const CURLED_FINGERS = [6, 8, 10, 12, 14, 16, 18, 20];

/** Positive when the palm faces the camera, negative when the back of the hand
 * does, scaled by confidence (≤ 1). A fist curls its fingers onto the palm side
 * of the wrist → knuckle axis; an open hand falls back on handedness.
 */
export function palmTowardCamera(points: readonly Point3[], handedness: 'Left' | 'Right' | null): number | null {
  if (!finite(points, 0, 5, 9, 17, ...CURLED_FINGERS)) return null;
  const axis = sub(points[9], points[0]);
  const size = length(axis);
  if (size < 1e-6) return null;
  const unit = { x: axis.x / size, y: axis.y / size, z: axis.z / size };
  const curl = { x: 0, y: 0, z: 0 };
  for (const i of CURLED_FINGERS) {
    const offset = sub(points[i], points[0]);
    curl.x += offset.x / CURLED_FINGERS.length;
    curl.y += offset.y / CURLED_FINGERS.length;
    curl.z += offset.z / CURLED_FINGERS.length;
  }
  // Keep only the palmar offset: off the hand axis and off the knuckle line,
  // where open fingers' spread and the off-centre middle knuckle would leak in.
  const knuckles = sub(points[5], points[17]);
  const across = cross(unit, cross(knuckles, unit));
  const acrossSize = length(across);
  let palmSide = curl;
  for (const [axis, norm] of [[unit, 1], [across, acrossSize]] as const) {
    if (norm < 1e-9) continue;
    const along = dot(palmSide, axis) / (norm * norm);
    palmSide = { x: palmSide.x - along * axis.x, y: palmSide.y - along * axis.y, z: palmSide.z - along * axis.z };
  }
  const curled = length(palmSide);
  if (curled > 0.2 * size) return -palmSide.z / curled;
  if (!handedness) return null;
  // In the mirrored frame a right palm facing the camera has its thumb on the
  // left, so index × pinky (from the wrist) points away from the camera.
  const normal = cross(sub(points[5], points[0]), sub(points[17], points[0]));
  const size2 = length(normal);
  if (size2 < 1e-9) return null;
  return (handedness === 'Right' ? normal.z : -normal.z) / size2;
}

/** Picks the pose from the knuckle line with hysteresis and a short dwell, so
 * rotating the forearm between poses never flickers through the other axis.
 */
export class AxisSelector {
  private current: WristAxis | null = null;
  private pending: WristAxis | null = null;
  private since = 0;

  get axis(): WristAxis | null { return this.current; }

  reset(): void {
    this.current = null;
    this.pending = null;
  }

  update(yaw: number | null, now: number): WristAxis | null {
    if (yaw === null || !Number.isFinite(yaw)) return this.current;
    if (this.current === null) {
      this.current = yaw >= 45 ? 'horizontal' : 'vertical';
      return this.current;
    }
    const want = this.current === 'horizontal'
      ? (yaw < FRONT_ENTER_DEGREES ? 'vertical' : 'horizontal')
      : (yaw > SIDE_ENTER_DEGREES ? 'horizontal' : 'vertical');
    if (want === this.current) {
      this.pending = null;
    } else if (want !== this.pending) {
      this.pending = want;
      this.since = now;
    } else if (now - this.since >= AXIS_DWELL_MS) {
      this.current = want;
      this.pending = null;
    }
    return this.current;
  }
}

/** Turns raw depth pitch into anatomical extension (+) / flexion (−) degrees.
 * The camera rarely looks exactly along the upright forearm, so the first
 * steady straight-wrist pose becomes the zero, which then follows slow posture
 * drift while the wrist is straight. Which way flexion moves in depth depends
 * on whether the palm faces the camera, so that is judged near neutral and
 * held through the bend (the palm itself turns with the hand).
 */
export class VerticalCalibration {
  /** Inverts up/down for players whose palm direction is misjudged. */
  swap = false;
  private zero: number | null = null;
  private samples: { t: number; pitch: number }[] = [];
  private palm = 0;
  private last = -Infinity;

  get calibrated(): boolean { return this.zero !== null; }
  get baseline(): number | null { return this.zero; }
  get palmFacesCamera(): boolean { return this.palm >= 0; }

  reset(): void {
    this.zero = null;
    this.samples = [];
    this.palm = 0;
    this.last = -Infinity;
  }

  /** Returns null until a steady straight wrist has been seen. */
  update(pitch: number | null, palm: number | null, now: number): number | null {
    if (pitch === null || !Number.isFinite(pitch) || !Number.isFinite(now)) return null;
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    const near = this.zero === null || Math.abs(pitch - this.zero) < WRIST_VERTICAL_TRIGGER_DEGREES;
    if (palm !== null && Number.isFinite(palm) && near) this.palm += (Math.max(-1, Math.min(1, palm)) - this.palm) * 0.25;
    if (this.zero === null) {
      this.samples = this.samples.filter((s) => now - s.t <= CALIBRATION_MS + 100 && s.t <= now);
      this.samples.push({ t: now, pitch });
      const pitches = this.samples.map((s) => s.pitch);
      const spread = Math.max(...pitches) - Math.min(...pitches);
      const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
      if (now - this.samples[0].t < CALIBRATION_MS || spread > CALIBRATION_SPREAD_DEGREES || Math.abs(mean) > CALIBRATION_LIMIT_DEGREES) return null;
      this.zero = mean;
      this.samples = [];
    }
    const toward = pitch - this.zero!;
    // Palm toward the camera: flexion moves the knuckles toward it.
    const angle = -toward * (this.palm >= 0 ? 1 : -1) * (this.swap ? -1 : 1);
    if (Math.abs(angle) < WRIST_NEUTRAL_DEGREES) this.zero! += toward * (1 - Math.exp(-elapsed / BASELINE_FOLLOW_MS));
    return angle;
  }
}

type Candidate = 'neutral' | WristAction;

function classify(reading: WristReading, previous: Candidate | null): Candidate {
  const { axis, angle } = reading;
  const magnitude = Math.abs(angle);
  const direction: WristAction = axis === 'horizontal' ? (angle < 0 ? 'left' : 'right') : (angle > 0 ? 'up' : 'down');
  if (magnitude <= WRIST_NEUTRAL_DEGREES) return 'neutral';
  if (axis === 'horizontal' || magnitude >= WRIST_VERTICAL_TRIGGER_DEGREES) return direction;
  // Between neutral and trigger, keep whatever the bend already was.
  return previous === direction ? direction : 'neutral';
}

/** A held side-on bend behaves like a held arrow key; a front-on bend is one
 * jump or slide per bend. Only fresh, stable observations can emit presses.
 * Brief dropouts preserve readiness, never emit or accumulate dwell time;
 * longer losses, pose changes and game transitions require neutral again.
 */
export class WristGesture {
  private ready = false;
  private axis: WristAxis | null = null;
  private candidate: Candidate | null = null;
  private held: WristAction | null = null;
  private dwell = 0;
  private previousValid = false;
  private lastValid = -Infinity;
  private lastUpdate = -Infinity;
  private nextRepeat = Infinity;
  private currentState: WristGestureState = 'center';

  get state(): WristGestureState { return this.currentState; }

  reset(): void {
    this.ready = false;
    this.axis = null;
    this.candidate = null;
    this.held = null;
    this.dwell = 0;
    this.previousValid = false;
    this.lastValid = -Infinity;
    this.lastUpdate = -Infinity;
    this.nextRepeat = Infinity;
    this.currentState = 'center';
  }

  /** A bare number is a side-on (horizontal) angle. */
  update(input: number | WristReading | null, now: number, enabled: boolean): WristAction | null {
    if (!enabled || !Number.isFinite(now)) {
      this.reset();
      this.currentState = enabled ? 'lost' : 'disabled';
      return null;
    }
    if (now < this.lastUpdate || now - this.lastValid > WRIST_TRACKING_TIMEOUT_MS) this.reset();
    const elapsed = now - this.lastUpdate;
    this.lastUpdate = now;
    const reading = typeof input === 'number' ? { axis: 'horizontal' as const, angle: input } : input;
    if (reading === null || !Number.isFinite(reading.angle)) {
      // Preserve confirmed time across short misses without counting the gap.
      // Resetting the candidate here starves controls when every third frame
      // misses a side-on hand, even though the visible direction is consistent.
      this.previousValid = false;
      this.currentState = 'lost';
      return null;
    }
    if (reading.axis !== this.axis) {
      // Turning the forearm mid-bend must not fire the other pose's action.
      if (this.axis !== null) this.ready = false;
      this.axis = reading.axis;
      this.candidate = null;
      this.held = null;
      this.nextRepeat = Infinity;
    }
    this.lastValid = now;
    const next = classify(reading, this.candidate);
    if (next !== this.candidate) {
      this.candidate = next;
      this.dwell = 0;
    } else if (this.previousValid) this.dwell += elapsed;
    this.previousValid = true;
    if (next === 'neutral') {
      // Neutral immediately stops repeat. A brief threshold wobble must not
      // release/re-press a held key, so commit the release after the dwell.
      if (this.dwell >= DWELL_MS) {
        this.ready = true;
        this.held = null;
        this.nextRepeat = Infinity;
      }
      this.currentState = this.ready && this.held === null ? 'ready' : 'center';
      return null;
    }
    if (!this.ready) {
      this.currentState = 'center';
      return null;
    }
    this.currentState = 'aiming';
    if (this.dwell < DWELL_MS) return null;
    this.currentState = next;
    if (next !== this.held) {
      this.held = next;
      this.nextRepeat = reading.axis === 'horizontal' ? now + REPEAT_DELAY_MS : Infinity;
      return next;
    }
    if (now < this.nextRepeat) return null;
    // One press per fresh observation, never a burst to catch up after a stall.
    this.nextRepeat = now + REPEAT_INTERVAL_MS;
    return next;
  }
}

