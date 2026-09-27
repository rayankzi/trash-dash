// Crop the HUD / menu icons out of Unity's UISpritesheet.png (and the logo out
// of its mostly-empty 720x720 canvas) so the overlay UI can use them as plain
// <img> sources. Sheet rectangles are sprite bounds in the 2048x779 sheet,
// found by alpha connected-component analysis.
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const UI = path.resolve(import.meta.dirname, '../public/assets/ui');
const SHEET = path.join(UI, 'UISpritesheet.png');
const LOGO = path.join(UI, 'Logo.png');
const OUT = path.join(UI, 'icons');
const PAD = 4;

/** name -> [x, y, width, height] in source pixels (UISpritesheet unless noted). */
const ICONS = {
  logo: [0, 0, 720, 470, LOGO],
  magnet: [1461, 303, 102, 103],
  score2: [1590, 303, 120, 98],
  invincibility: [1739, 284, 123, 117],
  extralife: [1888, 295, 102, 93],
  fishbone: [865, 294, 58, 31],
  premium: [799, 287, 45, 45],
  heart: [741, 289, 46, 41],
  cat: [1582, 467, 140, 117],
  raccoon: [1582, 639, 131, 115],
  day: [1866, 435, 140, 151],
  night: [1866, 603, 140, 151],
  trophy: [20, 477, 63, 61],
};

/**
 * The logo sits on a translucent white sunburst that reads as a grey box over
 * the 3D scene. The rays are the only translucent near-white pixels (the
 * lettering's white rim is opaque), so key those out, softening the cut-off.
 */
async function writeWithoutSunburst(image, dest) {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const lightest = Math.min(data[i], data[i + 1], data[i + 2]);
    if (alpha < 254 && lightest > 150) {
      data[i + 3] = Math.min(255, Math.max(0, (alpha - 225) * 8));
    }
  }
  await sharp(data, { raw: info }).png().toFile(dest);
}

mkdirSync(OUT, { recursive: true });
let written = 0;

for (const [name, [x, y, w, h, source = SHEET]] of Object.entries(ICONS)) {
  const dest = path.join(OUT, `${name}.png`);
  try {
    if (statSync(dest).mtimeMs > statSync(source).mtimeMs) continue;
  } catch {
    // missing: fall through and write it
  }
  const meta = await sharp(source).metadata();
  const left = Math.max(0, x - PAD);
  const top = Math.max(0, y - PAD);
  const width = Math.min(meta.width - left, w + PAD * 2);
  const height = Math.min(meta.height - top, h + PAD * 2);
  const crop = sharp(source).extract({ left, top, width, height });
  if (source === LOGO) await writeWithoutSunburst(crop, dest);
  else await crop.png().toFile(dest);
  written++;
}

console.log(`ui icons: ${written} written, ${Object.keys(ICONS).length - written} up to date`);
