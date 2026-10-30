import { Game, optionsFromQuery } from './game/Game';
import { playerData } from './save/PlayerData';
import { THEMES } from './data/themes';
import { audio } from './audio/AudioManager';
import { WristCameraControls } from './input/WristCameraControls';
import { WristGameBridge } from './input/WristGameBridge';

async function boot(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const query = new URLSearchParams(location.search);
  playerData.load();
  const options = optionsFromQuery(query, playerData.data.usedTheme);
  const game = new Game(canvas, options);

  // Debug / test handle for browser-console inspection and Playwright.
  (window as unknown as Record<string, unknown>).__game = {
    game,
    audio,
    post: game.post,
    scene: game.scene,
    renderer: game.renderer,
    camera: game.camera,
    trackManager: game.trackManager,
    environment: game.environment,
    character: game.character,
    get controller() {
      return game.controller;
    },
    get collider() {
      return game.collider;
    },
    get consumables() {
      return game.consumables;
    },
    get director() {
      return game.director;
    },
    getState: () => game.currentState,
    themes: THEMES,
    test: { seed: query.get('seed'), theme: options.theme, segment: options.segment, mirror: options.mirror },
  };

  await game.load();
  const wrist = new WristGameBridge(game);
  new WristCameraControls(() => wrist);
}

boot().catch((err) => {
  console.error('boot failed', err);
  const root = document.getElementById('ui-root')!;
  root.textContent = '';
  const message = document.createElement('div');
  message.style.cssText = 'color:#fff;padding:2rem;font:700 1rem system-ui';
  message.textContent = `Failed to load: ${err}`;
  root.appendChild(message);
});
