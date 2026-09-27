import * as THREE from 'three';

/**
 * Presentation values the Unity theme assets do not carry: the colour of the
 * ground haze under the street, the light rig that the handful of Standard
 * materials in the scene react to, the runner's own lighting, and the tone of
 * the dust it kicks up.
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
  character: {
    light: [number, number, number];
    shadow: [number, number, number];
    rim: [number, number, number];
    rimStrength: number;
  };
  dustColor: number;
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
    character: {
      light: [1, 0.98, 0.94],
      shadow: [0.64, 0.6, 0.8],
      rim: [1, 0.94, 0.78],
      rimStrength: 0.4,
    },
    dustColor: 0xd9d4cc,
  },
  night: {
    fogColor: 0x2a4a86,
    groundColor: 0x1c2440,
    ambientColor: 0x3a4a7a,
    ambientIntensity: 0.85,
    sunColor: 0x9fb6ff,
    sunIntensity: 0.55,
    shadowOpacity: 0.3,
    character: {
      // Moonlit: cool key, deep blue shadow side, a moon rim. Kept dimmer than
      // day so the white fur stays under the night bloom threshold (0.72) —
      // only the lamps should glow.
      light: [0.66, 0.68, 0.76],
      shadow: [0.3, 0.33, 0.55],
      rim: [0.45, 0.62, 0.95],
      rimStrength: 0.45,
    },
    dustColor: 0x8a9cc8,
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
