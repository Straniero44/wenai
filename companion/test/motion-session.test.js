import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Ayva, TempestStroke } from '../vendor/ayvajs/index.js';
import { INTERRUPT_SPEED, MotionSession, strokeInput } from '../src/motion-session.js';
import {
  DEFAULT_BPM,
  DEFAULT_DURATION_S,
  INITIAL_PARAMETERS,
  STROKE_NAMES,
  bpmAt,
} from '../src/parameters.js';

class VirtualClock {
  constructor() {
    this.time = 0;
    this.pending = [];
  }

  now() {
    return this.time;
  }

  sleep(seconds) {
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    return new Promise((resolve) => {
      this.pending.push({ at: this.time + delay, resolve });
    });
  }

  async advance(seconds) {
    const end = this.time + seconds;
    let steps = 0;
    let zeroStreak = 0;

    while (steps < 20000) {
      steps += 1;
      const index = soonestIndex(this.pending, end);
      if (index < 0) {
        break;
      }

      const next = this.pending.splice(index, 1)[0];
      const zeroDelay = next.at <= this.time + 1e-9;
      zeroStreak = zeroDelay ? zeroStreak + 1 : 0;
      if (zeroStreak > 500) {
        throw new Error(`VirtualClock zero-delay loop at t=${this.time}`);
      }

      this.time = Math.max(this.time, next.at);
      next.resolve(true);
      await settle();
    }

    if (steps >= 20000) {
      throw new Error(`VirtualClock step budget exceeded at t=${this.time}`);
    }

    this.time = Math.max(this.time, end);
    await settle();
  }
}

function soonestIndex(pending, end) {
  let best = -1;
  let bestAt = Infinity;

  for (let index = 0; index < pending.length; index += 1) {
    const at = pending[index].at;
    if (at <= end + 1e-9 && at < bestAt) {
      best = index;
      bestAt = at;
    }
  }

  return best;
}

function settle() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createSpeedControl(initial) {
  const state = { ...initial };
  const sets = [];
  return {
    sets,
    get() {
      return { ...state };
    },
    set(patch) {
      sets.push({ ...patch });
      if (Object.hasOwn(patch, 'enabled')) state.enabled = patch.enabled;
      if (Object.hasOwn(patch, 'maxUnitsPerSecond')) state.maxUnitsPerSecond = patch.maxUnitsPerSecond;
    },
    snapshot() {
      return { ...state };
    },
  };
}

function createSession(options = {}) {
  const writes = [];
  const clock = new VirtualClock();
  const output = {
    write(line) {
      writes.push(line);
    },
  };
  const speed = options.speed ?? null;
  const session = new MotionSession({
    output,
    timer: clock,
    ...(speed ? { speedCap: speed } : {}),
    ...(options.travel ? { travel: options.travel } : {}),
  });
  return { session, clock, writes, speed };
}

function recordMotion(session) {
  const events = [];
  const originalHome = session.ayva.home.bind(session.ayva);
  const originalDo = session.ayva.do.bind(session.ayva);

  session.ayva.home = async (...args) => {
    events.push('home');
    return originalHome(...args);
  };

  session.ayva.do = (behavior) => {
    events.push(`do:${session.current?.name ?? 'none'}`);
    return originalDo(behavior);
  };

  return events;
}

describe('motion session', { concurrency: 1 }, () => {
  test('catalog has the 42 design names and six-axis travel is 0.20–0.80', () => {
    assert.equal(STROKE_NAMES.length, 42);
    assert.equal(STROKE_NAMES.includes('orbit-grind'), true);
    assert.equal(STROKE_NAMES.includes('not-a-stroke'), false);
    assert.deepEqual(Object.keys(TempestStroke.library), [...STROKE_NAMES]);

    const { session } = createSession();
    for (const axis of ['L0', 'L1', 'L2', 'R0', 'R1', 'R2']) {
      const config = session.ayva.getAxis(axis);
      assert.equal(config.min, 0.2);
      assert.equal(config.max, 0.8);
    }

    assert.equal(session.ayva.getAxis('A0').min, 0);
    assert.equal(session.ayva.getAxis('A0').max, 1);
    assert.equal(session.state, 'idle');
    assert.equal(session.bpm, null);
    assert.deepEqual(session.parameters, {
      transition_s: 2,
      bpm_mode: 'transition',
      bpm_range: [20, 60],
      acceleration_range: [0, 20],
      twist_enabled: false,
      twist_range: [0, 1],
      twist_phase: 0,
      twist_ecc: 0,
    });
  });

  test('travel limits come from config aliases and fall back per axis', () => {
    const travel = {
      stroke: [0, 1],
      surge: [0.1, 0.9],
      sway: [0.3, 0.7],
      twist: [0.4, 0.6],
      roll: [0, 0.5],
      pitch: [0.25, 0.75],
    };
    const { session } = createSession({ travel });
    for (const [axis, [min, max]] of Object.entries({
      L0: [0, 1],
      L1: [0.1, 0.9],
      L2: [0.3, 0.7],
      R0: [0.4, 0.6],
      R1: [0, 0.5],
      R2: [0.25, 0.75],
    })) {
      const config = session.ayva.getAxis(axis);
      assert.equal(config.min, min, `${axis} min`);
      assert.equal(config.max, max, `${axis} max`);
    }

    const partial = createSession({ travel: { stroke: [0.05, 0.95] } }).session;
    assert.equal(partial.ayva.getAxis('L0').min, 0.05);
    assert.equal(partial.ayva.getAxis('L0').max, 0.95);
    assert.equal(partial.ayva.getAxis('L1').min, 0.2);
    assert.equal(partial.ayva.getAxis('L1').max, 0.8);
  });

  test('setTravel updates one axis, orders the pair, and rejects an unchanged window', () => {
    const { session } = createSession();
    const next = session.setTravel({ stroke: [0.9, 0.1] });
    assert.deepEqual(next.stroke, [0.1, 0.9]);
    assert.equal(session.ayva.getAxis('L0').min, 0.1);
    assert.equal(session.ayva.getAxis('L0').max, 0.9);
    assert.equal(session.ayva.getAxis('L1').min, 0.2);
    assert.equal(session.ayva.getAxis('L1').max, 0.8);
    assert.deepEqual(session.travel.surge, [0.2, 0.8]);

    assert.throws(() => session.setTravel({ stroke: [0.4, 0.4] }), RangeError);
    assert.equal(session.ayva.getAxis('L0').min, 0.1);
    assert.throws(() => session.setTravel({ valve: [0, 1] }), TypeError);
    assert.equal(session.ayva.getAxis('L0').max, 0.9);
  });

  test('omitted bpm and duration_s default to 60 and 30 for one clip and for each clip in a list', () => {
    const { session } = createSession();

    session.play({ clips: [{ name: 'orbit-grind' }] });
    assert.equal(session.state, 'playing');
    assert.deepEqual(session.current, {
      name: 'orbit-grind',
      bpm: DEFAULT_BPM,
      duration_s: DEFAULT_DURATION_S,
    });
    assert.equal(session.bpm, 60);
    assert.equal(session.queue.length, 0);
    assert.equal(session.parameters.transition_s, INITIAL_PARAMETERS.transition_s);

    session.play({
      clips: [
        { name: 'vortex-tease' },
        { name: 'long-stroke-1' },
      ],
    });
    assert.equal(session.state, 'braking');
    assert.equal(session.current.name, 'orbit-grind');
    assert.deepEqual(session.queue, [
      { name: 'vortex-tease', bpm: 60, duration_s: 30 },
      { name: 'long-stroke-1', bpm: 60, duration_s: 30 },
    ]);
  });

  test('explicit bpm and duration are kept, and a later play keeps omitted session fields', () => {
    const { session } = createSession();

    session.play({
      clips: [
        { name: 'orbit-grind' },
        { name: 'long-stroke-1', bpm: 45, duration_s: 12 },
      ],
      transition_s: 4,
      bpm_mode: 'continuous',
      bpm_range: [30, 90],
      acceleration_range: [1, 15],
      twist_enabled: true,
      twist_range: [0.25, 0.75],
      twist_phase: 1,
      twist_ecc: 0.3,
    });

    assert.deepEqual(session.current, {
      name: 'orbit-grind',
      bpm: 60,
      duration_s: 30,
    });
    assert.deepEqual(session.queue, [
      { name: 'long-stroke-1', bpm: 45, duration_s: 12 },
    ]);
    assert.equal(session.parameters.transition_s, 4);
    assert.equal(session.parameters.bpm_mode, 'continuous');
    assert.deepEqual(session.parameters.bpm_range, [30, 90]);
    assert.deepEqual(session.parameters.acceleration_range, [1, 15]);
    assert.equal(session.parameters.twist_enabled, true);
    assert.deepEqual(session.parameters.twist_range, [0.25, 0.75]);
    assert.equal(session.parameters.twist_phase, 1);
    assert.equal(session.parameters.twist_ecc, 0.3);

    session.play({ clips: [{ name: 'long-stroke-2', duration_s: 5 }] });
    assert.equal(session.parameters.transition_s, 4);
    assert.equal(session.parameters.bpm_mode, 'continuous');
    assert.equal(session.parameters.twist_enabled, true);
    assert.deepEqual(session.parameters.bpm_range, [30, 90]);
  });

  test('rejects an unknown stroke, empty clips, and out-of-range values without starting motion', () => {
    const { session, writes } = createSession();
    const events = recordMotion(session);

    assert.throws(() => session.play({ clips: [{ name: 'not-a-stroke' }] }), /Unknown stroke: not-a-stroke/);
    assert.throws(() => session.play({ clips: [] }), /at least one animation/);
    assert.throws(() => session.play({}), /at least one animation/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', bpm: 0 }] }), /bpm/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', bpm: 201 }] }), /bpm/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', bpm: 1.5 }] }), /bpm/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', bpm: '60' }] }), /bpm/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', duration_s: 0.05 }] }), /duration_s/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', duration_s: 30.1 }] }), /duration_s/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind' }], transition_s: 0 }), /transition_s/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind' }], bpm_mode: 'free' }), /bpm_mode/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind' }], bpm_range: [60, 20] }), /bpm_range/);
    assert.throws(() => session.play({ clips: [{ name: 'orbit-grind', script: 'ayva.do()' }] }), /Unknown clip field/);

    assert.equal(session.state, 'idle');
    assert.equal(events.length, 0);
    assert.equal(writes.length, 0);

    session.play({ clips: [{ name: 'orbit-grind', duration_s: 5 }], transition_s: 3 });
    assert.throws(() => session.play({ clips: [{ name: 'nope' }], transition_s: 9 }), /Unknown stroke/);
    assert.equal(session.state, 'playing');
    assert.equal(session.current.name, 'orbit-grind');
    assert.equal(session.parameters.transition_s, 3);
    assert.deepEqual(events, ['do:orbit-grind']);

    session.play({
      clips: [
        { name: 'swirl-tease', bpm: 200, duration_s: 0.1 },
        { name: 'swirl-tease', bpm: 1, duration_s: 30 },
      ],
    });
    assert.equal(session.state, 'braking');
    assert.equal(session.current.name, 'orbit-grind');
    assert.deepEqual(session.queue, [
      { name: 'swirl-tease', bpm: 200, duration_s: 0.1 },
      { name: 'swirl-tease', bpm: 1, duration_s: 30 },
    ]);
  });

  test('one clip does not transition; two clips transition in order and do not home between them', async () => {
    const { session, clock, writes } = createSession();
    const events = recordMotion(session);
    const transitions = [];
    const original = TempestStroke.prototype.transition;

    TempestStroke.prototype.transition = function transitionSpy(config, bpm, duration, ...rest) {
      transitions.push({
        config,
        duration,
        isFunction: typeof bpm === 'function',
        bpmValue: typeof bpm === 'function' ? bpm() : bpm,
      });
      return original.call(this, config, bpm, duration, ...rest);
    };

    try {
      session.play({
        clips: [
          { name: 'orbit-grind', duration_s: 0.2, bpm: 40 },
          { name: 'long-stroke-1', duration_s: 0.2, bpm: 80 },
        ],
        transition_s: 0.25,
      });

      assert.equal(session.state, 'playing');
      assert.deepEqual(events, ['do:orbit-grind']);
      assert.equal(transitions.length, 0);
      assert.equal(session.bpm, 40);
      assert.equal(events.includes('home'), false);

      await clock.advance(0.2);

      assert.equal(transitions.length, 1);
      assert.equal(transitions[0].config, 'long-stroke-1');
      assert.equal(transitions[0].duration, 0.25);
      assert.equal(transitions[0].isFunction, true);
      assert.equal(transitions[0].bpmValue, 80);
      assert.equal(session.current.name, 'long-stroke-1');
      assert.equal(session.current.bpm, 80);
      assert.equal(events.includes('home'), false);
      assert.deepEqual(events, ['do:orbit-grind', 'do:long-stroke-1']);

      await clock.advance(0.25 + 0.2);
      assert.equal(session.state, 'homing');
      assert.equal(session.current, null);
      assert.equal(session.queue.length, 0);
      assert.equal(transitions.length, 1);
      assert.equal(events.filter((event) => event === 'home').length, 1);
      assert.deepEqual(events, ['do:orbit-grind', 'do:long-stroke-1', 'home']);
      assert.ok(writes.some((line) => /L0\d{4}/.test(line)));

      await clock.advance(3);
      assert.equal(session.state, 'idle');
      assert.equal(session.current, null);
      assert.equal(events.filter((event) => event === 'home').length, 1);
    } finally {
      TempestStroke.prototype.transition = original;
    }
  });

  test('a play during playback slows for one second, homes, waits one second, then starts the new list', async () => {
    const speed = createSpeedControl({
      enabled: false,
      maxUnitsPerSecond: 2,
      ceiling: 10,
    });
    const { session, clock } = createSession({ speed });
    const events = recordMotion(session);

    session.play({
      clips: [
        { name: 'orbit-grind', duration_s: 30 },
        { name: 'long-stroke-1', duration_s: 30 },
      ],
    });
    assert.deepEqual(events, ['do:orbit-grind']);
    assert.equal(session.queue[0].name, 'long-stroke-1');

    session.play({ clips: [{ name: 'vortex-tease', duration_s: 30 }] });
    assert.equal(session.state, 'braking');
    assert.equal(session.current.name, 'orbit-grind');
    assert.deepEqual(session.queue.map((clip) => clip.name), ['vortex-tease']);
    assert.equal(events.includes('home'), false);
    assert.equal(speed.snapshot().enabled, true);
    assert.equal(speed.snapshot().maxUnitsPerSecond, INTERRUPT_SPEED);

    await clock.advance(1);
    assert.equal(session.state, 'homing');
    assert.equal(session.current, null);
    assert.equal(events.includes('do:vortex-tease'), false);
    assert.equal(events.filter((event) => event === 'home').length, 1);
    assert.equal(speed.snapshot().enabled, true);

    await clock.advance(1);
    assert.equal(session.state, 'homing');
    assert.equal(events.includes('do:vortex-tease'), false);

    let steps = 0;
    while (session.current?.name !== 'vortex-tease' && steps < 12) {
      await clock.advance(0.5);
      steps += 1;
    }
    assert.equal(session.state, 'playing');
    assert.equal(session.current.name, 'vortex-tease');
    assert.equal(session.current.duration_s, 30);
    assert.equal(session.queue.length, 0);
    assert.equal(events.includes('do:long-stroke-1'), false);
    assert.deepEqual(events, ['do:orbit-grind', 'home', 'do:vortex-tease']);
    assert.equal(speed.snapshot().enabled, true);
    assert.equal(speed.snapshot().maxUnitsPerSecond, INTERRUPT_SPEED);

    await clock.advance(1);
    assert.equal(session.state, 'playing');
    assert.equal(session.current.name, 'vortex-tease');
    assert.equal(speed.snapshot().enabled, false);
    assert.equal(speed.snapshot().maxUnitsPerSecond, 2);
  });

  test('reset homes and returns to idle without starting another animation', async () => {
    const { session, clock } = createSession();
    const events = recordMotion(session);

    const idleDone = session.reset();
    assert.equal(session.state, 'homing');
    assert.equal(events.includes('do:orbit-grind'), false);
    await clock.advance(1);
    await idleDone;
    assert.equal(session.state, 'idle');
    assert.equal(session.current, null);
    assert.deepEqual(events, ['home']);

    session.play({
      clips: [
        { name: 'orbit-grind', duration_s: 30 },
        { name: 'long-stroke-1', duration_s: 30 },
      ],
    });
    const done = session.reset();
    assert.equal(session.state, 'braking');
    assert.equal(session.current.name, 'orbit-grind');
    assert.equal(session.queue.length, 0);
    assert.equal(events.filter((event) => event === 'home').length, 1);

    await clock.advance(1);
    assert.equal(session.state, 'homing');
    assert.equal(session.current, null);

    await clock.advance(3);
    await done;

    assert.equal(session.state, 'idle');
    assert.equal(session.current, null);
    assert.equal(session.queue.length, 0);
    assert.equal(events.includes('do:long-stroke-1'), false);
    assert.equal(events.filter((event) => event === 'do:orbit-grind').length, 1);
    assert.equal(events.at(-1), 'home');
  });

  test('continuous mode ramps only when the clip omits bpm, and the provider reads the live value', async () => {
    const { session, clock } = createSession();
    let behavior = null;
    const originalDo = session.ayva.do.bind(session.ayva);
    session.ayva.do = (next) => {
      behavior = next;
      return originalDo(next);
    };

    session.play({
      clips: [{ name: 'orbit-grind', duration_s: 10 }],
      bpm_mode: 'continuous',
      bpm_range: [20, 120],
      acceleration_range: [0, 60],
    });

    assert.equal(session.bpm, 60);
    assert.equal(behavior.bpm, 60);
    await clock.advance(1);
    assert.equal(session.bpm, 120);
    assert.ok(Math.abs(behavior.bpm - 120) < 5);

    session.play({
      clips: [{ name: 'long-stroke-1', bpm: 45, duration_s: 10 }],
      bpm_mode: 'continuous',
      bpm_range: [20, 120],
      acceleration_range: [0, 60],
    });
    await clock.advance(3);
    assert.equal(session.current.name, 'long-stroke-1');
    assert.equal(session.bpm, 45);

    const transitionParameters = {
      ...session.parameters,
      bpm_mode: 'transition',
    };
    assert.equal(bpmAt(5, transitionParameters, null), 60);
    assert.equal(bpmAt(5, transitionParameters, 45), 45);
    assert.equal(bpmAt(0, {
      bpm_mode: 'continuous',
      bpm_range: [20, 100],
      acceleration_range: [0, 20],
    }, null), 60);
    assert.equal(bpmAt(1, {
      bpm_mode: 'continuous',
      bpm_range: [20, 100],
      acceleration_range: [0, 20],
    }, null), 80);
    assert.equal(bpmAt(10, {
      bpm_mode: 'continuous',
      bpm_range: [20, 100],
      acceleration_range: [0, 20],
    }, null), 100);
    assert.equal(bpmAt(0, {
      bpm_mode: 'continuous',
      bpm_range: [20, 40],
      acceleration_range: [0, 20],
    }, null), 40);
  });

  test('twist_enabled adds tempest twist only to a stroke that has no R0', async (t) => {
    const saved = TempestStroke.library['orbit-grind'];
    const withoutTwist = structuredClone(saved);
    delete withoutTwist.R0;
    TempestStroke.update('orbit-grind', withoutTwist);
    t.after(() => {
      TempestStroke.restoreLibrary();
    });

    const enabled = {
      ...INITIAL_PARAMETERS,
      twist_enabled: true,
      twist_range: [0.2, 0.7],
      twist_phase: 2,
      twist_ecc: -0.4,
    };
    const kept = strokeInput('orbit-grind', { ...enabled, twist_enabled: false });
    assert.equal(kept, 'orbit-grind');

    TempestStroke.restoreLibrary();
    const withLibraryTwist = strokeInput('long-stroke-1', enabled);
    assert.equal(withLibraryTwist, 'long-stroke-1');

    TempestStroke.update('orbit-grind', withoutTwist);
    const added = strokeInput('orbit-grind', enabled);
    assert.equal(added.R0.from, 0.2);
    assert.equal(added.R0.to, 0.7);
    assert.equal(added.R0.phase, 2);
    assert.equal(added.R0.ecc, -0.4);
    assert.equal(added.R0.motion, Ayva.tempestMotion);
    assert.equal(Object.prototype.hasOwnProperty.call(TempestStroke.library['orbit-grind'], 'R0'), false);

    const { session } = createSession();
    let behavior = null;
    const originalDo = session.ayva.do.bind(session.ayva);
    session.ayva.do = (next) => {
      behavior = next;
      return originalDo(next);
    };

    session.play({
      clips: [{ name: 'orbit-grind', duration_s: 1 }],
      twist_enabled: true,
      twist_range: [0.2, 0.7],
      twist_phase: 2,
      twist_ecc: -0.4,
    });

    assert.equal(behavior.axes.R0.from, 0.2);
    assert.equal(behavior.axes.R0.to, 0.7);
    assert.equal(behavior.axes.R0.phase, 2);
    assert.equal(behavior.axes.R0.ecc, -0.4);
    assert.equal(behavior.axes.R0.motion, Ayva.tempestMotion);

    const other = createSession().session;
    let keptBehavior = null;
    const originalKept = other.ayva.do.bind(other.ayva);
    other.ayva.do = (next) => {
      keptBehavior = next;
      return originalKept(next);
    };
    other.play({
      clips: [{ name: 'long-stroke-1', duration_s: 1 }],
      twist_enabled: true,
      twist_phase: 2,
      twist_ecc: -0.4,
    });
    assert.equal(keptBehavior.axes.R0.from, TempestStroke.library['long-stroke-1'].R0.from);
    assert.equal(keptBehavior.axes.R0.to, TempestStroke.library['long-stroke-1'].R0.to);
    assert.notEqual(keptBehavior.axes.R0.phase, 2);
  });
});
