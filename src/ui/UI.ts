import './ui.css';

export interface PickerOption {
  key: string;
  label: string;
  sub: string;
  owned: boolean;
  selected: boolean;
}

/** HTML/CSS overlay UI: title screen, HUD, countdown, pause and game-over. */
export class UI {
  private root = document.getElementById('ui-root')!;
  private hud!: HTMLElement;
  private hudCoins!: HTMLElement;
  private hudLives!: HTMLElement;
  private hudScore!: HTMLElement;
  private hudMultiplier!: HTMLElement;
  private hudDistance!: HTMLElement;
  private countdown!: HTMLElement;
  private title!: HTMLElement;
  private pause!: HTMLElement;
  private gameOver!: HTMLElement;
  private gameOverStats!: HTMLElement;
  private damageFlash!: HTMLElement;

  onStart: () => void = () => {};
  onRestart: () => void = () => {};
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onPauseRequest: () => void = () => {};

  constructor() {
    this.root.innerHTML = `
      <div class="hud">
        <div class="hud-top">
          <div class="hud-left">
            <div class="hud-lives"></div>
            <div class="hud-wallet">
              <div class="hud-coins"></div>
              <div class="hud-premium"></div>
            </div>
          </div>
          <div class="hud-score">
            <div class="score">0</div>
            <div class="hud-multiplier">x1</div>
            <div class="hud-distance">0m</div>
          </div>
        </div>
        <button class="pause-button" data-action="pause" aria-label="Pause">II</button>
        <div class="powerup-zone"></div>
        <div class="countdown" style="display:none"></div>
        <div class="hint">&larr;/&rarr; lanes &nbsp; &uarr; jump &nbsp; &darr; slide &nbsp; esc pause</div>
      </div>
      <div class="damage-flash"></div>
      <div class="screen title visible">
        <div class="panel">
          <h1>Trash Dash</h1>
          <div class="wallet"></div>
          <div class="pickers">
            <div class="picker character-picker"></div>
            <div class="picker theme-picker"></div>
          </div>
          <div class="missions-list"></div>
          <button data-action="start" disabled>Loading&hellip;</button>
        </div>
      </div>
      <div class="screen pause">
        <div class="panel">
          <h1>Paused</h1>
          <div class="pause-stats"></div>
          <div class="picker theme-picker-pause"></div>
          <button data-action="resume">Resume</button>
          <button class="ghost" data-action="pause-restart">Restart Run</button>
          <button class="ghost" data-action="quit">Quit to Menu</button>
        </div>
      </div>
      <div class="screen game-over">
        <div class="panel">
          <h1>Game Over</h1>
          <div class="big-score"></div>
          <div class="stats"></div>
          <div class="mission-claims"></div>
          <div class="leaderboard"></div>
          <button data-action="restart">Run Again</button>
          <button class="ghost" data-action="loadout">Loadout</button>
        </div>
      </div>`;

    this.hud = this.root.querySelector('.hud')!;
    this.hudCoins = this.root.querySelector('.hud-coins')!;
    this.hudLives = this.root.querySelector('.hud-lives')!;
    this.hudScore = this.root.querySelector('.hud-score .score')!;
    this.hudMultiplier = this.root.querySelector('.hud-multiplier')!;
    this.hudDistance = this.root.querySelector('.hud-distance')!;
    this.countdown = this.root.querySelector('.countdown')!;
    this.title = this.root.querySelector('.screen.title')!;
    this.pause = this.root.querySelector('.screen.pause')!;
    this.gameOver = this.root.querySelector('.screen.game-over')!;
    this.gameOverStats = this.root.querySelector('.game-over .stats')!;
    this.damageFlash = this.root.querySelector('.damage-flash')!;

    const on = (action: string, handler: () => void) =>
      this.root.querySelector(`[data-action=${action}]`)!.addEventListener('click', handler);
    on('start', () => this.onStart());
    on('restart', () => this.onRestart());
    on('pause-restart', () => this.onRestart());
    on('resume', () => this.onResume());
    on('quit', () => this.onQuit());
    on('pause', () => this.onPauseRequest());
    on('loadout', () => this.showTitle());
  }

  private renderPicker(
    el: Element,
    title: string,
    options: PickerOption[],
    onPick: (key: string) => void
  ): void {
    el.innerHTML = `<div class="picker-title">${title}</div>`;
    for (const o of options) {
      const btn = document.createElement('button');
      btn.className = 'picker-option' + (o.selected ? ' selected' : '');
      btn.innerHTML = `${o.label}${o.sub ? `<span class="sub">${o.sub}</span>` : ''}`;
      btn.addEventListener('click', () => onPick(o.key));
      el.appendChild(btn);
    }
  }

  /**
   * Render the loadout. Characters are bought with fishbones; the time of day
   * is a free presentation option, so it renders without a price and is also
   * mirrored into the pause menu for switching mid-session.
   */
  renderPickers(
    characters: PickerOption[],
    themes: PickerOption[],
    wallet: string,
    missions: { text: string; progress: string }[],
    onPickCharacter: (key: string) => void,
    onPickTheme: (key: string) => void
  ): void {
    this.root.querySelector('.wallet')!.textContent = wallet;
    this.renderPicker(this.root.querySelector('.character-picker')!, 'Character', characters, onPickCharacter);
    this.renderPicker(this.root.querySelector('.theme-picker')!, 'Time of Day', themes, onPickTheme);
    this.renderPicker(
      this.root.querySelector('.theme-picker-pause')!,
      'Time of Day',
      themes,
      onPickTheme
    );
    this.root.querySelector('.missions-list')!.innerHTML = missions
      .map((m) => `<div class="mission-row">${m.text} <span class="sub">${m.progress}</span></div>`)
      .join('');
  }

  renderGameOverMeta(
    leaderboard: { name: string; score: number }[],
    claims: { text: string; reward: number; index: number }[],
    onClaim: (index: number) => void
  ): void {
    this.root.querySelector('.leaderboard')!.innerHTML =
      leaderboard.length === 0
        ? ''
        : '<div class="picker-title">Best Runs</div>' +
          leaderboard
            .slice(0, 5)
            .map((e, i) => `<div class="mission-row">${i + 1}. ${e.name} <span class="sub">${e.score}</span></div>`)
            .join('');
    const claimsEl = this.root.querySelector('.mission-claims')!;
    claimsEl.innerHTML = '';
    for (const c of claims) {
      const btn = document.createElement('button');
      btn.className = 'claim-btn';
      btn.textContent = `Claim: ${c.text} (+${c.reward} ✨)`;
      btn.addEventListener('click', () => {
        btn.remove();
        onClaim(c.index);
      });
      claimsEl.appendChild(btn);
    }
  }

  /** Enable the start button once boot has finished loading assets. */
  setReady(): void {
    const btn = this.root.querySelector<HTMLButtonElement>('[data-action=start]')!;
    btn.disabled = false;
    btn.textContent = 'Run!';
  }

  private showScreen(screen: HTMLElement | null): void {
    for (const el of [this.title, this.pause, this.gameOver]) {
      el.classList.toggle('visible', el === screen);
    }
  }

  showTitle(): void {
    this.showScreen(this.title);
    this.hud.classList.remove('visible');
  }

  showGame(): void {
    this.showScreen(null);
    this.hud.classList.add('visible');
  }

  /** Pause keeps the HUD on screen behind the menu so the run stays readable. */
  showPause(score: number, distance: number, coins: number): void {
    this.showScreen(this.pause);
    this.hud.classList.add('visible');
    this.root.querySelector('.pause-stats')!.innerHTML =
      `Score: ${score}<br>Distance: ${Math.floor(distance)}m<br>Fishbones: ${coins}`;
  }

  showGameOver(score: number, coins: number, distance: number, highscore: number): void {
    this.showScreen(this.gameOver);
    this.hud.classList.remove('visible');
    this.gameOver.querySelector('.big-score')!.textContent = `Score: ${score}`;
    this.gameOverStats.innerHTML = `Fishbones: ${coins}<br>Distance: ${Math.floor(distance)}m<br>Best: ${highscore}`;
  }

  setCountdown(text: string): void {
    const changed = this.countdown.textContent !== text;
    this.countdown.style.display = text ? 'flex' : 'none';
    this.countdown.textContent = text;
    if (text && changed) {
      // Restart the pop animation on every tick.
      this.countdown.classList.remove('tick');
      void this.countdown.offsetWidth;
      this.countdown.classList.add('tick');
    }
  }

  /** Red edge flash when the player takes a non-fatal hit. */
  flashDamage(): void {
    this.damageFlash.classList.remove('active');
    void this.damageFlash.offsetWidth;
    this.damageFlash.classList.add('active');
  }

  /** Render active powerup chips (name + remaining seconds). */
  updatePowerups(items: { name: string; timeLeft: number }[]): void {
    const zone = this.root.querySelector('.powerup-zone')!;
    zone.innerHTML = items
      .map((i) => `<div class="powerup-chip">${i.name} ${Math.ceil(i.timeLeft)}s</div>`)
      .join('');
  }

  updateHud(score: number, multiplier: number, coins: number, lives: number, distance: number, premium = 0): void {
    const premiumEl = this.root.querySelector('.hud-premium');
    if (premiumEl) premiumEl.textContent = premium > 0 ? `✨ ${premium}` : '';
    this.hudScore.textContent = String(score);
    this.hudMultiplier.textContent = `x${multiplier}`;
    this.hudCoins.textContent = `🐟 ${coins}`;
    this.hudLives.textContent = '❤'.repeat(Math.max(0, lives)) + '♡'.repeat(Math.max(0, 3 - lives));
    this.hudDistance.textContent = `${Math.floor(distance)}m`;
  }
}
