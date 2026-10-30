// Port of Assets/Scripts/Missions/Missions.cs: five mission types, four
// difficulty tiers each (reward = tier + 1 premium), always two active.

export type MissionType = 'singleRun' | 'pickup' | 'barrierJump' | 'sliding' | 'multiplier';

const TIERS: Record<MissionType, number[]> = {
  singleRun: [500, 1000, 1500, 2000],
  pickup: [1000, 2000, 3000, 4000],
  barrierJump: [20, 50, 75, 100],
  sliding: [20, 30, 75, 150],
  multiplier: [2, 3, 4, 5],
};

const DESCRIPTIONS: Record<MissionType, (max: number) => string> = {
  singleRun: (m) => `Run ${m}m in a single run`,
  pickup: (m) => `Collect ${m} fishbones`,
  barrierJump: (m) => `Jump over ${m} barriers`,
  sliding: (m) => `Slide for ${m}m`,
  multiplier: (m) => `Reach a x${m} multiplier`,
};

export interface Mission {
  type: MissionType;
  progress: number;
  max: number;
  reward: number;
}

export const missionDescription = (m: Mission) => DESCRIPTIONS[m.type](m.max);
export const missionComplete = (m: Mission) => m.progress >= m.max;

export function newMission(excludeTypes: MissionType[] = []): Mission {
  const types = (Object.keys(TIERS) as MissionType[]).filter((t) => !excludeTypes.includes(t));
  const type = types[Math.floor(Math.random() * types.length)];
  const tier = Math.floor(Math.random() * 4);
  return { type, progress: 0, max: TIERS[type][tier], reward: tier + 1 };
}

/** Keep exactly two active missions (PlayerData.CheckMissionsCount). */
export function topUpMissions(missions: Mission[]): void {
  // Older saves used Unity's x8/x10 goals, beyond the web runner's x5 cap.
  for (const mission of missions) {
    if (mission.type === 'multiplier' && mission.max > 5) {
      mission.max = TIERS.multiplier[Math.max(0, Math.min(3, mission.reward - 1))];
    }
  }
  while (missions.length < 2) {
    missions.push(newMission(missions.map((m) => m.type)));
  }
}

/** Per-run progress tracker feeding the persistent mission list. */
export class MissionProgress {
  private runDistance = 0;

  constructor(private missions: Mission[]) {}

  startRun(): void {
    this.runDistance = 0;
    for (const m of this.missions) {
      if (m.type === 'singleRun' || m.type === 'multiplier') m.progress = 0;
    }
  }

  update(dt: number, speed: number, multiplier: number, isSliding: boolean): void {
    const dist = speed * dt;
    this.runDistance += dist;
    for (const m of this.missions) {
      if (missionComplete(m)) continue;
      switch (m.type) {
        case 'singleRun':
          m.progress = Math.max(m.progress, this.runDistance);
          break;
        case 'sliding':
          m.progress += isSliding ? dist : 0;
          break;
        case 'multiplier':
          m.progress = Math.max(m.progress, multiplier);
          break;
      }
    }
  }

  coinPicked(): void {
    for (const m of this.missions) {
      if (m.type === 'pickup' && !missionComplete(m)) m.progress++;
    }
  }

  barrierJumped(): void {
    for (const m of this.missions) {
      if (m.type === 'barrierJump' && !missionComplete(m)) m.progress++;
    }
  }
}
