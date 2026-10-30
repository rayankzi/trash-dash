import { expect, test, type Page } from '@playwright/test';
import { syntheticHandSource, type SyntheticHandOptions } from '../helpers/syntheticHand';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

async function installCamera(page: Page): Promise<void> {
  // Exercise actual video/canvas capture and the production gesture state machine.
  // Only ML landmark output is replaced, so gestures and failures are repeatable.
  await page.route('**/assets/vision_bundle-*.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      const syntheticHand = ${syntheticHandSource};
      export const FilesetResolver = { forVisionTasks: async () => ({}) };
      export const HandLandmarker = { createFromOptions: async () => {
        const id = window.wristModelCount = (window.wristModelCount || 0) + 1;
        if (window.wristModelError) throw new Error('Model unavailable');
        const detector = {
          detectForVideo(canvas) {
            if (window.wristThrow) throw new Error('Inference failed');
            window.wristFrames = (window.wristFrames || 0) + 1;
            if (window.wristDropEvery && window.wristFrames % window.wristDropEvery === 0) return { landmarks: [] };
            if (window.wristDropFrames > 0) {
              window.wristDropFrames--;
              return { landmarks: [] };
            }
            if (window.wristAngle === null) return { landmarks: [] };
            if (window.wristHand) {
              // Full anatomical hand: world landmarks and handedness like the real model.
              const r = syntheticHand({ imageWidth: canvas.width, imageHeight: canvas.height, ...window.wristHand });
              return { landmarks: [r.landmarks], worldLandmarks: [r.worldLandmarks], handedness: [r.handedness] };
            }
            const radians = (window.wristAngle || 0) * Math.PI / 180;
            const hand = Array.from({length: 21}, () => ({x: .5, y: .7, z: 0}));
            hand[9] = {x: .5 + Math.sin(radians) * 100 / canvas.width,
              y: .7 - Math.cos(radians) * 100 / canvas.height, z: 0};
            return { landmarks: [hand] };
          },
          close() { (window.wristClosed ||= []).push(id); }
        };
        if (window.wristDeferModel) return new Promise(resolve => {
          window.wristResolveModel = () => resolve(detector);
        });
        return detector;
      } };
    `,
  }));
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      ((window as any).wristStreams ||= []).push(stream);
      if ((window as any).wristDeferPermission) {
        return new Promise((resolve) => { (window as any).wristResolvePermission = () => resolve(stream); });
      }
      return stream;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLVideoElement) (window as any).wristVideo = this;
      return play.call(this);
    };
  });
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?seed=10&theme=day');
  await expect(page.locator('.wrist-controls')).toBeVisible();
  // Software WebGL is too slow to measure input timing; keep the real camera
  // clock and run-state transitions, freeze only world rendering/collisions.
  await page.evaluate(() => (window as any).__game.renderer.setAnimationLoop(null));
  await page.locator('.wrist-controls summary').click();
}
async function enable(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Enable camera' }).click();
  await expect(page.locator('.wrist-reading')).toContainText('Neutral');
}
async function startRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { game } = (window as any).__game;
    game.startRun();
    game.updateCountdown(4);
  });
}
async function pose(page: Page, angle: number | null): Promise<void> {
  await page.evaluate((value) => { (window as any).wristHand = null; (window as any).wristAngle = value; }, angle);
}
/** Shows a synthetic anatomical hand (see tests/helpers/syntheticHand.ts); null hides the hand. */
async function hand(page: Page, options: SyntheticHandOptions | null): Promise<void> {
  await page.evaluate((value) => {
    (window as any).wristHand = value;
    (window as any).wristAngle = value ? undefined : null;
  }, options);
}
const readingText = (page: Page) => page.locator('.wrist-reading');
const motion = (page: Page) => page.evaluate(() => {
  const c = (window as any).__game.controller;
  return { jumping: c.isJumping, sliding: c.isSliding, lane: c.currentLane };
});
const lane = (page: Page) => page.evaluate(() => (window as any).__game.controller.currentLane);
async function streamsEnded(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).wristStreams.every((stream: MediaStream) => stream.getTracks().every((track) => track.readyState === 'ended')));
}

test('held bends repeat, reverse, stop at neutral, and coexist with focused keyboard controls', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installCamera(page);
  await boot(page);
  expect(await page.evaluate(() => (window as any).wristStreams)).toBeUndefined();
  await enable(page);
  await startRun(page);
  // 10 degrees was displayed as Neutral but could never arm the old controls.
  await pose(page, 10);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await page.locator('.wrist-controls summary').focus();
  await page.keyboard.press('ArrowRight');
  expect(await lane(page)).toBe(0);
  await page.evaluate(() => { (window as any).wristDropEvery = 3; });
  await pose(page, -30);
  await expect.poll(() => lane(page), { intervals: [25] }).toBe(1);
  await expect.poll(() => lane(page)).toBe(2); // same held pose, repeated press
  await page.evaluate(() => { (window as any).wristDropEvery = 0; });
  await pose(page, 30); // no pause at neutral before reversing
  await expect.poll(() => lane(page), { intervals: [25] }).toBe(1);
  await expect.poll(() => lane(page)).toBe(0);
  await pose(page, 0);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(800); // longer than repeat delay; neutral must cancel
  expect(await lane(page)).toBe(1);
  // One missing hand frame must not disarm a ready player.
  await page.evaluate(() => { (window as any).wristDropFrames = 1; (window as any).wristAngle = -30; });
  await expect.poll(() => lane(page)).toBe(2);
  expect(await page.evaluate(() => {
    const c = (window as any).__game.controller;
    return [c.isJumping, c.isSliding];
  })).toEqual([false, false]);
  await pose(page, 0);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await page.screenshot({ path: testInfo.outputPath('wrist-ready.png') });
  // Focus stays in the panel: pause, resume, W and S must still reach the game.
  await page.keyboard.press('p');
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('paused');
  await page.locator('.wrist-controls summary').focus();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('playing');
  await page.keyboard.press('w');
  expect(await page.evaluate(() => (window as any).__game.controller.isJumping)).toBe(true);
  await page.keyboard.press('s');
  expect(await page.evaluate(() => (window as any).__game.controller.isJumping)).toBe(false);
  await page.getByRole('button', { name: 'Disable camera' }).click();
  expect(await streamsEnded(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).wristClosed)).toEqual([1]);
  expect(errors).toEqual([]);
});

test('tracking loss, camera stalls, fast pause/resume and restart cannot replay stale gestures', async ({ page }) => {
  await installCamera(page);
  await boot(page);
  await enable(page);
  await startRun(page);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await page.evaluate(async () => {
    await (window as any).wristStreams.at(-1).getVideoTracks()[0].applyConstraints({ width: 320, height: 240 });
  });
  await expect(page.locator('.wrist-controls canvas')).toHaveAttribute('width', '320');
  await expect(page.locator('.wrist-controls canvas')).toHaveAttribute('height', '240');
  await pose(page, null);
  await expect(page.locator('.wrist-indicator')).toHaveText('Find hand');
  await page.waitForTimeout(900);
  await pose(page, -30);
  await expect(page.locator('.wrist-indicator')).toHaveText('Center wrist');
  expect(await lane(page)).toBe(1);
  await pose(page, 0);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await page.evaluate(() => (window as any).wristVideo.pause());
  await expect(page.locator('.wrist-indicator')).toHaveText('Waiting');
  await pose(page, -30);
  await page.evaluate(() => (window as any).wristVideo.play());
  await expect(page.locator('.wrist-indicator')).toHaveText('Center wrist');
  expect(await lane(page)).toBe(1);
  await pose(page, 0);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  // Both changes happen in one JS task, between camera frames.
  await page.evaluate(() => {
    (window as any).__game.game.pauseRun();
    (window as any).__game.game.resumeRun();
    (window as any).wristAngle = -30;
  });
  await expect(page.locator('.wrist-indicator')).toHaveText('Center wrist');
  expect(await lane(page)).toBe(1);
  await pose(page, 0);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await pose(page, -30);
  await expect.poll(() => lane(page)).toBe(2);
  await page.evaluate(() => (window as any).__game.game.startRun());
  await expect(page.locator('.wrist-indicator')).toHaveText('Standby');
  expect(await lane(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).__game.controller.inputEnabled)).toBe(false);
  await page.waitForTimeout(600);
  expect(await lane(page)).toBe(1);
  await page.evaluate(() => (window as any).__game.game.updateCountdown(4));
  await expect(page.locator('.wrist-indicator')).toHaveText('Center wrist');
  expect(await lane(page)).toBe(1);
});

test('disabling during camera permission and model loading releases late resources without stopping a newer session', async ({ page }) => {
  await installCamera(page);
  await boot(page);
  await page.evaluate(() => { (window as any).wristDeferPermission = true; });
  await page.getByRole('button', { name: 'Enable camera' }).click();
  await page.waitForFunction(() => !!(window as any).wristResolvePermission);
  await page.getByRole('button', { name: 'Disable camera' }).click();
  await page.evaluate(() => { (window as any).wristDeferPermission = false; (window as any).wristResolvePermission(); });
  await expect.poll(() => streamsEnded(page)).toBe(true);
  await page.evaluate(() => { (window as any).wristDeferModel = true; });
  await page.getByRole('button', { name: 'Enable camera' }).click();
  await page.waitForFunction(() => !!(window as any).wristResolveModel);
  await page.getByRole('button', { name: 'Disable camera' }).click();
  expect(await streamsEnded(page)).toBe(true);
  await page.evaluate(() => { (window as any).wristDeferModel = false; });
  await enable(page); // second model completes before the cancelled first one
  await page.evaluate(() => (window as any).wristResolveModel());
  await expect.poll(() => page.evaluate(() => (window as any).wristClosed)).toEqual([1]);
  // The menu now takes wrist gestures too, so a neutral hand reads Ready (not Standby) on the title screen.
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  expect(await streamsEnded(page)).toBe(false);
  await page.getByRole('button', { name: 'Disable camera' }).click();
  expect(await streamsEnded(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).wristClosed)).toEqual([1, 2]);
});

test('permission, model and inference failures can be retried; disconnect and hidden tab release the camera', async ({ page }) => {
  await installCamera(page);
  await boot(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => {
      navigator.mediaDevices.getUserMedia = original;
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await page.getByRole('button', { name: 'Enable camera' }).click();
  await expect(page.locator('.wrist-status')).toContainText('permission denied');
  await page.evaluate(() => { (window as any).wristModelError = true; });
  await page.getByRole('button', { name: 'Enable camera' }).click();
  await expect(page.locator('.wrist-status')).toContainText('Model unavailable');
  expect(await streamsEnded(page)).toBe(true);
  await page.evaluate(() => { (window as any).wristModelError = false; });
  await enable(page);
  await page.evaluate(() => { (window as any).wristThrow = true; });
  await expect(page.locator('.wrist-status')).toContainText('Hand tracking stopped');
  expect(await streamsEnded(page)).toBe(true);
  await page.evaluate(() => { (window as any).wristThrow = false; });
  await enable(page);
  await page.evaluate(() => {
    (window as any).wristStreams.at(-1).getVideoTracks()[0].dispatchEvent(new Event('ended'));
  });
  await expect(page.locator('.wrist-status')).toContainText('disconnected');
  expect(await streamsEnded(page)).toBe(true);
  await enable(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.wrist-status')).toContainText('tab is hidden');
  expect(await streamsEnded(page)).toBe(true);
  await page.evaluate(() => {
    delete (document as any).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('button', { name: 'Enable camera' })).toBeEnabled();
  await startRun(page);
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('playing');
});

const front = (bend: number, extra: Partial<SyntheticHandOptions> = {}): SyntheticHandOptions =>
  ({ pose: 'front', palm: 'camera', handedness: 'Right', bend, ...extra });
const side = (bend: number, extra: Partial<SyntheticHandOptions> = {}): SyntheticHandOptions =>
  ({ pose: 'side', palm: 'thumb-camera', handedness: 'Right', bend, ...extra });

test('front-on pose: flexion slides, extension jumps (with a biased camera pitch)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installCamera(page);
  await boot(page);
  await enable(page);
  await startRun(page);
  const tilt = { forearmTilt: { pitch: 20 } };
  await hand(page, front(0, tilt));
  await expect(readingText(page)).toContainText('Front-on');
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await expect(readingText(page)).toContainText('Neutral');
  expect(await motion(page)).toMatchObject({ jumping: false, sliding: false });
  await hand(page, front(-35, tilt));
  await expect.poll(async () => (await motion(page)).sliding).toBe(true);
  await expect(readingText(page)).toContainText('Flexion');
  await page.waitForTimeout(600); // held bend: a single slide, no repeat
  expect(await motion(page)).toMatchObject({ jumping: false, sliding: true });
  await hand(page, front(0, tilt));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(35, tilt));
  await expect.poll(async () => (await motion(page)).jumping).toBe(true);
  await expect(readingText(page)).toContainText('Extension');
  expect((await motion(page)).sliding).toBe(false);
  expect((await motion(page)).lane).toBe(1);
  await hand(page, null);
  expect(errors).toEqual([]);
});

test('back of the left hand facing the camera: extension jumps, flexion slides', async ({ page }) => {
  await installCamera(page);
  await boot(page);
  await enable(page);
  await startRun(page);
  const o = { palm: 'away', handedness: 'Left' } as const;
  await hand(page, front(0, o));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(-35, o));
  await expect.poll(async () => (await motion(page)).sliding).toBe(true);
  await hand(page, front(0, o));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(35, o));
  await expect.poll(async () => (await motion(page)).jumping).toBe(true);
});

test('rotating the forearm switches between side-on lanes and front-on jump/slide', async ({ page }) => {
  await installCamera(page);
  await boot(page);
  await enable(page);
  await startRun(page);
  await hand(page, side(0));
  await expect(readingText(page)).toContainText('Side-on');
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, side(30)); // thumb-camera right hand: extension tilts left (lane +1)
  await expect.poll(() => lane(page)).toBe(2);
  await hand(page, side(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  // Rotate through intermediate twists into the front pose.
  for (const twist of [0, 20, 40, 60, 80, 90]) {
    await hand(page, { ...side(0), pose: 'front', palm: 'camera', twist: 90 - twist } as SyntheticHandOptions);
    await page.waitForTimeout(80);
  }
  await expect(readingText(page)).toContainText('Front-on');
  expect(await lane(page)).toBe(2);
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready', { timeout: 15_000 });
  await hand(page, front(-35));
  await expect.poll(async () => (await motion(page)).sliding).toBe(true);
  expect(await lane(page)).toBe(2);
  // Back to side-on while neutral: lanes work again.
  await hand(page, side(0));
  await expect(readingText(page)).toContainText('Side-on');
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, side(-30));
  await expect.poll(() => lane(page)).toBe(1);
});

test('hand missing for over 1.5 s during a run pauses the game', async ({ page }) => {
  await installCamera(page);
  await boot(page);
  await enable(page);
  await startRun(page);
  await hand(page, front(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('playing');
  await hand(page, null);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('playing');
  await expect.poll(() => page.evaluate(() => (window as any).__game.getState()), { timeout: 5000 }).toBe('paused');
});

test('a whole session is playable by wrist alone: start, auto-pause, resume, results, run again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installCamera(page);
  await boot(page);
  await enable(page);
  const state = () => page.evaluate(() => (window as any).__game.getState());
  const focused = () => page.locator('#ui-root button.wrist-focus');
  const finishCountdown = async () => {
    await expect.poll(state).toBe('countdown');
    await page.evaluate(() => (window as any).__game.game.updateCountdown(4));
    expect(await state()).toBe('playing');
  };
  // Title: the Run button is focused; extending the wrist presses it.
  await hand(page, front(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await expect(focused()).toHaveCount(1);
  await expect(focused()).toHaveClass(/primary/);
  await expect(page.locator('.wrist-legend')).toContainText('Select');
  await hand(page, front(35));
  await finishCountdown();
  // The extension still held from pressing Run must not also jump.
  await page.waitForTimeout(400);
  expect((await motion(page)).jumping).toBe(false);
  await expect(page.locator('.wrist-legend')).toContainText('Jump');
  await hand(page, front(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  // Hiding the hand pauses; the Resume button is focused, extension resumes.
  await hand(page, null);
  await expect.poll(state, { timeout: 5000 }).toBe('paused');
  await expect(focused()).toHaveText(/Resume/);
  await hand(page, front(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(35));
  await expect.poll(state).toBe('playing');
  // Crash out: results screen, walk focus with side-on tilts, flex returns to
  // the primary button, extend runs again.
  await hand(page, front(0));
  await page.evaluate(() => {
    const { game } = (window as any).__game;
    game.endRun();
    game.showResults();
  });
  await expect(focused()).toHaveClass(/primary/);
  const primary = await focused().textContent();
  await hand(page, side(0));
  await expect(readingText(page)).toContainText('Side-on');
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, side(-30));
  await expect.poll(async () => focused().textContent()).not.toBe(primary);
  await hand(page, side(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(0));
  await expect(readingText(page)).toContainText('Front-on');
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(-35));
  await expect.poll(async () => focused().textContent()).toBe(primary);
  await hand(page, front(0));
  await expect(page.locator('.wrist-indicator')).toHaveText('Ready');
  await hand(page, front(35));
  await finishCountdown();
  expect(errors).toEqual([]);
});
