export type HorizontalDirection = 'left' | 'right';
export type VerticalDirection = 'up' | 'down';
/** Left/right come from the side-on pose, up/down from the knuckles-to-camera pose. */
export type WristAction = HorizontalDirection | VerticalDirection;

/** run: lanes/jump/slide. menu: focus navigation. idle: gestures ignored (loading, countdown). */
export type WristContext = 'run' | 'menu' | 'idle';

/** What the camera loop drives. The game decides what each action means in its current state. */
export interface WristTarget {
  readonly context: WristContext;
  /** Changes whenever the meaning of gestures changes; held bends must return to neutral first. */
  readonly revision: number;
  perform(action: WristAction): void;
  /** The hand has been out of view for a while during a run. */
  trackingLost(): void;
  /** Short legend labels for the current context, e.g. { up: 'Jump', ... }. */
  hints(): Record<WristAction, string>;
}
