import { afterEach, expect, it, vi } from 'vitest';
import { newMission, topUpMissions, type Mission } from '../src/save/Missions';
import { SPEED_STEP } from '../src/core/consts';

afterEach(() => vi.restoreAllMocks());

it('every multiplier mission tier is attainable in the web game', () => {
  for (let tier = 0; tier < 4; tier++) {
    vi.spyOn(Math, 'random').mockReturnValue((tier + 0.5) / 4);
    const mission = newMission(['singleRun', 'pickup', 'barrierJump', 'sliding']);
    expect(mission.max).toBeLessThanOrEqual(1 + SPEED_STEP);
    expect(mission.max).toBeGreaterThan(1);
    expect(mission.reward).toBe(tier + 1);
  }
});

it('repairs impossible saved goals while preserving earned progress and rewards', () => {
  const missions: Mission[] = [
    { type: 'multiplier', max: 8, progress: 4, reward: 3 },
    { type: 'multiplier', max: 10, progress: 2, reward: 4 },
  ];
  topUpMissions(missions);
  expect(missions).toEqual([
    { type: 'multiplier', max: 4, progress: 4, reward: 3 },
    { type: 'multiplier', max: 5, progress: 2, reward: 4 },
  ]);
});
