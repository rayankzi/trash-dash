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

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private music: { name: MusicName; source: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** Requested before the context existed; started on unlock. */
  private pendingMusic: MusicName | null = null;
  private musicLevel = 0.5;
  private muted = false;
  private paused = false;
  private hidden = false;
  private preparing: Promise<void> | null = null;
  private resuming: Promise<void> | null = null;
  private wind: { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private noise: AudioBuffer | null = null;
  onStateChange: () => void = () => {};

  get needsGesture(): boolean {
    return !this.muted && (!this.ctx || this.ctx.state !== 'running') && !this.paused && !this.hidden;
  }

  /** Decode during loading, including when autoplay is blocked. */
  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    this.ensureContext();
    if (!this.ctx) return Promise.resolve();
    const paths = [...Object.values(MUSIC), ...Object.values(SFX)];
    this.preparing = Promise.all(Array.from({ length: 3 }, async () => {
      while (paths.length) await this.load(paths.shift()!);
    })).then(() => {});
    return this.preparing;
  }

  private ensureContext(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.ctx.onstatechange = () => {
        // A queued resume can finish after pause/visibility changes.
        if ((this.paused || this.hidden) && this.ctx?.state === 'running') void this.ctx.suspend().catch(() => {});
        this.onStateChange();
      };
      this.createWind();
    } catch {
      // Audio may be unavailable; the game remains playable.
      this.ctx = null;
    }
    this.onStateChange();
  }

  /** Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    this.ensureContext();
    if (!this.ctx || this.paused || this.hidden) return;
    if (this.ctx.state !== 'running') this.resuming = this.ctx.resume().catch(() => this.onStateChange());
    if (this.pendingMusic) this.playMusic(this.pendingMusic, this.musicLevel);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
    this.onStateChange();
  }

  /** Freeze/thaw everything for the pause menu. */
  setSuspended(suspended: boolean): void {
    this.paused = suspended;
    this.syncSuspension();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.syncSuspension();
  }

  private syncSuspension(): void {
    if (!this.ctx) return;
    if (this.paused || this.hidden) {
      if (this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
    } else {
      this.unlock();
    }
  }

  private load(path: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(path);
    if (!pending) {
      const ctx = this.ctx!;
      pending = fetch(`assets/${path}`, { signal: AbortSignal.timeout(15_000) })
        .then((res) => {
          if (!res.ok) throw new Error(`Audio ${res.status}: ${path}`);
          return res.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => {
          this.buffers.delete(path);
          return null;
        });
      this.buffers.set(path, pending);
    }
    return pending;
  }

  play(name: SfxName, volume = 1, detune = 0, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.paused || this.hidden || this.muted) return;
    const master = this.master;
    const requestedAt = performance.now();
    void Promise.all([this.load(SFX[name]), this.resuming]).then(([buf]) => {
      // Never replay stale effects after a slow download or a pause.
      if (!buf || this.paused || this.hidden || this.muted || ctx.state !== 'running' || performance.now() - requestedAt > 250) return;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      const stereo = ctx.createStereoPanner();
      stereo.pan.value = Math.max(-1, Math.min(1, pan));
      gain.gain.value = volume;
      src.buffer = buf;
      src.detune.value = detune;
      src.connect(gain).connect(stereo).connect(master);
      src.onended = () => { src.disconnect(); gain.disconnect(); stereo.disconnect(); };
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
      source.onended = () => { source.disconnect(); gain.disconnect(); };
      source.start();
      this.music = { name, source, gain };
    });
  }

  /** A quiet filtered air bed grows with speed without downloading another asset. */
  private createWind(): void {
    const ctx = this.ctx!;
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 450;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(this.master!);
    source.start();
    this.wind = { source, gain, filter };
  }

  setMotion(speed: number, running: boolean, sliding = false): void {
    if (!this.ctx || !this.wind) return;
    const time = this.ctx.currentTime;
    this.wind.gain.gain.setTargetAtTime(running ? 0.018 + speed * 0.045 + (sliding ? 0.025 : 0) : 0, time, 0.25);
    this.wind.filter.frequency.setTargetAtTime(450 + speed * 1300, time, 0.25);
  }

  /** Soft, alternating footfalls and a heavier touchdown keep the runner grounded. */
  footstep(pan: number, landing = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted || this.paused || this.hidden || ctx.state !== 'running') return;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = landing ? 580 : 850;
    const gain = ctx.createGain();
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = Math.max(-1, Math.min(1, pan));
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(landing ? 0.2 : 0.09, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
    source.connect(filter).connect(gain).connect(stereo).connect(this.master);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); stereo.disconnect(); };
    source.start(now, Math.random());
    source.stop(now + 0.09);
  }
}

export const audio = new AudioManager();
