import { expect, test, type Page } from '@playwright/test';

const cases = [
  ['day', 'IndustrialWarehouse01', '0'],
  ['day', 'UrbanRoadTSection', '1'],
  ['night', 'SuburbsHouse01', '0'],
  ['night', 'UrbanPlasterWalls03', '1'],
] as const;

/**
 * Canvas-only render checks: hide the HTML overlay (the loadout card covers a
 * large part of the frame) and compose the pinned frame inside a rAF so the
 * browser has a presented buffer to capture.
 */
async function composePinnedFrame(page: Page, animation: 'idle' | 'run', shot: 'follow' | 'menu'): Promise<void> {
  await page.addStyleTag({ content: '#ui-root { display: none !important; }' });
  await page.evaluate(
    ([clip, cameraShot]) =>
      new Promise<void>((resolve) => {
        const game = (window as any).__game;
        game.renderer.setAnimationLoop(null);
        game.director.setShot(cameraShot, 0);
        game.director.update(0, 0);
        game.character.play(clip, 0);
        game.character.update(0);
        requestAnimationFrame(() => {
          game.post.render(0);
          resolve();
        });
      }),
    [animation, shot] as const
  );
}

async function collectPageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

for (const [theme, segment, mirror] of cases) {
  test(`${theme} ${segment} mirror=${mirror} renders a continuous opening`, async ({ page }) => {
    const errors = await collectPageErrors(page);
    await page.goto(`/?test=1&seed=12345&theme=${theme}&segment=${segment}&mirror=${mirror}`);
    const start = page.locator('[data-action=start]');
    await expect(start).toBeEnabled();
    // Pin and explicitly compose the reference frame. The title shows a
    // front showcase; this test is about the chase view.
    await composePinnedFrame(page, 'idle', 'follow');

    const game = await page.evaluate(() => {
      const handle = (window as unknown as { __game?: { renderer?: { info?: { memory?: unknown; render?: unknown } } } }).__game;
      return handle ? { ready: true, info: handle.renderer?.info ?? null } : { ready: false, info: null };
    });
    expect(game.ready).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);

    const canvas = page.locator('#game-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveScreenshot(`${theme}-${segment}-${mirror}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });
}

test('split building primitives keep their authored surfaces', async ({ page }) => {
  const errors = await collectPageErrors(page);
  await page.goto('/?test=1&seed=12345&theme=day&segment=IndustrialWarehouse02&mirror=0');
  await expect(page.locator('[data-action=start]')).toBeEnabled();

  const warehouseMaterials = await page.evaluate(() => {
    const names = new Set<string>();
    (window as any).__game.scene.traverse((object: any) => {
      if (!object.isMesh || !/^Warehouse02_/.test(object.name)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) names.add(material.name);
    });
    return [...names].sort();
  });
  expect(warehouseMaterials).toEqual(['BrickWall', 'CorrugatedMetal', 'Pipe', 'VCOL']);
  expect(errors, errors.join('\n')).toEqual([]);

  await page.locator('[data-action=start]').click();
  // Stop the loop and compose one frame from a pinned pose: how far the start
  // animation has played after a wall-clock wait is not reproducible, and the
  // frame this test cares about is the buildings, not the character.
  await composePinnedFrame(page, 'run', 'follow');
  await expect(page.locator('#game-canvas')).toHaveScreenshot('day-side-buildings-materials.png', {
    animations: 'disabled',
    // Cloud and pickup placement share the seeded asynchronous boot stream;
    // the exact material assertion above is authoritative for this test.
    maxDiffPixelRatio: 0.03,
  });
});

test('theme switching does not leak scene resources or produce missing assets', async ({ page }) => {
  const errors = await collectPageErrors(page);
  await page.goto('/?test=1&seed=7&theme=day&segment=UrbanBuilding01&mirror=0');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  const switchTheme = async (theme: 'day' | 'night') => page.evaluate(async (nextTheme) => {
    const game = (window as any).__game;
    await Promise.all([
      game.trackManager.begin(nextTheme),
      game.environment.setTheme(nextTheme, game.themes[nextTheme]),
    ]);
  }, theme);
  await switchTheme('night');
  const warmed = await page.evaluate(() => {
    const game = (window as any).__game;
    return game?.renderer?.info?.memory ?? null;
  });
  await switchTheme('day');
  await switchTheme('night');
  const repeated = await page.evaluate(() => (window as any).__game?.renderer?.info?.memory ?? null);
  expect(warmed).toBeTruthy();
  expect(repeated).toBeTruthy();
  expect(repeated.geometries).toBeLessThanOrEqual(warmed.geometries + 5);
  expect(repeated.textures).toBeLessThanOrEqual(warmed.textures + 2);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('long-run recenter keeps the environment and track aligned', async ({ page }) => {
  const errors = await collectPageErrors(page);
  await page.goto('/?test=1&seed=99&theme=day&segment=IndustrialWarehouse01&mirror=0');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  const state = await page.evaluate(() => {
    const game = (window as any).__game;
    game.trackManager.startMove();
    for (let i = 0; i < 2_000; i++) game.trackManager.update(0.1);
    return {
      distance: game.trackManager.worldDistance,
      originDistance: game.trackManager.characterRoot.position.length(),
      environment: game.environment.state,
      skyDome: !!game.scene.getObjectByName('SkyGradientDome'),
    };
  });
  expect(state.distance).toBeGreaterThan(1_000);
  expect(state.originDistance).toBeLessThan(100);
  // The authored theme sky mesh is deliberately replaced by the gradient dome.
  expect(state.environment).toEqual({ theme: 'day', clouds: 20 });
  expect(state.skyDome).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('stays within the rendering complexity budget', async ({ page }) => {
  await page.goto('/?test=1&seed=17&theme=day&segment=UrbanBuilding01&mirror=0');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  await page.waitForTimeout(250);
  const budget = await page.evaluate(() => {
    const renderer = (window as any).__game.renderer;
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      pixelRatio: renderer.getPixelRatio(),
    };
  });
  // Complete multi-material building primitives increase the authored scene
  // complexity; these bounds still leave headroom over the deterministic
  // 253-call / 160k-triangle reference frame.
  expect(budget.calls).toBeLessThanOrEqual(300);
  expect(budget.triangles).toBeLessThanOrEqual(200_000);
  expect(budget.geometries).toBeLessThanOrEqual(30);
  // The bloom chain's mip render targets are counted as textures alongside the
  // handful of authored albedo maps.
  expect(budget.textures).toBeLessThanOrEqual(26);
  expect(budget.pixelRatio).toBeLessThanOrEqual(2);
});

/**
 * Drive the game logic at a fixed 60 Hz from the test, independent of rAF.
 * Frames are simulated but not composed: software GL is far too slow headless
 * to post-process hundreds of frames, and flow tests only check state.
 */
async function pinClock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const game = (window as any).__game.game;
    game.renderer.setAnimationLoop(null);
    game.post.render = () => {};
    game.timer.getDelta = () => 1 / 60;
    (window as any).step = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * 60); i++) game.frame();
      return game.currentState;
    };
  });
}

test('title showcases the runner in front of a filled street', async ({ page }) => {
  const errors = await collectPageErrors(page);
  await page.goto('/?test=1&seed=12345&theme=day&segment=UrbanBuilding01&mirror=0');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  await composePinnedFrame(page, 'idle', 'menu');
  expect(errors, errors.join('\n')).toEqual([]);
  await expect(page.locator('#game-canvas')).toHaveScreenshot('title-showcase.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.03,
  });
});

test('a run goes countdown -> playing -> game over -> menu', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await collectPageErrors(page);
  await page.goto('/?test=1&seed=4&theme=day');
  await expect(page.locator('[data-action=start]')).toBeEnabled();
  await pinClock(page);

  await page.keyboard.press('Space');
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('countdown');
  await expect(page.locator('.hud')).toHaveClass(/visible/);

  const playing = await page.evaluate(() => (window as any).step(4));
  expect(playing).toBe('playing');

  // No input: the runner eventually crashes out on its final life.
  const result = await page.evaluate(() => {
    const game = (window as any).__game;
    game.collider.lives = 1;
    // Fast-forward at 20 Hz: 0.5 units per step at top speed is still well
    // inside the ~1.1-unit overlap window of a collision, so nothing tunnels.
    const inner = game.game;
    inner.timer.getDelta = () => 1 / 20;
    let state = 'playing';
    for (let i = 0; i < 4000 && state === 'playing'; i++) {
      inner.frame();
      state = inner.currentState;
    }
    for (let i = 0; i < 60; i++) inner.frame();
    inner.timer.getDelta = () => 1 / 60;
    return { state: game.getState(), score: game.trackManager.score };
  });
  expect(result.state).toBe('gameover');
  expect(result.score).toBeGreaterThan(0);
  await expect(page.locator('.screen.game-over')).toHaveClass(/visible/);
  await expect(page.locator('.result-score')).not.toHaveText('');

  await page.locator('[data-action=loadout]').click();
  expect(await page.evaluate(() => (window as any).__game.getState())).toBe('title');
  await expect(page.locator('.screen.title')).toHaveClass(/visible/);
  expect(errors, errors.join('\n')).toEqual([]);
});
