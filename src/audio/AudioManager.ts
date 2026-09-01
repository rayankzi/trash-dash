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
  slide: 'audio/SFX/Slide.ogg',
  countdown: 'audio/SFX/4321.ogg',
  button: 'audio/SFX/ButtonPresses.ogg',
} as const;

export type SfxName = keyof typeof SFX;

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private musicSource: AudioBufferSourceNode | null = null;
  sfxVolume = 1;
  musicVolume = 0.5;

  /** Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      // Preload everything lazily once unlocked.
      for (const path of Object.values(SFX)) void this.load(path);
      void this.load('audio/Music/MenuTheme.ogg');
      void this.load('audio/Music/DeathLoop.ogg');
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
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

  private async load(path: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const cached = this.buffers.get(path);
    if (cached) return cached;
    try {
      const res = await fetch(`assets/${path}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(path, buf);
      return buf;
    } catch {
      return null;
    }
  }

  play(name: SfxName): void {
    if (!this.ctx) return;
    void this.load(SFX[name]).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = this.sfxVolume;
      src.buffer = buf;
      src.connect(gain).connect(this.ctx.destination);
      src.start();
    });
  }

  async playMusic(track: 'menu' | 'death' | null): Promise<void> {
    if (!this.ctx) return;
    this.musicSource?.stop();
    this.musicSource = null;
    if (!track) return;
    const path = track === 'menu' ? 'audio/Music/MenuTheme.ogg' : 'audio/Music/DeathLoop.ogg';
    const buf = await this.load(path);
    if (!buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    gain.gain.value = this.musicVolume;
    src.buffer = buf;
    src.loop = true;
    src.connect(gain).connect(this.ctx.destination);
    src.start();
    this.musicSource = src;
  }
}

export const audio = new AudioManager();
