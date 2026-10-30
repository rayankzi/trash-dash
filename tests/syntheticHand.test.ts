import { describe, expect, it } from 'vitest';
import { syntheticHand, syntheticHandSource, type SyntheticHandOptions } from './helpers/syntheticHand';

const W = 640, H = 480;
const px = (r: ReturnType<typeof syntheticHand>, i: number) => ({ x: r.landmarks[i].x * W, y: r.landmarks[i].y * H, z: r.landmarks[i].z * W });
const wd = (r: ReturnType<typeof syntheticHand>, i: number, j: number) => {
  const a = r.worldLandmarks[i], b = r.worldLandmarks[j];
  return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
};
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
const base = (o: Partial<SyntheticHandOptions> = {}): SyntheticHandOptions =>
  ({ pose: 'side', bend: 0, handedness: 'Right', ...o });

describe('syntheticHand generator', () => {
  it('returns 21 landmarks, wrist at center with z=0, and 100px wrist->middle MCP', () => {
    const r = syntheticHand(base());
    expect(r.landmarks).toHaveLength(21);
    expect(r.worldLandmarks).toHaveLength(21);
    expect(r.landmarks[0]).toEqual({ x: 0.5, y: 0.7, z: 0 });
    const m = px(r, 9), w = px(r, 0);
    expect(Math.hypot(m.x - w.x, m.y - w.y)).toBeCloseTo(100, 0);
    expect(r.handedness[0].categoryName).toBe('Right');
  });

  it('side pose: knuckle line along z; front pose: along x', () => {
    const side = wd(syntheticHand(base({ pose: 'side' })), 5, 17);
    expect(Math.abs(side.z) / len(side)).toBeGreaterThan(0.98); // pinky MCP sits ~1cm closer to the wrist
    const front = wd(syntheticHand(base({ pose: 'front' })), 5, 17);
    expect(Math.abs(front.x) / len(front)).toBeGreaterThan(0.98);
    expect(len(front)).toBeCloseTo(0.07, 2);
  });

  it('side palm option picks which edge faces the camera', () => {
    const tc = syntheticHand(base({ pose: 'side', palm: 'thumb-camera' }));
    expect(tc.worldLandmarks[5].z).toBeLessThan(tc.worldLandmarks[17].z); // index (radial) side closer
    const pc = syntheticHand(base({ pose: 'side', palm: 'pinky-camera' }));
    expect(pc.worldLandmarks[17].z).toBeLessThan(pc.worldLandmarks[5].z);
  });

  it('right hand palm to camera has thumb at -x; back of hand flips; left mirrors', () => {
    const rp = syntheticHand(base({ pose: 'front', palm: 'camera' }));
    expect(rp.landmarks[5].x).toBeLessThan(rp.landmarks[17].x);
    expect(rp.landmarks[2].x).toBeLessThan(rp.landmarks[0].x);
    const rb = syntheticHand(base({ pose: 'front', palm: 'away' }));
    expect(rb.landmarks[5].x).toBeGreaterThan(rb.landmarks[17].x);
    const lp = syntheticHand(base({ pose: 'front', palm: 'camera', handedness: 'Left' }));
    expect(lp.landmarks[5].x).toBeGreaterThan(lp.landmarks[17].x);
  });

  it('front pose: extension moves middle MCP away from camera when palm faces camera, flexion toward', () => {
    const z = (bend: number, palm: 'camera' | 'away') => {
      const r = syntheticHand(base({ pose: 'front', bend, palm }));
      return r.worldLandmarks[9].z - r.worldLandmarks[0].z;
    };
    expect(z(0, 'camera')).toBeCloseTo(0, 6);
    expect(z(30, 'camera')).toBeGreaterThan(0.04);
    expect(z(-30, 'camera')).toBeLessThan(-0.04);
    expect(z(30, 'away')).toBeLessThan(-0.04); // back of hand to camera: extension comes toward camera
    expect(z(-30, 'away')).toBeGreaterThan(0.04);
    // in-image the hand stays vertical-ish (foreshortened)
    const r = syntheticHand(base({ pose: 'front', bend: 30 }));
    expect(Math.abs(px(r, 9).x - px(r, 0).x)).toBeLessThan(15);
  });

  it('side pose: bend tilts the 2D wrist->middle MCP by the bend angle (thumb-camera right: extension tilts left)', () => {
    const tilt = (bend: number, o: Partial<SyntheticHandOptions> = {}) => {
      const r = syntheticHand(base({ bend, ...o }));
      const m = px(r, 9), w = px(r, 0);
      return Math.atan2(m.x - w.x, -(m.y - w.y)) * 180 / Math.PI; // + = tilts to image right
    };
    expect(tilt(0)).toBeCloseTo(0, 3);
    expect(tilt(30)).toBeCloseTo(-30, 1);
    expect(tilt(-30)).toBeCloseTo(30, 1);
    expect(tilt(30, { palm: 'pinky-camera' })).toBeCloseTo(30, 1);
    expect(tilt(30, { handedness: 'Left' })).toBeCloseTo(30, 1);
  });

  it('left hand is the exact x-mirror of the right hand about the wrist', () => {
    for (const pose of ['side', 'front'] as const) {
      for (const bend of [-35, 0, 40]) {
        const R = syntheticHand(base({ pose, bend, handedness: 'Right' }));
        const Lh = syntheticHand(base({ pose, bend, handedness: 'Left' }));
        for (let i = 0; i < 21; i++) {
          expect(Lh.landmarks[i].x - 0.5).toBeCloseTo(-(R.landmarks[i].x - 0.5), 9);
          expect(Lh.landmarks[i].y).toBeCloseTo(R.landmarks[i].y, 9);
          expect(Lh.landmarks[i].z).toBeCloseTo(R.landmarks[i].z, 9);
        }
        expect(Lh.handedness[0].categoryName).toBe('Left');
      }
    }
  });

  it('normalized and world landmarks are consistent', () => {
    const S = 100 / 0.09;
    const r = syntheticHand(base({ pose: 'front', bend: 25, forearmTilt: { roll: 8, pitch: -6 } }));
    for (let i = 1; i < 21; i++) {
      const d = wd(r, 0, i);
      expect((r.landmarks[i].x - r.landmarks[0].x) * W / S).toBeCloseTo(d.x, 9);
      expect((r.landmarks[i].y - r.landmarks[0].y) * H / S).toBeCloseTo(d.y, 9);
      expect((r.landmarks[i].z - r.landmarks[0].z) * W / S).toBeCloseTo(d.z, 9);
    }
    const mean = r.worldLandmarks.reduce((s, p) => s + p.x + p.y + p.z, 0);
    expect(mean).toBeCloseTo(0, 9);
  });

  it('bend preserves bone lengths', () => {
    const a = syntheticHand(base({ pose: 'front', bend: 0 }));
    const b = syntheticHand(base({ pose: 'front', bend: 50, forearmTilt: { roll: 10, pitch: 10 }, twist: 20 }));
    for (let i = 1; i < 21; i++) expect(len(wd(b, 0, i))).toBeCloseTo(len(wd(a, 0, i)), 9);
  });

  it('fist curls fingers to the palm side; open hand extends them', () => {
    // front, palm to camera: palm side is -z
    const f = syntheticHand(base({ pose: 'front' }));
    for (const i of [6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20]) expect(f.worldLandmarks[i].z).toBeLessThan(f.worldLandmarks[0].z);
    expect(len(wd(f, 0, 12))).toBeLessThan(0.09);
    const open = syntheticHand(base({ pose: 'front', fist: false }));
    expect(len(wd(open, 0, 12))).toBeGreaterThan(0.17);
  });

  it('forearmTilt roll/pitch and twist behave', () => {
    const ang = (r: ReturnType<typeof syntheticHand>) => {
      const m = px(r, 9), w = px(r, 0);
      return Math.atan2(m.x - w.x, -(m.y - w.y)) * 180 / Math.PI;
    };
    // front pose: middle MCP is 1.2cm off the wrist axis, so compare against the untilted angle
    expect(ang(syntheticHand(base({ pose: 'front', forearmTilt: { roll: 12 } }))) - ang(syntheticHand(base({ pose: 'front' })))).toBeCloseTo(12, 3);
    const p = syntheticHand(base({ pose: 'front', forearmTilt: { pitch: 20 } }));
    expect(p.worldLandmarks[9].z).toBeLessThan(p.worldLandmarks[0].z); // pitch + = toward camera
    // 90 deg twist turns the front pose into a side pose (knuckles along z)
    const t = wd(syntheticHand(base({ pose: 'front', twist: 90 })), 5, 17);
    expect(Math.abs(t.z) / len(t)).toBeGreaterThan(0.98);
    const t0 = wd(syntheticHand(base({ pose: 'front', twist: 0 })), 5, 17);
    expect(Math.abs(t0.x) / len(t0)).toBeGreaterThan(0.98);
  });

  it('noise is deterministic per seed and bounded', () => {
    const a = syntheticHand(base({ noise: 0.002, seed: 7 }));
    const b = syntheticHand(base({ noise: 0.002, seed: 7 }));
    const c = syntheticHand(base({ noise: 0.002, seed: 8 }));
    const clean = syntheticHand(base());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(len(wd(a, 0, 9))).toBeCloseTo(len(wd(clean, 0, 9)), 1);
  });

  it('source string is self-contained (evaluates without module scope or helpers)', () => {
    const fn = new Function(`return ${syntheticHandSource}`)();
    expect(fn(base({ pose: 'front', bend: 20 }))).toEqual(syntheticHand(base({ pose: 'front', bend: 20 })));
  });
});
