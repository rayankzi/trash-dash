import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CharacterCollider } from '../src/character/CharacterCollider';
import type { CharacterController } from '../src/character/CharacterController';
import type { TrackManager } from '../src/track/TrackManager';
import type { TrackSegment } from '../src/track/TrackSegment';
import {
  obstacleColliderProfile,
  setObstacleColliderBox,
} from '../src/obstacles/Obstacles';

function obstacle(name: 'ObstacleRat' | 'ObstacleHighBarrier') {
  const object = new THREE.Object3D();
  object.name = name;
  const profile = obstacleColliderProfile(name)!;
  const box = new THREE.Box3();
  setObstacleColliderBox(box, object, profile);
  return { box, kind: 'obstacle' as const, obj: object };
}

function collisionHarness(obstacleName: 'ObstacleRat' | 'ObstacleHighBarrier') {
  const controller = {
    holder: new THREE.Object3D(),
    isJumping: false,
    isSliding: false,
  } as unknown as CharacterController;
  const segment = { colliders: [obstacle(obstacleName)] } as unknown as TrackSegment;
  const track = { nearbySegments: () => [segment] } as unknown as TrackManager;
  const collider = new CharacterCollider(controller, track);
  return { collider, controller };
}

describe('obstacle gameplay colliders', () => {
  it('lets a raised jump clear the rat while a grounded runner is hit', () => {
    const grounded = collisionHarness('ObstacleRat');
    grounded.collider.update(1 / 60);
    expect(grounded.collider.lives).toBe(2);

    const airborne = collisionHarness('ObstacleRat');
    airborne.controller.isJumping = true;
    airborne.controller.holder.position.y = 0.8;
    airborne.collider.update(1 / 60);
    expect(airborne.collider.lives).toBe(3);
  });

  it('lets the sliding collider pass below the high barrier', () => {
    const standing = collisionHarness('ObstacleHighBarrier');
    standing.collider.update(1 / 60);
    expect(standing.collider.lives).toBe(2);

    const sliding = collisionHarness('ObstacleHighBarrier');
    sliding.controller.isSliding = true;
    sliding.collider.update(1 / 60);
    expect(sliding.collider.lives).toBe(3);
  });

  it('keeps the rat in its lane instead of using its oversized skinned bounds', () => {
    const profile = obstacleColliderProfile('ObstacleRat')!;
    expect(profile.size[0]).toBeLessThan(1);
    expect(profile.center[1] + profile.size[1] / 2).toBe(0.55);
  });
});
