import * as THREE from 'three';
import { TrackManager } from '../track/TrackManager';
import { Character, CHARACTERS } from '../character/Character';
import { CharacterController } from '../character/CharacterController';
import { CharacterCollider } from '../character/CharacterCollider';
import { coinPool } from '../coins/CoinPool';
import {
  ConsumableSystem,
  CONSUMABLES,
  preloadConsumables,
  spawnPowerupPickup,
  spawnPremiumPickup,
  type ConsumableType,
} from '../consumables/Consumables';
import { UI, type HudState } from '../ui/UI';
import { playerData } from '../save/PlayerData';
import { MissionProgress, topUpMissions, missionComplete, missionDescription, type Mission } from '../save/Missions';
import { audio, impactSound } from '../audio/AudioManager';
import { EnvironmentManager } from '../environment/EnvironmentManager';
import { PostProcessing } from '../rendering/PostProcessing';
import { GroundHaze } from '../rendering/GroundHaze';
import { themeLook, UNITY_SUN_ROTATION } from '../rendering/ThemeLook';
import { CharacterShadow } from '../rendering/CharacterShadow';
import { SkyDome } from '../rendering/SkyDome';
import { Effects } from '../rendering/Effects';
import { ShieldAura } from '../rendering/ShieldAura';
import { characterLight } from '../rendering/CurvedMaterial';
import { CameraDirector } from './CameraDirector';
import { seededRandom } from '../core/random';
import { THEMES, isThemeKey, type ThemeKey } from '../data/themes';
import { CAMERA_FOV, COUNTDOWN_SECONDS, COUNTDOWN_SPEED, FOG_FAR, FOG_NEAR, MAX_LIVES } from '../core/consts';

export type GameState = 'loading' | 'title' | 'countdown' | 'playing' | 'paused' | 'gameover';

const COUNTDOWN_TIME = COUNTDOWN_SECONDS / COUNTDOWN_SPEED;
/** How long "Go!" stays up once the run has started. */
const GO_TIME = 0.6;
/** Death animation plays out before the results card slides in. */
const GAME_OVER_DELAY = 1.3;
/** Coins picked within this window of each other raise the pickup pitch. */
const COIN_STREAK_WINDOW = 0.45;
/** Early runs show the controls reminder. */
const HINT_RUNS = 3;

const THEME_NAMES: Record<ThemeKey, string> = { day: 'Day', night: 'Night' };

export interface GameOptions {
  random: () => number;
  theme: ThemeKey;
  segment?: string;
  mirror?: boolean;
}

/** Reads the deterministic test hooks (`?seed=&theme=&segment=&mirror=`). */
export function optionsFromQuery(query: URLSearchParams, savedTheme: string): GameOptions {
  const seed = Number(query.get('seed'));
  const theme = query.get('theme');
  const mirror = query.get('mirror');
  return {
    random: query.has('seed') && Number.isFinite(seed) ? seededRandom(seed) : Math.random,
    theme: isThemeKey(theme) ? theme : isThemeKey(savedTheme) ? savedTheme : 'day',
    segment: query.get('segment') ?? undefined,
    mirror: mirror === '0' ? false : mirror === '1' ? true : undefined,
  };
}

/**
 * Owns the scene, the per-frame loop and the run state machine
 * (loading → title → countdown → playing ⇄ paused → gameover), and wires the
 * gameplay systems' events to audio, effects, camera and UI.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.3, 1000);
  readonly post: PostProcessing;
  readonly ui = new UI();
  readonly trackManager: TrackManager;
  readonly environment: EnvironmentManager;
  readonly character = new Character();
  controller!: CharacterController;
  collider!: CharacterCollider;
  consumables!: ConsumableSystem;
  director!: CameraDirector;
  private effects!: Effects;
  private shield!: ShieldAura;
  private ground!: GroundHaze;
  private shadow!: CharacterShadow;
  private skyDome!: SkyDome;
  private missionProgress!: MissionProgress;
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly timer = new THREE.Timer();

  private state: GameState = 'loading';
  private stateBeforePause: GameState = 'playing';
  private themeKey: ThemeKey;
  private countdownLeft = 0;
  private goLeft = 0;
  private gameOverLeft = 0;
  private coinStreak = 0;
  private lastCoinTime = -Infinity;
  private runTime = 0;
  private bestAtStart = 0;
  private announcedBest = false;
  private lastMultiplier = 1;
  private missionsDoneAtStart = new Set<number>();
  private lastPowerup: ConsumableType | null = null;
  /** Completed missions offered on the results card, indexed by claim id. */
  private claimable: Mission[] = [];
  private readonly feet = new THREE.Vector3();
  private readonly hudState: HudState = {
    score: 0, multiplier: 1, coins: 0, premium: 0, lives: MAX_LIVES, maxLives: MAX_LIVES, distance: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly options: GameOptions
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera.aspect = innerWidth / innerHeight;
    this.themeKey = options.theme;

    const fog = new THREE.Color(...THEMES[this.themeKey].fogColor);
    this.scene.background = fog;
    this.scene.fog = new THREE.Fog(fog, FOG_NEAR, FOG_FAR);
    // Main.unity's light rig. The curved-unlit world ignores it; only the few
    // Standard materials react. The runner has its own light (characterLight).
    this.sun.position.set(0, 0, -10).applyQuaternion(UNITY_SUN_ROTATION);
    this.scene.add(this.ambient, this.sun, this.sun.target);

    this.post = new PostProcessing(this.renderer, this.scene, this.camera);
    this.trackManager = new TrackManager(this.scene, {
      random: options.random,
      segment: options.segment,
      mirror: options.mirror,
    });
    this.environment = new EnvironmentManager(this.scene, this.trackManager, options.random);

    // Time spent in a hidden tab is not simulated on return.
    this.timer.connect(document);
    addEventListener('resize', () => this.resize());
  }

  private pixelRatio(): number {
    // Capped so a 3x phone display does not ask for nine times the pixels.
    return Math.min(devicePixelRatio, 2);
  }

  private resize(): void {
    // Dragging to a display of another density changes the ratio as well as
    // the size, and the composer has to hear about both.
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setPixelRatio(this.renderer.getPixelRatio());
    this.post.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  get currentState(): GameState {
    return this.state;
  }

  // ------------------------------------------------------------------ boot

  /** Expects `playerData` to be loaded already (boot reads the saved theme). */
  async load(): Promise<void> {
    // Models, textures and animation clips all go through the default
    // manager; track it so the title never shows untextured props.
    const manager = THREE.DefaultLoadingManager;
    let busy = false;
    let drained: (() => void) | null = null;
    manager.onStart = () => (busy = true);
    manager.onProgress = (_url, loaded, total) => this.ui.setLoadingProgress(total ? loaded / total : 0);
    manager.onLoad = () => {
      busy = false;
      drained?.();
    };

    audio.setMuted(playerData.data.muted);
    this.ui.setMuted(playerData.data.muted);
    topUpMissions(playerData.data.missions);
    this.missionProgress = new MissionProgress(playerData.data.missions);

    await Promise.all([coinPool.init(this.scene), this.character.load(playerData.data.usedCharacter), preloadConsumables()]);

    const runner = this.trackManager.characterRoot;
    this.controller = new CharacterController(this.character, this.trackManager);
    this.collider = new CharacterCollider(this.controller, this.trackManager);
    this.consumables = new ConsumableSystem(this.trackManager, this.collider, this.controller.holder);
    this.director = new CameraDirector(this.camera, runner, this.controller.holder);
    this.ground = new GroundHaze(runner);
    this.shadow = new CharacterShadow(runner);
    this.skyDome = new SkyDome(runner);
    this.effects = new Effects(this.scene);
    this.shield = new ShieldAura(this.controller.holder);

    await Promise.all([
      this.trackManager.begin(this.themeKey),
      this.environment.setTheme(this.themeKey, THEMES[this.themeKey]),
    ]);
    this.applyThemeLook();
    this.character.play('idle');
    // Textures requested while the track was built may still be in flight.
    if (busy) await new Promise<void>((resolve) => (drained = resolve));
    manager.onStart = manager.onLoad = () => {};

    this.bindGameplayEvents();
    this.bindInput();
    this.bindUi();

    this.state = 'title';
    this.refreshLoadout();
    this.ui.setReady();
    this.ui.showTitle();
    audio.playMusic('menu', 0.45);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ wiring

  private bindGameplayEvents(): void {
    const track = this.trackManager.events;
    track.addEventListener('spawnPowerup', ((e: CustomEvent) => {
      spawnPowerupPickup(e.detail.segment, e.detail.pos, e.detail.rot, this.options.random);
    }) as EventListener);
    track.addEventListener('spawnPremium', ((e: CustomEvent) => {
      spawnPremiumPickup(e.detail.segment, e.detail.pos, e.detail.rot);
    }) as EventListener);
    track.addEventListener('recenter', ((e: CustomEvent) => {
      this.effects.translate(e.detail.offset);
    }) as EventListener);

    const collider = this.collider.events;
    collider.addEventListener('coin', ((e: CustomEvent) => {
      this.missionProgress.coinPicked();
      this.effects.coin(e.detail.position);
      // Chained pickups climb in pitch, like a combo.
      this.coinStreak = this.runTime - this.lastCoinTime < COIN_STREAK_WINDOW ? Math.min(this.coinStreak + 1, 12) : 0;
      this.lastCoinTime = this.runTime;
      audio.play('coin', 0.7, this.coinStreak * 50);
    }) as EventListener);
    collider.addEventListener('premium', ((e: CustomEvent) => {
      this.effects.premium(e.detail.position);
      audio.play('premium');
      this.ui.toast('+1 Sardine', 'gold');
    }) as EventListener);
    collider.addEventListener('powerup', ((e: CustomEvent) => {
      const type = e.detail.type as ConsumableType;
      const def = CONSUMABLES[type];
      this.consumables.use(type);
      this.effects.powerup(e.detail.position, def.color);
      audio.play('powerup');
      if (type === 'magnet') audio.play('magnet', 0.8);
      if (type === 'invincibility') audio.play('invincible', 0.8);
      if (type !== 'extralife') this.lastPowerup = type;
      this.ui.toast(def.name, 'powerup', def.color);
    }) as EventListener);
    collider.addEventListener('barrierJumped', () => this.missionProgress.barrierJumped());
    collider.addEventListener('hit', ((e: CustomEvent) => {
      const { obstacle, position } = e.detail as { obstacle: THREE.Object3D; position: THREE.Vector3 };
      const impact = impactSound(obstacle.name);
      if (impact) audio.play(impact, 0.9);
      audio.play(this.isRaccoon ? 'raccoonHit' : 'hit');
      this.effects.hit(position);
      this.director.shake();
      this.post.flash();
      if (this.collider.lives > 0) this.character.play('hit');
    }) as EventListener);
    collider.addEventListener('death', () => this.endRun());
    // Invincibility over: drop the hit reaction and pick the run cycle back up.
    collider.addEventListener('recovered', () => {
      if (this.state !== 'playing' && this.state !== 'paused') return;
      if (this.controller.isJumping || this.controller.isSliding) return;
      this.character.play('run', 0.2);
    });

    this.controller.onJump = () => audio.play(this.isRaccoon ? 'raccoonJump' : 'jump');
    this.controller.onSlide = () => {
      audio.play('slide');
      this.effects.dustBurst(this.feetPosition(), themeLook(this.themeKey).dustColor, 0.8);
    };
    this.controller.onLand = () => {
      if (this.state === 'playing') this.effects.dustBurst(this.feetPosition(), themeLook(this.themeKey).dustColor);
    };
  }

  private bindInput(): void {
    this.controller.attachInput(document.body);
    // Browsers only allow audio after a gesture.
    const unlock = () => audio.unlock();
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const key = e.key;
      if (key === 'Escape' || key === 'p' || key === 'P') {
        e.preventDefault();
        if (this.state === 'paused') this.resumeRun();
        else this.pauseRun();
      } else if (key === 'm' || key === 'M') {
        this.toggleMute();
      } else if (key === ' ' || key === 'Enter') {
        // Space/Enter start from menus; a focused button handles Enter itself.
        const focused = document.activeElement;
        if (key === 'Enter' && focused instanceof HTMLButtonElement) return;
        // Otherwise the focused button would also "click" on keyup, restarting
        // the countdown or picking a character mid-run.
        if (focused instanceof HTMLElement) focused.blur();
        if (this.state === 'title' || this.state === 'gameover') {
          e.preventDefault();
          this.startRun();
        } else if (this.state === 'paused') {
          e.preventDefault();
          this.resumeRun();
        }
      }
    });
    // Leaving the tab mid-run is an implicit pause rather than a free death.
    addEventListener('blur', () => this.pauseRun());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseRun();
    });
  }

  private bindUi(): void {
    const ui = this.ui;
    ui.onStart = () => this.startRun();
    ui.onRestart = () => this.startRun();
    ui.onResume = () => this.resumeRun();
    ui.onQuit = () => this.quitToMenu();
    ui.onPauseRequest = () => this.pauseRun();
    ui.onToggleMute = () => this.toggleMute();
    ui.onButton = () => audio.play('button', 0.5);
    ui.onPickTheme = (key) => void this.selectTheme(key);
    ui.onPickCharacter = (key) => void this.selectCharacter(key);
    ui.onClaim = (index) => {
      const mission = this.claimable[index];
      const position = playerData.data.missions.indexOf(mission);
      if (!mission || position < 0 || !missionComplete(mission)) return;
      playerData.data.premium += mission.reward;
      playerData.data.missions.splice(position, 1);
      topUpMissions(playerData.data.missions);
      playerData.save();
      audio.play('claim');
      this.refreshLoadout();
    };
  }

  private get isRaccoon(): boolean {
    return playerData.data.usedCharacter === 'Raccoon';
  }

  private feetPosition(): THREE.Vector3 {
    return this.controller.holder.getWorldPosition(this.feet);
  }

  private toggleMute(): void {
    playerData.data.muted = !playerData.data.muted;
    playerData.save();
    audio.setMuted(playerData.data.muted);
    this.ui.setMuted(playerData.data.muted);
  }

  // ------------------------------------------------------------------ loadout

  private refreshLoadout(): void {
    const d = playerData.data;
    this.ui.renderLoadout({
      coins: d.coins,
      premium: d.premium,
      best: playerData.bestScore,
      characters: Object.entries(CHARACTERS).map(([key, c]) => ({
        key,
        name: c.name,
        icon: c.icon,
        cost: c.cost,
        owned: d.characters.includes(key),
        selected: d.usedCharacter === key,
        affordable: d.coins >= c.cost,
      })),
      themes: (Object.keys(THEMES) as ThemeKey[]).map((key) => ({
        key,
        name: THEME_NAMES[key],
        icon: key,
        selected: this.themeKey === key,
      })),
      missions: d.missions.map((m) => ({
        text: missionDescription(m),
        progress: m.progress,
        max: m.max,
        reward: m.reward,
      })),
    });
  }

  private async selectCharacter(key: string): Promise<void> {
    const def = CHARACTERS[key];
    const d = playerData.data;
    if (!def || d.usedCharacter === key) return;
    if (!d.characters.includes(key)) {
      if (d.coins < def.cost) {
        this.ui.denyPurchase(key, def.cost - d.coins);
        return;
      }
      d.coins -= def.cost;
      d.characters.push(key);
      audio.play('premium');
    }
    d.usedCharacter = key;
    playerData.save();
    await this.character.load(key);
    this.controller.holder.add(this.character.root);
    this.character.play('idle');
    this.refreshLoadout();
  }

  /** Time of day is a free presentation option, not a shop item. */
  private async selectTheme(key: string): Promise<void> {
    if (!isThemeKey(key) || this.themeKey === key) return;
    this.themeKey = key;
    playerData.data.usedTheme = key;
    if (!playerData.data.themes.includes(key)) playerData.data.themes.push(key);
    playerData.save();
    this.refreshLoadout();
    await Promise.all([this.trackManager.begin(key), this.environment.setTheme(key, THEMES[key])]);
    this.applyThemeLook();
    this.effects.clear();
    if (this.state === 'playing' || this.state === 'countdown' || this.state === 'paused') this.startRun();
  }

  private applyThemeLook(): void {
    const look = themeLook(this.themeKey);
    const color = new THREE.Color(look.fogColor);
    this.scene.background = color;
    const fog = this.scene.fog as THREE.Fog;
    const theme = THEMES[this.themeKey];
    fog.color.copy(color);
    fog.near = theme.fogStart ?? FOG_NEAR;
    fog.far = theme.fogEnd ?? FOG_FAR;
    this.ambient.color.setHex(look.ambientColor);
    this.ambient.intensity = look.ambientIntensity;
    this.sun.color.setHex(look.sunColor);
    this.sun.intensity = look.sunIntensity;
    this.ground.setColor(look.groundColor);
    this.shadow.setOpacity(look.shadowOpacity);
    this.skyDome.setTheme(this.themeKey);
    this.post.setTheme(this.themeKey);
    characterLight.lightColor.value.setRGB(...look.character.light);
    characterLight.shadowColor.value.setRGB(...look.character.shadow);
    characterLight.rimColor.value.setRGB(...look.character.rim);
    characterLight.rimStrength.value = look.character.rimStrength;
  }

  // ------------------------------------------------------------------ run flow

  private resetRunState(): void {
    this.trackManager.reset();
    this.controller.reset();
    this.collider.reset();
    this.consumables.reset();
    this.effects.clear();
    this.lastPowerup = null;
    this.coinStreak = 0;
    this.lastCoinTime = -Infinity;
    this.runTime = 0;
    this.lastMultiplier = 1;
    this.syncHud();
    this.ui.resetHud(this.hudState);
  }

  startRun(): void {
    if (this.state === 'loading') return;
    this.resetRunState();
    this.state = 'countdown';
    this.countdownLeft = COUNTDOWN_TIME;
    this.goLeft = 0;
    this.bestAtStart = playerData.bestScore;
    this.announcedBest = false;
    this.missionsDoneAtStart = new Set(
      playerData.data.missions.flatMap((m, i) => (missionComplete(m) ? [i] : []))
    );
    this.missionProgress.startRun();
    this.director.setShot('follow', 1.3);
    this.ui.showGame();
    if (playerData.data.runs < HINT_RUNS) this.ui.showHint(6);
    this.character.play('start');
    audio.unlock();
    audio.setSuspended(false);
    audio.playMusic('menu', 0.3);
    audio.play('countdown');
  }

  pauseRun(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.stateBeforePause = this.state;
    this.state = 'paused';
    this.controller.inputEnabled = false;
    audio.setSuspended(true);
    this.ui.showPause(this.trackManager.score, this.trackManager.worldDistance, this.collider.coins);
  }

  resumeRun(): void {
    if (this.state !== 'paused') return;
    this.state = this.stateBeforePause;
    this.controller.inputEnabled = this.state === 'playing';
    audio.setSuspended(false);
    this.ui.showGame();
  }

  quitToMenu(): void {
    if (this.state === 'loading') return;
    this.resetRunState();
    this.state = 'title';
    this.controller.inputEnabled = false;
    audio.setSuspended(false);
    audio.playMusic('menu', 0.45);
    this.character.play('idle');
    this.director.setShot('menu', 1.2);
    this.ui.setCountdown('');
    this.ui.hideHint();
    this.refreshLoadout();
    this.ui.showTitle();
  }

  private endRun(): void {
    this.state = 'gameover';
    this.gameOverLeft = GAME_OVER_DELAY;
    this.trackManager.stopMove();
    this.controller.inputEnabled = false;
    this.character.play('death');
    this.director.setShot('death', 1.4);
    this.ui.hideHint();
    audio.play(this.isRaccoon ? 'raccoonDeath' : 'death');
    audio.playMusic('death', 0.4);
  }

  private showResults(): void {
    const d = playerData.data;
    const score = this.trackManager.score;
    d.coins += this.collider.coins;
    d.premium += this.collider.premium;
    d.runs += 1;
    const rank = playerData.insertScore(d.previousName, score);
    playerData.save();
    this.ui.showGameOver({
      score,
      coins: this.collider.coins,
      premium: this.collider.premium,
      distance: this.trackManager.worldDistance,
      best: playerData.bestScore,
      newBest: score > 0 && score > this.bestAtStart,
      leaderboard: d.highscores,
      rank,
      claims: (this.claimable = d.missions.filter(missionComplete)).map((m, index) => ({
        text: missionDescription(m),
        reward: m.reward,
        index,
      })),
    });
    this.refreshLoadout();
  }

  // ------------------------------------------------------------------ frame

  private syncHud(): void {
    const s = this.hudState;
    s.score = this.trackManager.score;
    s.multiplier = this.trackManager.multiplier;
    s.coins = this.collider.coins;
    s.premium = this.collider.premium;
    s.lives = this.collider.lives;
    s.distance = this.trackManager.worldDistance;
  }

  private updateCountdown(dt: number): void {
    this.countdownLeft -= dt;
    const step = COUNTDOWN_TIME / 3;
    this.ui.setCountdown(String(Math.max(1, Math.ceil(this.countdownLeft / step))));
    if (this.countdownLeft > 0) return;
    this.state = 'playing';
    this.goLeft = GO_TIME;
    this.ui.setCountdown('Go!');
    this.trackManager.startMove();
    this.controller.inputEnabled = true;
    this.character.play('run');
  }

  private updatePlaying(dt: number): void {
    this.runTime += dt;
    if (this.goLeft > 0) {
      this.goLeft -= dt;
      if (this.goLeft <= 0) this.ui.setCountdown('');
    }
    this.trackManager.update(dt);
    this.controller.update(dt);
    this.collider.update(dt);
    this.consumables.update(dt);
    this.missionProgress.update(dt, this.trackManager.speed, this.trackManager.multiplier, this.controller.isSliding);

    this.syncHud();
    this.ui.updateHud(this.hudState);
    this.ui.updatePowerups(
      this.consumables.active.map((a) => ({
        type: a.type,
        timeLeft: a.timeLeft,
        duration: a.duration,
        color: CONSUMABLES[a.type].color,
      }))
    );
    this.announceMilestones();

    // Footstep dust while grounded, a denser stream while sliding.
    const grounded = this.controller.holder.position.y < 0.05;
    if (grounded && this.state === 'playing') {
      this.effects.runDust(
        this.feetPosition(),
        themeLook(this.themeKey).dustColor,
        this.trackManager.speedRatio,
        this.controller.isSliding,
        dt
      );
    }
    for (const { type } of this.consumables.active) {
      const chest = this.feetPosition().setY(this.feet.y + 0.9);
      this.effects.aura(chest, CONSUMABLES[type].color, type === 'magnet', dt);
    }
  }

  private announceMilestones(): void {
    const multiplier = this.trackManager.multiplier;
    if (multiplier > this.lastMultiplier) this.ui.toast(`Speed up! x${multiplier}`, 'gold');
    this.lastMultiplier = multiplier;

    if (!this.announcedBest && this.bestAtStart > 0 && this.trackManager.score > this.bestAtStart) {
      this.announcedBest = true;
      this.ui.toast('New best!', 'gold');
    }
    playerData.data.missions.forEach((m, i) => {
      if (missionComplete(m) && !this.missionsDoneAtStart.has(i)) {
        this.missionsDoneAtStart.add(i);
        this.ui.toast('Mission complete!', 'info');
        audio.play('claim', 0.6);
      }
    });
  }

  /** Rim-light tint for the active powerup, pulsing gently. */
  private updatePowerupLook(dt: number, time: number): void {
    const active = this.lastPowerup && this.consumables.isActive(this.lastPowerup)
      ? this.lastPowerup
      : this.consumables.active.find((a) => a.type !== 'extralife')?.type;
    const target = active ? 0.5 + Math.sin(time * 6) * 0.2 : 0;
    if (active) characterLight.rimBoostColor.value.setHex(CONSUMABLES[active].color);
    const boost = characterLight.rimBoost;
    boost.value += (target - boost.value) * Math.min(1, dt * 8);
    this.shield.update(dt, this.consumables.timeLeft('invincibility'), this.controller.isSliding);
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const time = this.timer.getElapsed();

    switch (this.state) {
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'playing':
        this.updatePlaying(dt);
        break;
      case 'gameover':
        if (this.gameOverLeft > 0) {
          this.gameOverLeft -= dt;
          // Let a mid-air death settle onto the street.
          this.controller.update(dt);
          if (this.gameOverLeft <= 0) this.showResults();
        }
        break;
    }

    if (this.state !== 'paused') {
      this.character.update(dt);
      this.director.update(dt, this.trackManager.speedRatio);
      this.effects.trackRunner(this.feetPosition(), dt);
      this.effects.update(dt, this.renderer, this.camera);
      this.updatePowerupLook(dt, time);
    }
    this.shadow.update(this.controller.holder.position.x, this.controller.holder.position.y);
    const speed = this.state === 'playing' ? THREE.MathUtils.smoothstep(this.trackManager.speedRatio, 0.3, 1) : 0;
    this.post.setSpeed(speed);
    this.post.render(this.state === 'paused' ? 0 : dt);
  }
}
