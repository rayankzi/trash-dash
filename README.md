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
                         # (Unity-YAML checks skip when the Unity source is not checked out)
npm run test:visual      # deterministic render checks + a full run-flow test, desktop + portrait
npm run test:visual:update # intentionally refresh visual baselines
```

## Controls

- **←/→** (or A/D): change lane
- **↑** (or W / Space): jump — pressed just before landing, it fires on touchdown
- **↓** (or S): slide — mid-air, it fast-falls straight into a slide
- **Space / Enter**: start a run from the menu or results screen
- **Esc** (or P): pause / resume
- **M**: mute / unmute (saved)
- Touch: swipe in any direction

## Asset pipeline (`tools/`)

| Script | What it does |
|---|---|
| `convert-textures.mjs` | TIFF albedos → WebP (sharp); copies particle/UI PNGs |
| `convert-models.mjs` | Every FBX → binary glTF via FBX2glTF; skips un-pulled Git-LFS stubs (`Dog.FBX`, `Dog_Run.fbx`, `MenuActors.fbx`) |
| `extract-segments.mjs` | Parses Unity prefab YAML → `src/data/segments/**` (path nodes, obstacle spawn t-values, visual node trees) and `obstacles.json` |
| `build-manifest.mjs` | Parses `ThemeData` + `.mat` YAML → `themes.json` (zones, fog, sky/cloud environment) and `materials.json` (shader family + exact texture URL/tint) |
| `copy-audio-fonts.mjs` | Copies OGG SFX/music (the 36 MB adaptive-stem set is deliberately excluded) |
| `extract-ui-icons.mjs` | Crops HUD/menu icons out of Unity's `UISpritesheet.png`, and the logo out of `Logo.png` (keying out its translucent sunburst) into `public/assets/ui/icons/` |

All steps are idempotent (mtime-checked). The `unity-game/` folder is read-only source.

## Architecture (`src/`)

- `main.ts` — boot only: loads the save, reads the `?seed=&theme=&segment=&mirror=`
  test hooks, creates the `Game` and exposes the `window.__game` debug/test handle.
- `game/Game.ts` — owns the scene, frame loop and run state machine
  (loading → title → countdown → playing ⇄ paused → gameover) and wires gameplay
  events to audio, effects, camera and UI.
- `game/CameraDirector.ts` — the one camera, driven through three shots in the
  runner's local frame: a front showcase for the menu, Unity's chase camera
  (lane drift, speed FOV kick, hit shake), and a death shot. Shot changes are a
  crane move over the runner's head (a straight line would pass through it; a
  side orbit clips the alley walls).
- `track/TrackManager.ts` — port of Unity's `TrackManager.cs`: speed/score/multiplier,
  10-segment rolling queue with exit→entry stitching and random mirroring, floating-origin
  recentring, coin/powerup placement (1.5-unit lane walk with obstacle avoidance). Also
  stitches obstacle-free backdrop segments *behind* the start line so the menu camera,
  which looks back down the street, never sees the void.
- `track/TrackSegment.ts` — piecewise-linear path sampling (`GetPointAt` equivalent).
- `character/` — controller (lanes/jump/slide driven by world distance, exact Unity constants,
  plus an input buffer, fast-fall and lane-change lean), AABB collider with lives +
  invincibility blink, animation wrapper (Cat clips drive both characters — identical rigs).
- `obstacles/` — SimpleBarricade, AllLane, Patrolling (ping-pong), Missile behaviours from
  extracted prefab data.
- `consumables/` — Magnet (15s), Score×2 (10s), Invincibility (10s), Extra Life; ramping
  spawn chances as in the original.
- `coins/CoinPool.ts` — 256 pooled fishbones as lightweight proxies, drawn as one
  `InstancedMesh` (one draw call for the whole coin field).
- `rendering/CurvedMaterial.ts` — the signature Unity clip-space curved-world shader,
  plus shader-family-specific alpha, cloud, vertex-color and standard materials, and the
  runner's own lit material (`characterLight`: wrap-lit toon step, coloured shadow side,
  rim light that doubles as the powerup tint, invincibility blink).
- `rendering/` also holds the presentation layer the original leaves to Unity's renderer:
  `PostProcessing` (bloom + per-theme colour grade, vignette, speed lines, damage flash),
  `Effects` (GPU point-sprite particles using the original particle textures: pickup
  sparkles, footstep/landing dust, flipbook impact smoke, powerup auras), `ShieldAura`,
  `SkyDome` (gradient sky replacing the flat theme fog colour), `GroundHaze` (fills the
  void beside the authored street), `CharacterShadow`, and `ThemeLook` (per-theme
  fog/ground/light rig and character lighting).
- `data/themes.ts` — the one typed view of the extracted `themes.json`.
- `save/` — versioned JSON save in localStorage (coins, premium, unlocks, top-10 leaderboard,
  missions — 5 types, always 2 active, mute, run count); v1 saves migrate automatically.
- `ui/` — HTML/CSS overlay: loading screen with progress, title/loadout (character and
  time-of-day cards, mission progress bars), HUD (hearts, fishbones, score, multiplier,
  powerup timer rings, toasts), pause and results (count-up score, new-best banner,
  mission claims, leaderboard). Per-frame HUD updates are diffed, so a steady run only
  touches the DOM when a number changes.

## Known gaps vs. the original

- The original running dog model is an unresolved Git-LFS pointer. The web build uses a
  visible low-poly fallback automatically and will prefer the original after it is fetched
  and assets are regenerated.
- Adaptive layered music stems, character accessories UI, and the tutorial are not ported yet.
- The rendered world is a consistent mirror image of Unity's (handedness); segments randomly
  mirror in the original anyway, so gameplay is unaffected.

## Wrist camera controls

Open **Wrist controls** at the bottom left, choose **Enable camera**, and allow camera
access. Use HTTPS or localhost. No Python process is needed: this ports the
`wrist-rom-demo/wrist_flexion_v2.py` vertical-baseline calculation to MediaPipe in
JavaScript. The first activation downloads the MediaPipe runtime and hand model
from jsDelivr / Google; camera frames are processed locally and are not uploaded.

- Keep your forearm vertical and show one hand from the side, as in the Python demo.
- **Flexion → left arrow**, **extension → right arrow**, following the demo's signs
  in the mirrored camera image. These labels depend on that camera/hand orientation.
- First hold your wrist within **±12°** of vertical until the indicator says **Ready**.
  Then bend more than **12°** to move. Neutral and new directions must hold for
  **120 ms** to filter jitter. This uses the same neutral range as the displayed label.
- **Hold to repeat**, like holding an arrow key: the first bend moves one lane,
  repeats start **400 ms** later, then repeat every **250 ms**, within the three lanes.
  Straighten to stop immediately, or bend the other way to reverse without a neutral pause.
- Brief missed detections pause movement without forgetting that you're ready.
  Tracking loss or stalled frames longer than **750 ms**, a pause/resume, or restarting
  a run requires neutral again. No commands are queued while the hand is missing.
- Movement only applies during gameplay. The indicator shows **Ready**, **Hold bend**,
  **Holding**, **Center wrist**, **Find hand**, or **Waiting** to explain what's happening.
  You can collapse the preview while tracking stays on. Keyboard arrows, W/S, and
  pause/mute shortcuts also work when the camera panel is focused.
- **Disable camera**, hiding the tab, or leaving the page stops the camera.
- Jump and slide have **no wrist mapping yet**; their existing keyboard/swipe controls
  remain available.

The preview shows the same wrist (landmark 0) to middle knuckle (landmark 9) vector
and upward baseline as v2. As in that demo, this is a 2D movement estimate; tilting
the whole forearm can also trigger it.
