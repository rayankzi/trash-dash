// Convert Unity TIFF albedos to WebP and copy web-ready PNGs into public/assets.
import { mkdirSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import sharp from 'sharp';
import { UNITY_ROOT } from './lib/unity.mjs';

const OUT = path.resolve(import.meta.dirname, '../public/assets/textures');
const UI_OUT = path.resolve(import.meta.dirname, '../public/assets/ui');
mkdirSync(OUT, { recursive: true });
mkdirSync(UI_OUT, { recursive: true });

const isNewer = (src, dest) => {
  try {
    return statSync(src).mtimeMs > statSync(dest).mtimeMs;
  } catch {
    return true; // dest missing
  }
};

let converted = 0;
let copied = 0;
let skipped = 0;

// TIFF albedos -> WebP (flat output dir; names are unique in the source project)
for (const rel of fg.sync('Assets/Textures/**/*.{tif,tiff}', { cwd: UNITY_ROOT })) {
  const src = path.join(UNITY_ROOT, rel);
  const dest = path.join(OUT, path.basename(rel, path.extname(rel)) + '.webp');
  if (!isNewer(src, dest)) {
    skipped++;
    continue;
  }
  await sharp(src).webp({ quality: 85 }).toFile(dest);
  converted++;
}

// Particle/effect PNGs are already web-friendly -> copy as-is
for (const rel of fg.sync('Assets/Textures/**/*.png', { cwd: UNITY_ROOT })) {
  const src = path.join(UNITY_ROOT, rel);
  const dest = path.join(OUT, path.basename(rel));
  if (!isNewer(src, dest)) {
    skipped++;
    continue;
  }
  copyFileSync(src, dest);
  copied++;
}

// UI sprites
for (const rel of fg.sync('Assets/UI/*.png', { cwd: UNITY_ROOT })) {
  const src = path.join(UNITY_ROOT, rel);
  const dest = path.join(UI_OUT, path.basename(rel));
  if (!isNewer(src, dest)) {
    skipped++;
    continue;
  }
  copyFileSync(src, dest);
  copied++;
}

console.log(`textures: ${converted} converted, ${copied} copied, ${skipped} up-to-date`);
