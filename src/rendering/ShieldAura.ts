import * as THREE from 'three';

/**
 * Fresnel bubble around the runner while the Invincible powerup is active. It
 * fades in and out rather than popping, and flickers in its last two seconds
 * so the player can see the protection is about to run out.
 */
export class ShieldAura {
  private readonly mesh: THREE.Mesh;
  private readonly uniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(0x7fe8ff) },
  };
  private target = 0;

  constructor(parent: THREE.Object3D) {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        varying vec3 vLocal;
        void main() {
          vLocal = position;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = -mvPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec3 vNormal;
        varying vec3 vView;
        varying vec3 vLocal;
        void main() {
          float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);
          // Energy bands sliding up the bubble.
          float bands = 0.5 + 0.5 * sin(vLocal.y * 14.0 - uTime * 6.0);
          float intensity = fresnel * (0.75 + 0.25 * bands) + 0.04;
          gl_FragColor = vec4(uColor * intensity * uOpacity, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
    this.mesh.name = 'ShieldAura';
    this.mesh.scale.set(0.85, 1.1, 0.85);
    this.mesh.position.y = 0.95;
    this.mesh.renderOrder = 30;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** `timeLeft` is the powerup's remaining seconds, or 0 when inactive. */
  update(dt: number, timeLeft: number, sliding: boolean): void {
    this.target = timeLeft > 0 ? 1 : 0;
    if (timeLeft > 0 && timeLeft < 2) this.target = Math.sin(timeLeft * 18) > 0 ? 1 : 0.25;
    const opacity = this.uniforms.uOpacity;
    opacity.value += (this.target - opacity.value) * Math.min(1, dt * 10);
    this.uniforms.uTime.value += dt;
    this.mesh.visible = opacity.value > 0.01;
    // Squash down with the slide so the bubble hugs the character.
    const sy = sliding ? 0.6 : 1.1;
    this.mesh.scale.y += (sy - this.mesh.scale.y) * Math.min(1, dt * 12);
    this.mesh.position.y = this.mesh.scale.y * 0.86;
  }
}
