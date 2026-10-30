# Wrist control review — October 2, 2026

Reviewed the Python v2 angle port, browser camera/model lifecycle, gesture timing,
shared keyboard/lane input, run transitions, and desktop/mobile controls. Jump and
slide still have no camera mapping.

## Findings and fixes

- **Stopped after one press:** the original gesture latch required neutral after
  every move, including reversals. A held bend now sends the first press after
  120 ms of confirmed observations, repeats after 400 ms, then every 250 ms.
  Bending the opposite way reverses directly. Neutral stops repeating immediately.
- **Misleading neutral label:** the preview called ±12° neutral while controls
  required ±8°. Both now use ±12°, with an explicit Ready indicator.
- **Missed detections and low frame rates:** one missing frame or a gap above
  250 ms previously erased readiness. Short misses now pause confirmation without
  discarding valid observations; missing time never counts toward confirmation.
  No movement is sent without a fresh hand observation. Loss beyond 750 ms requires
  neutral again. A late frame cannot cause a burst of queued presses.
- **Pause/restart races:** the controller now exposes an input revision so a
  pause/resume between camera frames still resets gestures. Reset also disables
  movement during the countdown.
- **Keyboard focus:** the camera panel no longer swallows arrows, W/S, pause, or
  mute shortcuts. Enter/Space retain native panel-button activation.
- **Frozen or resized video:** a stalled feed shows Waiting and clears pending
  movement. Inference dimensions follow camera resolution changes to preserve angles.
- **Mobile button overlap:** the full run-flow test found that the collapsed
  camera panel covered the results Menu button. Narrow screens now reserve space
  below their menu cards.
- **Lifecycle verification:** cancellation while permission/model loading is
  pending releases late resources without stopping a newer session. Permission,
  model, inference, and camera-disconnect failures support retry. Hiding the tab
  releases camera tracks.

## Validation

Six regression cases reproduced the old intermittent-input behavior. Tests now
cover held repeats, reversals, threshold jitter, every-third-frame detection loss,
twenty alternating gestures at 3/5/10/20/60 FPS, invalid samples, lane bounds,
countdown gating, and camera cleanup.

The production build and 41 unit tests pass; three Unity-source checks are skipped
because the source checkout is absent. The full 34-case browser suite initially
passed 33 cases and identified the mobile Menu overlap described above. The final
rerun passed all 16 affected wrist, startup, and complete run-flow cases on desktop
and portrait Chromium, including the previously failing mobile Menu interaction.
The other 18 browser cases (render snapshots, materials, resource counts, and track
recentering) passed in the full run and were unaffected by the final gesture/layout fixes.

An additional smoke test used the real MediaPipe runtime/model with the official
[hand test image](https://storage.googleapis.com/mediapipe-assets/thumb_up.jpg)
streamed through a canvas camera. Rotating that image exercised neutral, repeated
left moves, direct reversal, repeated right moves, and neutral stopping through
the production code, with no page errors. This checks actual landmark inference,
not just mocked landmark coordinates.

## Remaining practical limits

A physical webcam session with the user's wrist has not been tested. The v2
measurement is still a 2D hand angle relative to vertical: camera/hand orientation,
lighting, occlusion, and tilting the whole forearm affect it. Keep the forearm
upright, start at Ready, hold a bend to move, and straighten to stop.
