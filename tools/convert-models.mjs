// Convert every FBX model and animation clip to binary glTF via FBX2glTF.
// Git-LFS pointer stubs (un-pulled binaries) are skipped with a warning.
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fg from 'fast-glob';
import { UNITY_ROOT } from './lib/unity.mjs';
import { detectStaticPivotOffsetMeters } from './lib/fbx-pivot.mjs';
import { recenterGlbPositions } from './lib/glb-recenter.mjs';

const run = promisify(execFile);
const FBX2GLTF = path.resolve(
  import.meta.dirname,
  '../node_modules/fbx2gltf/bin',
  process.platform === 'darwin' ? 'Darwin' : process.platform === 'win32' ? 'Windows_NT' : 'Linux',
  process.platform === 'win32' ? 'FBX2glTF.exe' : 'FBX2glTF'
);
const OUT = path.resolve(import.meta.dirname, '../public/assets');

const isLfsStub = (file) => {
  if (statSync(file).size > 1024) return false;
  return readFileSync(file, 'utf8').startsWith('version https://git-lfs.github.com/spec/v1');
};

const isNewer = (src, dest) => {
  try {
    return statSync(src).mtimeMs > statSync(dest).mtimeMs;
  } catch {
    return true;
  }
};

// Map source FBX -> output GLB. Models keep their folder structure; animation
// clips go under anim/.
const jobs = [];
for (const rel of fg.sync('Assets/Models/**/*.{fbx,FBX}', { cwd: UNITY_ROOT })) {
  const outRel = path.join('models', path.relative('Assets/Models', rel)).replace(/\.fbx$/i, '');
  jobs.push({ src: path.join(UNITY_ROOT, rel), out: path.join(OUT, outRel) });
}
for (const rel of fg.sync('Assets/Animation/*.{fbx,FBX}', { cwd: UNITY_ROOT })) {
  const outRel = path.join('anim', path.basename(rel).replace(/\.fbx$/i, ''));
  jobs.push({ src: path.join(UNITY_ROOT, rel), out: path.join(OUT, outRel) });
}

let done = 0;
let skipped = 0;
let stubs = 0;
let recentered = 0;
const failures = [];

const CONCURRENCY = 8;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const glb = job.out + '.glb';
      if (isLfsStub(job.src)) {
        console.warn(`SKIP (git-lfs pointer, run 'git lfs pull' in ${UNITY_ROOT} to fetch): ${job.src}`);
        stubs++;
        continue;
      }
      if (!isNewer(job.src, glb)) {
        skipped++;
        continue;
      }
      mkdirSync(path.dirname(glb), { recursive: true });
      try {
        await run(FBX2GLTF, ['--binary', '-i', job.src, '-o', job.out]);
        done++;

        // FBX2glTF 0.9.7 does not evaluate the FBX rotation/scaling pivot
        // chain, so a small number of source models -- ones whose mesh
        // vertices were authored off-centre relative to the node's origin,
        // with only the DCC-tool pivot left recording the true centre --
        // come out with geometry baked far from their node's translation.
        // Unity's own FBX importer bakes these correctly (confirmed against
        // the shipped .prefab placement); FBX2glTF doesn't. Detect and
        // correct that here, driven entirely by the source FBX's own pivot
        // data -- see tools/lib/fbx-pivot.mjs for the full root-cause
        // writeup and the safety conditions that gate this.
        const shift = detectStaticPivotOffsetMeters(job.src);
        if (shift) {
          // recenterGlbPositions itself re-checks the shift against the
          // mesh's own bounding-box extent and no-ops (returns []) for
          // small, legitimate pivots that FBX2glTF already handled fine.
          const touched = recenterGlbPositions(glb, shift);
          if (touched.length > 0) {
            recentered++;
            console.log(
              `RECENTER ${path.relative(OUT, glb)} by (${shift.x.toFixed(3)}, ${shift.y.toFixed(3)}, ${shift.z.toFixed(3)}) ` +
                `[${touched.length} accessor(s)]`
            );
          }
        }
      } catch (err) {
        failures.push({ src: job.src, message: err.stderr || err.message });
      }
    }
  })
);

console.log(
  `models: ${done} converted, ${skipped} up-to-date, ${stubs} LFS stubs skipped, ${recentered} recentered, ${failures.length} failed`
);
for (const f of failures) console.error(`FAILED: ${f.src}\n  ${f.message.split('\n')[0]}`);
if (failures.length > 0) process.exitCode = 1;
