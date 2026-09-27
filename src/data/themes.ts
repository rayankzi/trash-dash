import type { PrefabNode } from '../core/AssetManager';
import themesJson from './themes.json';

/**
 * Typed view of the extracted ThemeData assets. `skyModel`, `cloudModels` and
 * `skyTransform` are still emitted by the pipeline but deliberately unused at
 * runtime: the gradient SkyDome replaces the authored sky mesh.
 */
export interface ThemeData {
  name: string;
  cost: number;
  premiumCost: number;
  fogColor: [number, number, number];
  fogStart?: number;
  fogEnd?: number;
  zones: { length: number; segments: string[] }[];
  cloudPrefabs?: { name: string; root: PrefabNode }[];
  cloudMinimumDistance?: [number, number, number];
  cloudSpread?: [number, number, number];
  cloudNumber?: number;
  parallaxRatio?: number;
}

export type ThemeKey = 'day' | 'night';

export const THEMES = themesJson as unknown as Record<ThemeKey, ThemeData>;

export function isThemeKey(key: string | null | undefined): key is ThemeKey {
  return !!key && Object.hasOwn(THEMES, key);
}
