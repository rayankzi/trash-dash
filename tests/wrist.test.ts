import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  AxisSelector, classifyWrist, depthPitch, knuckleYaw, palmTowardCamera, signedWristAngle,
  VerticalCalibration, WristGesture, type WristAction,
} from '../src/input/WristGesture';
import { syntheticHand, type SyntheticHandOptions } from './helpers/syntheticHand';
import { CharacterController } from '../src/character/CharacterController';
import type { Character } from '../src/character/Character';
import type { TrackManager } from '../src/track/TrackManager';

describe('Python v2 wrist geometry parity', () => {
  it('uses pixel coordinates and the upward vertical baseline', () => {
    const wrist = { x: 50, y: 100 };
    expect(signedWristAngle(wrist, { x: 50, y: 50 })).toBe(0);
    expect(signedWristAngle(wrist, { x: 100, y: 100 })).toBe(90);
    expect(signedWristAngle(wrist, { x: 0, y: 100 })).toBe(-90);
    expect(signedWristAngle(wrist, { x: 0, y: 50 })).toBe(-45);
    expect(signedWristAngle(wrist, wrist)).toBeNull();
    expect(signedWristAngle(wrist, { x: NaN, y: 50 })).toBeNull();
  });
  it('preserves the 12 degree neutral tolerance and sign labels', () => {
    expect(classifyWrist(-12)).toBe('Neutral');
    expect(classifyWrist(12)).toBe('Neutral');
    expect(classifyWrist(-13)).toBe('Flexion');
    expect(classifyWrist(13)).toBe('Extension');
  });
});

describe('wrist lane gestures', () => {
  it('requires initial neutral and never moves from the first bent sample', () => {
    const gesture = new WristGesture();
    expect(gesture.update(-30, 0, true)).toBeNull();
    expect(gesture.update(-30, 500, true)).toBeNull();
    expect(gesture.state).toBe('center');
    gesture.update(12, 600, true);
    gesture.update(12, 750, true);
    expect(gesture.state).toBe('ready');
    expect(gesture.update(-30, 800, true)).toBeNull();
    expect(gesture.update(-30, 950, true)).toBe('left');
  });

  it('stops repeat immediately at neutral and debounces threshold jitter', () => {
    const gesture = new WristGesture();
    gesture.update(0, 0, true);
    gesture.update(0, 150, true);
    gesture.update(-14, 200, true);
    gesture.update(-11, 250, true);
    expect(gesture.update(-14, 300, true)).toBeNull();
    expect(gesture.update(-14, 450, true)).toBe('left');
    gesture.update(0, 500, true);
    gesture.update(-30, 550, true);
    expect(gesture.update(-30, 700, true)).toBeNull();
    // Repeat is due, but neutral cancels it immediately.
    expect(gesture.update(0, 900, true)).toBeNull();
    expect(gesture.update(0, 1050, true)).toBeNull();
    gesture.update(-30, 1100, true);
    expect(gesture.update(-30, 1250, true)).toBe('left');
  });

  it.each(['lost', 'paused', 'stale'] as const)('requires neutral after prolonged %s tracking', (reason) => {
    const gesture = new WristGesture();
    gesture.update(0, 0, true);
    gesture.update(0, 150, true);
    gesture.update(-30, 200, true);
    if (reason === 'lost') gesture.update(null, 1000, true);
    if (reason === 'paused') gesture.update(-30, 250, false);
    expect(gesture.update(-30, 1100, true)).toBeNull();
    expect(gesture.update(-30, 1250, true)).toBeNull();
    expect(gesture.state).toBe('center');
  });

  it('never repeats from missing frames or catches up missed presses in a burst', () => {
    const gesture = new WristGesture();
    gesture.update(0, 0, true);
    gesture.update(0, 150, true);
    gesture.update(-30, 200, true);
    expect(gesture.update(-30, 350, true)).toBe('left');
    for (let t = 400; t <= 900; t += 50) expect(gesture.update(null, t, true)).toBeNull();
    // An already-confirmed held key may resume on a fresh matching frame,
    // but sends only one press, with a new repeat deadline.
    expect(gesture.update(-30, 950, true)).toBe('left');
    expect(gesture.update(-30, 1100, true)).toBeNull();
    expect(gesture.update(-30, 1150, true)).toBeNull();
    expect(gesture.update(-30, 1200, true)).toBe('left');
    expect(gesture.update(-30, 1350, true)).toBeNull();
  });

  it('does not count time without a hand toward the initial movement dwell', () => {
    const gesture = new WristGesture();
    gesture.update(0, 0, true);
    gesture.update(0, 150, true);
    gesture.update(-30, 200, true);
    gesture.update(null, 250, true);
    expect(gesture.update(-30, 600, true)).toBeNull();
    expect(gesture.update(-30, 750, true)).toBe('left');
  });

  it('resets safely after invalid timestamps and rejects invalid angles', () => {
    const gesture = new WristGesture();
    gesture.update(0, 100, true);
    gesture.update(0, 250, true);
    expect(gesture.update(NaN, 300, true)).toBeNull();
    expect(gesture.update(-30, NaN, true)).toBeNull();
    expect(gesture.update(-30, 400, true)).toBeNull();
    gesture.update(0, 500, true);
    gesture.update(0, 650, true);
    gesture.update(-30, 700, true);
    expect(gesture.update(-30, 200, true)).toBeNull();
    expect(gesture.update(-30, 350, true)).toBeNull();
  });

  it.each([3, 5, 10, 20, 60])('handles twenty alternating held gestures at %i inference frames/sec', (fps) => {
    const gesture = new WristGesture();
    let now = 0;
    const dt = 1000 / fps;
    const feed = (angle: number, ms: number) => {
      const presses: string[] = [];
      for (let i = 0; i < Math.ceil(ms / dt); i++) {
        const press = gesture.update(angle, now, true);
        if (press) presses.push(press);
        now += dt;
      }
      return presses;
    };
    feed(0, 800);
    for (let i = 0; i < 20; i++) {
      const direction = i % 2 === 0 ? 'left' : 'right';
      const presses = feed(direction === 'left' ? -30 : 30, 1600);
      expect(presses.length).toBeGreaterThanOrEqual(3);
      expect(presses.every((press) => press === direction)).toBe(true);
    }
    expect(feed(0, 2000)).toEqual([]);
  });
});

describe('runner wrist input', () => {
  it('matches arrow directions, respects lane bounds and disabled input, without jumping or sliding', () => {
    const character = { root: new THREE.Object3D(), play: vi.fn() } as unknown as Character;
    const track = { characterRoot: new THREE.Object3D() } as TrackManager;
    const controller = new CharacterController(character, track);
    const lane = vi.fn();
    controller.onLaneChange = lane;
    controller.moveHorizontal('left');
    expect(lane).not.toHaveBeenCalled();
    controller.inputEnabled = true;
    controller.moveHorizontal('left');
    controller.update(1);
    expect(controller.holder.position.x).toBeGreaterThan(0);
    controller.moveHorizontal('left');
    expect(lane).toHaveBeenCalledTimes(1);
    controller.moveHorizontal('right');
    controller.moveHorizontal('right');
    controller.update(1);
    expect(controller.holder.position.x).toBeLessThan(0);
    expect(controller.isJumping).toBe(false);
    expect(controller.isSliding).toBe(false);
    expect(character.play).not.toHaveBeenCalled();
    const revision = controller.inputRevision;
    controller.inputEnabled = false;
    controller.inputEnabled = true;
    expect(controller.inputRevision).toBeGreaterThan(revision);
    controller.reset();
    expect(controller.inputEnabled).toBe(false);
    controller.moveHorizontal('left');
    expect(controller.holder.position.x).toBe(0);
  });
});

describe('reported intermittent wrist input regressions', () => {
  const armed = () => {
    const gesture = new WristGesture();
    gesture.update(0, 0, true);
    gesture.update(0, 150, true);
    return gesture;
  };
  it('repeats a held bend after the initial arrow press', () => {
    const gesture = armed();
    gesture.update(-30, 200, true);
    expect(gesture.update(-30, 350, true)).toBe('left');
    gesture.update(-30, 500, true);
    gesture.update(-30, 650, true);
    expect(gesture.update(-30, 800, true)).toBe('left');
  });
  it('accepts a direct reversal without pausing at neutral', () => {
    const gesture = armed();
    gesture.update(-30, 200, true);
    gesture.update(-30, 350, true);
    gesture.update(30, 400, true);
    expect(gesture.update(30, 550, true)).toBe('right');
  });
  it('accepts the same neutral range shown to the player', () => {
    const gesture = new WristGesture();
    expect(classifyWrist(10)).toBe('Neutral');
    gesture.update(10, 0, true);
    gesture.update(10, 150, true);
    gesture.update(-30, 200, true);
    expect(gesture.update(-30, 350, true)).toBe('left');
  });
  it('survives a single missed detection while ready', () => {
    const gesture = armed();
    gesture.update(null, 200, true);
    gesture.update(-30, 250, true);
    expect(gesture.update(-30, 400, true)).toBe('left');
  });
  it('supports deliberate movement at low inference frame rates', () => {
    const gesture = new WristGesture();
    gesture.update(0, 0, true);
    gesture.update(0, 350, true);
    gesture.update(-30, 700, true);
    expect(gesture.update(-30, 1050, true)).toBe('left');
  });
  it('can confirm a bend despite an isolated missed detection every third frame', () => {
    const gesture = armed();
    const presses: string[] = [];
    for (let frame = 0; frame < 18; frame++) {
      const press = gesture.update(frame % 3 === 2 ? null : -30, 200 + frame * 50, true);
      if (press) presses.push(press);
    }
    expect(presses.length).toBeGreaterThanOrEqual(2);
    expect(presses.every((press) => press === 'left')).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Two-pose geometry, driven by the synthetic anatomical hand generator.
// ---------------------------------------------------------------------------
const FRAME_MS = 33;
const W = 640, H = 480;

/** Mirrors WristCameraControls.read(): yaw -> axis, then side angle or calibrated depth angle -> gesture. */
class Pipeline {
  readonly selector = new AxisSelector();
  readonly calibration = new VerticalCalibration();
  readonly gesture = new WristGesture();
  t = 1000;
  seed = 1;
  last: { axis: string | null; angle: number | null } = { axis: null, angle: null };

  frame(o: SyntheticHandOptions): WristAction | null {
    const hand = syntheticHand({ ...o, seed: this.seed++ });
    const world = hand.worldLandmarks;
    const axis = this.selector.update(knuckleYaw(world), this.t) ?? 'horizontal';
    let angle: number | null;
    if (axis === 'horizontal') {
      angle = signedWristAngle(
        { x: hand.landmarks[0].x * W, y: hand.landmarks[0].y * H },
        { x: hand.landmarks[9].x * W, y: hand.landmarks[9].y * H });
    } else {
      angle = this.calibration.update(depthPitch(world), palmTowardCamera(world, o.handedness), this.t);
    }
    this.last = { axis, angle };
    const action = this.gesture.update(angle === null ? null : { axis, angle }, this.t, true);
    this.t += FRAME_MS;
    return action;
  }

  /** Holds a pose for `ms` and returns every emitted action. */
  hold(o: SyntheticHandOptions, ms: number): WristAction[] {
    const out: WristAction[] = [];
    for (const end = this.t + ms; this.t < end;) {
      const a = this.frame(o);
      if (a) out.push(a);
    }
    return out;
  }
}

const POSES: Array<Pick<SyntheticHandOptions, 'pose' | 'palm'>> = [
  { pose: 'side', palm: 'thumb-camera' },
  { pose: 'side', palm: 'pinky-camera' },
  { pose: 'front', palm: 'camera' },
  { pose: 'front', palm: 'away' },
];
const HANDS = ['Left', 'Right'] as const;
const FISTS = [true, false];

describe('axis classification from synthetic hands', () => {
  for (const p of POSES) for (const handedness of HANDS) for (const fist of FISTS) for (const bend of [-40, -20, 0, 20, 40]) {
    it(`${p.pose}/${p.palm}/${handedness}/${fist ? 'fist' : 'open'}/bend ${bend}`, () => {
      const yaw = knuckleYaw(syntheticHand({ ...p, handedness, fist, bend }).worldLandmarks)!;
      if (p.pose === 'side') expect(yaw).toBeGreaterThan(75); else expect(yaw).toBeLessThan(15);
    });
  }
});

describe('front pose: extension jumps, flexion slides', () => {
  for (const palm of ['camera', 'away'] as const) for (const handedness of HANDS) for (const fist of FISTS) {
    for (const pitch of [0, 20, -20]) {
      it(`${palm}/${handedness}/${fist ? 'fist' : 'open'}/forearm pitch ${pitch}`, () => {
        const base: SyntheticHandOptions = { pose: 'front', palm, handedness, fist, bend: 0, forearmTilt: { pitch } };
        const pipe = new Pipeline();
        expect(pipe.hold(base, 1200)).toEqual([]);
        expect(pipe.last.axis).toBe('vertical');
        expect(Math.abs(pipe.last.angle!)).toBeLessThan(3);
        expect(pipe.hold({ ...base, bend: 35 }, 600)).toEqual(['up']);
        expect(pipe.hold(base, 400)).toEqual([]);
        expect(pipe.hold({ ...base, bend: -35 }, 600)).toEqual(['down']);
      });
    }
  }

  it('reports anatomical angle magnitude close to the true bend', () => {
    const base: SyntheticHandOptions = { pose: 'front', palm: 'camera', handedness: 'Right', bend: 0, forearmTilt: { pitch: 20 } };
    const pipe = new Pipeline();
    pipe.hold(base, 1000);
    pipe.hold({ ...base, bend: 30 }, 100);
    expect(pipe.last.angle!).toBeGreaterThan(24);
    expect(pipe.last.angle!).toBeLessThan(36);
  });

  it('tolerates measurement noise: no phantom actions, one action per bend', () => {
    const base: SyntheticHandOptions = { pose: 'front', palm: 'camera', handedness: 'Left', bend: 0, noise: 0.003 };
    const pipe = new Pipeline();
    expect(pipe.hold(base, 3000)).toEqual([]);
    expect(pipe.hold({ ...base, bend: 40 }, 800)).toEqual(['up']);
    expect(pipe.hold(base, 800)).toEqual([]);
    expect(pipe.hold({ ...base, bend: -40 }, 800)).toEqual(['down']);
  });

  it('palm cue agrees with the pose', () => {
    for (const handedness of HANDS) for (const fist of FISTS) {
      const cam = syntheticHand({ pose: 'front', palm: 'camera', handedness, fist, bend: 0 }).worldLandmarks;
      const away = syntheticHand({ pose: 'front', palm: 'away', handedness, fist, bend: 0 }).worldLandmarks;
      expect(palmTowardCamera(cam, handedness)!).toBeGreaterThan(0.3);
      expect(palmTowardCamera(away, handedness)!).toBeLessThan(-0.3);
    }
  });
});

describe('side pose: tilt drives left/right', () => {
  for (const palm of ['thumb-camera', 'pinky-camera'] as const) for (const handedness of HANDS) for (const fist of FISTS) {
    it(`${palm}/${handedness}/${fist ? 'fist' : 'open'}`, () => {
      const base: SyntheticHandOptions = { pose: 'side', palm, handedness, fist, bend: 0 };
      // Image-plane tilt direction: thumb-camera right hand (and pinky-camera left hand) tilts left under extension.
      const extLeft = (palm === 'thumb-camera') === (handedness === 'Right');
      const pipe = new Pipeline();
      expect(pipe.hold(base, 800)).toEqual([]);
      expect(pipe.last.axis).toBe('horizontal');
      const ext = pipe.hold({ ...base, bend: 30 }, 300);
      expect(ext[0]).toBe(extLeft ? 'left' : 'right');
      pipe.hold(base, 300);
      const flex = pipe.hold({ ...base, bend: -30 }, 300);
      expect(flex[0]).toBe(extLeft ? 'right' : 'left');
    });
  }
});

describe('AxisSelector hysteresis with twist sweeps', () => {
  const yawAt = (twist: number) => knuckleYaw(syntheticHand({ pose: 'front', palm: 'camera', handedness: 'Right', bend: 0, twist }).worldLandmarks);
  it('first reading picks by the 45 degree midpoint', () => {
    expect(new AxisSelector().update(30, 0)).toBe('vertical');
    expect(new AxisSelector().update(60, 0)).toBe('horizontal');
    expect(new AxisSelector().update(null, 0)).toBeNull();
  });
  it('stays vertical through a partial twist, flips to horizontal only after dwell above 55', () => {
    const sel = new AxisSelector();
    let t = 0;
    sel.update(yawAt(0), t);
    for (let twist = 0; twist <= 50; twist += 10) { t += 50; expect(sel.update(yawAt(twist), t)).toBe('vertical'); }
    for (let i = 0; i < 30; i++) { t += 50; expect(sel.update(yawAt(50), t)).toBe('vertical'); }
    t += 50; expect(sel.update(yawAt(70), t)).toBe('vertical'); // dwell not met
    t += 100; expect(sel.update(yawAt(70), t)).toBe('vertical');
    t += 100; expect(sel.update(yawAt(70), t)).toBe('horizontal');
  });
  it('a brief excursion across the threshold does not flip', () => {
    const sel = new AxisSelector();
    sel.update(yawAt(0), 0);
    sel.update(yawAt(70), 50);
    sel.update(yawAt(70), 100);
    expect(sel.update(yawAt(20), 150)).toBe('vertical');
    expect(sel.update(yawAt(70), 200)).toBe('vertical');
    expect(sel.update(yawAt(70), 300)).toBe('vertical');
  });
  it('returning needs yaw below 35, not merely below 55', () => {
    const sel = new AxisSelector();
    sel.update(80, 0);
    for (let t = 50; t < 1500; t += 50) expect(sel.update(45, t)).toBe('horizontal');
    sel.update(25, 1550);
    expect(sel.update(25, 1600)).toBe('horizontal');
    expect(sel.update(25, 1750)).toBe('vertical');
  });
  it('ignores unreadable frames', () => {
    const sel = new AxisSelector();
    sel.update(10, 0);
    expect(sel.update(null, 100)).toBe('vertical');
    expect(sel.update(NaN, 200)).toBe('vertical');
  });
});

describe('VerticalCalibration', () => {
  const settle = (cal: VerticalCalibration, pitch: number, from: number, to: number, palm = 1) => {
    let v: number | null = null;
    for (let t = from; t <= to; t += FRAME_MS) v = cal.update(pitch, palm, t);
    return v;
  };
  it('outputs nothing until a steady 300 ms hold', () => {
    const cal = new VerticalCalibration();
    for (let t = 0; t < 270; t += FRAME_MS) expect(cal.update(5, 1, t)).toBeNull();
    expect(cal.calibrated).toBe(false);
    let out: number | null = null;
    for (let t = 270; t < 450; t += FRAME_MS) out = cal.update(5, 1, t) ?? out;
    expect(cal.calibrated).toBe(true);
    expect(cal.baseline).toBeCloseTo(5, 5);
    expect(out).toBeCloseTo(0, 5);
  });
  it('wobbling more than 6 degrees never calibrates', () => {
    const cal = new VerticalCalibration();
    for (let t = 0, i = 0; t < 2000; t += FRAME_MS, i++) expect(cal.update(i % 2 ? 0 : 10, 1, t)).toBeNull();
    expect(cal.calibrated).toBe(false);
  });
  it('rejects a steady pose beyond 45 degrees as zero', () => {
    const cal = new VerticalCalibration();
    expect(settle(cal, 60, 0, 2000)).toBeNull();
    expect(settle(cal, -50, 2000, 4000)).toBeNull();
    expect(cal.calibrated).toBe(false);
    expect(settle(cal, 40, 4000, 5000)).toBeCloseTo(0, 3);
    expect(cal.calibrated).toBe(true);
  });
  it('flexion is negative when the palm faces the camera and positive when it does not; swap inverts', () => {
    const cal = new VerticalCalibration();
    settle(cal, 0, 0, 600, 1);
    // knuckles toward the camera (+pitch) with palm toward camera = flexion
    expect(cal.update(30, 1, 640)).toBeCloseTo(-30, 3);
    expect(cal.update(-30, 1, 680)).toBeCloseTo(30, 3);
    cal.swap = true;
    expect(cal.update(30, 1, 720)).toBeCloseTo(30, 3);
    cal.swap = false;
    const back = new VerticalCalibration();
    settle(back, 0, 0, 600, -1);
    expect(back.palmFacesCamera).toBe(false);
    expect(back.update(30, -1, 640)).toBeCloseTo(30, 3);
  });
  it('palm sign is held through a bend even if the cue flips', () => {
    const cal = new VerticalCalibration();
    settle(cal, 0, 0, 600, 1);
    for (let t = 640; t < 1500; t += FRAME_MS) cal.update(35, -1, t);
    expect(cal.palmFacesCamera).toBe(true);
  });
  it('follows slow drift while straight but does not absorb a held bend', () => {
    const cal = new VerticalCalibration();
    settle(cal, 0, 0, 600);
    let t = 600, pitch = 0, out = 0;
    for (; t < 600 + 30000; t += FRAME_MS) { pitch += 0.00035 * FRAME_MS; out = cal.update(pitch, 1, t)!; } // ~0.35 deg/s
    expect(pitch).toBeGreaterThan(9);
    expect(Math.abs(out)).toBeLessThan(5);
    const held = pitch - 35;
    let bent = 0;
    for (const end = t + 20000; t < end; t += FRAME_MS) bent = cal.update(held, 1, t)!;
    expect(bent).toBeGreaterThan(30); // extension, still 35-ish
  });
  it('reset forgets the zero', () => {
    const cal = new VerticalCalibration();
    settle(cal, 3, 0, 600);
    cal.reset();
    expect(cal.calibrated).toBe(false);
    expect(cal.update(3, 1, 700)).toBeNull();
  });
});

describe('WristGesture vertical actions', () => {
  const v = (angle: number) => ({ axis: 'vertical' as const, angle });
  const h = (angle: number) => ({ axis: 'horizontal' as const, angle });
  const run = (g: WristGesture, r: ReturnType<typeof v>, t0: number, ms: number) => {
    const out: WristAction[] = [];
    for (let t = t0; t <= t0 + ms; t += FRAME_MS) { const a = g.update(r, t, true); if (a) out.push(a); }
    return { out, end: t0 + ms + FRAME_MS };
  };
  const armed = () => { const g = new WristGesture(); const { end } = run(g, v(0), 0, 400); return { g, t: end }; };

  it('needs neutral first', () => {
    const g = new WristGesture();
    expect(run(g, v(30), 0, 1000).out).toEqual([]);
  });
  it('fires exactly one action per held bend, no repeat', () => {
    const { g, t } = armed();
    const up = run(g, v(30), t, 3000);
    expect(up.out).toEqual(['up']);
    const down = (() => { const n = run(g, v(0), up.end, 300); return run(g, v(-30), n.end, 3000); })();
    expect(down.out).toEqual(['down']);
  });
  it('re-arms after neutral, and requires the dwell to commit neutral', () => {
    const { g, t } = armed();
    const a = run(g, v(30), t, 400);
    expect(a.out).toEqual(['up']);
    // 1-2 frames of neutral is not enough to re-arm
    const blip = run(g, v(0), a.end, 40);
    const again = run(g, v(30), blip.end, 400);
    expect(again.out).toEqual([]);
    const n = run(g, v(0), again.end, 300);
    expect(run(g, v(30), n.end, 400).out).toEqual(['up']);
  });
  it('needs the 120 ms dwell', () => {
    const { g, t } = armed();
    expect(g.update(v(30), t, true)).toBeNull();
    expect(g.update(v(30), t + 60, true)).toBeNull();
    expect(g.update(v(30), t + 130, true)).toBe('up');
  });
  it('hysteresis: 12-20 degrees never starts an action, but keeps an action started above 20', () => {
    const { g, t } = armed();
    const mid = run(g, v(16), t, 1000);
    expect(mid.out).toEqual([]);
    const up = run(g, v(25), mid.end, 400);
    expect(up.out).toEqual(['up']);
    expect(run(g, v(16), up.end, 1000).out).toEqual([]); // still held, no refire
    const n = run(g, v(0), up.end + 1100, 300);
    expect(run(g, v(-16), n.end, 600).out).toEqual([]);
    expect(run(g, v(-21), n.end + 700, 400).out).toEqual(['down']);
  });
  it('switching axis mid-bend requires neutral again', () => {
    const { g, t } = armed();
    const a = run(g, v(30), t, 300);
    expect(a.out).toEqual(['up']);
    // Rotate forearm: the horizontal reading is bent, so nothing may fire.
    const mid = run(g, h(-30), a.end, 1000);
    expect(mid.out).toEqual([]);
    expect(g.state).toBe('center');
    const n = run(g, h(0), mid.end, 300);
    expect(run(g, h(-30), n.end, 300).out[0]).toBe('left');
    // and back to vertical while bent
    const bentV = run(g, v(30), n.end + 400, 1000);
    expect(bentV.out).toEqual([]);
  });
  it('horizontal still repeats while held (side-on unchanged)', () => {
    const g = new WristGesture();
    run(g, h(0), 0, 400);
    const held = run(g, h(-30), 500, 1500);
    expect(held.out.length).toBeGreaterThan(3);
    expect(new Set(held.out)).toEqual(new Set(['left']));
  });
});
