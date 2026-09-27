import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assets } from '../core/AssetManager';

// Animation clip GLBs share one rig across both characters (verified: Cat and
// Raccoon GLBs expose identical bone names), so the Cat clips drive either mesh.
const CLIPS: Record<string, string> = {
  run: 'anim/Cat_RunShort',
  jump: 'anim/Cat_Jump',
  slide: 'anim/Cat_Slide',
  hit: 'anim/Cat_HitWall1',
  death: 'anim/Cat_Death',
  idle: 'anim/Cat_Idle1',
  start: 'anim/Cat_Start',
};

export interface CharacterDef {
  name: string;
  /** Portrait under assets/ui/icons. */
  icon: string;
  model: string;
  material: string;
  cost: number;
  premiumCost: number;
  accessories: string[]; // accessory mesh node names baked into the FBX, hidden by default
}

// Costs from the Unity character prefabs.
export const CHARACTERS: Record<string, CharacterDef> = {
  Cat: {
    name: 'Trash Cat',
    icon: 'cat',
    model: 'models/Cat',
    material: 'CatOrange',
    cost: 0,
    premiumCost: 0,
    accessories: ['HatandTie', 'ConstructionGearMesh', 'PartHatandBowtie'],
  },
  Raccoon: {
    name: 'Rubbish Raccoon',
    icon: 'raccoon',
    model: 'models/Racoon',
    material: 'Racoon',
    cost: 50000,
    premiumCost: 20,
    accessories: ['ConstructionGearMesh', 'PartHatandBowtie'],
  },
};

/**
 * Loads the character model + animation clips and exposes a small named-state
 * animation API replacing Unity's Animator controller.
 */
export class Character {
  root!: THREE.Object3D;
  private mixer!: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: string | null = null;

  async load(characterKey = 'Cat'): Promise<void> {
    const def = CHARACTERS[characterKey] ?? CHARACTERS.Cat;
    const model = await assets.loadModel(def.model);
    const newRoot = cloneSkinned(model);
    newRoot.traverse((child) => {
      if (def.accessories.includes(child.name)) child.visible = false;
      if (child instanceof THREE.Mesh) child.frustumCulled = false;
    });
    assets.applyMaterials(newRoot, [def.material]);
    if (this.root) this.root.removeFromParent();
    this.root = newRoot;

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions.clear();
    this.current = null;
    await Promise.all(
      Object.entries(CLIPS).map(async ([name, path]) => {
        await assets.loadModel(path);
        const clip = assets.getAnimations(path)[0];
        if (clip) {
          const action = this.mixer.clipAction(clip);
          if (name === 'jump' || name === 'slide' || name === 'hit' || name === 'start' || name === 'death') {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
          }
          this.actions.set(name, action);
        }
      })
    );
  }

  /** Crossfade to a named state; returns the action (to read duration etc.). */
  play(name: string, fade = 0.15, timeScale = 1): THREE.AnimationAction | undefined {
    const action = this.actions.get(name);
    if (!action) return undefined;
    if (this.current === name && action.isRunning()) {
      action.timeScale = timeScale;
      return action;
    }
    const prev = this.current ? this.actions.get(this.current) : undefined;
    action.reset();
    action.timeScale = timeScale;
    if (prev && prev !== action) {
      action.crossFadeFrom(prev, fade, false);
    }
    action.play();
    this.current = name;
    return action;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }
}
