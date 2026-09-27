import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Per-theme look. Day stays crisp and flat; night leans on glow and contrast. */
export interface GradeSettings {
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** Applied after bloom, so glows stay the brightest thing in a dark frame. */
  exposure: number;
  vignette: number;
  saturation: number;
  contrast: number;
  lift: [number, number, number];
}

export const GRADES: Record<string, GradeSettings> = {
  day: {
    // The daylight sky sits just under full white, so the threshold has to stay
    // above it or the whole horizon blooms into a glare.
    bloomStrength: 0.16,
    bloomRadius: 0.45,
    bloomThreshold: 0.99,
    exposure: 1,
    vignette: 0.28,
    saturation: 1.12,
    contrast: 1.06,
    lift: [1.0, 1.0, 1.01],
  },
  night: {
    // The night art is authored as bright moonlit blue, which on its own reads
    // as "daytime, tinted". Bloom picks out only the genuinely emissive lamps
    // and windows, then the exposure pull-down turns the rest into night.
    bloomStrength: 0.55,
    bloomRadius: 0.7,
    bloomThreshold: 0.72,
    exposure: 0.42,
    vignette: 0.5,
    saturation: 1.1,
    contrast: 1.16,
    lift: [0.84, 0.93, 1.16],
  },
};

/**
 * Final colour grade: vignette, saturation, contrast and a per-theme lift,
 * applied after bloom so the glow is graded with everything else. Also draws
 * the speed lines that streak in from the frame edges near top speed, and the
 * red damage flash.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: GRADES.day.vignette },
    uSaturation: { value: GRADES.day.saturation },
    uContrast: { value: GRADES.day.contrast },
    uLift: { value: new THREE.Vector3(1, 1, 1) },
    uExposure: { value: 1 },
    uFlash: { value: 0 },
    uSpeed: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uFlash;
    uniform float uExposure;
    uniform float uSpeed;
    uniform float uTime;
    uniform float uAspect;
    uniform vec3 uLift;
    varying vec2 vUv;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }

    // Thin radial streaks racing outward from the centre, confined to the
    // frame edges so the track itself stays clean.
    float speedLines(vec2 uv) {
      vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
      float radius = length(p);
      float angle = atan(p.y, p.x) / 6.2831853 + 0.5;
      float lanes = 110.0;
      float cell = floor(angle * lanes);
      float seed = hash(cell);
      float across = abs(fract(angle * lanes) - 0.5) * 2.0;
      float thin = 1.0 - smoothstep(0.0, 0.35, across);
      float head = fract(seed * 13.0 + uTime * (0.9 + seed * 1.2));
      float along = radius - (0.25 + head * 0.8);
      float streak = smoothstep(-0.22, 0.0, along) * (1.0 - smoothstep(0.0, 0.02, along));
      float edge = smoothstep(0.28, 0.62, radius);
      return step(0.72, seed) * thin * streak * edge;
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb * uLift * uExposure;

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;

      // Radial falloff from the centre of the frame.
      vec2 offset = vUv - 0.5;
      float radius = dot(offset, offset);
      color *= 1.0 - uVignette * smoothstep(0.12, 0.75, radius);

      color += vec3(1.0) * speedLines(vUv) * uSpeed * 0.22;

      // Damage flash tints the frame edges red without hiding the track.
      color = mix(color, vec3(0.85, 0.12, 0.12), uFlash * smoothstep(0.05, 0.6, radius));

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }
  `,
};

export class PostProcessing {
  readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private flashTime = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    // Every composer buffer is measured in drawing-buffer pixels, not CSS
    // pixels: on a HiDPI display the two differ by the renderer's pixel ratio.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // A multisampled target keeps the hard-edged low-poly silhouettes clean;
    // the composer bypasses the context's own antialias setting.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(size, GRADES.day.bloomStrength, GRADES.day.bloomRadius, GRADES.day.bloomThreshold);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    // Given a target, EffectComposer adopts that target's pixel dimensions as
    // its own CSS width/height and then multiplies them by the pixel ratio
    // again on the next resize. Restating the size in CSS pixels puts the
    // composer on the renderer's own footing, so the scene is composed at the
    // full drawing-buffer resolution from the first frame rather than at
    // 1/pixelRatio until something happens to resize the window.
    const cssSize = renderer.getSize(new THREE.Vector2());
    this.setPixelRatio(renderer.getPixelRatio());
    this.setSize(cssSize.x, cssSize.y);

    this.setTheme('day');
  }

  setTheme(themeKey: string): void {
    const g = GRADES[themeKey] ?? GRADES.day;
    this.bloom.strength = g.bloomStrength;
    this.bloom.radius = g.bloomRadius;
    this.bloom.threshold = g.bloomThreshold;
    this.grade.uniforms.uVignette.value = g.vignette;
    this.grade.uniforms.uSaturation.value = g.saturation;
    this.grade.uniforms.uContrast.value = g.contrast;
    this.grade.uniforms.uExposure.value = g.exposure;
    (this.grade.uniforms.uLift.value as THREE.Vector3).set(...g.lift);
  }

  /** Trigger the red damage flash; it decays over `flashDuration` seconds. */
  flash(): void {
    this.flashTime = 0.45;
  }

  /** Both dimensions are CSS pixels; the composer scales them by the pixel ratio. */
  setSize(width: number, height: number): void {
    // This sizes every pass, the bloom included, at drawing-buffer resolution.
    // Re-sizing the bloom afterwards would only undo that.
    this.composer.setSize(width, height);
    this.grade.uniforms.uAspect.value = width / Math.max(1, height);
  }

  /** Keep the composer's buffers in step when the renderer's ratio changes. */
  setPixelRatio(pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
  }

  /** 0..1 intensity of the edge speed lines. */
  setSpeed(amount: number): void {
    this.grade.uniforms.uSpeed.value = amount;
  }

  render(dt: number): void {
    this.grade.uniforms.uTime.value += dt;
    if (this.flashTime > 0) {
      this.flashTime = Math.max(0, this.flashTime - dt);
      this.grade.uniforms.uFlash.value = Math.min(1, this.flashTime / 0.45) * 0.55;
    } else if (this.grade.uniforms.uFlash.value !== 0) {
      this.grade.uniforms.uFlash.value = 0;
    }
    this.composer.render(dt);
  }
}
