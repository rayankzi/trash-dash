import { describe, expect, it, vi } from 'vitest';
import { WristGameBridge, type WristGame } from '../src/input/WristGameBridge';
import { WristMenu, type MenuControl, type MenuSurface } from '../src/input/WristMenu';

type State = 'loading' | 'title' | 'countdown' | 'playing' | 'paused' | 'gameover';

function fakeGame(state: State) {
  const controller = {
    inputRevision: 0,
    moveHorizontal: vi.fn(),
    jump: vi.fn(),
    slide: vi.fn(),
  };
  const game = {
    currentState: state,
    loadoutLocked: false,
    controller,
    pauseRun: vi.fn(),
  };
  return { game: game as unknown as WristGame & typeof game, controller };
}

class FakeSurface implements MenuSurface {
  screenName = 'title';
  names: string[] = ['mute', 'char', 'theme', 'start'];
  primary = 'start';
  activated: string[] = [];
  focused = new Set<string>();
  cleared = 0;
  screen() { return this.screenName; }
  clear() { this.cleared++; this.focused.clear(); }
  controls(): MenuControl[] {
    return this.names.map((name) => ({
      key: name,
      label: name,
      primary: name === this.primary,
      activate: () => this.activated.push(name),
      setFocused: (on) => (on ? this.focused.add(name) : this.focused.delete(name)),
    }));
  }
}

const bridgeFor = (state: State, surface = new FakeSurface()) => {
  const f = fakeGame(state);
  return { ...f, surface, bridge: new WristGameBridge(f.game, new WristMenu(surface)) };
};

describe('WristGameBridge context', () => {
  it.each([
    ['playing', 'run'],
    ['title', 'menu'],
    ['paused', 'menu'],
    ['gameover', 'menu'],
    ['loading', 'idle'],
    ['countdown', 'idle'],
  ] as const)('maps %s to %s', (state, context) => {
    expect(bridgeFor(state).bridge.context).toBe(context);
  });

  it('is idle while the loadout is busy', () => {
    const { bridge, game } = bridgeFor('title');
    game.loadoutLocked = true;
    expect(bridge.context).toBe('idle');
  });

  it('bumps revision on state, lock and controller input changes', () => {
    const { bridge, game, controller } = bridgeFor('countdown');
    const seen = [bridge.revision];
    expect(bridge.revision).toBe(seen[0]);
    game.currentState = 'playing';
    seen.push(bridge.revision);
    controller.inputRevision++;
    seen.push(bridge.revision);
    game.currentState = 'paused';
    seen.push(bridge.revision);
    game.loadoutLocked = true;
    seen.push(bridge.revision);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('bumps revision when the menu screen changes', () => {
    const { bridge, surface } = bridgeFor('title');
    const before = bridge.revision;
    surface.screenName = 'pause';
    expect(bridge.revision).not.toBe(before);
  });
});

describe('WristGameBridge actions', () => {
  it('routes run actions to the controller', () => {
    const { bridge, controller } = bridgeFor('playing');
    bridge.perform('left');
    bridge.perform('right');
    bridge.perform('up');
    bridge.perform('down');
    expect(controller.moveHorizontal.mock.calls).toEqual([['left'], ['right']]);
    expect(controller.jump).toHaveBeenCalledTimes(1);
    expect(controller.slide).toHaveBeenCalledTimes(1);
    expect(bridge.hints()).toEqual({ left: 'Lane left', right: 'Lane right', up: 'Jump', down: 'Slide' });
  });

  it('ignores actions while idle', () => {
    const { bridge, controller, surface } = bridgeFor('countdown');
    bridge.perform('up');
    expect(controller.jump).not.toHaveBeenCalled();
    expect(surface.activated).toEqual([]);
  });

  it('pauses on tracking loss only while playing', () => {
    for (const state of ['title', 'paused', 'gameover', 'loading', 'countdown'] as const) {
      const { bridge, game } = bridgeFor(state);
      bridge.trackingLost();
      expect(game.pauseRun).not.toHaveBeenCalled();
    }
    const { bridge, game } = bridgeFor('playing');
    bridge.trackingLost();
    expect(game.pauseRun).toHaveBeenCalledTimes(1);
  });

  it('uses the primary label as the down hint in menus', () => {
    const { bridge, surface } = bridgeFor('title');
    surface.names = ['mute', 'Run!'];
    surface.primary = 'Run!';
    expect(bridge.hints()).toEqual({ left: 'Previous', right: 'Next', up: 'Select', down: 'Run!' });
  });
});

describe('WristMenu focus', () => {
  it('focuses the primary action when a screen first appears', () => {
    const { bridge, surface } = bridgeFor('title');
    void bridge.revision;
    expect([...surface.focused]).toEqual(['start']);
    bridge.perform('up');
    expect(surface.activated).toEqual(['start']);
  });

  it('wraps in both directions', () => {
    const { bridge, surface } = bridgeFor('title');
    bridge.perform('right');
    expect([...surface.focused]).toEqual(['mute']);
    bridge.perform('left');
    expect([...surface.focused]).toEqual(['start']);
    bridge.perform('left');
    expect([...surface.focused]).toEqual(['theme']);
    bridge.perform('up');
    expect(surface.activated).toEqual(['theme']);
  });

  it('down returns to the primary action', () => {
    const { bridge, surface } = bridgeFor('title');
    bridge.perform('left');
    bridge.perform('left');
    bridge.perform('down');
    expect([...surface.focused]).toEqual(['start']);
  });

  it('re-focuses the primary action on screen change and clears old markers', () => {
    const { bridge, surface } = bridgeFor('title');
    bridge.perform('left');
    surface.screenName = 'pause';
    surface.names = ['mute', 'resume', 'quit'];
    surface.primary = 'resume';
    void bridge.revision;
    expect([...surface.focused]).toEqual(['resume']);
    expect(surface.cleared).toBeGreaterThan(0);
  });

  it('stays near a focused control that disappears', () => {
    const { bridge, surface } = bridgeFor('title');
    surface.names = ['a', 'b', 'c', 'start'];
    bridge.perform('left');
    bridge.perform('left');
    expect([...surface.focused]).toEqual(['b']);
    surface.names = ['a', 'c', 'start'];
    surface.focused.clear(); // the removed node is gone from the DOM
    bridge.perform('right');
    expect([...surface.focused]).toEqual(['start']);
  });
});
