import * as THREE from 'three';
import { TrackManager, type ThemeData } from './track/TrackManager';
import { Character } from './character/Character';
import { CharacterController } from './character/CharacterController';
import { CharacterCollider } from './character/CharacterCollider';
import { coinPool } from './coins/CoinPool';
import {
  ConsumableSystem,
  CONSUMABLES,
  preloadConsumables,
  spawnPowerupPickup,
  spawnPremiumPickup,
  type ConsumableType,
} from './consumables/Consumables';
import { UI } from './ui/UI';
import { playerData } from './save/PlayerData';
import { CHARACTERS } from './character/Character';
import { MissionProgress, topUpMissions, missionComplete, missionDescription } from './save/Missions';
import { audio } from './audio/AudioManager';
import { EnvironmentManager } from './environment/EnvironmentManager';
import { PostProcessing } from './rendering/PostProcessing';
import { GroundHaze } from './rendering/GroundHaze';
import { themeLook, UNITY_SUN_ROTATION } from './rendering/ThemeLook';
import { CharacterShadow } from './rendering/CharacterShadow';
import { SkyDome } from './rendering/SkyDome';
import {
  CAMERA_OFFSET,
  CAMERA_PITCH_DEG,
  CAMERA_FOV,
  CAMERA_FOV_SPEED_KICK,
  CAMERA_REFERENCE_ASPECT,
  CAMERA_LANE_FOLLOW,
  CAMERA_FOLLOW_DAMPING,
  CAMERA_SHAKE_TIME,
  CAMERA_SHAKE_AMOUNT,
  FOG_NEAR,
  FOG_FAR,
  COUNTDOWN_SECONDS,
  COUNTDOWN_SPEED,
} from './core/consts';
import themesJson from './data/themes.json';

type GameStateName = 'title' | 'countdown' | 'playing' | 'paused' | 'gameover';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function boot() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  /** Capped so a 3x phone display does not ask for nine times the pixels. */
  const pixelRatio = () => Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const theme = (themesJson as unknown as Record<string, { fogColor: [number, number, number] }>).day;
  const fogColor = new THREE.Color(...theme.fogColor);
  scene.background = fogColor;
  scene.fog = new THREE.Fog(fogColor, FOG_NEAR, FOG_FAR);

  // Main.unity lighting, without shadow maps (the original curved-unlit props
  // ignore it; Standard materials receive a restrained authored light rig).
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.copy(new THREE.Vector3(0, 0, -10).applyQuaternion(UNITY_SUN_ROTATION));
  sun.target.position.set(0, 0, 0);
  sun.castShadow = false;
  scene.add(ambient, sun, sun.target);

  /** Vertical FOV that holds the reference-aspect horizontal FOV on wide screens. */
  function verticalFov(baseFov: number, aspect: number): number {
    if (aspect <= CAMERA_REFERENCE_ASPECT) return baseFov;
    const halfBase = THREE.MathUtils.degToRad(baseFov) * 0.5;
    const halfHorizontal = Math.atan(Math.tan(halfBase) * CAMERA_REFERENCE_ASPECT);
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfHorizontal) / aspect));
  }

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, innerWidth / innerHeight, 0.3, 1000);
  camera.fov = verticalFov(CAMERA_FOV, camera.aspect);
  camera.updateProjectionMatrix();
  const post = new PostProcessing(renderer, scene, camera);
  addEventListener('resize', () => {
    // Dragging the window to a display of a different density changes the ratio
    // as well as the size, and the composer has to hear about both.
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    post.setPixelRatio(renderer.getPixelRatio());
    post.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.fov = verticalFov(CAMERA_FOV, camera.aspect);
    camera.updateProjectionMatrix();
  });

  playerData.load();
  const ui = new UI();

  const themeInfo = themesJson as unknown as Record<
    string,
    ThemeData & {
      name: string;
      cost: number;
      premiumCost: number;
      fogColor: [number, number, number];
    }
  >;
  const query = new URLSearchParams(location.search);
  const seedValue = Number(query.get('seed'));
  const random = Number.isFinite(seedValue) && query.has('seed') ? seededRandom(seedValue) : Math.random;
  const requestedTheme = query.get('theme');
  const initialTheme = requestedTheme && themeInfo[requestedTheme] ? requestedTheme : playerData.data.usedTheme;
  const mirrorValue = query.get('mirror');
  const forcedMirror = mirrorValue === '0' ? false : mirrorValue === '1' ? true : undefined;
  const trackManager = new TrackManager(scene, {
    random,
    segment: query.get('segment') ?? undefined,
    mirror: forcedMirror,
  });
  const environment = new EnvironmentManager(scene, trackManager, random);
  await coinPool.init(scene);

  const character = new Character();
  await character.load(playerData.data.usedCharacter);
  topUpMissions(playerData.data.missions);
  const missionProgress = new MissionProgress(playerData.data.missions);
  const controller = new CharacterController(character, trackManager);
  const collider = new CharacterCollider(controller, trackManager);
  controller.attachInput(document.body);

  await preloadConsumables();
  const consumables = new ConsumableSystem(trackManager, collider, controller.holder);
  trackManager.events.addEventListener('spawnPowerup', ((e: CustomEvent) => {
    spawnPowerupPickup(e.detail.segment, e.detail.pos, e.detail.rot);
  }) as EventListener);
  trackManager.events.addEventListener('spawnPremium', ((e: CustomEvent) => {
    spawnPremiumPickup(e.detail.segment, e.detail.pos, e.detail.rot);
  }) as EventListener);
  collider.events.addEventListener('powerup', ((e: CustomEvent) => {
    consumables.use(e.detail as ConsumableType);
  }) as EventListener);
  consumables.events.addEventListener('changed', () => {
    ui.updatePowerups(consumables.active.map((a) => ({ name: CONSUMABLES[a.type].name, timeLeft: a.timeLeft })));
  });

  // Camera parented to the character root, like Unity's Main Camera.
  const cameraRig = new THREE.Object3D();
  cameraRig.position.set(...CAMERA_OFFSET);
  cameraRig.rotation.x = THREE.MathUtils.degToRad(-CAMERA_PITCH_DEG);
  trackManager.characterRoot.add(cameraRig);
  cameraRig.add(camera);
  camera.rotation.y = Math.PI; // Unity camera looks down +Z; three.js cameras look down -Z.

  const ground = new GroundHaze(trackManager.characterRoot);
  const shadow = new CharacterShadow(trackManager.characterRoot);
  const skyDome = new SkyDome(trackManager.characterRoot);

  let state: GameStateName = 'title';
  let stateBeforePause: GameStateName = 'playing';
  let countdownLeft = 0;
  let shakeLeft = 0;

  await Promise.all([
    trackManager.begin(initialTheme),
    environment.setTheme(initialTheme, themeInfo[initialTheme]),
  ]);
  character.play('idle');

  function applyThemeLook(key: string): void {
    const look = themeLook(key);
    const color = new THREE.Color(look.fogColor);
    scene.background = color;
    (scene.fog as THREE.Fog).color = color;
    ambient.color.setHex(look.ambientColor);
    ambient.intensity = look.ambientIntensity;
    sun.color.setHex(look.sunColor);
    sun.intensity = look.sunIntensity;
    ground.setColor(look.groundColor);
    shadow.setOpacity(look.shadowOpacity);
    skyDome.setTheme(key);
    post.setTheme(key);
  }

  /** Time of day is a free presentation option, not a shop item. */
  async function selectTheme(key: string): Promise<void> {
    if (!themeInfo[key] || playerData.data.usedTheme === key) return;
    playerData.data.usedTheme = key;
    if (!playerData.data.themes.includes(key)) playerData.data.themes.push(key);
    playerData.save();
    await Promise.all([trackManager.begin(key), environment.setTheme(key, themeInfo[key])]);
    applyThemeLook(key);
    refreshLoadout();
    if (state === 'playing' || state === 'countdown' || state === 'paused') startRun();
  }

  function refreshLoadout(): void {
    const d = playerData.data;
    ui.renderPickers(
      Object.entries(CHARACTERS).map(([key, c]) => ({
        key,
        label: c.name,
        sub: d.characters.includes(key) ? '' : `${c.cost} 🐟`,
        owned: d.characters.includes(key),
        selected: d.usedCharacter === key,
      })),
      Object.entries(themeInfo).map(([key, t]) => ({
        key,
        label: t.name,
        sub: '',
        owned: true,
        selected: d.usedTheme === key,
      })),
      `🐟 ${d.coins}   ✨ ${d.premium}`,
      d.missions.map((m) => ({
        text: missionDescription(m),
        progress: `${Math.min(Math.floor(m.progress), m.max)}/${m.max}`,
      })),
      async (key) => {
        const def = CHARACTERS[key];
        if (!d.characters.includes(key)) {
          if (d.coins < def.cost) return;
          d.coins -= def.cost;
          d.characters.push(key);
        }
        d.usedCharacter = key;
        playerData.save();
        await character.load(key);
        controller.holder.add(character.root);
        character.play('idle');
        refreshLoadout();
      },
      (key) => void selectTheme(key)
    );
  }
  applyThemeLook(initialTheme);

  function startRun() {
    trackManager.reset();
    controller.reset();
    collider.reset();
    consumables.reset();
    ui.updatePowerups([]);
    state = 'countdown';
    countdownLeft = COUNTDOWN_SECONDS / COUNTDOWN_SPEED;
    shakeLeft = 0;
    cameraRig.position.set(...CAMERA_OFFSET);
    missionProgress.startRun();
    ui.showGame();
    character.play('start');
    audio.unlock();
    audio.setSuspended(false);
    void audio.playMusic(null);
    audio.play('countdown');
  }

  function pauseRun() {
    if (state !== 'playing' && state !== 'countdown') return;
    stateBeforePause = state;
    state = 'paused';
    controller.inputEnabled = false;
    audio.setSuspended(true);
    ui.showPause(trackManager.score, trackManager.worldDistance, collider.coins);
  }

  function resumeRun() {
    if (state !== 'paused') return;
    state = stateBeforePause;
    controller.inputEnabled = state === 'playing';
    audio.setSuspended(false);
    ui.showGame();
  }

  function quitToMenu() {
    state = 'title';
    trackManager.stopMove();
    controller.inputEnabled = false;
    audio.setSuspended(false);
    character.play('idle');
    ui.setCountdown('');
    ui.showTitle();
    refreshLoadout();
  }

  function endRun() {
    state = 'gameover';
    trackManager.stopMove();
    controller.inputEnabled = false;
    character.play('death');
    audio.play(isRaccoon() ? 'raccoonDeath' : 'death');
    void audio.playMusic('death');
    playerData.data.coins += collider.coins;
    playerData.data.premium += collider.premium;
    playerData.insertScore(playerData.data.previousName, trackManager.score);
    playerData.save();
    const best = playerData.data.highscores[0]?.score ?? trackManager.score;
    setTimeout(() => {
      if (state !== 'gameover') return;
      ui.showGameOver(trackManager.score, collider.coins, trackManager.worldDistance, best);
      const completed = playerData.data.missions
        .map((m, index) => ({ m, index }))
        .filter(({ m }) => missionComplete(m));
      ui.renderGameOverMeta(
        playerData.data.highscores,
        completed.map(({ m, index }) => ({ text: missionDescription(m), reward: m.reward, index })),
        (index) => {
          const m = playerData.data.missions[index];
          if (!m || !missionComplete(m)) return;
          playerData.data.premium += m.reward;
          playerData.data.missions.splice(index, 1);
          topUpMissions(playerData.data.missions);
          playerData.save();
        }
      );
      refreshLoadout();
    }, 1200);
  }

  ui.onStart = startRun;
  ui.onRestart = startRun;
  ui.onResume = resumeRun;
  ui.onQuit = quitToMenu;
  ui.onPauseRequest = pauseRun;
  refreshLoadout();
  ui.setReady();

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'p' && e.key !== 'P') return;
    e.preventDefault();
    if (state === 'paused') resumeRun();
    else pauseRun();
  });
  // A tab switch mid-run is an implicit pause rather than a free death.
  addEventListener('blur', () => pauseRun());

  collider.events.addEventListener('death', endRun);
  collider.events.addEventListener('coin', () => {
    missionProgress.coinPicked();
    audio.play('coin');
  });
  collider.events.addEventListener('barrierJumped', () => missionProgress.barrierJumped());
  collider.events.addEventListener('premium', () => audio.play('premium'));
  collider.events.addEventListener('powerup', () => audio.play('powerup'));
  collider.events.addEventListener('hit', () => {
    if (collider.lives > 0) {
      character.play('hit');
      ui.flashDamage();
      post.flash();
      shakeLeft = CAMERA_SHAKE_TIME;
    }
    audio.play(playerData.data.usedCharacter === 'Raccoon' ? 'raccoonHit' : 'hit');
  });
  // Invincibility over: drop the hit reaction and pick the run cycle back up.
  collider.events.addEventListener('recovered', () => {
    if (state !== 'playing' && state !== 'paused') return;
    if (controller.isJumping || controller.isSliding) return;
    character.play('run', 0.2);
  });

  const isRaccoon = () => playerData.data.usedCharacter === 'Raccoon';
  controller.onJump = () => audio.play(isRaccoon() ? 'raccoonJump' : 'jump');
  controller.onSlide = () => audio.play('slide');
  document.body.addEventListener('pointerdown', () => audio.unlock(), { once: false });

  // Debug handle for browser-console inspection during development.
  (window as unknown as Record<string, unknown>).__game = {
    THREE,
    post,
    scene,
    renderer,
    trackManager,
    environment,
    character,
    controller,
    collider,
    camera,
    consumables,
    pause: pauseRun,
    resume: resumeRun,
    setTheme: selectTheme,
    getState: () => state,
    test: {
      seed: query.get('seed'),
      theme: initialTheme,
      segment: query.get('segment'),
      mirror: forcedMirror,
    },
    themes: themeInfo,
  };

  const clock = new THREE.Clock();

  /** Speed-scaled field of view, lane-following drift and hit shake. */
  function updateCamera(dt: number): void {
    const targetFov = verticalFov(
      CAMERA_FOV + CAMERA_FOV_SPEED_KICK * trackManager.speedRatio,
      camera.aspect
    );
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
    }

    const follow = Math.min(1, dt * CAMERA_FOLLOW_DAMPING);
    const targetX = controller.holder.position.x * CAMERA_LANE_FOLLOW;
    const targetY = CAMERA_OFFSET[1] + controller.holder.position.y * 0.25;
    cameraRig.position.x += (targetX - cameraRig.position.x) * follow;
    cameraRig.position.y += (targetY - cameraRig.position.y) * follow;

    if (shakeLeft > 0) {
      shakeLeft = Math.max(0, shakeLeft - dt);
      const amount = CAMERA_SHAKE_AMOUNT * (shakeLeft / CAMERA_SHAKE_TIME);
      camera.position.set((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount, 0);
    } else if (camera.position.lengthSq() !== 0) {
      camera.position.set(0, 0, 0);
    }
  }

  const frame = () => {
    const dt = Math.min(clock.getDelta(), 0.1);

    if (state === 'countdown') {
      countdownLeft -= dt;
      ui.setCountdown(String(Math.max(1, Math.ceil(countdownLeft))));
      if (countdownLeft <= 0) {
        ui.setCountdown('');
        state = 'playing';
        trackManager.startMove();
        controller.inputEnabled = true;
        character.play('run');
      }
    }

    if (state === 'playing') {
      trackManager.update(dt);
      controller.update(dt);
      collider.update(dt);
      consumables.update(dt);
      missionProgress.update(dt, trackManager.speed, trackManager.multiplier, controller.isSliding);
      shadow.update(controller.holder.position.x, controller.holder.position.y);
      ui.updateHud(
        trackManager.score,
        trackManager.multiplier,
        collider.coins,
        collider.lives,
        trackManager.worldDistance,
        collider.premium
      );
      if (consumables.active.length) {
        ui.updatePowerups(consumables.active.map((a) => ({ name: CONSUMABLES[a.type].name, timeLeft: a.timeLeft })));
      }
    }

    if (state !== 'paused') {
      character.update(dt);
      updateCamera(dt);
    }
    post.render(dt);
  };
  renderer.setAnimationLoop(frame);
}

boot().catch((err) => {
  console.error('boot failed', err);
  document.getElementById('ui-root')!.innerHTML = `<div style="color:#fff;padding:2rem">Failed to load: ${err}</div>`;
});
