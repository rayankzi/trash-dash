// Versioned JSON save in localStorage, replacing Unity's binary save.bin.
// The version ladder mirrors PlayerData.cs's incremental Read() pattern.
import type { Mission } from './Missions';

const SAVE_KEY = 'trash-dash-save';
const SAVE_VERSION = 2;

export interface HighscoreEntry {
  name: string;
  score: number;
}

export interface SaveData {
  version: number;
  coins: number;
  premium: number;
  characters: string[];
  usedCharacter: string;
  themes: string[];
  usedTheme: string;
  highscores: HighscoreEntry[];
  missions: Mission[];
  previousName: string;
  muted: boolean;
  /** Completed runs; the controls hint is shown for the first few. */
  runs: number;
}

const DEFAULTS: SaveData = {
  version: SAVE_VERSION,
  coins: 0,
  premium: 0,
  characters: ['Cat'],
  usedCharacter: 'Cat',
  themes: ['day'],
  usedTheme: 'day',
  highscores: [],
  missions: [],
  previousName: 'Trash Cat',
  muted: false,
  runs: 0,
};

type StoredSave = Partial<SaveData> & { masterVolume?: number };

class PlayerData {
  data: SaveData = structuredClone(DEFAULTS);

  load(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredSave;
      const data = structuredClone(DEFAULTS);
      // Copy only known keys so retired fields do not linger in the save.
      for (const key of Object.keys(DEFAULTS) as (keyof SaveData)[]) {
        if (parsed[key] !== undefined) (data as unknown as Record<string, unknown>)[key] = parsed[key];
      }
      // v1 -> v2: the unused volume sliders became a single mute switch, and
      // veterans have already seen the controls hint.
      if ((parsed.version ?? 1) < 2) {
        data.muted = parsed.masterVolume === 0;
        data.runs = parsed.highscores?.length ?? 0;
      }
      data.version = SAVE_VERSION;
      this.data = data;
    } catch {
      this.data = structuredClone(DEFAULTS);
    }
  }

  save(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
    } catch {
      // Private mode / quota: progress simply is not persisted this session.
    }
  }

  get bestScore(): number {
    return this.data.highscores[0]?.score ?? 0;
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
