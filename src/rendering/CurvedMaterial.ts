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
  blinkable?: boolean;
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

function installBlink(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uBlinkingValue = globalBlink;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBlinkingValue;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         diffuseColor.rgb = clamp(
           mix(diffuseColor.rgb, vec3(1.0, 1.0, 0.75), uBlinkingValue),
           vec3(0.0), vec3(1.0)
         );`
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
  if (opts.blinkable) installBlink(material);

  material.customProgramCacheKey = () =>
    `trash-dash-basic:${curved ? 'curved' : 'flat'}:${opts.blinkable ? 'blink' : 'plain'}`;
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

/** Unity's Unlit/UnlitBlinking: flat and flashes toward warm white. */
export function makeBlinkingMaterial(
  map: THREE.Texture | null,
  color: THREE.ColorRepresentation = 0xffffff,
  doubleSided = false
): THREE.MeshBasicMaterial {
  return makeCurvedMaterial({ map, color, curved: false, blinkable: true, depthWrite: true, doubleSided });
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
