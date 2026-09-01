// Versioned JSON save in localStorage, replacing Unity's binary save.bin.
// The version ladder mirrors PlayerData.cs's incremental Read() pattern.

const SAVE_KEY = 'trash-dash-save';
const SAVE_VERSION = 1;

export interface HighscoreEntry {
  name: string;
  score: number;
}

import type { Mission } from './Missions';

export interface SaveData {
  version: number;
  coins: number;
  premium: number;
  consumables: Record<string, number>;
  characters: string[];
  usedCharacter: string;
  themes: string[];
  usedTheme: string;
  highscores: HighscoreEntry[];
  missions: Mission[];
  previousName: string;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
}

const DEFAULTS: SaveData = {
  version: SAVE_VERSION,
  coins: 0,
  premium: 0,
  consumables: {},
  characters: ['Cat'],
  usedCharacter: 'Cat',
  themes: ['day'],
  usedTheme: 'day',
  highscores: [],
  missions: [],
  previousName: 'Trash Cat',
  masterVolume: 1,
  musicVolume: 1,
  sfxVolume: 1,
};

class PlayerData {
  data: SaveData = structuredClone(DEFAULTS);

  load(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      // Version migration ladder: add `if (parsed.version < N)` steps on schema bumps.
      this.data = { ...structuredClone(DEFAULTS), ...parsed, version: SAVE_VERSION };
    } catch {
      this.data = structuredClone(DEFAULTS);
    }
  }

  save(): void {
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
  }

  /** Insert into the top-10 leaderboard; returns rank index or -1 if not placed. */
  insertScore(name: string, score: number): number {
    const entry = { name, score };
    const list = this.data.highscores;
    let index = list.findIndex((e) => e.score < score);
    if (index === -1) index = list.length;
    if (index >= 10) return -1;
    list.splice(index, 0, entry);
    list.length = Math.min(list.length, 10);
    return index;
  }
}

export const playerData = new PlayerData();
