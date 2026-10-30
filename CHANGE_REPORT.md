# Game improvement report

## Audio startup

- Music and all 21 sound effects now fetch and decode during loading, with three concurrent loading jobs instead of a burst of work on the first input.
- The menu requests its music during boot. It plays automatically when the browser permits it; otherwise, the title offers **Enable sound**. Chrome requires a user gesture on a fresh visit, so a click/tap or keypress unlocks the prepared audio.
- Audio gestures are captured even while the game is loading. The sound status keeps the same space after unlocking so the Run button cannot move away from a first click.
- Saved mute preferences remain in effect. Sound controls now have clear mute/unmute labels and keyboard hints.
- Pausing and hiding the tab suspend audio. Pressing unrelated keys or toggling mute while paused cannot accidentally resume it.
- Late sound effects are discarded rather than replayed after loading or pausing. Finished audio nodes disconnect, failed downloads can retry, and audio fetches have a timeout.

## Smoother startup and rendering

- Concurrent requests for the same model share one load/decode operation. Cached geometry is reused across prefabs, and failed model loads remain retryable.
- Theme textures preload with models, before gameplay needs them.
- The loading screen now includes a **Warming up the alley…** stage. It compiles scene shaders and renders the chase/menu views and post-processing before enabling Run, including the shield shader.
- Starting from the title reuses the prepared street instead of immediately discarding and rebuilding it.
- Render resolution starts with a three-million-pixel budget and a maximum device-pixel ratio of 2. Sustained slow frames reduce resolution gradually; sustained good performance restores it slowly. The HTML interface stays at native resolution.
- Large frame deltas are capped at 50 ms to limit sudden movement after a hitch.
- Camera following uses exponential damping for more consistent smoothing across frame rates.

## More grounded movement

- Added quiet, speed-responsive wind, stronger during slides.
- Added soft alternating stereo footsteps whose cadence follows travel distance, plus a heavier landing sound.
- Coin pickup sounds pan toward the runner's lane.
- Added a small landing dip and subtle banking during lane changes. Added motion respects the system's reduced-motion preference; menu sway and impact shake also respect it.
- Instant camera cuts now apply the destination field of view immediately. Zero-duration animation changes clear previous animation weights instead of retaining a blended pose.
- The results camera's sideways drift is bounded, so leaving the results screen open cannot keep moving the camera into alley walls.

## Controls and reliability

- Swipes require deliberate movement, ignore button touches and secondary pointers, and reset on pointer cancellation.
- Character/theme loading locks conflicting controls until ready.
- Changing the theme from the pause menu keeps the new run paused until Resume.
- The sound status is compact on portrait screens, keeping both missions and Run accessible.
- Multiplier mission goals now use attainable ×2/×3/×4/×5 tiers. Existing impossible ×8/×10 goals are repaired while retaining progress and rewards. Mission initialization and repairs are saved immediately.

## Verification

- Production TypeScript/Vite build: passed.
- Unit tests: **19 passed**, with **3 existing Unity-source checks skipped** because the original Unity source is unavailable in this checkout.
- Browser suite: **26 passed** across desktop Chromium and Pixel 7 portrait emulation. This covers day/night scenes, authored materials, scene resource budgets, repeated theme changes, long-run recentring, full run/results/menu flow, first-input audio, nonzero music output, pause/mute/resume, initial model request deduplication, and theme changes while paused.
- New unit coverage checks concurrent model loads and retries, pixel-budget limits and adaptive-resolution hysteresis, and attainable/repaired multiplier missions.
- Live Chrome via Computer Use: checked the real autoplay gate, first-click Run, keyboard movement and pause, portrait title and night gameplay, a deliberate lane swipe, and changing the theme while paused. Restored the normal viewport and left the day menu open.
- The browser test harness now allows 30 seconds for readiness and 60 seconds per test, because software WebGL completes shader warmup before Run is enabled.
- Final verification of the production build: **14 additional screenshot and run-flow checks passed**, comparing against the reviewed references without updating them.
- Live Chrome reported no runtime errors. `git diff --check` passed.

Saved verification images: [desktop title](reports/2026-09-26/title-desktop.png) and [portrait title](reports/2026-09-26/title-portrait.png).

The screenshot references are updated for the corrected instant-cut field of view, clean animation pose, and reuse of the opening street. They do not represent a change to the authored building materials.

Browser audio output is checked using a Web Audio analyser, in addition to the visible controls. This verifies a nonzero audio signal; it does not measure physical speaker volume. Headless Chromium allows autoplay, so its regression test explicitly suspends the native audio context; Chrome's actual first-visit gesture requirement is checked separately through Computer Use.

No fixed FPS improvement is claimed across all hardware. The changes remove identified startup work from the first interaction and bound rendering cost. GPU warmup makes readiness more honest and can keep the loading screen visible longer on software-rendered or slow devices.
