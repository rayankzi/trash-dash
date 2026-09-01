import * as THREE from 'three';

export interface SkyGradient {
  top: number;
  horizon: number;
  /** Height in world units over which the two colours blend. */
  falloff: number;
}

export const SKY_GRADIENTS: Record<string, SkyGradient> = {
  day: { top: 0x62aee8, horizon: 0xcfe9f8, falloff: 120 },
  night: { top: 0x050a1c, horizon: 0x2a4a86, falloff: 150 },
};

/**
 * Large inverted sphere painted with a vertical gradient, drawn behind
 * everything else. The Unity themes only supply a flat fog colour, which reads
 * as a blown-out white hole wherever the street opens up; a graded sky gives
 * those gaps depth and keeps the bloom pass from latching onto pure white.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly uniforms;

  constructor(parent: THREE.Object3D, radius = 500) {
    const gradient = SKY_GRADIENTS.day;
    this.uniforms = {
      uTop: { value: new THREE.Color(gradient.top) },
      uHorizon: { value: new THREE.Color(gradient.horizon) },
      uFalloff: { value: gradient.falloff },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying float vHeight;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vHeight = world.y - cameraPosition.y;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform float uFalloff;
        varying float vHeight;
        void main() {
          float t = smoothstep(-0.15, 1.0, vHeight / uFalloff);
          gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), material);
    this.mesh.name = 'SkyGradientDome';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  setTheme(themeKey: string): void {
    const gradient = SKY_GRADIENTS[themeKey] ?? SKY_GRADIENTS.day;
    this.uniforms.uTop.value.setHex(gradient.top);
    this.uniforms.uHorizon.value.setHex(gradient.horizon);
    this.uniforms.uFalloff.value = gradient.falloff;
  }
}
