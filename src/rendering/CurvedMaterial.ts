import * as THREE from 'three';

/** Normalized Unity shader families emitted by the asset extractor. */
export type ShaderFamily =
  | 'curvedOpaque'
  | 'curvedAlpha'
  | 'curvedCloud'
  | 'blinking'
  | 'vertexColor'
  | 'standard';

// Mirrors Shader.SetGlobalFloat in the Unity project.
export const globalCurve = { value: 0.005 };
export const globalBlink = { value: 0 };

const CURVE_VERTEX_CHUNK = /* glsl */ `
  #include <project_vertex>
  // Unity's CurvedCode.cginc changes clip-space Y using camera depth. Keeping
  // the displacement in clip space (rather than moving world vertices) is
  // important: it preserves the authored perspective and segment seams.
  float curvedCameraDepth = max(-mvPosition.z, 0.0);
  gl_Position.y -= uCurveStrength * curvedCameraDepth * curvedCameraDepth;
`;

export interface CurvedMaterialOptions {
  map?: THREE.Texture | null;
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  transparent?: boolean;
  /** Defaults to true. Set false for Unity's non-curved shader families. */
  curved?: boolean;
  /** Defaults to false for transparent materials and true otherwise. */
  depthWrite?: boolean;
  /** Lit, rim-lit and blinkable: the runner's own shading model. */
  character?: boolean;
  skinning?: boolean;
  /** Defaults to front-facing, matching Unity's culled shaders. */
  doubleSided?: boolean;
}

function installCurve(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uCurveStrength = globalCurve;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uCurveStrength;')
      .replace('#include <project_vertex>', CURVE_VERTEX_CHUNK);
  };
}

/**
 * Shared lighting for the runner. The world is authored unlit with painted
 * shading, which leaves the character reading as a flat cut-out against it.
 * These uniforms give it a soft wrap-around key light, a coloured shadow side
 * and a rim light so it pops off the street; `rimColor`/`rimBoost` double as
 * the powerup tint (gold for x2, cyan for the shield...).
 */
export const characterLight = {
  /** View-space direction *towards* the key light. */
  keyDirection: { value: new THREE.Vector3(-0.45, 0.75, 0.5).normalize() },
  lightColor: { value: new THREE.Color(1, 0.97, 0.92) },
  shadowColor: { value: new THREE.Color(0.62, 0.6, 0.78) },
  rimColor: { value: new THREE.Color(1, 0.95, 0.85) },
  rimStrength: { value: 0.45 },
  /** Extra, animated rim used by powerup feedback. */
  rimBoost: { value: 0 },
  rimBoostColor: { value: new THREE.Color(1, 0.8, 0.2) },
};

function installCharacterLighting(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, {
      uBlinkingValue: globalBlink,
      uKeyDirection: characterLight.keyDirection,
      uLightColor: characterLight.lightColor,
      uShadowColor: characterLight.shadowColor,
      uRimColor: characterLight.rimColor,
      uRimStrength: characterLight.rimStrength,
      uRimBoost: characterLight.rimBoost,
      uRimBoostColor: characterLight.rimBoostColor,
    });
    // MeshBasicMaterial only derives normals for skinning/env maps; force the
    // normal chain on so the (skinned) character has view-space normals.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCharNormal;\nvarying vec3 vCharView;')
      .replace('#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )', '#if 1')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vCharNormal = normalize(transformedNormal);
         vCharView = -mvPosition.xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uBlinkingValue;
         uniform vec3 uKeyDirection;
         uniform vec3 uLightColor;
         uniform vec3 uShadowColor;
         uniform vec3 uRimColor;
         uniform float uRimStrength;
         uniform float uRimBoost;
         uniform vec3 uRimBoostColor;
         varying vec3 vCharNormal;
         varying vec3 vCharView;`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         vec3 charN = normalize(vCharNormal);
         if (!gl_FrontFacing) charN = -charN;
         vec3 charV = normalize(vCharView);
         // Half-Lambert wrap with a soft toon step: keeps the painted albedo
         // readable while giving the silhouette a lit and a shadowed side.
         float wrapLight = dot(charN, uKeyDirection) * 0.5 + 0.5;
         float lit = smoothstep(0.28, 0.72, wrapLight);
         diffuseColor.rgb *= mix(uShadowColor, uLightColor, lit);
         float fresnel = pow(1.0 - clamp(dot(charN, charV), 0.0, 1.0), 3.0);
         diffuseColor.rgb += fresnel * (uRimColor * uRimStrength * (0.35 + 0.65 * lit) + uRimBoostColor * uRimBoost);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 1.0, 0.75), uBlinkingValue);
         diffuseColor.rgb = clamp(diffuseColor.rgb, 0.0, 1.0);`
      );
  };
}

/**
 * Three.js equivalent of CurvedUnlit, CurvedUnlitAlpha, and
 * CurvedUnlitCloud. It intentionally stays unlit, consumes baked vertex
 * colours, and lets callers opt out of depth writes for alpha/cloud passes.
 */
export function makeCurvedMaterial(opts: CurvedMaterialOptions = {}): THREE.MeshBasicMaterial {
  const transparent = opts.transparent ?? false;
  const curved = opts.curved ?? true;
  const material = new THREE.MeshBasicMaterial({
    map: opts.map ?? null,
    color: opts.color ?? 0xffffff,
    vertexColors: opts.vertexColors ?? false,
    transparent,
    depthWrite: opts.depthWrite ?? !transparent,
    alphaTest: 0,
    fog: true,
    side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });

  if (curved) installCurve(material);
  if (opts.character) installCharacterLighting(material);

  material.customProgramCacheKey = () =>
    `trash-dash-basic:${curved ? 'curved' : 'flat'}:${opts.character ? 'character' : 'plain'}`;
  return material;
}

/**
 * True when a mesh is a flat sheet rather than a closed solid. The FBX→glTF
 * conversion loses the authored winding on the single-quad scenery (brick and
 * plaster walls, fences, graffiti decals), so those vanish and expose the void
 * beside the track unless they are drawn double-sided. Closed volumes must keep
 * Unity's culling: the background buildings deliberately overlap the corridor
 * and rely on their back faces being invisible.
 */
export function isPlanarGeometry(geometry: THREE.BufferGeometry): boolean {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return false;
  const size = box.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (largest <= 0) return false;
  return Math.min(size.x, size.y, size.z) < largest * 0.05;
}

/** Unity's Unlit/VertexColor: flat, opaque, and never tinted. */
export function makeVertexColorMaterial(doubleSided = false): THREE.MeshBasicMaterial {
  return makeCurvedMaterial({
    color: 0xffffff,
    vertexColors: true,
    curved: false,
    depthWrite: true,
    doubleSided,
  });
}

/**
 * Unity's Unlit/UnlitBlinking (the character family), upgraded with the
 * shared character lighting. Still flashes toward warm white while blinking.
 */
export function makeCharacterMaterial(
  map: THREE.Texture | null,
  color: THREE.ColorRepresentation = 0xffffff,
  doubleSided = false
): THREE.MeshBasicMaterial {
  return makeCurvedMaterial({ map, color, curved: false, character: true, depthWrite: true, doubleSided });
}

/**
 * Lightweight compatibility material for Unity Standard materials. Scene
 * ambient and directional lights provide the lighting; real-time shadows are
 * deliberately not enabled by this material.
 */
export function makeStandardMaterial(
  map: THREE.Texture | null,
  color: THREE.ColorRepresentation = 0xffffff,
  vertexColors = false,
  doubleSided = false
): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    map,
    color,
    vertexColors,
    fog: true,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/** Accept both normalized output and the shader names in older manifests. */
export function normalizeShaderFamily(familyOrShader: string | undefined): ShaderFamily {
  const shader = (familyOrShader ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (shader.includes('curvedunlitalpha') || shader === 'curvedalpha') return 'curvedAlpha';
  if (shader.includes('curvedunlitcloud') || shader === 'curvedcloud') return 'curvedCloud';
  if (shader.includes('unlitblinking') || shader === 'blinking') return 'blinking';
  if (shader.includes('vertexcolor') || shader === 'vertexcolor') return 'vertexColor';
  if (
    shader.includes('curvedunlit') ||
    shader.includes('curvedrotation') ||
    shader === 'curvedopaque'
  ) {
    return 'curvedOpaque';
  }
  return 'standard';
}
