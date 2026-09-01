// Web gameplay tuning, with the Unity scene's spatial alignment overrides.

export const LANE_OFFSET = 1.5;
export const LANE_CHANGE_SPEED = 14; // scene-serialized value in Main.unity (code default 1.0 is overridden)

export const MIN_SPEED = 5.0;
export const MAX_SPEED = 10.0;
export const ACCELERATION = 0.2; // world units / s^2
export const SPEED_STEP = 4; // multiplier tiers between min and max speed

export const JUMP_LENGTH = 2.0;
export const JUMP_HEIGHT = 1.2;
export const SLIDE_LENGTH = 2.0;
export const GROUNDING_SPEED = 80;
export const TRACK_SPEED_TO_JUMP_ANIM_RATIO = 0.6;

export const MAX_LIVES = 3;
export const INVINCIBILITY_TIME = 2.0; // seconds after a hit
export const BLINK_PERIOD = 0.1;

export const DESIRED_SEGMENT_COUNT = 10;
export const SEGMENT_REMOVAL_DISTANCE = -30;

// Obstacle-free run at the start of every run, in world units measured from the
// character's spawn point (~11 s at MIN_SPEED) so the player is up to speed and
// oriented before the first hazard.
export const STARTING_SAFE_DISTANCE = 55;

/**
 * Minimum clearance between two consecutive obstacles, keyed by how hard the
 * previous one was to clear. A wall (all-lane barrier) commits the player to a
 * jump or slide, so nothing may sit in the landing zone — and a lane-crossing
 * rat, which has to be read and timed, is pushed much further out still.
 * Distances are world units; at MAX_SPEED (10 u/s) 16 units is 1.6 seconds,
 * against a jump that covers 4 units. The authored segments are only 9-27 units
 * long with about one obstacle slot each, so larger gaps thin the track out
 * noticeably — these are the smallest values that still leave room to land,
 * re-read the track and change lane.
 */
export const OBSTACLE_GAPS = {
  /** Previous obstacle left every lane blocked (jump/slide barrier). */
  wall: { barricade: 16, wall: 22, moving: 26 },
  /** Previous obstacle moved across lanes (patrolling rat, incoming dog). */
  moving: { barricade: 14, wall: 20, moving: 24 },
  /** Previous obstacle blocked two of three lanes. */
  narrow: { barricade: 11, wall: 16, moving: 20 },
  /** Previous obstacle blocked a single lane. */
  open: { barricade: 8, wall: 12, moving: 16 },
} as const;

export const FLOATING_ORIGIN_THRESHOLD_SQ = 10000;

export const COIN_STEP = 1.5; // world units between coin placements
export const POWERUP_CHANCE_RATE = 0.5 * 0.001; // per floor(second) since last powerup
export const PREMIUM_CHANCE_RATE = 0.5 * 0.0001;
export const COIN_POOL_SIZE = 256;

export const COUNTDOWN_SECONDS = 5;
export const COUNTDOWN_SPEED = 1.5;

export const PARALLAX_RATIO = 0.8;

// Main.unity starts the character slightly inside the first segment. Keeping
// the camera away from the prefab entry cap avoids exposing the sky below it.
export const STARTING_SEGMENT_DISTANCE = 2.0;

// A shallow, opaque underlay only covers the playable lanes. The authored road
// remains visible; this catches sub-pixel cracks where adjacent meshes meet.
export const ROAD_RIBBON_HALF_WIDTH = LANE_OFFSET + 0.7;
export const ROAD_RIBBON_Y_OFFSET = 0.035;

export const MISSILE_SPEED = 5;

// Camera (Main.unity): camera world pos (0,4,-3), character world pos (0,0,3);
// SetParent(keepWorld) makes the effective follow offset (0,4,-6).
export const CAMERA_OFFSET: [number, number, number] = [0, 4, -6];
export const CAMERA_PITCH_DEG = -15;
export const CAMERA_FOV = 58.7;
/** Extra field of view at MAX_SPEED, for a sense of acceleration. */
export const CAMERA_FOV_SPEED_KICK = 5;
/**
 * The aspect ratio CAMERA_FOV is authored for. Wider windows keep this
 * horizontal field of view and lose vertical instead of widening: the segments
 * only model scenery for the width the original game framed, so letting the
 * view spread sideways exposes the backs of the neighbouring street's walls.
 */
export const CAMERA_REFERENCE_ASPECT = 16 / 9;
/** How much of the character's lane offset the camera follows (0 = rigid). */
export const CAMERA_LANE_FOLLOW = 0.35;
export const CAMERA_FOLLOW_DAMPING = 7;
export const CAMERA_SHAKE_TIME = 0.3;
export const CAMERA_SHAKE_AMOUNT = 0.22;

// Fog (Main.unity RenderSettings, linear)
export const FOG_NEAR = 50;
export const FOG_FAR = 80;

// Character collider (CharacterCollider.cs), local box
export const COLLIDER_CENTER_STANDING: [number, number, number] = [0, 1.0, 0];
export const COLLIDER_SIZE_STANDING: [number, number, number] = [0.6, 2.0, 0.6];
export const COLLIDER_CENTER_SLIDING: [number, number, number] = [0, 0.4, 0];
export const COLLIDER_SIZE_SLIDING: [number, number, number] = [0.6, 0.8, 0.6];

export const MAGNET_SPEED = 10;
export const MAGNET_HALF_EXTENTS: [number, number, number] = [20, 1, 1];
