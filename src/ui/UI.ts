import './ui.css';

const ICONS = 'assets/ui/icons';
const icon = (name: string, className = 'icon') =>
  `<img class="${className}" src="${ICONS}/${name}.png" alt="" draggable="false">`;

export interface CharacterCard {
  key: string;
  name: string;
  icon: string;
  cost: number;
  owned: boolean;
  selected: boolean;
  affordable: boolean;
}

export interface ThemeCard {
  key: string;
  name: string;
  icon: string;
  selected: boolean;
}

export interface MissionView {
  text: string;
  progress: number;
  max: number;
  reward: number;
}

export interface LoadoutView {
  coins: number;
  premium: number;
  best: number;
  characters: CharacterCard[];
  themes: ThemeCard[];
  missions: MissionView[];
}

export interface HudState {
  score: number;
  multiplier: number;
  coins: number;
  premium: number;
  lives: number;
  maxLives: number;
  distance: number;
}

export interface PowerupView {
  type: string;
  timeLeft: number;
  duration: number;
  color: number;
}

export interface RunResult {
  score: number;
  coins: number;
  premium: number;
  distance: number;
  best: number;
  newBest: boolean;
  leaderboard: { name: string; score: number }[];
  /** Index of this run in the leaderboard, or -1. */
  rank: number;
  claims: { text: string; reward: number; index: number }[];
}

const format = (value: number) => Math.floor(value).toLocaleString('en-US');

function el<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`UI element missing: ${selector}`);
  return found;
}

/** Restart a one-shot CSS animation class on an element. */
function retrigger(element: HTMLElement, className: string): void {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

/**
 * HTML/CSS overlay: loading, title/loadout, HUD, countdown, pause and game
 * over. Every per-frame update is diffed against the last value written, so
 * a steady run touches the DOM only when a number actually changes.
 */
export class UI {
  private readonly root = el(document, '#ui-root');
  private readonly hud: HTMLElement;
  private readonly screens: Record<'loading' | 'title' | 'pause' | 'gameOver', HTMLElement>;
  private readonly hudRefs: {
    score: HTMLElement;
    multiplier: HTMLElement;
    distance: HTMLElement;
    coins: HTMLElement;
    coinPill: HTMLElement;
    premium: HTMLElement;
    premiumPill: HTMLElement;
    lives: HTMLElement;
  };
  private readonly countdown: HTMLElement;
  private readonly powerupZone: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly progressBar: HTMLElement;
  private last: Partial<HudState> = {};
  private powerupEls = new Map<string, { root: HTMLElement; ring: HTMLElement; label: HTMLElement; shown: number }>();
  private hintTimer = 0;
  private muted = false;

  onStart: () => void = () => {};
  onRestart: () => void = () => {};
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onPauseRequest: () => void = () => {};
  onPickCharacter: (key: string) => void = () => {};
  onPickTheme: (key: string) => void = () => {};
  onToggleMute: () => void = () => {};
  onClaim: (index: number) => void = () => {};
  /** Any button press, for the click sound. */
  onButton: () => void = () => {};

  constructor() {
    this.root.innerHTML = `
      <div class="hud">
        <div class="hud-bar">
          <div class="hud-left">
            <div class="hud-lives"></div>
            <div class="pill coin-pill">${icon('fishbone', 'pill-icon')}<span class="hud-coins">0</span></div>
            <div class="pill premium-pill hidden">${icon('premium', 'pill-icon')}<span class="hud-premium">0</span></div>
          </div>
          <div class="hud-right">
            <div class="score-box">
              <div class="score">0</div>
              <div class="score-meta"><span class="multiplier">x1</span><span class="distance">0 m</span></div>
            </div>
            <button class="icon-button pause-button" data-action="pause" aria-label="Pause">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>
            </button>
          </div>
        </div>
        <div class="powerup-zone"></div>
        <div class="toasts"></div>
        <div class="countdown"></div>
        <div class="hint">
          <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> change lane</span>
          <span><kbd>&uarr;</kbd> jump</span>
          <span><kbd>&darr;</kbd> slide</span>
          <span class="touch-only">Swipe to move</span>
        </div>
      </div>

      <div class="screen loading visible">
        <img class="loading-logo" src="${ICONS}/logo.png" alt="Trash Dash">
        <div class="progress"><div class="progress-fill"></div></div>
        <div class="loading-label">Loading the alley&hellip;</div>
      </div>

      <div class="screen title">
        <div class="title-brand">
          <img class="title-logo" src="${ICONS}/logo.png" alt="Trash Dash">
        </div>
        <div class="card loadout">
          <div class="wallet-row">
            <div class="pill">${icon('fishbone', 'pill-icon')}<span data-bind="coins">0</span></div>
            <div class="pill">${icon('premium', 'pill-icon')}<span data-bind="premium">0</span></div>
            <div class="pill best">${icon('trophy', 'pill-icon')}<span data-bind="best">0</span></div>
            <button class="icon-button mute-button" data-action="mute" aria-label="Toggle sound"></button>
          </div>
          <section>
            <h2>Runner</h2>
            <div class="choice-grid characters"></div>
            <div class="purchase-message" role="status"></div>
          </section>
          <section>
            <h2>Time of day</h2>
            <div class="choice-grid themes"></div>
          </section>
          <section>
            <h2>Missions</h2>
            <div class="missions"></div>
          </section>
          <button class="primary run-button" data-action="start" disabled>Loading&hellip;</button>
          <div class="key-hint">Press <kbd>Space</kbd> to run</div>
        </div>
      </div>

      <div class="screen pause">
        <div class="card compact">
          <button class="icon-button mute-button corner" data-action="mute" aria-label="Toggle sound"></button>
          <h1>Paused</h1>
          <div class="stat-tiles pause-stats"></div>
          <button class="primary" data-action="resume">Resume</button>
          <div class="button-row">
            <button class="secondary" data-action="pause-restart">Restart</button>
            <button class="secondary" data-action="quit">Menu</button>
          </div>
          <div class="choice-grid themes compact-themes"></div>
          <div class="key-hint"><kbd>Esc</kbd> to resume</div>
        </div>
      </div>

      <div class="screen game-over">
        <div class="card compact">
          <div class="result-banner">Game Over</div>
          <div class="result-score">0</div>
          <div class="stat-tiles result-stats"></div>
          <div class="claims"></div>
          <div class="leaderboard"></div>
          <button class="primary" data-action="restart">Run Again</button>
          <button class="secondary" data-action="loadout">Menu</button>
          <div class="key-hint">Press <kbd>Space</kbd> to run again</div>
        </div>
      </div>`;

    this.hud = el(this.root, '.hud');
    this.screens = {
      loading: el(this.root, '.screen.loading'),
      title: el(this.root, '.screen.title'),
      pause: el(this.root, '.screen.pause'),
      gameOver: el(this.root, '.screen.game-over'),
    };
    this.hudRefs = {
      score: el(this.hud, '.score'),
      multiplier: el(this.hud, '.multiplier'),
      distance: el(this.hud, '.distance'),
      coins: el(this.hud, '.hud-coins'),
      coinPill: el(this.hud, '.coin-pill'),
      premium: el(this.hud, '.hud-premium'),
      premiumPill: el(this.hud, '.premium-pill'),
      lives: el(this.hud, '.hud-lives'),
    };
    this.countdown = el(this.hud, '.countdown');
    this.powerupZone = el(this.hud, '.powerup-zone');
    this.toasts = el(this.hud, '.toasts');
    this.hint = el(this.hud, '.hint');
    this.progressBar = el(this.root, '.progress-fill');

    const actions: Record<string, () => void> = {
      start: () => this.onStart(),
      restart: () => this.onRestart(),
      'pause-restart': () => this.onRestart(),
      resume: () => this.onResume(),
      quit: () => this.onQuit(),
      pause: () => this.onPauseRequest(),
      loadout: () => this.onQuit(),
      mute: () => this.onToggleMute(),
    };
    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('button');
      if (!target || target.disabled) return;
      this.onButton();
      const action = target.dataset.action;
      if (action && actions[action]) actions[action]();
      else if (target.dataset.character) this.onPickCharacter(target.dataset.character);
      else if (target.dataset.theme) this.onPickTheme(target.dataset.theme);
      else if (target.dataset.claim) {
        target.disabled = true;
        target.classList.add('claimed');
        target.textContent = 'Claimed!';
        this.onClaim(Number(target.dataset.claim));
      }
    });
    this.setMuted(false);
  }

  // ---------------------------------------------------------------- screens

  private showScreen(screen: HTMLElement | null, hud: boolean): void {
    for (const el of Object.values(this.screens)) el.classList.toggle('visible', el === screen);
    this.hud.classList.toggle('visible', hud);
    this.root.dataset.screen =
      (Object.entries(this.screens).find(([, el]) => el === screen)?.[0] ?? 'game');
  }

  /** 0..1 asset loading progress. */
  setLoadingProgress(progress: number): void {
    this.progressBar.style.transform = `scaleX(${Math.max(0.04, Math.min(1, progress))})`;
  }

  /** Enable the start button once boot has finished loading assets. */
  setReady(): void {
    const button = el<HTMLButtonElement>(this.root, '[data-action=start]');
    button.disabled = false;
    button.textContent = 'Run!';
  }

  showTitle(): void {
    this.showScreen(this.screens.title, false);
    el<HTMLButtonElement>(this.screens.title, '[data-action=start]').focus({ preventScroll: true });
  }

  showGame(): void {
    this.showScreen(null, true);
  }

  /** Pause keeps the HUD on screen behind the menu so the run stays readable. */
  showPause(score: number, distance: number, coins: number): void {
    el(this.screens.pause, '.pause-stats').innerHTML = [
      this.tile('Score', format(score)),
      this.tile('Distance', `${format(distance)} m`),
      this.tile('Fishbones', format(coins), 'fishbone'),
    ].join('');
    this.showScreen(this.screens.pause, true);
    el<HTMLButtonElement>(this.screens.pause, '[data-action=resume]').focus({ preventScroll: true });
  }

  showGameOver(result: RunResult): void {
    const screen = this.screens.gameOver;
    const banner = el(screen, '.result-banner');
    banner.textContent = result.newBest ? 'New Best!' : 'Game Over';
    banner.classList.toggle('best', result.newBest);
    this.countUp(el(screen, '.result-score'), result.score);
    el(screen, '.result-stats').innerHTML = [
      this.tile('Fishbones', `+${format(result.coins)}`, 'fishbone'),
      this.tile('Distance', `${format(result.distance)} m`),
      this.tile('Best', format(result.best), 'trophy'),
    ].join('');

    el(screen, '.claims').innerHTML = result.claims
      .map(
        (c) => `<div class="claim"><span>${c.text}</span>
          <button class="reward" data-claim="${c.index}">Claim +${c.reward} ${icon('premium', 'inline-icon')}</button></div>`
      )
      .join('');

    el(screen, '.leaderboard').innerHTML = result.leaderboard.length
      ? `<h2>Best runs</h2><ol>${result.leaderboard
          .slice(0, 5)
          .map(
            (entry, i) =>
              `<li class="${i === result.rank ? 'current' : ''}"><span class="rank">${i + 1}</span><span class="name"></span><span class="value">${format(entry.score)}</span></li>`
          )
          .join('')}</ol>`
      : '';
    // Names come from the save file: set as text, never parsed as markup.
    el(screen, '.leaderboard')
      .querySelectorAll<HTMLElement>('.name')
      .forEach((node, i) => (node.textContent = result.leaderboard[i].name));

    this.showScreen(screen, false);
    el<HTMLButtonElement>(screen, '[data-action=restart]').focus({ preventScroll: true });
  }

  private tile(label: string, value: string, iconName?: string): string {
    return `<div class="tile">${iconName ? icon(iconName, 'tile-icon') : ''}<div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
  }

  private countUp(target: HTMLElement, value: number): void {
    const start = performance.now();
    const duration = Math.min(1200, 300 + value * 0.2);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      target.textContent = format(value * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- loadout

  renderLoadout(view: LoadoutView): void {
    const title = this.screens.title;
    el(title, '[data-bind=coins]').textContent = format(view.coins);
    el(title, '[data-bind=premium]').textContent = format(view.premium);
    el(title, '[data-bind=best]').textContent = format(view.best);

    el(title, '.characters').innerHTML = view.characters
      .map((c) => {
        const status = c.selected ? 'Selected' : c.owned ? 'Owned' : `${icon('fishbone', 'inline-icon')} ${format(c.cost)}`;
        const state = [c.selected && 'selected', !c.owned && 'locked', !c.owned && !c.affordable && 'unaffordable']
          .filter(Boolean)
          .join(' ');
        return `<button class="choice ${state}" data-character="${c.key}" aria-pressed="${c.selected}">
          ${icon(c.icon, 'choice-art')}
          <span class="choice-name">${c.name}</span>
          <span class="choice-status">${status}</span>
        </button>`;
      })
      .join('');

    const themes = view.themes
      .map(
        (t) => `<button class="choice theme ${t.selected ? 'selected' : ''}" data-theme="${t.key}" aria-pressed="${t.selected}">
          ${icon(t.icon, 'choice-art theme-art')}
          <span class="choice-name">${t.name}</span>
        </button>`
      )
      .join('');
    for (const grid of this.root.querySelectorAll('.themes')) grid.innerHTML = themes;

    el(title, '.missions').innerHTML = view.missions
      .map((m) => {
        const ratio = Math.min(1, m.progress / m.max);
        return `<div class="mission ${ratio >= 1 ? 'done' : ''}">
          <div class="mission-text">${m.text}</div>
          <div class="mission-reward">+${m.reward} ${icon('premium', 'inline-icon')}</div>
          <div class="bar"><div class="bar-fill" style="transform:scaleX(${ratio})"></div></div>
          <div class="mission-progress">${format(Math.min(m.progress, m.max))} / ${format(m.max)}</div>
        </div>`;
      })
      .join('');
  }

  /** Shake a locked character card and say how many fishbones are missing. */
  denyPurchase(key: string, missing: number): void {
    const card = this.screens.title.querySelector<HTMLElement>(`[data-character="${key}"]`);
    if (card) retrigger(card, 'shake');
    const message = el(this.screens.title, '.purchase-message');
    message.textContent = `You need ${format(missing)} more fishbones`;
    retrigger(message, 'flash');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const svg = muted
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-action=mute]')) {
      button.innerHTML = svg;
      button.setAttribute('aria-pressed', String(this.muted));
    }
  }

  // ---------------------------------------------------------------- HUD

  /** Reset every HUD readout, e.g. when a new run starts. */
  resetHud(state: HudState): void {
    this.last = {};
    this.updateHud(state);
    this.updatePowerups([]);
    this.toasts.replaceChildren();
  }

  updateHud(state: HudState): void {
    const last = this.last;
    const refs = this.hudRefs;
    if (last.score !== state.score) refs.score.textContent = format(state.score);
    if (last.distance === undefined || Math.floor(last.distance) !== Math.floor(state.distance)) {
      refs.distance.textContent = `${format(state.distance)} m`;
    }
    if (last.multiplier !== state.multiplier) {
      refs.multiplier.textContent = `x${state.multiplier}`;
      refs.multiplier.dataset.tier = String(Math.min(state.multiplier, 5));
      if (last.multiplier !== undefined && state.multiplier > last.multiplier) retrigger(refs.multiplier, 'bump');
    }
    if (last.coins !== state.coins) {
      refs.coins.textContent = format(state.coins);
      if (last.coins !== undefined && state.coins > last.coins) retrigger(refs.coinPill, 'bump');
    }
    if (last.premium !== state.premium) {
      refs.premium.textContent = format(state.premium);
      refs.premiumPill.classList.toggle('hidden', state.premium === 0);
      if (last.premium !== undefined && state.premium > last.premium) retrigger(refs.premiumPill, 'bump');
    }
    if (last.lives !== state.lives || last.maxLives !== state.maxLives) {
      refs.lives.innerHTML = Array.from(
        { length: state.maxLives },
        (_, i) => `<img class="life ${i < state.lives ? '' : 'lost'}" src="${ICONS}/heart.png" alt="">`
      ).join('');
      if (last.lives !== undefined && state.lives < last.lives) retrigger(refs.lives, 'hurt');
      if (last.lives !== undefined && state.lives > last.lives) retrigger(refs.lives, 'bump');
    }
    this.last = { ...state };
  }

  /** Active powerup timers: icon plus a draining ring, keyed by type. */
  updatePowerups(items: PowerupView[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.type);
      let entry = this.powerupEls.get(item.type);
      if (!entry) {
        const root = document.createElement('div');
        root.className = 'powerup';
        root.innerHTML = `<div class="powerup-ring"></div>${icon(item.type, 'powerup-icon')}<span class="powerup-time"></span>`;
        root.style.setProperty('--tint', `#${item.color.toString(16).padStart(6, '0')}`);
        this.powerupZone.appendChild(root);
        entry = { root, ring: el(root, '.powerup-ring'), label: el(root, '.powerup-time'), shown: -1 };
        this.powerupEls.set(item.type, entry);
      }
      const fraction = Math.max(0, item.timeLeft / item.duration);
      entry.ring.style.setProperty('--progress', fraction.toFixed(3));
      const seconds = Math.ceil(item.timeLeft);
      if (seconds !== entry.shown) {
        entry.shown = seconds;
        entry.label.textContent = String(seconds);
        entry.root.classList.toggle('ending', item.timeLeft < 3);
      }
    }
    for (const [type, entry] of this.powerupEls) {
      if (seen.has(type)) continue;
      entry.root.remove();
      this.powerupEls.delete(type);
    }
  }

  /** Big centred countdown text ('3', '2', '1', 'Go!'), empty to hide. */
  setCountdown(text: string): void {
    if (this.countdown.textContent === text) return;
    this.countdown.textContent = text;
    this.countdown.classList.toggle('go', text === 'Go!');
    if (text) retrigger(this.countdown, 'tick');
    else this.countdown.classList.remove('tick');
  }

  /** Short celebratory message under the score. */
  toast(text: string, kind: 'gold' | 'info' | 'powerup' = 'info', tint?: number): void {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = text;
    if (tint !== undefined) node.style.setProperty('--tint', `#${tint.toString(16).padStart(6, '0')}`);
    this.toasts.appendChild(node);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    setTimeout(() => node.remove(), 1600);
  }

  /** Controls reminder, shown for a few seconds at the start of early runs. */
  showHint(seconds: number): void {
    clearTimeout(this.hintTimer);
    this.hint.classList.add('visible');
    this.hintTimer = window.setTimeout(() => this.hint.classList.remove('visible'), seconds * 1000);
  }

  hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hint.classList.remove('visible');
  }
}
