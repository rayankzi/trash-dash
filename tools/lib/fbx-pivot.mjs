// Minimal binary-FBX reader used to detect a specific, narrow authoring defect
// seen in a handful of source models (see README below the function).
//
// We do NOT implement a general FBX parser here -- just enough of the FBX
// 7.x binary node-record format (magic header, 64-bit record header, typed
// properties) to walk "Objects" for Model nodes and "GlobalSettings" for the
// scene unit, and to read a handful of named Properties70 entries.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function readFbxDocument(buf) {
  let pos = 0;
  const u8 = () => buf.readUInt8(pos++);
  const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const u64 = () => { const v = Number(buf.readBigUInt64LE(pos)); pos += 8; return v; };
  const i16 = () => { const v = buf.readInt16LE(pos); pos += 2; return v; };
  const i32 = () => { const v = buf.readInt32LE(pos); pos += 4; return v; };
  const i64 = () => { const v = Number(buf.readBigInt64LE(pos)); pos += 8; return v; };
  const f32 = () => { const v = buf.readFloatLE(pos); pos += 4; return v; };
  const f64 = () => { const v = buf.readDoubleLE(pos); pos += 8; return v; };
  const bytes = (n) => { const v = buf.subarray(pos, pos + n); pos += n; return v; };

  const magic = buf.subarray(0, 21).toString('latin1');
  if (!magic.startsWith('Kaydara FBX Binary')) return null;
  pos = 23;
  const version = u32();
  const use64 = version >= 7500; // FBX 7500+ widened record header fields to 64-bit

  function readProperty() {
    const type = String.fromCharCode(u8());
    switch (type) {
      case 'Y': return i16();
      case 'C': return u8() !== 0;
      case 'I': return i32();
      case 'F': return f32();
      case 'D': return f64();
      case 'L': return i64();
      case 'S': { const len = u32(); return bytes(len).toString('latin1'); }
      case 'R': { const len = u32(); return bytes(len); }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        // Bulk typed array: length, encoding (0=raw,1=zlib), compressed byte length, data.
        const arrLen = u32();
        const encoding = u32();
        const compLen = u32();
        const elemSize = { f: 4, d: 8, l: 8, i: 4, b: 1 }[type];
        const raw = encoding === 0 ? bytes(arrLen * elemSize) : zlib.inflateSync(bytes(compLen));
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const arr = new Array(arrLen);
        for (let i = 0; i < arrLen; i++) {
          if (type === 'f') arr[i] = dv.getFloat32(i * 4, true);
          else if (type === 'd') arr[i] = dv.getFloat64(i * 8, true);
          else if (type === 'l') arr[i] = Number(dv.getBigInt64(i * 8, true));
          else if (type === 'i') arr[i] = dv.getInt32(i * 4, true);
          else arr[i] = dv.getUint8(i) !== 0;
        }
        return arr;
      }
      default:
        throw new Error(`unknown FBX property type '${type}' at byte ${pos}`);
    }
  }

  function readNode() {
    const endOffset = use64 ? u64() : u32();
    const numProps = use64 ? u64() : u32();
    const propListLen = use64 ? u64() : u32();
    const nameLen = u8();
    const name = bytes(nameLen).toString('latin1');
    if (endOffset === 0 && numProps === 0 && propListLen === 0 && nameLen === 0) return null; // NULL sentinel record
    const propsStart = pos;
    const properties = [];
    for (let i = 0; i < numProps; i++) properties.push(readProperty());
    pos = propsStart + propListLen;
    const children = [];
    while (pos < endOffset) {
      const child = readNode();
      if (child === null) break;
      children.push(child);
    }
    pos = endOffset;
    return { name, properties, children };
  }

  const topLevel = [];
  while (pos < buf.length) {
    let node;
    try {
      node = readNode();
    } catch {
      break; // trailing footer bytes are not node records; stop cleanly
    }
    if (node === null) {
      // A NULL record at top level *might* just be the end-of-siblings marker
      // for the node we're inside of; probe once more before giving up.
      const save = pos;
      try {
        const maybe = readNode();
        if (maybe === null) break;
        topLevel.push(maybe);
        continue;
      } catch {
        pos = save;
        break;
      }
    }
    topLevel.push(node);
  }
  return topLevel;
}

function findAll(nodes, name, acc = []) {
  for (const n of nodes) {
    if (n.name === name) acc.push(n);
    if (n.children) findAll(n.children, name, acc);
  }
  return acc;
}

function properties70Of(node) {
  const p70 = node.children?.find((c) => c.name === 'Properties70');
  if (!p70) return {};
  const result = {};
  for (const p of p70.children) {
    if (p.name !== 'P') continue;
    result[p.properties[0]] = p.properties.slice(4); // [name,type,label,flags, ...values]
  }
  return result;
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const vecNear = (a, b, eps = 1e-6) => a.every((v, i) => near(v, b[i], eps));
const vecMag = (v) => Math.hypot(...v);

/**
 * Detects the "orphaned Max pivot" defect and returns the correction to apply
 * to FBX2glTF's output, in meters, or null if the file doesn't match.
 *
 * BACKGROUND: two Daytime warehouse models shipped with their glTF geometry
 * baked ~98 units away from their node origin (see convert-models.mjs for
 * where this is applied). Root-cause investigation (see web-game/tools -- no
 * separate doc, see PR/commit description) found:
 *
 *   - The source FBX's single Model node has RotationPivot/ScalingPivot set
 *     to a large, non-zero value (evidently 3ds Max's "Affect Pivot Only"
 *     was used to move the object's pivot to its bounding-box centre, but
 *     the underlying mesh vertices were never re-frozen to local origin
 *     afterward -- so the raw control points are still authored ~ that same
 *     distance from (0,0,0)).
 *   - FBX2glTF 0.9.7 does not evaluate the FBX rotation/scaling pivot chain
 *     at all: patching RotationPivot/ScalingPivot to zero in the source FBX
 *     and reconverting produces byte-identical (still-offset) output. So it
 *     emits the Geometry node's raw, off-centre control points verbatim
 *     while leaving the glTF node's translation at identity.
 *   - Unity's own FBX importer *does* evaluate that pivot chain when baking
 *     the imported Mesh asset (confirmed: the shipped .prefab places these
 *     GameObjects at local (0,0,0), same as every correctly-behaving model,
 *     so Unity's copy of the geometry must already be centred).
 *
 * RotationPivot therefore isn't causing the bug mechanically -- but it is an
 * exact, verifiable record of how far off-centre the raw vertex data is
 * (confirmed against each affected model's correct counterpart to sub-cm
 * precision), which is what we use to correct FBX2glTF's output.
 *
 * To avoid ever "correcting" a model whose pivot is legitimately doing
 * something (rotation/scale about an off-centre point), this only fires when
 * the node has no Lcl Translation/Rotation/Scaling override (i.e. is
 * otherwise fully identity) and RotationPivot === ScalingPivot exactly --
 * the signature of a pivot that mathematically cannot affect the correct,
 * intended position and exists purely as an editing convenience in the DCC
 * tool.
 *
 * That structural check alone isn't sufficient though: several otherwise
 * fine models (e.g. NightTime/Car01Night.fbx, NightTime/Car02Night.fbx,
 * NightTime/BinBagClosedNight.fbx) also carry a small, harmless non-zero
 * pivot (a few cm, i.e. a natural "anchor point isn't dead centre" offset)
 * that FBX2glTF correctly leaves un-baked. So this function only reports the
 * *candidate* offset; the caller (see glb-recenter.mjs's recenterGlbPositions)
 * additionally checks the candidate's magnitude against the converted mesh's
 * own bounding-box extent before applying it, since that's where we can
 * actually tell a "leftover layout position" (comparable to the object's own
 * size) apart from a "minor anchor offset" (a small fraction of it).
 */
export function detectStaticPivotOffsetMeters(fbxPath) {
  const buf = readFileSync(fbxPath);
  const topLevel = readFbxDocument(buf);
  if (!topLevel) return null; // ASCII FBX or unrecognised header; not handled

  const models = [];
  for (const objs of findAll(topLevel, 'Objects')) {
    for (const c of objs.children) if (c.name === 'Model') models.push(c);
  }
  if (models.length !== 1) return null; // only simple, non-skeletal single-mesh props

  const props = properties70Of(models[0]);
  const rp = props['RotationPivot'];
  const sp = props['ScalingPivot'];
  if (!rp || !sp) return null;
  if (props['Lcl Translation'] || props['Lcl Rotation'] || props['Lcl Scaling']) return null; // pivot may legitimately matter
  if (!vecNear(rp, sp)) return null; // pivot chain only cancels when rotation & scaling pivots coincide
  if (vecMag(rp) < 1e-3) return null; // ignore float authoring noise (sub-hundredth-of-a-mm)

  let unitScaleFactor = 1; // cm per FBX unit; FBX default scene unit is cm
  for (const gs of findAll(topLevel, 'GlobalSettings')) {
    const gsProps = properties70Of(gs);
    if (gsProps['UnitScaleFactor']) unitScaleFactor = gsProps['UnitScaleFactor'][0];
  }
  // FBX2glTF always emits meters; it converts by (raw * unitScaleFactor / 100).
  const toMeters = unitScaleFactor / 100;
  return { x: rp[0] * toMeters, y: rp[1] * toMeters, z: rp[2] * toMeters };
}
