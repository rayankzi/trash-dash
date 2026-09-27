import * as THREE from 'three';
import { assets } from '../core/AssetManager';
import { globalCurve } from './CurvedMaterial';

/**
 * One GPU point-sprite layer: a fixed-size ring buffer of particles simulated
 * on the CPU and drawn in a single call. Sprites follow the curved-world bend
 * like the rest of the scene, and flipbook textures (the original SmokePuff
 * strip) animate over each particle's life.
 */
interface LayerOptions {
  texture: string;
  capacity: number;
  additive?: boolean;
  /** Horizontal flipbook frame count (1 = static sprite). */
  frames?: number;
}

export interface EmitOptions {
  count: number;
  color: THREE.ColorRepresentation;
  /** Random per-particle lightness variation, 0..1. */
  colorJitter?: number;
  size: [number, number];
  /** Multiplier applied to the size over the particle's life (end / start). */
  grow?: number;
  life: [number, number];
  speed: [number, number];
  /** Mean direction (normalised internally); omitted = uniform sphere. */
  direction?: THREE.Vector3;
  /** 0 = exactly `direction`, 1 = full hemisphere around it. */
  spread?: number;
  /** Random offset radius around the emit position. */
  radius?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
  /** Fraction of the runner's velocity the particles carry along. */
  inherit?: number;
}

const tmpColor = new THREE.Color();
const tmpDirection = new THREE.Vector3();
const tmpOffset = new THREE.Vector3();
const tmpSize = new THREE.Vector2();

class ParticleLayer {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private next = 0;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly alpha: Float32Array;
  private readonly size: Float32Array;
  private readonly rotation: Float32Array;
  private readonly frame: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly grow: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly spin: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private live = 0;
  private readonly frames: number;
  readonly uniforms: { uScale: { value: number } };

  constructor(options: LayerOptions) {
    const n = (this.capacity = options.capacity);
    this.position = new Float32Array(n * 3);
    this.color = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rotation = new Float32Array(n);
    this.frame = new Float32Array(n);
    this.velocity = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.spin = new Float32Array(n);

    const attribute = (array: Float32Array, itemSize: number) =>
      new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', attribute(this.position, 3));
    this.geometry.setAttribute('aColor', attribute(this.color, 3));
    this.geometry.setAttribute('aAlpha', attribute(this.alpha, 1));
    this.geometry.setAttribute('aSize', attribute(this.size, 1));
    this.geometry.setAttribute('aRotation', attribute(this.rotation, 1));
    this.geometry.setAttribute('aFrame', attribute(this.frame, 1));

    this.uniforms = { uScale: { value: 600 } };
    // Textures load with flipY=false, so gl_PointCoord (y down) maps straight
    // onto image rows.
    const texture = assets.getTexture(`textures/${options.texture}`);
    this.frames = options.frames ?? 1;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uMap: { value: texture },
        uFrames: { value: this.frames },
        uCurveStrength: globalCurve,
      },
      transparent: true,
      depthWrite: false,
      blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSize;
        attribute float aRotation;
        attribute float aFrame;
        uniform float uScale;
        uniform float uCurveStrength;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vRotation;
        varying float vFrame;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vRotation = aRotation;
          vFrame = aFrame;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float depth = max(-mvPosition.z, 0.0);
          gl_Position.y -= uCurveStrength * depth * depth;
          gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(depth, 0.1) : 0.0;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uFrames;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vRotation;
        varying float vFrame;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float c = cos(vRotation);
          float s = sin(vRotation);
          uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          uv.x = (uv.x + floor(vFrame)) / uFrames;
          vec4 texel = texture2D(uMap, uv);
          float alpha = texel.a * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(texel.rgb * vColor, alpha);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
  }

  emit(origin: THREE.Vector3, options: EmitOptions, carried: THREE.Vector3): void {
    const base = tmpColor.set(options.color);
    const [r, g, b] = [base.r, base.g, base.b];
    for (let n = 0; n < options.count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const i3 = i * 3;

      tmpOffset.randomDirection().multiplyScalar((options.radius ?? 0) * Math.random());
      this.position[i3] = origin.x + tmpOffset.x;
      this.position[i3 + 1] = origin.y + tmpOffset.y;
      this.position[i3 + 2] = origin.z + tmpOffset.z;

      if (options.direction) {
        tmpDirection
          .randomDirection()
          .multiplyScalar(options.spread ?? 0.5)
          .add(options.direction)
          .normalize();
      } else {
        tmpDirection.randomDirection();
      }
      const speed = THREE.MathUtils.lerp(options.speed[0], options.speed[1], Math.random());
      const inherit = options.inherit ?? 0;
      this.velocity[i3] = tmpDirection.x * speed + carried.x * inherit;
      this.velocity[i3 + 1] = tmpDirection.y * speed + carried.y * inherit;
      this.velocity[i3 + 2] = tmpDirection.z * speed + carried.z * inherit;

      const jitter = 1 + ((Math.random() - 0.5) * 2 * (options.colorJitter ?? 0));
      this.color[i3] = Math.min(1, r * jitter);
      this.color[i3 + 1] = Math.min(1, g * jitter);
      this.color[i3 + 2] = Math.min(1, b * jitter);

      this.age[i] = 0;
      this.life[i] = THREE.MathUtils.lerp(options.life[0], options.life[1], Math.random());
      this.baseSize[i] = THREE.MathUtils.lerp(options.size[0], options.size[1], Math.random());
      this.grow[i] = options.grow ?? 1;
      this.gravity[i] = options.gravity ?? 0;
      this.drag[i] = options.drag ?? 0;
      this.spin[i] = (Math.random() - 0.5) * 2 * (options.spin ?? 0);
      this.rotation[i] = Math.random() * Math.PI * 2;
      this.frame[i] = 0;
      this.alpha[i] = 1;
      this.size[i] = this.baseSize[i];
    }
    this.live = Math.min(this.capacity, this.live + options.count);
  }

  update(dt: number): void {
    if (this.live === 0) return;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alpha[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.alpha[i] = 0;
        continue;
      }
      alive++;
      const i3 = i * 3;
      const damping = Math.max(0, 1 - this.drag[i] * dt);
      this.velocity[i3] *= damping;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * damping - this.gravity[i] * dt;
      this.velocity[i3 + 2] *= damping;
      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;
      this.rotation[i] += this.spin[i] * dt;
      // Quick pop in, long ease out.
      this.alpha[i] = Math.min(1, t * 12) * (1 - t * t);
      this.size[i] = this.baseSize[i] * THREE.MathUtils.lerp(1, this.grow[i], t) * Math.min(1, 0.4 + t * 8);
      this.frame[i] = Math.min(this.frames - 1, t * this.frames);
    }
    this.live = alive;
    for (const name of ['position', 'aAlpha', 'aSize', 'aRotation', 'aFrame', 'aColor']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
  }

  translate(offset: THREE.Vector3): void {
    for (let i = 0; i < this.capacity; i++) {
      this.position[i * 3] += offset.x;
      this.position[i * 3 + 1] += offset.y;
      this.position[i * 3 + 2] += offset.z;
    }
  }

  clear(): void {
    this.alpha.fill(0);
    this.live = 0;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Game-feel particles: pickup sparkles, kicked-up dust, impact smoke and
 * powerup auras. Everything lives in world space so dust stays where it was
 * kicked up while the runner moves on; pickups instead inherit most of the
 * runner's velocity so their sparkle stays on screen.
 */
export class Effects {
  private readonly layers: Record<'glow' | 'sparkle' | 'star' | 'puff' | 'smoke' | 'spark', ParticleLayer>;
  private readonly runnerVelocity = new THREE.Vector3();
  private readonly lastRunner = new THREE.Vector3();
  private hasLastRunner = false;
  private dustTimer = 0;
  private auraTimer = 0;

  constructor(parent: THREE.Object3D) {
    this.layers = {
      glow: new ParticleLayer({ texture: 'Particle01.png', capacity: 256, additive: true }),
      sparkle: new ParticleLayer({ texture: 'Sparkle.png', capacity: 256, additive: true }),
      star: new ParticleLayer({ texture: 'Star.png', capacity: 96 }),
      puff: new ParticleLayer({ texture: 'Puff.png', capacity: 160 }),
      smoke: new ParticleLayer({ texture: 'SmokePuff.png', capacity: 32, frames: 10 }),
      spark: new ParticleLayer({ texture: 'MagnetSparks.png', capacity: 64, additive: true }),
    };
    // Dust under everything else; additive glints drawn last.
    const order = ['puff', 'smoke', 'star', 'glow', 'sparkle', 'spark'] as const;
    order.forEach((key, index) => {
      this.layers[key].points.renderOrder = 10 + index;
      parent.add(this.layers[key].points);
    });
  }

  /** Called every frame with the runner's feet position (world space). */
  trackRunner(position: THREE.Vector3, dt: number): void {
    if (this.hasLastRunner && dt > 0) {
      this.runnerVelocity.subVectors(position, this.lastRunner).divideScalar(dt);
      // A floating-origin recentre is a jump of ~100 units, not a velocity.
      if (this.runnerVelocity.lengthSq() > 900) this.runnerVelocity.set(0, 0, 0);
    }
    this.lastRunner.copy(position);
    this.hasLastRunner = true;
  }

  /** Point-sprite size is in world units; convert once per frame. */
  update(dt: number, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const height = renderer.getDrawingBufferSize(tmpSize).y;
    const scale = height * 0.5 * camera.projectionMatrix.elements[5];
    for (const layer of Object.values(this.layers)) {
      layer.uniforms.uScale.value = scale;
      layer.update(dt);
    }
  }

  translate(offset: THREE.Vector3): void {
    for (const layer of Object.values(this.layers)) layer.translate(offset);
    this.lastRunner.add(offset);
  }

  clear(): void {
    for (const layer of Object.values(this.layers)) layer.clear();
    this.hasLastRunner = false;
    this.runnerVelocity.set(0, 0, 0);
  }

  private emit(layer: keyof Effects['layers'], at: THREE.Vector3, options: EmitOptions): void {
    this.layers[layer].emit(at, options, this.runnerVelocity);
  }

  coin(at: THREE.Vector3): void {
    this.emit('sparkle', at, {
      count: 5, color: 0xfff2a8, size: [0.35, 0.6], grow: 0.3, life: [0.25, 0.45],
      speed: [1.5, 3.5], direction: UP, spread: 1, inherit: 0.95, spin: 6,
    });
    this.emit('glow', at, {
      count: 1, color: 0xffd35a, size: [0.9, 0.9], grow: 1.6, life: [0.2, 0.2],
      speed: [0, 0], inherit: 1,
    });
  }

  premium(at: THREE.Vector3): void {
    this.emit('star', at, {
      count: 10, color: 0xffd24a, colorJitter: 0.15, size: [0.25, 0.45], grow: 0.2, life: [0.5, 0.8],
      speed: [2.5, 5], direction: UP, spread: 1, gravity: 6, inherit: 1, spin: 8,
    });
    this.emit('glow', at, {
      count: 1, color: 0xfff0b0, size: [1.4, 1.4], grow: 1.8, life: [0.35, 0.35], speed: [0, 0], inherit: 1,
    });
  }

  powerup(at: THREE.Vector3, color: THREE.ColorRepresentation): void {
    this.emit('sparkle', at, {
      count: 14, color, colorJitter: 0.2, size: [0.3, 0.55], grow: 0.2, life: [0.35, 0.6],
      speed: [2.5, 4.5], spread: 1, drag: 4, inherit: 1, spin: 5,
    });
    this.emit('glow', at, {
      count: 1, color, size: [1.4, 1.4], grow: 1.8, life: [0.35, 0.35], speed: [0, 0], inherit: 1,
    });
  }

  /** Cartoon impact: a smoke flipbook pop plus a ring of stars. */
  hit(at: THREE.Vector3): void {
    this.emit('smoke', at, {
      count: 1, color: 0xf2eee8, size: [1.5, 1.7], grow: 1.3, life: [0.4, 0.45],
      speed: [0.2, 0.6], direction: UP, spread: 1, inherit: 0.9,
    });
    this.emit('star', at, {
      count: 8, color: 0xffe066, colorJitter: 0.2, size: [0.22, 0.38], grow: 0.4, life: [0.45, 0.7],
      speed: [2.5, 4.5], direction: UP, spread: 1.2, gravity: 5, inherit: 0.9, spin: 10,
    });
  }

  /** Landing / slide kick-off dust around the feet. */
  dustBurst(at: THREE.Vector3, color: THREE.ColorRepresentation, amount = 1): void {
    this.emit('puff', at, {
      count: Math.round(6 * amount), color, colorJitter: 0.08, size: [0.35, 0.6], grow: 2.2,
      life: [0.35, 0.6], speed: [0.8, 2], direction: UP, spread: 1.6, drag: 4, radius: 0.2,
    });
  }

  /**
   * Continuous footstep dust while running (denser at speed) or sliding.
   * `dt` accumulates so the emission rate is frame-rate independent.
   */
  runDust(at: THREE.Vector3, color: THREE.ColorRepresentation, speedRatio: number, sliding: boolean, dt: number): void {
    const interval = sliding ? 0.03 : THREE.MathUtils.lerp(0.14, 0.07, speedRatio);
    this.dustTimer += dt;
    while (this.dustTimer >= interval) {
      this.dustTimer -= interval;
      this.emit('puff', at, {
        count: 1, color, colorJitter: 0.08, size: sliding ? [0.3, 0.5] : [0.18, 0.32], grow: 2.4,
        life: [0.35, 0.55], speed: [0.3, 0.9], direction: UP, spread: 1.2, drag: 3, radius: 0.15,
      });
    }
  }

  /**
   * Ambient particles while a powerup runs, in the powerup's colour: electric
   * sparks for the magnet, glints for everything else.
   */
  aura(at: THREE.Vector3, color: THREE.ColorRepresentation, sparks: boolean, dt: number): void {
    this.auraTimer += dt;
    if (this.auraTimer < 0.06) return;
    this.auraTimer = 0;
    if (sparks) {
      this.emit('spark', at, {
        count: 1, color, size: [0.25, 0.4], grow: 0.4, life: [0.18, 0.28],
        speed: [0.5, 1.5], radius: 0.7, inherit: 1, spin: 4,
      });
    } else {
      this.emit('sparkle', at, {
        count: 1, color, size: [0.2, 0.35], grow: 0.3, life: [0.3, 0.5],
        speed: [0.4, 1.2], direction: UP, spread: 1, radius: 0.55, inherit: 1, spin: 4,
      });
    }
  }
}
