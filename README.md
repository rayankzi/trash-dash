# Trash Dash — Web

A JavaScript/WebGL port of Unity's "Trash Dash" endless-runner sample (in
`../EndlessRunnerSampleGame`),
built with **three.js + Vite + TypeScript**, reusing the original game's models, textures,
animations, and audio.

## Run it

```bash
npm install
npm run assets   # converts EndlessRunnerSampleGame assets -> public/assets + src/data
npm run dev      # http://localhost:5173
```

Set `UNITY_SOURCE_DIR=/absolute/path/to/a/Unity/project` to use another source checkout.
Unity object `fileID` values are kept as strings during extraction so 64-bit component
references cannot be rounded by JavaScript.

`npm run build` produces a production build in `dist/`.

## Validate it

```bash
npm test                 # extraction, model/texture, obstacle, and road-coverage invariants
npm run test:visual      # deterministic Chromium render checks at desktop + portrait sizes
npm run test:visual:update # intentionally refresh visual baselines
```

## Controls

- **←/→** (or A/D): change lane
- **↑** (or W / Space): jump
- **↓** (or S): slide
- **Esc** (or P): pause / resume
- Touch: swipe in any direction

## Asset pipeline (`tools/`)

| Script | What it does |
|---|---|
| `convert-textures.mjs` | TIFF albedos → WebP (sharp); copies particle/UI PNGs |
| `convert-models.mjs` | Every FBX → binary glTF via FBX2glTF; skips un-pulled Git-LFS stubs (`Dog.FBX`, `Dog_Run.fbx`, `MenuActors.fbx`) |
| `extract-segments.mjs` | Parses Unity prefab YAML → `src/data/segments/**` (path nodes, obstacle spawn t-values, visual node trees) and `obstacles.json` |
| `build-manifest.mjs` | Parses `ThemeData` + `.mat` YAML → `themes.json` (zones, fog, sky/cloud environment) and `materials.json` (shader family + exact texture URL/tint) |
| `copy-audio-fonts.mjs` | Copies OGG SFX/music (the 36 MB adaptive-stem set is deliberately excluded) |

All steps are idempotent (mtime-checked). The `unity-game/` folder is read-only source.

## Architecture (`src/`)

- `track/TrackManager.ts` — port of Unity's `TrackManager.cs`: speed/score/multiplier,
  10-segment rolling queue with exit→entry stitching and random mirroring, floating-origin
  recentring, coin/powerup placement (1.5-unit lane walk with obstacle avoidance).
- `track/TrackSegment.ts` — piecewise-linear path sampling (`GetPointAt` equivalent).
- `character/` — controller (lanes/jump/slide driven by world distance, exact Unity constants),
  AABB collider with lives + invincibility blink, animation wrapper (Cat clips drive both
  characters — identical rigs).
- `obstacles/` — SimpleBarricade, AllLane, Patrolling (ping-pong), Missile behaviours from
  extracted prefab data.
- `consumables/` — Magnet (15s), Score×2 (10s), Invincibility (10s), Extra Life; ramping
  spawn chances as in the original.
- `rendering/CurvedMaterial.ts` — the signature Unity clip-space curved-world shader,
  plus shader-family-specific alpha, cloud, vertex-color, standard, and blink materials.
- `rendering/` also holds the presentation layer the original leaves to Unity's renderer:
  `PostProcessing` (bloom + per-theme colour grade, vignette, damage flash), `SkyDome`
  (gradient sky replacing the flat theme fog colour), `GroundHaze` (fills the void beside
  the authored street), `CharacterShadow`, and `ThemeLook` (per-theme fog/ground/light rig).
- `save/` — versioned JSON save in localStorage (coins, premium, unlocks, top-10 leaderboard,
  missions — 5 types, always 2 active).
- `ui/` — HTML/CSS overlay (loadout with character purchase, time-of-day option, HUD,
  pause menu, game over).

## Known gaps vs. the original

- The original running dog model is an unresolved Git-LFS pointer. The web build uses a
  visible low-poly fallback automatically and will prefer the original after it is fetched
  and assets are regenerated.
- Adaptive layered music stems, character accessories UI, and the tutorial are not ported yet.
- The rendered world is a consistent mirror image of Unity's (handedness); segments randomly
  mirror in the original anyway, so gameplay is unaffected.
