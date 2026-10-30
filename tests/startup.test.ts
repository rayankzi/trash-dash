import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetManager } from '../src/core/AssetManager';
import { RenderQuality, renderPixelRatio } from '../src/rendering/RenderQuality';

afterEach(() => vi.restoreAllMocks());

describe('startup model loading', () => {
  it('shares concurrent loads across prefabs and caches the same model', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({
      scene: new THREE.Group(), animations: [],
    } as unknown as GLTF);
    const assets = new AssetManager();
    const results = await Promise.all(Array.from({ length: 20 }, () => assets.loadModel('models/Shared')));
    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(await assets.loadModel('models/Shared')).toBe(results[0]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('allows a failed model to be retried', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ scene: new THREE.Group(), animations: [] } as unknown as GLTF);
    const assets = new AssetManager();
    await expect(assets.loadModel('models/Retry')).rejects.toThrow('network');
    await expect(assets.loadModel('models/Retry')).resolves.toBeInstanceOf(THREE.Group);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('render quality', () => {
  it('caps high-density render cost while preserving ordinary desktop resolution', () => {
    expect(renderPixelRatio(1440, 900, 1)).toBe(1);
    const ratio = renderPixelRatio(2560, 1440, 2);
    expect(2560 * 1440 * ratio ** 2).toBeCloseTo(3_000_000);
    expect(renderPixelRatio(400, 800, 3)).toBe(2);
  });

  it('ignores isolated stalls, reduces sustained load, and recovers slowly', () => {
    const quality = new RenderQuality();
    quality.sample(3);
    for (let i = 0; i < 180; i++) quality.sample(1 / 60);
    expect(quality.scale).toBe(1);
    for (let i = 0; i < 240; i++) quality.sample(1 / 30);
    expect(quality.scale).toBeLessThan(1);
    const reduced = quality.scale;
    for (let i = 0; i < 120; i++) quality.sample(1 / 60);
    expect(quality.scale).toBe(reduced);
    for (let i = 0; i < 900; i++) quality.sample(1 / 60);
    expect(quality.scale).toBeGreaterThan(reduced);
    expect(quality.scale).toBeLessThanOrEqual(1);
  });
});
