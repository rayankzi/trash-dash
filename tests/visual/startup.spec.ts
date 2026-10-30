import { expect, test } from '@playwright/test';

test('first gesture starts preloaded music; mute, pause and resume preserve audio state', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?seed=10&theme=day');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  // Headless Chromium permits autoplay. Exercise the same native suspended
  // state explicitly; the actual autoplay gate is also checked in live Chrome.
  await page.evaluate(async () => { await (window as any).__game.audio.ctx.suspend(); });
  await expect(page.locator('.sound-prompt')).toContainText('Enable sound');
  await page.screenshot({ path: testInfo.outputPath('sound-ready-title.png') });
  const ready = await page.evaluate(async () => {
    const { audio } = (window as any).__game;
    const buffers = await Promise.all([...audio.buffers.values()]);
    return { state: audio.ctx.state, count: buffers.length, loaded: buffers.every(Boolean) };
  });
  expect(ready).toEqual({ state: 'suspended', count: 23, loaded: true });
  await page.locator('.sound-prompt').click();
  await expect(page.locator('.sound-prompt')).toContainText('Sound on');
  // Measure real output from the music graph, not just a mute icon.
  const energy = await page.evaluate(async () => {
    const audio = (window as any).__game.audio;
    const analyser = audio.ctx.createAnalyser();
    audio.master.connect(analyser);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    audio.master.disconnect(analyser);
    return data.reduce((sum, value) => sum + value * value, 0);
  });
  expect(energy).toBeGreaterThan(0.00001);
  await page.evaluate(() => (window as any).__game.renderer.setAnimationLoop(null));
  await page.locator('[data-action=start]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__game.getState())).toBe('countdown');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).__game.audio.ctx.state)).toBe('suspended');
  await page.keyboard.press('m');
  await page.keyboard.press('m');
  expect(await page.evaluate(() => (window as any).__game.audio.ctx.state)).toBe('suspended');
  await page.locator('[data-action=resume]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__game.audio.ctx.state)).toBe('running');
  expect(errors).toEqual([]);
});

test('first Run click stays on target while sound unlocks and reuses the warmed street', async ({ page }) => {
  const models = new Map<string, number>();
  page.on('request', (request) => {
    if (request.url().endsWith('.glb')) models.set(request.url(), (models.get(request.url()) ?? 0) + 1);
  });
  await page.goto('/?seed=11&theme=day');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  await page.evaluate(() => {
    (window as any).openingSegment = (window as any).__game.trackManager.currentSegment;
  });
  await page.locator('[data-action=start]').click();
  const state = await page.evaluate(() => ({
    state: (window as any).__game.getState(),
    sameStreet: (window as any).openingSegment === (window as any).__game.trackManager.currentSegment,
  }));
  expect(state).toEqual({ state: 'countdown', sameStreet: true });
  expect([...models.values()].every((count) => count === 1)).toBe(true);
});

test('switching theme while paused stays paused and cannot race a second selection', async ({ page }) => {
  await page.goto('/?seed=12&theme=day');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  await page.locator('[data-action=start]').click();
  await page.keyboard.press('Escape');
  await page.locator('.pause [data-theme=night]').click();
  await expect(page.locator('#ui-root')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('paused');
  await expect(page.locator('.pause [data-theme=night]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-action=resume]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__game.getState())).toBe('countdown');
});
