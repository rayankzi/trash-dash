/**
 * Geometrically faithful synthetic MediaPipe HandLandmarker results for tests.
 *
 * The hand is built from anatomy, not per-pose sign flips:
 *   1. A canonical RIGHT hand is defined in a local frame (r, a, p) in metres:
 *        r = radial (thumb side), a = distal (wrist -> fingers), p = palmar (out of the palm).
 *      It is right-handed with r = p x a. A LEFT hand is the same geometry with r negated.
 *   2. The forearm frame is placed in camera space (x right of the mirrored selfie image,
 *      y DOWN, z AWAY from the camera). Forearm axis a is always "up in the image" (0,-1,0)
 *      before tilt. Only the forearm roll about its own axis differs between poses:
 *        front : palm normal p = (0,0,-1) (palm: 'camera') or (0,0,+1) (palm: 'away').
 *                Knuckle line (index MCP <-> pinky MCP, the r axis) then runs along image x.
 *        side  : the radial (thumb-edge) direction is along depth:
 *                'thumb-camera' -> thumb edge toward camera (r_world = (0,0,-1)),
 *                'pinky-camera' -> pinky edge toward camera (r_world = (0,0,+1)).
 *                Knuckle line runs along z; palm normal is then in the image plane (+-x).
 *                For side, palm:'camera' is an alias of 'thumb-camera' and 'away' of 'pinky-camera'.
 *   3. twist rotates the forearm about its own axis (right-hand rule about the axis direction
 *      (0,-1,0), i.e. positive twist swings the palm normal toward the image-left when viewed from the
 *      camera... verified numerically in tests) BEFORE the wrist bend.
 *   4. bend rotates the hand about the wrist's radio-ulnar axis (the r axis). Flexion (bend < 0) swings
 *      the fingers toward the palm side (+p), extension (bend > 0) toward the back of the hand (-p):
 *        a' = a cos(b) - p sin(b),  p' = p cos(b) + a sin(b).
 *   5. forearmTilt then rotates the whole arm about the wrist: roll (about the camera axis; roll > 0 moves
 *      the fingertip end toward image +x) then pitch (about image x; pitch > 0 moves the fingertip end
 *      toward the camera, i.e. z negative).
 *
 * Projection: orthographic (weak perspective) with constant scale so that 0.09 m == 100 px
 * (wrist -> middle MCP in a neutral hand is ~100 px at any image size). Normalized landmarks:
 *   x = cx + X*S/width, y = cy + Y*S/height, z = Z*S/width  (Z relative to the wrist, wrist z = 0).
 * worldLandmarks are metres, axes aligned with the camera, origin at the centroid of the 21 points.
 *
 * `syntheticHand` is built from `syntheticHandSource` (a self-contained function expression, no
 * imports/closure/transpiler helpers), so Playwright specs can inject it:
 *   page.route(..., body: `const syntheticHand = ${syntheticHandSource};` ...)
 *   page.addInitScript(`window.syntheticHand = ${syntheticHandSource};`)
 */
export interface SyntheticHandOptions {
  pose: 'side' | 'front';
  /** Degrees of anatomical wrist bend: + = extension (toward back of hand), - = flexion (toward palm). */
  bend: number;
  /** front: palm toward/away from the camera. side: 'thumb-camera' | 'pinky-camera' ('camera'/'away' alias them). Default: front 'camera', side 'thumb-camera'. */
  palm?: 'camera' | 'away' | 'thumb-camera' | 'pinky-camera';
  handedness: 'Left' | 'Right';
  /** Default true: fingers curled into the palm, thumb across them. */
  fist?: boolean;
  /** Degrees. roll: tilt forearm in the image plane (+ = fingertip end toward image +x). pitch: + = toward camera. */
  forearmTilt?: { roll?: number; pitch?: number };
  /** Degrees of extra forearm rotation about its own axis (before the bend). */
  twist?: number;
  imageWidth?: number;
  imageHeight?: number;
  /** Normalized wrist position, default {x:.5,y:.7}. */
  center?: { x: number; y: number };
  /** Deterministic seeded jitter amplitude in metres (uniform +-noise). */
  noise?: number;
  /** Seed for noise, default 1. */
  seed?: number;
}

export interface SyntheticLandmark { x: number; y: number; z: number }
export interface SyntheticHandResult {
  landmarks: SyntheticLandmark[];
  worldLandmarks: SyntheticLandmark[];
  handedness: { categoryName: 'Left' | 'Right'; score: number; index: number; displayName: string }[];
}

export const syntheticHandSource: string = String.raw`(function (o) {
  var D = Math.PI / 180;
  var W = o.imageWidth || 640, H = o.imageHeight || 480;
  var c = o.center || { x: 0.5, y: 0.7 };
  var right = o.handedness === 'Right';
  var fist = o.fist !== false;
  var palm = o.palm || (o.pose === 'front' ? 'camera' : 'thumb-camera');
  var add = function (u, v) { return [u[0] + v[0], u[1] + v[1], u[2] + v[2]]; };
  var mul = function (u, s) { return [u[0] * s, u[1] * s, u[2] * s]; };
  var dot = function (u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; };
  var cross = function (u, v) {
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  };
  var rodrigues = function (v, k, ang) {
    var cs = Math.cos(ang), sn = Math.sin(ang);
    return add(add(mul(v, cs), mul(cross(k, v), sn)), mul(k, dot(k, v) * (1 - cs)));
  };

  // ---- canonical RIGHT hand, local (r radial, a distal, p palmar), metres ----
  var L = [];
  L[0] = [0, 0, 0];
  var mcp = { 5: [0.035, 0.088], 9: [0.012, 0.090], 13: [-0.012, 0.086], 17: [-0.035, 0.078] };
  var seg = { 5: [0.040, 0.022, 0.019], 9: [0.044, 0.026, 0.020], 13: [0.041, 0.024, 0.019], 17: [0.032, 0.018, 0.017] };
  [5, 9, 13, 17].forEach(function (b) {
    var r = mcp[b][0], a = mcp[b][1], s = seg[b];
    L[b] = [r, a, 0];
    if (fist) {
      // prox phalanx straight up out of the palm, middle folded back toward the wrist, distal into the palm
      L[b + 1] = [r, a, s[0]];
      L[b + 2] = [r, a - s[1], s[0]];
      L[b + 3] = [r, a - s[1], s[0] - s[2]];
    } else {
      L[b + 1] = [r, a + s[0], 0];
      L[b + 2] = [r, a + s[0] + s[1], 0];
      L[b + 3] = [r, a + s[0] + s[1] + s[2], 0];
    }
  });
  if (fist) {
    L[1] = [0.024, 0.018, 0.010]; L[2] = [0.040, 0.042, 0.028];
    L[3] = [0.028, 0.058, 0.052]; L[4] = [0.004, 0.058, 0.058]; // tip rests across the front of the fingers
  } else {
    L[1] = [0.024, 0.018, 0.006]; L[2] = [0.040, 0.044, 0.010];
    L[3] = [0.052, 0.068, 0.010]; L[4] = [0.060, 0.088, 0.010];
  }

  // ---- forearm frame in camera space ----
  var A = [0, -1, 0], P, Rphys;
  if (o.pose === 'front') {
    P = [0, 0, (palm === 'away') ? 1 : -1];
  } else {
    var thumbCam = !(palm === 'pinky-camera' || palm === 'away');
    Rphys = [0, 0, thumbCam ? -1 : 1];      // physical thumb-side direction
    P = right ? cross(A, Rphys) : cross(Rphys, A); // right: R = P x A ; left: R = A x P
  }
  P = rodrigues(P, A, (o.twist || 0) * D);
  var b = (o.bend || 0) * D;
  var A2 = add(mul(A, Math.cos(b)), mul(P, -Math.sin(b)));
  var P2 = add(mul(P, Math.cos(b)), mul(A, Math.sin(b)));
  var Mr = cross(P2, A2);                    // canonical-right r axis; left hand mirrors r
  var sgn = right ? 1 : -1;
  var tilt = o.forearmTilt || {};
  var roll = (tilt.roll || 0) * D, pitch = (tilt.pitch || 0) * D;
  var rollRot = function (v) {
    return [v[0] * Math.cos(roll) - v[1] * Math.sin(roll), v[0] * Math.sin(roll) + v[1] * Math.cos(roll), v[2]];
  };
  var pitchRot = function (v) {
    return [v[0], v[1] * Math.cos(pitch) - v[2] * Math.sin(pitch), v[1] * Math.sin(pitch) + v[2] * Math.cos(pitch)];
  };

  // deterministic noise (mulberry32)
  var st = (o.seed == null ? 1 : o.seed) >>> 0;
  var rnd = function () {
    st = (st + 0x6D2B79F5) >>> 0;
    var t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  var amp = o.noise || 0;

  var pts = [];
  for (var i = 0; i < 21; i++) {
    var l = L[i];
    var w = add(add(mul(Mr, sgn * l[0]), mul(A2, l[1])), mul(P2, l[2]));
    w = pitchRot(rollRot(w));
    if (amp) w = [w[0] + (rnd() * 2 - 1) * amp, w[1] + (rnd() * 2 - 1) * amp, w[2] + (rnd() * 2 - 1) * amp];
    pts.push(w);
  }
  var S = 100 / 0.09;                        // px per metre (orthographic)
  var wr = pts[0];
  var mean = [0, 0, 0];
  pts.forEach(function (q) { mean = add(mean, q); });
  mean = mul(mean, 1 / 21);
  return {
    landmarks: pts.map(function (q) {
      return { x: c.x + (q[0] - wr[0]) * S / W, y: c.y + (q[1] - wr[1]) * S / H, z: (q[2] - wr[2]) * S / W };
    }),
    worldLandmarks: pts.map(function (q) {
      return { x: q[0] - mean[0], y: q[1] - mean[1], z: q[2] - mean[2] };
    }),
    handedness: [{ categoryName: o.handedness, score: 0.95, index: right ? 1 : 0, displayName: o.handedness }]
  };
})`;

export const syntheticHand: (o: SyntheticHandOptions) => SyntheticHandResult =
  // eslint-disable-next-line no-eval
  (0, eval)(syntheticHandSource);
