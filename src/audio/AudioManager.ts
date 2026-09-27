// Web Audio SFX + music using the original OGG assets. Audio unlocks on the
// first user gesture (browser autoplay policy).

const SFX = {
  jump: 'audio/SFX/Cat/CatJump.ogg',
  hit: 'audio/SFX/Cat/CatInjured.ogg',
  death: 'audio/SFX/Cat/CatDeath.ogg',
  raccoonJump: 'audio/SFX/Raccoon/RaccoonJump.ogg',
  raccoonHit: 'audio/SFX/Raccoon/RaccoonHurt.ogg',
  raccoonDeath: 'audio/SFX/Raccoon/RaccoonDead.ogg',
  coin: 'audio/SFX/FishboneCollection.ogg',
  premium: 'audio/SFX/PremiumCurrency.ogg',
  powerup: 'audio/SFX/PowerUp.ogg',
  magnet: 'audio/SFX/Magnet.ogg',
  invincible: 'audio/SFX/Invincible.ogg',
  slide: 'audio/SFX/Slide.ogg',
  countdown: 'audio/SFX/4321.ogg',
  button: 'audio/SFX/ButtonPresses.ogg',
  claim: 'audio/SFX/MenuClaimMission.ogg',
  impactBin: 'audio/SFX/TrashCan.ogg',
  impactWheelieBin: 'audio/SFX/WheelieBin.ogg',
  impactCone: 'audio/SFX/TrafficCone.ogg',
  impactBarrier: 'audio/SFX/WoodenBarrier.ogg',
  impactRat: 'audio/SFX/Rat/RatHit.ogg',
  impactDog: 'audio/SFX/Dog/DogHit.ogg',
} as const;

const MUSIC = {
  menu: 'audio/Music/MenuTheme.ogg',
  death: 'audio/Music/DeathLoop.ogg',
} as const;

export type SfxName = keyof typeof SFX;
export type MusicName = keyof typeof MUSIC;

/** Impact sound for the obstacle the runner just hit. */
const IMPACTS: Record<string, SfxName> = {
  ObstacleBin: 'impactBin',
  ObstacleWheelyBin: 'impactWheelieBin',
  ObstacleRoadworksCone: 'impactCone',
  ObstacleRoadworksBarrier: 'impactBarrier',
  ObstacleHighBarrier: 'impactBarrier',
  ObstacleLowBarrier: 'impactBarrier',
  ObstacleRat: 'impactRat',
  ObstacleDog: 'impactDog',
};

export function impactSound(obstacleName: string): SfxName | undefined {
  return IMPACTS[obstacleName];
}

const MUSIC_FADE = 0.6;

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private music: { name: MusicName; source: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** Requested before the context existed; started on unlock. */
  private pendingMusic: MusicName | null = null;
  private musicLevel = 0.5;
  private muted = false;

  /** Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      for (const path of [...Object.values(SFX), ...Object.values(MUSIC)]) void this.load(path);
      if (this.pendingMusic) this.playMusic(this.pendingMusic, this.musicLevel);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  /** Freeze/thaw everything for the pause menu. */
  setSuspended(suspended: boolean): void {
    if (!this.ctx) return;
    if (suspended) {
      if (this.ctx.state === 'running') void this.ctx.suspend();
    } else if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private load(path: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(path);
    if (!pending) {
      const ctx = this.ctx!;
      pending = fetch(`assets/${path}`)
        .then((res) => res.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => null);
      this.buffers.set(path, pending);
    }
    return pending;
  }

  play(name: SfxName, volume = 1, detune = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const master = this.master;
    void this.load(SFX[name]).then((buf) => {
      if (!buf) return;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.buffer = buf;
      src.detune.value = detune;
      src.connect(gain).connect(master);
      src.start();
    });
  }

  /**
   * Crossfade to a looping music track (`null` fades out). Requests made
   * before the first gesture are remembered and start on unlock.
   */
  playMusic(name: MusicName | null, level = 0.5): void {
    this.pendingMusic = name;
    this.musicLevel = level;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;

    if (this.music && this.music.name === name) {
      this.music.gain.gain.setTargetAtTime(level, now, MUSIC_FADE / 3);
      return;
    }
    if (this.music) {
      const { source, gain } = this.music;
      gain.gain.setTargetAtTime(0, now, MUSIC_FADE / 3);
      source.stop(now + MUSIC_FADE * 2);
      this.music = null;
    }
    if (!name) return;

    const master = this.master;
    void this.load(MUSIC[name]).then((buf) => {
      // Superseded by another request while decoding.
      if (!buf || this.pendingMusic !== name || this.music) return;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(this.musicLevel, ctx.currentTime, MUSIC_FADE / 3);
      source.buffer = buf;
      source.loop = true;
      source.connect(gain).connect(master);
      source.start();
      this.music = { name, source, gain };
    });
  }
}

export const audio = new AudioManager();
