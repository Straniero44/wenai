/**
 * Play-parameter rules from docs/ai-companion-design.md sections 5 and 8.
 * Omitted fields keep the session's current values, which start at the initials below.
 */

export class MotionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MotionInputError';
  }
}

export const STROKE_NAMES = Object.freeze([
  'down-forward',
  'down-backward',
  'back-thrust-down',
  'back-thrust-down-swirl',
  'thrust-forward',
  'thrust-forward-swirl',
  'lean-forward-thrust-down',
  'lean-forward-thrust-down-swirl',
  'diagonal-down-back',
  'diagonal-down-forward',
  'orbit-tease',
  'left-right-tease',
  'forward-back-tease',
  'vortex-tease',
  'swirl-tease',
  'forward-back-grind',
  'orbit-grind',
  'short-low-roll-forward',
  'short-low-roll-backward',
  'short-mid-roll-forward',
  'short-mid-roll-backward',
  'short-high-roll-backward',
  'short-high-roll-forward',
  'long-stroke-1',
  'long-stroke-2',
  'long-stroke-3',
  'long-stroke-4',
  'long-stroke-5',
  'grind-circular',
  'grind-vortex',
  'grind-forward-back',
  'grind-forward-back-phased',
  'grind-forward-back-tilt',
  'grind-forward-tilt',
  'tease-orbit-right',
  'tease-orbit-left',
  'tease-left-right-rock',
  'tease-down-back',
  'tease-back-swirl-right',
  'tease-back-swirl-left',
  'tease-up-down-circle-right',
  'tease-up-down-circle-left',
]);

const STROKE_SET = new Set(STROKE_NAMES);

export const DEFAULT_BPM = 60;

export const DEFAULT_DURATION_S = 30;

export const TRAVEL_AXES = Object.freeze(['L0', 'L1', 'L2', 'R0', 'R1', 'R2']);

/**
 * config.json uses the device aliases for travel keys; the session applies
 * limits per TCode axis.
 */
export const TRAVEL_AXIS_KEYS = Object.freeze({
  L0: 'stroke',
  L1: 'surge',
  L2: 'sway',
  R0: 'twist',
  R1: 'roll',
  R2: 'pitch',
});

export const DEFAULT_TRAVEL = Object.freeze([0.2, 0.8]);

export const INITIAL_PARAMETERS = Object.freeze({
  transition_s: 2,
  bpm_mode: 'transition',
  bpm_range: Object.freeze([20, 60]),
  acceleration_range: Object.freeze([0, 20]),
  twist_enabled: false,
  twist_range: Object.freeze([0, 1]),
  twist_phase: 0,
  twist_ecc: 0,
});

const PLAY_FIELDS = new Set([
  'clips',
  'transition_s',
  'bpm_mode',
  'bpm_range',
  'acceleration_range',
  'twist_enabled',
  'twist_range',
  'twist_phase',
  'twist_ecc',
]);

const CLIP_FIELDS = new Set(['name', 'bpm', 'duration_s']);

function fail(message) {
  throw new MotionInputError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cloneParameters(parameters) {
  return {
    transition_s: parameters.transition_s,
    bpm_mode: parameters.bpm_mode,
    bpm_range: [parameters.bpm_range[0], parameters.bpm_range[1]],
    acceleration_range: [parameters.acceleration_range[0], parameters.acceleration_range[1]],
    twist_enabled: parameters.twist_enabled,
    twist_range: [parameters.twist_range[0], parameters.twist_range[1]],
    twist_phase: parameters.twist_phase,
    twist_ecc: parameters.twist_ecc,
  };
}

function readDuration(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 30) {
    fail(`${name} must be a number from 0.1 to 30`);
  }
  return value;
}

function readBpm(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) {
    fail('bpm must be an integer from 1 to 200');
  }
  return value;
}

function readPair(value, name, min, max, integer) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(`${name} must be a pair of numbers`);
  }

  const parts = value.map((part, index) => {
    if (typeof part !== 'number' || !Number.isFinite(part) || part < min || part > max) {
      fail(`${name}[${index}] must be a number from ${min} to ${max}`);
    }
    if (integer && !Number.isInteger(part)) {
      fail(`${name}[${index}] must be an integer from ${min} to ${max}`);
    }
    return part;
  });

  if (parts[0] > parts[1]) {
    fail(`${name} low must be <= high`);
  }

  return parts;
}

function normalizeClip(clip, index) {
  if (!isPlainObject(clip)) {
    fail(`clips[${index}] must be an object`);
  }

  const unknown = Object.keys(clip).filter((key) => !CLIP_FIELDS.has(key));
  if (unknown.length) {
    fail(`Unknown clip field: ${unknown.join(', ')}`);
  }

  if (!Object.prototype.hasOwnProperty.call(clip, 'name') || typeof clip.name !== 'string' || !STROKE_SET.has(clip.name)) {
    fail(`Unknown stroke: ${clip?.name}`);
  }

  const normalized = {
    name: clip.name,
    duration_s: DEFAULT_DURATION_S,
    bpmSpecified: false,
    specifiedBpm: null,
  };

  if (Object.prototype.hasOwnProperty.call(clip, 'duration_s')) {
    normalized.duration_s = readDuration(clip.duration_s, 'duration_s');
  }

  if (Object.prototype.hasOwnProperty.call(clip, 'bpm')) {
    normalized.specifiedBpm = readBpm(clip.bpm);
    normalized.bpmSpecified = true;
  }

  return normalized;
}

/**
 * Validate a play request. Throws MotionInputError before any motion should start.
 * Omitted optional fields are copied from currentParameters.
 */
export function normalizePlay(input, currentParameters = INITIAL_PARAMETERS) {
  if (!isPlainObject(input)) {
    fail('play expects an object');
  }

  const unknown = Object.keys(input).filter((key) => !PLAY_FIELDS.has(key));
  if (unknown.length) {
    fail(`Unknown field: ${unknown.join(', ')}`);
  }

  if (!Array.isArray(input.clips) || input.clips.length === 0) {
    fail('clips must contain at least one animation');
  }

  const clips = input.clips.map((clip, index) => normalizeClip(clip, index));
  const parameters = cloneParameters(currentParameters);

  if (Object.prototype.hasOwnProperty.call(input, 'transition_s')) {
    parameters.transition_s = readDuration(input.transition_s, 'transition_s');
  }

  if (Object.prototype.hasOwnProperty.call(input, 'bpm_mode')) {
    if (input.bpm_mode !== 'transition' && input.bpm_mode !== 'continuous') {
      fail('bpm_mode must be transition or continuous');
    }
    parameters.bpm_mode = input.bpm_mode;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'bpm_range')) {
    parameters.bpm_range = readPair(input.bpm_range, 'bpm_range', 1, 200, true);
  }

  if (Object.prototype.hasOwnProperty.call(input, 'acceleration_range')) {
    parameters.acceleration_range = readPair(input.acceleration_range, 'acceleration_range', 0, 200, false);
  }

  if (Object.prototype.hasOwnProperty.call(input, 'twist_enabled')) {
    if (typeof input.twist_enabled !== 'boolean') {
      fail('twist_enabled must be a boolean');
    }
    parameters.twist_enabled = input.twist_enabled;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'twist_range')) {
    parameters.twist_range = readPair(input.twist_range, 'twist_range', 0, 1, false);
  }

  if (Object.prototype.hasOwnProperty.call(input, 'twist_phase')) {
    const { twist_phase: phase } = input;
    if (typeof phase !== 'number' || !Number.isFinite(phase) || phase < -4 || phase > 4) {
      fail('twist_phase must be a number from -4 to 4');
    }
    parameters.twist_phase = phase;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'twist_ecc')) {
    const { twist_ecc: ecc } = input;
    if (typeof ecc !== 'number' || !Number.isFinite(ecc) || ecc < -1 || ecc > 1) {
      fail('twist_ecc must be a number from -1 to 1');
    }
    parameters.twist_ecc = ecc;
  }

  return { clips, parameters };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * BPM for one clip at elapsed seconds.
 * A clip that names bpm keeps that integer.
 * Otherwise the value is 60, unless bpm_mode is continuous: then it moves from 60
 * toward the high end of bpm_range at acceleration_range's high end (bpm/s)
 * and is clamped inside bpm_range.
 */
export function bpmAt(elapsedSeconds, parameters, specifiedBpm = null) {
  if (specifiedBpm != null) {
    return specifiedBpm;
  }

  if (parameters.bpm_mode !== 'continuous') {
    return DEFAULT_BPM;
  }

  const [low, high] = parameters.bpm_range;
  const accel = parameters.acceleration_range[1];
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
  const origin = DEFAULT_BPM;
  const target = high;
  let value = origin;

  if (accel > 0 && origin !== target) {
    const direction = Math.sign(target - origin);
    value = origin + (direction * accel * elapsed);
    value = direction > 0 ? Math.min(value, target) : Math.max(value, target);
  }

  return clamp(value, low, high);
}
