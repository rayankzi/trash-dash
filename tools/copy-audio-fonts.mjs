// Copy web-ready OGG audio into public/assets/audio. The 36.5MB adaptive music
// stems are deliberately excluded until the stretch phase.
import { mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { UNITY_ROOT } from './lib/unity.mjs';

const OUT = path.resolve(import.meta.dirname, '../public/assets/audio');

const isNewer = (src, dest) => {
  try {
    return statSync(src).mtimeMs > statSync(dest).mtimeMs;
  } catch {
    return true;
  }
};

let copied = 0;
let skipped = 0;
for (const rel of fg.sync(['Assets/Sounds/SFX/**/*.ogg', 'Assets/Sounds/Music/*.ogg'], { cwd: UNITY_ROOT })) {
  const src = path.join(UNITY_ROOT, rel);
  const dest = path.join(OUT, path.relative('Assets/Sounds', rel));
  if (!isNewer(src, dest)) {
    skipped++;
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied++;
}
console.log(`audio: ${copied} copied, ${skipped} up-to-date`);
