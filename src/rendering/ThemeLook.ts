import * as THREE from 'three';

/**
 * Presentation values the Unity theme assets do not carry: the colour of the
 * ground haze under the street, and the light rig that the handful of Standard
 * materials in the scene react to.
 */
export interface ThemeLook {
  /**
   * Overrides the theme's authored fog colour so that fogged-out ground meets
   * the sky gradient at exactly the same tone — otherwise the horizon beyond
   * the street reads as a bright hole rather than distance.
   */
  fogColor: number;
  groundColor: number;
  ambientColor: number;
  ambientIntensity: number;
  sunColor: number;
  sunIntensity: number;
  shadowOpacity: number;
}

export const THEME_LOOKS: Record<string, ThemeLook> = {
  day: {
    fogColor: 0xcfe9f8,
    groundColor: 0x939cae,
    ambientColor: 0x7d84a0,
    ambientIntensity: 1,
    sunColor: 0xfff4d6,
    sunIntensity: 1,
    shadowOpacity: 0.42,
  },
  night: {
    fogColor: 0x2a4a86,
    groundColor: 0x1c2440,
    ambientColor: 0x3a4a7a,
    ambientIntensity: 0.85,
    sunColor: 0x9fb6ff,
    sunIntensity: 0.55,
    shadowOpacity: 0.3,
  },
};

export function themeLook(key: string): ThemeLook {
  return THEME_LOOKS[key] ?? THEME_LOOKS.day;
}

/** Unity's Main.unity sun orientation, reused for both themes. */
export const UNITY_SUN_ROTATION = new THREE.Quaternion(
  0.40821794,
  -0.23456973,
  0.109381676,
  0.87542605
);
