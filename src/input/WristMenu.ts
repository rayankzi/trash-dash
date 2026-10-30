/** One focusable control on the active screen. */
export interface MenuControl {
  /** Stable across re-renders of the screen, so focus survives innerHTML rebuilds. */
  key: string;
  label: string;
  primary: boolean;
  activate(): void;
  setFocused(on: boolean): void;
}

/** What the menu navigates; the DOM implementation is below, tests use fakes. */
export interface MenuSurface {
  /** Identifies the visible screen; a change re-focuses the primary action. */
  screen(): string;
  /** Visible, enabled controls of the active screen in reading order. */
  controls(): MenuControl[];
  /** Drop any focus marker left on controls of screens that are now hidden. */
  clear(): void;
}

/**
 * Wrist focus navigation: left/right walk the controls (wrapping), up clicks
 * the focused one, down jumps back to the screen's primary action.
 */
export class WristMenu {
  private screen = '';
  private focusKey = '';
  private index = 0;

  constructor(private readonly surface: MenuSurface) {}

  /** Re-resolve focus after the screen or its contents changed. */
  sync(): MenuControl[] {
    const screen = this.surface.screen();
    const controls = this.surface.controls();
    if (screen !== this.screen) {
      this.screen = screen;
      this.surface.clear();
      this.focusKey = (controls.find((c) => c.primary) ?? controls[0])?.key ?? '';
    }
    let found = controls.findIndex((c) => c.key === this.focusKey);
    // The focused control vanished (claimed, disabled): stay near where it was.
    if (found < 0 && controls.length) found = Math.min(this.index, controls.length - 1);
    this.index = Math.max(0, found);
    this.focusKey = controls[this.index]?.key ?? '';
    controls.forEach((c, i) => c.setFocused(i === this.index));
    return controls;
  }

  perform(action: 'left' | 'right' | 'up' | 'down'): void {
    const controls = this.sync();
    if (!controls.length) return;
    if (action === 'up') {
      controls[this.index].activate();
      this.sync();
      return;
    }
    if (action === 'down') this.index = Math.max(0, controls.findIndex((c) => c.primary));
    else this.index = (this.index + (action === 'right' ? 1 : controls.length - 1)) % controls.length;
    this.focusKey = controls[this.index].key;
    controls.forEach((c, i) => c.setFocused(i === this.index));
  }

  screenId(): string {
    return this.surface.screen();
  }

  /** Label of the screen's main button (Run!, Resume, Run Again), for the legend. */
  primaryLabel(): string {
    return this.surface.controls().find((c) => c.primary)?.label ?? 'Main button';
  }
}

const FOCUS_CLASS = 'wrist-focus';

/** Navigates the buttons of the visible `.screen` inside #ui-root. */
export class DomMenuSurface implements MenuSurface {
  private get root(): HTMLElement | null {
    return document.getElementById('ui-root');
  }

  screen(): string {
    return this.root?.dataset.screen ?? '';
  }

  controls(): MenuControl[] {
    const screen = this.root?.querySelector<HTMLElement>('.screen.visible');
    if (!screen) return [];
    const seen = new Map<string, number>();
    const result: MenuControl[] = [];
    for (const button of screen.querySelectorAll<HTMLButtonElement>('button')) {
      // Never navigate into the camera panel, hidden or disabled buttons.
      if (button.disabled || button.closest('.wrist-controls') || button.getClientRects().length === 0) continue;
      const d = button.dataset;
      const base = d.action ?? (d.character && `c:${d.character}`) ?? (d.theme && `t:${d.theme}`) ?? (d.claim && `claim:${d.claim}`) ?? 'button';
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      result.push({
        key: `${base}#${n}`,
        label: button.textContent?.replace(/\s+/g, ' ').trim() || button.getAttribute('aria-label') || 'Select',
        primary: button.classList.contains('primary'),
        // A real click so the UI's delegated handler and audio unlock run.
        activate: () => button.click(),
        setFocused: (on) => {
          button.classList.toggle(FOCUS_CLASS, on);
          if (on) button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        },
      });
    }
    return result;
  }

  clear(): void {
    for (const el of document.querySelectorAll(`.${FOCUS_CLASS}`)) el.classList.remove(FOCUS_CLASS);
  }
}
