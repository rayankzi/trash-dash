// Shifts every POSITION accessor's vertex data in a binary glTF (.glb) file
// by a constant offset, in place. Used to correct the small set of converted
// models whose FBX source has raw geometry authored off-centre relative to
// its node origin (see fbx-pivot.mjs for the full root-cause writeup).
//
// Only POSITION touches vertex coordinates; normals/tangents/UVs and the
// glTF node transforms are left untouched, since a pure translation of the
// mesh doesn't change any of those.
import { readFileSync, writeFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a .glb file');
  const totalLength = buf.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < totalLength) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkType === CHUNK_JSON) json = JSON.parse(buf.toString('utf8', dataStart, dataStart + chunkLength));
    else if (chunkType === CHUNK_BIN) bin = buf.subarray(dataStart, dataStart + chunkLength);
    offset = dataStart + chunkLength;
  }
  if (!json || !bin) throw new Error('.glb missing JSON or BIN chunk');
  return { json, bin };
}

function writeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // glTF pads JSON with spaces

  let binBuf = bin;
  const binPad = (4 - (binBuf.length % 4)) % 4;
  if (binPad) binBuf = Buffer.concat([binBuf, Buffer.alloc(binPad, 0)]); // and BIN with zero bytes

  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4); // glTF version
  out.writeUInt32LE(total, 8);

  let o = 12;
  out.writeUInt32LE(jsonBuf.length, o); out.writeUInt32LE(CHUNK_JSON, o + 4); jsonBuf.copy(out, o + 8);
  o += 8 + jsonBuf.length;
  out.writeUInt32LE(binBuf.length, o); out.writeUInt32LE(CHUNK_BIN, o + 4); binBuf.copy(out, o + 8);

  return out;
}

// A candidate pivot offset (see fbx-pivot.mjs) is only trusted as a genuine
// "raw geometry authored off-centre" defect -- rather than a small, benign
// anchor-point pivot that FBX2glTF correctly leaves alone -- when it's a
// substantial fraction of the mesh's own size on that axis. Measured across
// the known-good and known-bad models in this project: confirmed defects
// have a pivot-to-extent ratio of 0.49-9.6x; benign small pivots (e.g.
// NightTime/Car01Night, Car02Night, BinBagClosedNight/BinBagOpenNight) top
// out at 0.068x. 0.2 sits in the middle of that (~7x) gap on a log scale, so
// it comfortably separates the two groups without being tuned to either.
const MIN_PIVOT_TO_EXTENT_RATIO = 0.2;

/**
 * Subtract {x,y,z} (meters) from every vertex used as a POSITION attribute,
 * but only if `shift` is large relative to the mesh's own bounding-box
 * extent on at least one axis (see MIN_PIVOT_TO_EXTENT_RATIO above) -- i.e.
 * only if it looks like the defect this function exists to correct, not a
 * legitimate small pivot FBX2glTF already handled correctly by ignoring.
 *
 * Throws if any mesh-referencing node has a non-identity transform (the
 * defect this corrects has only ever been observed on identity nodes; a
 * non-identity node would mean our assumptions about the file don't hold).
 *
 * Returns a summary of the accessors touched (empty if skipped), for
 * logging/verification.
 */
export function recenterGlbPositions(glbPath, shift) {
  const buf = readFileSync(glbPath);
  const { json, bin } = readGlb(buf);

  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    const identity = t.every((v) => v === 0) && r.slice(0, 3).every((v) => v === 0) && r[3] === 1 && s.every((v) => v === 1);
    if (!identity) {
      throw new Error(`${glbPath}: node "${node.name}" has a non-identity transform; refusing to recentre`);
    }
  }

  const positionAccessorIdx = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.attributes?.POSITION !== undefined) positionAccessorIdx.add(prim.attributes.POSITION);
    }
  }

  // Combined bounding box across every POSITION accessor, before any change,
  // to evaluate the pivot-to-extent ratio gate below.
  const combinedMin = [Infinity, Infinity, Infinity];
  const combinedMax = [-Infinity, -Infinity, -Infinity];
  for (const idx of positionAccessorIdx) {
    const acc = json.accessors[idx];
    for (let k = 0; k < 3; k++) {
      combinedMin[k] = Math.min(combinedMin[k], acc.min[k]);
      combinedMax[k] = Math.max(combinedMax[k], acc.max[k]);
    }
  }
  const extent = [0, 1, 2].map((k) => combinedMax[k] - combinedMin[k]);
  const shiftArr = [shift.x, shift.y, shift.z];
  const confirmed = [0, 1, 2].some((k) => extent[k] > 0 && Math.abs(shiftArr[k]) / extent[k] >= MIN_PIVOT_TO_EXTENT_RATIO);
  if (!confirmed) return [];

  const touched = [];
  for (const idx of positionAccessorIdx) {
    const acc = json.accessors[idx];
    if (acc.componentType !== 5126 /* FLOAT */ || acc.type !== 'VEC3') {
      throw new Error(`${glbPath}: accessor ${idx} is not a FLOAT VEC3 POSITION accessor`);
    }
    const view = json.bufferViews[acc.bufferView];
    const stride = view.byteStride ?? 12;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < acc.count; i++) {
      const off = base + i * stride;
      for (const [axis, k] of [['x', 0], ['y', 1], ['z', 2]]) {
        const v = bin.readFloatLE(off + k * 4) - shift[axis];
        bin.writeFloatLE(v, off + k * 4);
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const before = { min: acc.min, max: acc.max };
    acc.min = min;
    acc.max = max;
    touched.push({ accessor: idx, before, after: { min, max } });
  }

  writeFileSync(glbPath, writeGlb(json, bin));
  return touched;
}
