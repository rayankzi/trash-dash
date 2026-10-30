import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  AxisSelector, classifyWrist, depthPitch, knuckleYaw, palmTowardCamera, signedWristAngle, VerticalCalibration,
  WristGesture, WRIST_NEUTRAL_DEGREES, WRIST_TRACKING_TIMEOUT_MS, WRIST_VERTICAL_TRIGGER_DEGREES,
  type Point3, type WristReading,
} from './WristGesture';
import type { WristAction, WristTarget } from './wristTypes';
import './wrist-controls.css';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const PREFS_KEY = 'trashdash.wristControls';
/** A run pauses once the hand has been out of view this long. */
export const WRIST_AUTO_PAUSE_MS = 1500;
/** After this long without a hand the player may have moved; re-learn up/down zero. */
const RECALIBRATE_AFTER_MS = 3000;

interface WristPrefs { enabled?: boolean; swap?: boolean }
function loadPrefs(): WristPrefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as WristPrefs; } catch { return {}; }
}
function savePrefs(prefs: WristPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...prefs })); } catch { /* private mode */ }
}

const ARROWS: Record<WristAction, string> = { left: '←', right: '→', up: '↑', down: '↓' };

/** Browser port of the v2 camera loop, extended with a second, front-on pose
 * for jump/slide. Frames stay on this device. */
export class WristCameraControls {
  private readonly root = document.createElement('details');
  private readonly video = document.createElement('video');
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly button: HTMLButtonElement;
  private readonly recalibrate: HTMLButtonElement;
  private readonly swap: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly reading: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly gesture = new WristGesture();
  private readonly axis = new AxisSelector();
  private readonly vertical = new VerticalCalibration();
  private stream: MediaStream | null = null;
  private detector: HandLandmarker | null = null;
  private active = false;
  private generation = 0;
  private frame = 0;
  private lastInference = -Infinity;
  private lastVideoTime = -1;
  private lastTarget: WristTarget | null = null;
  private lastRevision = NaN;
  private lastHand = -Infinity;
  private seenThisRevision = false;
  private lostReported = false;
  private legendKey = '';

  constructor(private readonly getTarget: () => WristTarget) {
    this.root.className = 'wrist-controls';
    this.root.innerHTML = `
      <summary>Wrist controls <span class="wrist-indicator">Off</span></summary>
      <div class="wrist-body">
        <dl class="wrist-legend"></dl>
        <p>Make a fist with your forearm upright. Turn it <b>side-on</b> to steer, or <b>knuckles to the camera</b> to jump and slide. Start straight, bend to act, straighten to stop. Hide your hand to pause.</p>
        <canvas width="320" height="240" aria-label="Mirrored wrist camera preview" hidden></canvas>
        <output class="wrist-reading">Camera off</output>
        <p class="wrist-status" role="status">Camera stays on your device.</p>
        <div class="wrist-actions">
          <button type="button" class="wrist-toggle">Enable camera</button>
          <button type="button" class="wrist-recalibrate" hidden>Re-center up/down</button>
        </div>
        <label class="wrist-swap"><input type="checkbox"> Swap jump and slide</label>
      </div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.context = this.canvas.getContext('2d')!;
    this.button = this.root.querySelector('.wrist-toggle')!;
    this.recalibrate = this.root.querySelector('.wrist-recalibrate')!;
    this.swap = this.root.querySelector('.wrist-swap input')!;
    this.status = this.root.querySelector('.wrist-status')!;
    this.reading = this.root.querySelector('.wrist-reading')!;
    this.legend = this.root.querySelector('.wrist-legend')!;
    this.video.muted = true;
    this.video.playsInline = true;
    const prefs = loadPrefs();
    this.swap.checked = this.vertical.swap = prefs.swap === true;
    this.button.addEventListener('click', () => {
      if (this.active) {
        savePrefs({ enabled: false });
        this.stop();
      } else void this.start();
    });
    this.recalibrate.addEventListener('click', () => {
      this.vertical.reset();
      this.gesture.reset();
    });
    this.swap.addEventListener('change', () => {
      this.vertical.swap = this.swap.checked;
      this.gesture.reset();
      savePrefs({ swap: this.swap.checked });
    });
    // Preserve native button/summary activation, but let arrows, jump, pause,
    // and mute reach the game even when this panel has keyboard focus.
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    document.body.append(this.root);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.renderLegend();
    if (prefs.enabled) void this.resumeIfPermitted();
  }

  /** Hands-free return visits: restart the camera when the browser already
   * remembers the permission, so no click is needed to play. */
  private async resumeIfPermitted(): Promise<void> {
    try {
      const permission = await navigator.permissions?.query({ name: 'camera' as PermissionName });
      if (permission?.state === 'granted' && !this.active && !document.hidden) void this.start();
    } catch { /* Permissions API without camera support: wait for a click. */ }
  }

  private onPageHide = (): void => { this.stop(); };
  private onVisibility = (): void => {
    this.gesture.reset();
    if (document.hidden && this.active) this.stop('Camera stopped while this tab is hidden. Enable it again to continue.');
    else if (!document.hidden && !this.active && loadPrefs().enabled) void this.resumeIfPermitted();
  };

  private setIndicator(text: string): void {
    this.root.querySelector('.wrist-indicator')!.textContent = text;
  }

  private renderLegend(target?: WristTarget): void {
    const hints = target?.hints() ?? { left: 'Lane left', right: 'Lane right', up: 'Jump', down: 'Slide' };
    const key = JSON.stringify(hints);
    if (key === this.legendKey) return;
    this.legendKey = key;
    const item = (action: WristAction, how: string) =>
      `<div><dt>${ARROWS[action]} ${hints[action]}</dt><dd>${how}</dd></div>`;
    this.legend.innerHTML = item('left', 'Side-on, tilt left') + item('right', 'Side-on, tilt right')
      + item('up', 'Knuckles to camera, extend') + item('down', 'Knuckles to camera, flex');
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    this.active = true;
    this.button.textContent = 'Disable camera';
    this.setIndicator('Loading');
    this.status.textContent = 'Allow camera access to use wrist controls…';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS or localhost and a supported browser.');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (generation === this.generation) this.stop('Camera disconnected. Reconnect it and enable the camera again.');
        }, { once: true });
      }
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return;
      this.status.textContent = 'Loading hand tracking…';
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
      if (generation !== this.generation) return;
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      if (generation !== this.generation) return;
      // CPU avoids competing with the game's WebGL renderer for GPU resources.
      const detector = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: 0.7,
        minHandPresenceConfidence: 0.7,
        minTrackingConfidence: 0.7,
      });
      if (generation !== this.generation) { detector.close(); return; }
      this.detector = detector;
      savePrefs({ enabled: true });
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
      this.canvas.hidden = false;
      this.recalibrate.hidden = false;
      this.lastInference = performance.now();
      this.setIndicator('Find hand');
      this.frame = requestAnimationFrame(this.tick);
    } catch (error) {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : '';
      const message = name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in your browser, then retry.'
        : name === 'NotFoundError' ? 'No camera found. Connect a webcam, then retry.'
        : name === 'NotReadableError' ? 'Camera is busy or unavailable. Close other camera apps, then retry.'
        : `Could not start wrist controls. ${error instanceof Error ? error.message : 'Check your connection and retry.'}`;
      this.stop(message);
    }
  }

  private tick = (now: number): void => {
    if (!this.active || !this.detector) return;
    const target = this.getTarget();
    if (target !== this.lastTarget || target.revision !== this.lastRevision) {
      this.gesture.reset();
      this.lastTarget = target;
      this.lastRevision = target.revision;
      this.seenThisRevision = false;
      this.lostReported = false;
    }
    const enabled = target.context !== 'idle' && !document.hidden;
    if (!enabled) this.gesture.reset();
    // Limit inference to 20 Hz, and never infer twice on the same camera frame.
    if (now - this.lastInference >= 50 && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastInference = now;
      this.lastVideoTime = this.video.currentTime;
      try {
        const { context: ctx, canvas } = this;
        // Camera rotation or a renegotiated resolution must not stretch the
        // hand vector and change its measured angle.
        if (canvas.width !== this.video.videoWidth || canvas.height !== this.video.videoHeight) {
          canvas.width = this.video.videoWidth;
          canvas.height = this.video.videoHeight;
        }
        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        // Mirror BEFORE inference, matching cv2.flip(frame, 1) in the Python demo.
        const reading = this.read(this.detector.detectForVideo(canvas, now), now);
        // A hand still learning its up/down zero is present, just not readable.
        const handSeen = this.lastHand === now;
        if (handSeen) {
          this.lostReported = false;
          if (target.context === 'run') this.seenThisRevision = true;
        } else if (now - this.lastHand > RECALIBRATE_AFTER_MS) {
          this.vertical.reset();
          this.axis.reset();
        }
        const action = this.gesture.update(reading, now, enabled);
        if (action) target.perform(action);
        if (!handSeen && target.context === 'run' && this.seenThisRevision && !this.lostReported
          && now - this.lastHand >= WRIST_AUTO_PAUSE_MS) {
          this.lostReported = true;
          target.trackingLost();
        }
        this.renderLegend(target);
        this.showReading(reading);
        this.showTrackingStatus(reading, enabled, target);
      } catch (error) {
        console.error('Wrist tracking failed', error);
        this.stop('Hand tracking stopped. Disable other camera apps or check your connection, then retry.');
        return;
      }
    } else if (now - this.lastInference > WRIST_TRACKING_TIMEOUT_MS) {
      this.gesture.reset();
      this.reading.textContent = 'Waiting for camera frames';
      this.setIndicator('Waiting');
      this.status.textContent = 'Camera feed stalled. If it does not recover, disable and enable the camera.';
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Measures the current pose's bend and draws it over the preview. Returns
   * null while there is no hand or up/down is still learning its zero. */
  private read(result: HandLandmarkerResult, now: number): WristReading | null {
    const { context: ctx, canvas } = this;
    const hand = result.landmarks[0];
    if (!hand?.[0] || !hand[9]) return null;
    this.lastHand = now;
    const px = hand.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height, z: (p.z ?? 0) * canvas.width }));
    // World landmarks are metric and camera-aligned; their depth is far
    // steadier than the normalized z, which is all older results provide.
    const world: Point3[] = result.worldLandmarks?.[0]?.length === 21 ? result.worldLandmarks[0] : px;
    const label = (result.handedness ?? result.handednesses)?.[0]?.[0]?.categoryName;
    const handedness = label === 'Left' || label === 'Right' ? label : null;
    // Without a readable knuckle line (e.g. a 2-point hand), steer side-on as before.
    const axis = this.axis.update(knuckleYaw(world), now) ?? 'horizontal';
    const wrist = px[0];
    const middle = px[9];
    ctx.lineWidth = 4;
    if (px[5] && px[17]) {
      ctx.strokeStyle = '#ff9a3c';
      ctx.beginPath(); ctx.moveTo(px[5].x, px[5].y); ctx.lineTo(px[17].x, px[17].y); ctx.stroke();
    }
    ctx.strokeStyle = '#6baaff';
    ctx.beginPath(); ctx.moveTo(wrist.x, wrist.y); ctx.lineTo(wrist.x, wrist.y - 100); ctx.stroke();
    ctx.strokeStyle = '#a6e84c';
    ctx.beginPath(); ctx.moveTo(wrist.x, wrist.y); ctx.lineTo(middle.x, middle.y); ctx.stroke();
    if (axis === 'horizontal') {
      const angle = signedWristAngle(wrist, middle);
      return angle === null ? null : { axis, angle };
    }
    const angle = this.vertical.update(depthPitch(world), palmTowardCamera(world, handedness), now);
    if (angle !== null) this.drawGauge(angle);
    return angle === null ? null : { axis, angle };
  }

  /** Up/down happens in depth, which the preview cannot show, so draw a meter. */
  private drawGauge(angle: number): void {
    const { context: ctx, canvas } = this;
    const x = canvas.width - 28;
    const mid = canvas.height / 2;
    const scale = canvas.height / 2 / 60;
    ctx.fillStyle = 'rgba(7, 11, 31, 0.7)';
    ctx.fillRect(x - 10, mid - 60 * scale, 20, 120 * scale);
    ctx.fillStyle = 'rgba(166, 232, 76, 0.35)';
    ctx.fillRect(x - 10, mid - WRIST_NEUTRAL_DEGREES * scale, 20, 2 * WRIST_NEUTRAL_DEGREES * scale);
    ctx.fillStyle = '#ffffff';
    for (const edge of [-WRIST_VERTICAL_TRIGGER_DEGREES, WRIST_VERTICAL_TRIGGER_DEGREES]) ctx.fillRect(x - 14, mid - edge * scale - 1, 28, 2);
    const clamped = Math.max(-60, Math.min(60, angle));
    ctx.fillStyle = '#ff9a3c';
    ctx.beginPath(); ctx.arc(x, mid - clamped * scale, 9, 0, Math.PI * 2); ctx.fill();
  }

  private get calibrating(): boolean {
    return this.axis.axis === 'vertical' && !this.vertical.calibrated && this.lastHand === this.lastInference;
  }

  private showReading(reading: WristReading | null): void {
    if (!reading) {
      this.reading.textContent = this.calibrating
        ? 'Front-on · learning straight' : 'No hand detected';
      return;
    }
    const degrees = `${Math.abs(reading.angle).toFixed(0)}°`;
    if (reading.axis === 'horizontal') {
      this.reading.textContent = `Side-on · ${classifyWrist(reading.angle)} · ${degrees}`;
      return;
    }
    const label = Math.abs(reading.angle) <= WRIST_NEUTRAL_DEGREES ? 'Neutral' : reading.angle > 0 ? 'Extension' : 'Flexion';
    this.reading.textContent = `Front-on · ${label} · ${degrees}`;
  }

  private showTrackingStatus(reading: WristReading | null, enabled: boolean, target: WristTarget): void {
    const state = this.gesture.state;
    if (!reading) {
      if (this.calibrating) {
        this.setIndicator('Hold straight');
        this.status.textContent = 'Knuckles to the camera: hold your wrist straight and still for a moment to set up jump and slide.';
      } else {
        this.setIndicator('Find hand');
        this.status.textContent = this.lostReported ? 'Paused while your hand is out of view. Show your fist, then extend your wrist on Resume.'
          : 'Show one fist with your forearm upright. No moves are sent while tracking is lost.';
      }
    } else if (!enabled) {
      this.setIndicator('Standby');
      this.status.textContent = 'Tracking ready. Controls activate when the game is ready; start with your wrist straight.';
    } else if (state === 'center') {
      this.setIndicator('Center wrist');
      this.status.textContent = `Hold your wrist straight (within ±${WRIST_NEUTRAL_DEGREES}°) briefly to enable ${reading.axis === 'horizontal' ? 'left/right' : 'up/down'}.`;
    } else if (state === 'ready') {
      this.setIndicator('Ready');
      this.status.textContent = reading.axis === 'horizontal'
        ? 'Side-on — ready. Tilt and hold to move; straighten to stop. Turn knuckles to the camera for up/down.'
        : 'Front-on — ready. Extend or flex once per action. Turn side-on for left/right.';
    } else if (state === 'aiming') {
      this.setIndicator('Hold bend');
      this.status.textContent = 'Hold the bend briefly to act.';
    } else if (state === 'left' || state === 'right' || state === 'up' || state === 'down') {
      const hint = target.hints()[state];
      this.setIndicator(`${ARROWS[state]} ${hint}`);
      this.status.textContent = state === 'left' || state === 'right'
        ? `${hint}. Hold to repeat, straighten to stop, or bend the other way to reverse.`
        : `${hint}. Straighten your wrist before the next one.`;
    }
  }

  stop(message = 'Camera off. Keyboard and swipe controls are available.'): void {
    ++this.generation;
    this.active = false;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.detector?.close();
    this.detector = null;
    this.gesture.reset();
    this.axis.reset();
    this.vertical.reset();
    this.lastInference = -Infinity;
    this.lastVideoTime = -1;
    this.lastTarget = null;
    this.lastRevision = NaN;
    this.lastHand = -Infinity;
    this.seenThisRevision = false;
    this.lostReported = false;
    this.canvas.hidden = true;
    this.recalibrate.hidden = true;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.reading.textContent = 'Camera off';
    this.status.textContent = message;
    this.button.textContent = 'Enable camera';
    this.setIndicator('Off');
  }

  dispose(): void {
    this.stop();
    this.root.remove();
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
