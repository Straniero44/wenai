/**
 * Ordered TempestStroke playback for the companion motion service.
 * Behavior source: docs/ai-companion-design.md sections 5, 8, and 10.
 */

import { Ayva, TempestStroke } from '../vendor/ayvajs/index.js';
import { normalizeTravelPatch } from './config.js';
import {
  DEFAULT_BPM,
  DEFAULT_TRAVEL,
  INITIAL_PARAMETERS,
  TRAVEL_AXES,
  TRAVEL_AXIS_KEYS,
  bpmAt,
  cloneParameters,
  normalizePlay,
} from './parameters.js';

/** Playback is still moving when a new command arrives. Keep this slow for one second before homing. */
export const INTERRUPT_BUFFER_S = 1;

/** Stay at the home position before the replacement animation starts. */
export const INTERRUPT_HOLD_S = 1;

/** Full-scale units per second. The temporary cap stays on until the replacement animation has played for one second. */
export const INTERRUPT_SPEED = 1;

/** Keep the temporary cap for this long after the replacement animation starts. */
export const INTERRUPT_RELEASE_S = 1;

function createRealtimeTimer() {
  return {
    now() {
      return performance.now() / 1000;
    },

    sleep(seconds) {
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      return new Promise((resolve) => {
        setTimeout(resolve, delay * 1000);
      });
    },
  };
}

function presentClip(clip) {
  return {
    name: clip.name,
    duration_s: clip.duration_s,
    bpm: clip.bpmSpecified ? clip.specifiedBpm : DEFAULT_BPM,
  };
}

/**
 * Build the value passed to TempestStroke.
 * twist_enabled adds a sine twist only when the library stroke has no R0.
 * Strokes that already define R0 keep the library data.
 */
export function strokeInput(name, parameters) {
  const libraryConfig = TempestStroke.library[name];

  if (!parameters.twist_enabled || Object.prototype.hasOwnProperty.call(libraryConfig, 'R0')) {
    return name;
  }

  const [from, to] = parameters.twist_range;

  return {
    ...libraryConfig,
    R0: {
      from,
      to,
      phase: parameters.twist_phase,
      ecc: parameters.twist_ecc,
      motion: Ayva.tempestMotion,
    },
  };
}

export class MotionSession {
  #parameters = cloneParameters(INITIAL_PARAMETERS);

  #queue = [];

  #pending = null;

  #activeClip = null;

  #clipStartedAt = 0;

  #stroke = null;

  #generation = 0;

  #cancelArm = null;

  #brakeSaved = null;

  #brakeToken = 0;

  #travel = {};

  /**
   * @param {object} options
   * @param {{ write: (line: string) => void }} options.output device that receives ayvajs TCode lines
   * @param {{ now: () => number, sleep: (seconds?: number) => Promise<unknown> }} [options.timer]
   * @param {Ayva} [options.ayva]
   * @param {{ get: () => object, set: (patch: object) => void }} [options.speedCap]
   * @param {object} [options.travel] config-shaped travel limits, keyed by device alias
   */
  constructor(options = {}) {
    const output = options.output;

    if (!output || typeof output.write !== 'function') {
      throw new TypeError('MotionSession requires an output with write()');
    }

    this.timer = options.timer ?? createRealtimeTimer();
    this.ayva = options.ayva ?? new Ayva().defaultConfiguration();
    this.ayva.setTimer(this.timer);
    this.ayva.addOutput(output);
    this.output = output;
    this.speedCap = options.speedCap ?? null;
    this.state = 'idle';
    this.lastError = null;

    for (const axis of TRAVEL_AXES) {
      const key = TRAVEL_AXIS_KEYS[axis];
      const [from, to] = options.travel?.[key] ?? DEFAULT_TRAVEL;
      this.ayva.updateLimits(axis, from, to);
      this.#travel[key] = [Math.min(from, to), Math.max(from, to)];
    }
  }

  /** Six-axis windows currently applied to Ayva, each pair ordered low to high. */
  get travel() {
    return Object.fromEntries(
      TRAVEL_AXES.map((axis) => {
        const key = TRAVEL_AXIS_KEYS[axis];
        const pair = this.#travel[key];
        return [key, [pair[0], pair[1]]];
      }),
    );
  }

  /**
   * Replace one or more axis windows and apply them on the next TCode write.
   * Invalid input throws before any axis changes.
   */
  setTravel(update) {
    const patch = normalizeTravelPatch(update);
    const next = this.travel;
    for (const [key, pair] of Object.entries(patch)) next[key] = pair;
    for (const axis of TRAVEL_AXES) {
      const key = TRAVEL_AXIS_KEYS[axis];
      const [min, max] = next[key];
      this.ayva.updateLimits(axis, min, max);
    }
    this.#travel = next;
    return this.travel;
  }

  get parameters() {
    return cloneParameters(this.#parameters);
  }

  /** Live BPM of the clip that is playing. TempestStroke reads this on each slice. */
  get bpm() {
    if ((this.state !== 'playing' && this.state !== 'braking') || !this.#activeClip) {
      return null;
    }

    const specified = this.#activeClip.bpmSpecified ? this.#activeClip.specifiedBpm : null;
    return bpmAt(this.timer.now() - this.#clipStartedAt, this.#parameters, specified);
  }

  get current() {
    if ((this.state !== 'playing' && this.state !== 'braking') || !this.#activeClip) {
      return null;
    }

    return {
      name: this.#activeClip.name,
      duration_s: this.#activeClip.duration_s,
      bpm: this.bpm,
    };
  }

  /**
   * Clips still waiting. While homing for a new play, this is the accepted list.
   * The list that was cancelled is not included.
   */
  get queue() {
    const source = this.#pending ?? this.#queue;
    return source.map(presentClip);
  }

  /**
   * Start clips. Invalid input throws and leaves the current motion running.
   * A play that arrives while moving slows the output for one second, homes, waits one second, then starts the new list.
   */
  play(input) {
    const normalized = normalizePlay(input, this.#parameters);

    if (this.state === 'fault') {
      throw new Error('Session is faulted');
    }

    this.#parameters = normalized.parameters;
    const generation = this.#generation + 1;
    this.#generation = generation;

    if (this.state === 'playing' || this.state === 'braking' || this.state === 'homing') {
      this.#pending = normalized.clips;
      this.#engageBrake();
      if (this.state === 'playing' || this.state === 'braking') {
        this.state = 'braking';
      }
      this.#track(this.#interrupt(normalized.clips, generation), generation);
    } else {
      this.#track(this.#run(normalized.clips, generation, null), generation);
    }

    return {
      state: this.state,
      current: this.current,
      queue: this.queue,
      bpm: this.bpm,
      parameters: this.parameters,
    };
  }

  /**
   * Home and return to idle. Does not start another animation.
   * Resolves when the home has finished and the session is idle, unless a newer command superseded it.
   */
  reset() {
    if (this.state === 'fault') {
      return Promise.reject(new Error('Session is faulted'));
    }

    const generation = this.#generation + 1;
    this.#generation = generation;

    if (this.state === 'playing' || this.state === 'braking') {
      this.#pending = null;
      this.#queue = [];
      this.#engageBrake();
      this.state = 'braking';
      const done = this.#interrupt(null, generation);
      this.#track(done, generation);
      return done;
    }

    const done = this.#beginHome(null, generation);
    return done;
  }

  /**
   * Slow the live motion, then home. A replacement list waits one second at center before it plays.
   * The caller's speed cap stays in force until the replacement animation has played for one second.
   */
  async #interrupt(clips, generation) {
    if (this.state === 'braking') {
      const eased = await this.#arm(INTERRUPT_BUFFER_S);
      if (!eased || this.#generation !== generation) {
        return;
      }
    }

    if (this.#generation !== generation) {
      return;
    }

    await this.#beginHome(clips, generation);
  }

  #engageBrake() {
    if (!this.speedCap || typeof this.speedCap.get !== 'function' || typeof this.speedCap.set !== 'function') {
      return;
    }

    if (!this.#brakeSaved) {
      this.#brakeSaved = { ...this.speedCap.get() };
      this.#brakeToken += 1;
    }

    const saved = this.#brakeSaved;
    const ceiling = Number.isFinite(saved.ceiling) ? saved.ceiling : INTERRUPT_SPEED;
    let maxUnitsPerSecond = Math.min(INTERRUPT_SPEED, ceiling);
    if (saved.enabled && saved.maxUnitsPerSecond < maxUnitsPerSecond) {
      maxUnitsPerSecond = saved.maxUnitsPerSecond;
    }

    this.speedCap.set({ enabled: true, maxUnitsPerSecond });
  }

  #restoreBrake() {
    if (!this.#brakeSaved || !this.speedCap || typeof this.speedCap.set !== 'function') {
      this.#brakeSaved = null;
      return;
    }

    const saved = this.#brakeSaved;
    this.#brakeSaved = null;
    this.speedCap.set({
      enabled: saved.enabled,
      maxUnitsPerSecond: saved.maxUnitsPerSecond,
    });
  }

  #releaseBrakeLater(generation, token) {
    this.timer.sleep(INTERRUPT_RELEASE_S).then(() => {
      if (this.#generation !== generation || this.#brakeToken !== token || !this.#brakeSaved) {
        return;
      }
      this.#restoreBrake();
    });
  }

  #beginHome(clips, generation) {
    this.#disarm();
    this.#queue = [];
    this.#activeClip = null;
    this.#stroke = null;
    this.#pending = clips;
    this.state = 'homing';
    this.ayva.stop();
    const done = this.#afterHome(clips, generation);
    this.#track(done, generation);
    return done;
  }

  async #afterHome(clips, generation) {
    try {
      await this.ayva.home();
    } catch (error) {
      if (this.#generation === generation) {
        this.#fail(error);
      }
      return;
    }

    if (this.#generation !== generation) {
      return;
    }

    if (!clips) {
      this.#pending = null;
      this.#queue = [];
      this.#activeClip = null;
      this.#stroke = null;
      this.state = 'idle';
      this.#restoreBrake();
      return;
    }

    this.#pending = clips;
    const held = await this.#arm(INTERRUPT_HOLD_S);
    if (!held || this.#generation !== generation) {
      return;
    }

    await this.#run(clips, generation, null);
  }

  async #run(clips, generation, previousStroke) {
    let stroke = previousStroke;

    for (let index = 0; index < clips.length; index += 1) {
      if (this.#generation !== generation) {
        return;
      }

      const clip = clips[index];
      this.#pending = null;
      this.#queue = clips.slice(index + 1);
      this.#activeClip = clip;
      this.#clipStartedAt = this.timer.now();
      this.state = 'playing';

      // The library calls this once per slice, so a continuous ramp is visible mid-clip.
      const bpmProvider = () => this.bpm;
      const input = strokeInput(clip.name, this.#parameters);

      if (stroke) {
        // transition() only forwards the Ayva instance when the current stroke is bound.
        if (!stroke.ayva) {
          stroke.bind(this.ayva);
        }
        stroke = stroke.transition(input, bpmProvider, this.#parameters.transition_s);
        this.#stroke = stroke;
        this.#watch(this.ayva.do(stroke), generation);
        const blended = await this.#arm(this.#parameters.transition_s);
        if (!blended || this.#generation !== generation) {
          return;
        }
      } else {
        stroke = new TempestStroke(input, bpmProvider, 0, () => this.timer.now());
        stroke.bind(this.ayva);
        this.#stroke = stroke;
        this.#watch(this.ayva.do(stroke), generation);
      }

      if (index === 0 && this.#brakeSaved) {
        this.#releaseBrakeLater(generation, this.#brakeToken);
      }

      const played = await this.#arm(clip.duration_s);
      if (!played || this.#generation !== generation) {
        return;
      }
    }

    if (this.#generation !== generation) {
      return;
    }

    await this.#beginHome(null, generation);
  }

  /**
   * Clip and transition delays use the injected timer directly.
   * ayva.sleep() would register with ayva.ready(), which waits until every ayva sleep finishes,
   * and that would stall the stroke.
   */
  #arm(seconds) {
    const generation = this.#generation;
    let settled = false;

    return new Promise((resolve) => {
      const finish = (completed) => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.#cancelArm === cancel) {
          this.#cancelArm = null;
        }
        resolve(completed);
      };

      const cancel = () => finish(false);
      this.#cancelArm = cancel;
      this.timer.sleep(seconds).then(() => {
        if (this.#generation !== generation) {
          finish(false);
          return;
        }
        finish(true);
      });
    });
  }

  #disarm() {
    const cancel = this.#cancelArm;
    this.#cancelArm = null;
    if (cancel) {
      cancel();
    }
  }

  #watch(promise, generation) {
    promise.catch((error) => {
      if (this.#generation === generation && this.state !== 'fault') {
        this.#fail(error);
      }
    });
  }

  #track(work, generation) {
    work.catch((error) => {
      if (this.#generation === generation && this.state !== 'fault') {
        this.#fail(error);
      }
    });
  }

  #fail(error) {
    this.lastError = error;
    this.state = 'fault';
    this.#activeClip = null;
    this.#queue = [];
    this.#pending = null;
    try {
      this.ayva.stop();
    } catch {
      // The original failure is already recorded.
    }
  }
}
