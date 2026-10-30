import type { Game } from '../game/Game';
import type { WristAction, WristContext, WristTarget } from './wristTypes';
import { DomMenuSurface, WristMenu } from './WristMenu';

/** The slice of Game the bridge reads; lets tests supply a fake. */
export type WristGame = Pick<Game, 'currentState' | 'loadoutLocked' | 'controller' | 'pauseRun'>;

/**
 * Maps the four wrist actions onto the game: lanes/jump/slide during a run,
 * focus navigation over the visible screen everywhere else.
 */
export class WristGameBridge implements WristTarget {
  private lastSignature = '';
  private counter = 0;

  constructor(
    private readonly game: WristGame,
    private readonly menu = new WristMenu(new DomMenuSurface())
  ) {}

  get context(): WristContext {
    this.refresh();
    return this.currentContext();
  }

  get revision(): number {
    this.refresh();
    return this.counter;
  }

  perform(action: WristAction): void {
    const context = this.context;
    if (context === 'run') {
      const controller = this.game.controller;
      if (action === 'left' || action === 'right') controller.moveHorizontal(action);
      else if (action === 'up') controller.jump();
      else controller.slide();
    } else if (context === 'menu') {
      this.menu.perform(action);
    }
  }

  trackingLost(): void {
    if (this.game.currentState === 'playing') this.game.pauseRun();
  }

  hints(): Record<WristAction, string> {
    if (this.currentContext() === 'menu') {
      return { left: 'Previous', right: 'Next', up: 'Select', down: this.menu.primaryLabel() };
    }
    return { left: 'Lane left', right: 'Lane right', up: 'Jump', down: 'Slide' };
  }

  private currentContext(): WristContext {
    switch (this.game.currentState) {
      case 'playing':
        return 'run';
      case 'title':
      case 'paused':
      case 'gameover':
        return this.game.loadoutLocked ? 'idle' : 'menu';
      default:
        return 'idle';
    }
  }

  /** Bump the revision when gesture meaning changes, and keep menu focus valid. */
  private refresh(): void {
    const context = this.currentContext();
    const screen = context === 'menu' ? this.menu.screenId() : '';
    const signature = `${this.game.currentState}|${context}|${this.game.controller.inputRevision}|${screen}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.counter++;
    if (context === 'menu') this.menu.sync();
  }
}
