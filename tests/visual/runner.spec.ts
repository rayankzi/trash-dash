import { expect, test, type Page } from '@playwright/test';

const cases = [
  ['day', 'IndustrialWarehouse01', '0'],
  ['day', 'UrbanRoadTSection', '1'],
  ['night', 'SuburbsHouse01', '0'],
  ['night', 'UrbanPlasterWalls03', '1'],
] as const;

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
    // Pin and explicitly compose the reference frame. Stopping rAF before a
    // browser has presented its first frame can otherwise capture an empty
    // composer target, especially in throttled/headless tabs.
    await page.evaluate(() => {
      const game = (window as any).__game;
      game.renderer.setAnimationLoop(null);
      game.character.play('idle', 0);
      game.character.update(0);
      game.post.render(0);
    });

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
  await page.evaluate(() => {
    const game = (window as any).__game;
    game.renderer.setAnimationLoop(null);
    game.character.play('run', 0);
    game.character.update(0);
    game.post.render(0);
  });
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
  // The authored theme sky mesh is deliberately bypassed in favour of the
  // renderer's gradient dome (see EnvironmentManager's useThemeSky).
  expect(state.environment).toEqual({ theme: 'day', clouds: 20, skyLoaded: false });
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
