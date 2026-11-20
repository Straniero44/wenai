/* eslint-disable max-classes-per-file */
/* eslint-disable no-use-before-define */
import GeneratorBehavior from './generator-behavior.js';
import Ayva from '../ayva.js';
import StrokeParameterProvider from '../util/stroke-parameter-provider.js';
import defaultTempestStrokeLibrary from '../util/tempest-stroke-library.js';
import {
  createConstantProperty, cloneDeep, has, validNumber
} from '../util/util.js';

/**
 * A behavior that allows specifying oscillatory motion on an arbitrary
 * number of axes with a formula loosely based on orbital motion calculations.
 * See the [Tempest Stroke Tutorial]{@link https://ayvajs.github.io/ayvajs-docs/tutorial-behavior-api-tempest-stroke.html}.
 */
class TempestStroke extends GeneratorBehavior {
  #angle;

  #bpm;

  #bpmProvider;

  #timer;

  #startTime;

  #startAngle;

  get angle () {
    return this.#angle;
  }

  set angle (rad) {
    this.#angle = rad;
  }

  get startAngle () {
    return this.#startAngle;
  }

  set startAngle (angle) {
    this.#startAngle = angle;
  }

  get bpm () {
    return this.#bpm;
  }

  get startTime () {
    return this.#startTime;
  }

  set startTime (time) {
    this.#startTime = time;
  }

  get timer () {
    return this.#timer;
  }

  static #granularity = 36;

  static #library = cloneDeep(defaultTempestStrokeLibrary);

  /**
   * How many slices to divide a stroke (180 degrees) into.
   * This controls how often a bpm provider is called per stroke.
   */
  static set granularity (value) {
    if (!validNumber(value, 1, 180)) {
      throw new Error(`Invalid granularity: ${value}`);
    }

    TempestStroke.#granularity = value;
  }

  static get granularity () {
    return TempestStroke.#granularity;
  }

  static get DEFAULT_PARAMETERS () {
    return {
      from: 0,
      to: 1,
      phase: 0,
      ecc: 0,
      shift: 0,
      noise: 0,
      motion: Ayva.tempestMotion,
    };
  }

  static get DEFAULT_TIMER () {
    return () => performance.now() / 1000;
  }

  static library = new Proxy({}, {
    get: function (target, key, receiver) {
      if (key in TempestStroke.#library) {
        return cloneDeep(TempestStroke.#library[key]);
      }

      return Reflect.get(target, key, receiver);
    },

    ownKeys: function () {
      return Object.keys(TempestStroke.#library);
    },

    getOwnPropertyDescriptor: function (target, key) {
      if (key in TempestStroke.#library) {
        return { enumerable: true, configurable: true, value: this[key] };
      }

      return undefined;
    },
  });

  static computeTargetAngle (angle, startAngle) {
    const traversed = Math.abs(angle - startAngle);
    const strokeCount = Math.floor(traversed / Math.PI);
    const targetAngle = ((strokeCount + 1) * Math.PI) + startAngle;

    if (targetAngle === angle) {
      // Because rounding errors... :(
      return ((strokeCount + 2) * Math.PI) + startAngle;
    }

    return targetAngle;
  }

  static update (key, value) {
    TempestStroke.#library[key] = cloneDeep(value);
  }

  static remove (key) {
    delete TempestStroke.#library[key];
  }

  static restoreLibrary () {
    TempestStroke.#library = cloneDeep(defaultTempestStrokeLibrary);
  }

  /**
   * Create a new tempest stroke with the specified config.
   *
   * @example
   * ayva.do(new TempestStroke({
   *   stroke: {
   *     from: 0,
   *     to: 1,
   *   },
   *   twist: {
   *     from: 0.25,
   *     to: 0.75,
   *     phase: 1,
   *   },
   * }));
   * @param {Object} config
   * @param {Number} [bpm=60]
   * @param {Number} [angle=0]
   * @param {Object} [timer=null]
   * @param {Number} [startTime=null]
   */
  constructor (config, bpm = 60, angle = 0, timer = TempestStroke.DEFAULT_TIMER, startTime = null) {
    super();

    if (typeof config === 'string') {
      if (!has(TempestStroke.library, config)) {
        throw new Error(`No stroke named ${config} found.`);
      }

      config = TempestStroke.library[config]; // eslint-disable-line no-param-reassign
    }

    createConstantProperty(this, 'axes', {});

    Object.keys(config).forEach((axis) => {
      this.#validateNoise(config[axis]);

      createConstantProperty(this.axes, axis, {});

      Object.keys(config[axis]).forEach((property) => {
        createConstantProperty(this.axes[axis], property, config[axis][property]);
      });

      Object.keys(TempestStroke.DEFAULT_PARAMETERS).forEach((property) => {
        if (!has(config[axis], property)) {
          createConstantProperty(this.axes[axis], property, TempestStroke.DEFAULT_PARAMETERS[property]);
        }
      });

      const { from, to } = this.axes[axis];

      createConstantProperty(this.axes[axis], '$current', { from, to });
    });

    this.#angle = angle;
    this.#startAngle = angle;
    this.#bpmProvider = StrokeParameterProvider.createFrom(bpm);
    this.#bpm = this.#bpmProvider.next();
    this.#timer = timer instanceof Function ? {
      now: timer,
    } : timer;
    this.#startTime = startTime;
  }

  * generate (ayva) {
    if (this.#timer) {
      yield* this.#synchronizedGenerate(ayva);
    } else {
      yield* this.#unsynchronizedGenerate(ayva);
    }
  }

  /**
   * Generates moves that will move to the start position of this Tempest Stroke.
   * The speed of the moves default to 1 unit per second.
   *
   * @param {Ayva} ayva
   * @param {Object} [mixin] - configuration options to add or override for each move.
   */
  * start (ayva, mixin) {
    const moves = this.getStartMoves(ayva, mixin);
    yield moves;
  }

  /**
   * Returns an array of moves that will move to the start position of this Tempest Stroke.
   * The speed of the moves default to 1 unit per second.
   *
   * @deprecated since version 0.13.0. Use start() generator instead.
   * @param {Ayva} ayva
   * @param {Object} [mixinConfig] - configuration options to add or override for each move.
   * @returns array of moves
   */
  getStartMoves (ayva, mixinConfig) {
    const speedConfig = {};

    if (!mixinConfig || !(has(mixinConfig, 'speed') || has(mixinConfig, 'duration'))) {
      speedConfig.speed = 1;
    }

    const usedAxesMapByName = {};

    const axesMoves = Object.keys(this.axes).map((axisNameOrAlias) => {
      usedAxesMapByName[ayva.getAxis(axisNameOrAlias).name] = true;
      const params = this.axes[axisNameOrAlias];

      const to = params.motion(
        params.$current.from,
        params.$current.to,
        params.phase,
        params.ecc,
        this.#bpm,
        params.shift + this.#angle
      )({ index: -1, frequency: ayva.frequency });

      return {
        axis: axisNameOrAlias,
        to,
        ...speedConfig,
        ...mixinConfig,
      };
    });

    const unusedAxesMoves = ayva.getAxes()
      .filter((axis) => !usedAxesMapByName[axis.name])
      .map((axis) => {
        const movement = {
          axis: axis.name,
          to: axis.defaultValue,
          ...speedConfig,
          ...mixinConfig,
        };

        if (axis.type === 'boolean') {
          delete movement.speed;
          delete movement.duration;
        }

        return movement;
      });

    return [...axesMoves, ...unusedAxesMoves];
  }

  /**
   * Creates a new TempestStroke that starts with a transition from this TempestStroke.
   *
   * @example
   * const orbit = new TempestStroke('orbit-grind');
   *
   * // Create a transition from an orbit-grind to a 30 BPM vortex-tease that takes 5 seconds.
   * const vortex = orbit.transition('vortex-tease', 30, 5);
   *
   * ayva.do(vortex);
   *
   * @param {Object|String} config - stroke config or name of library config
   * @param {Number|Function} bpm - beats per minute of next stroke (or function that provides bpm)
   * @param {Number} duration - how long the transition should take in seconds
   */
  transition (config, bpm = 60, duration = 1, onTransitionStart = null, onTransitionEnd = null) {
    return new TempestStrokeWithTransition(config, bpm, this, duration, onTransitionStart, onTransitionEnd);
  }

  * #synchronizedGenerate (ayva) {
    this.#startTime = this.#startTime || this.#timer.now();
    const targetAngle = TempestStroke.computeTargetAngle(this.#angle, this.#startAngle);

    while (this.#angle < targetAngle) {
      const time = this.#timer.now() - this.#startTime;
      const bpmFactor = ((time * 2 * Math.PI) / 60);
      const theta = this.#bpm * bpmFactor;
      const originalAngle = this.#angle;
      this.#angle = this.#startAngle + theta;

      this.#setAxisValues(ayva, this.#angle - originalAngle);

      const originalBpm = this.#bpm;
      this.#bpm = this.#bpmProvider.next();

      // Magic maths to make sure bpm changes don't mess up the angle.
      this.#startAngle += (originalBpm - this.#bpm) * bpmFactor;

      yield ayva.period;
    }
  }

  * #unsynchronizedGenerate () {
    const { granularity } = TempestStroke;

    const startAngle = this.#angle;

    for (let i = 0; i < granularity; i++) {
      yield this.#createMoves(i);
      this.#angle = startAngle + (((i + 1) * Math.PI) / granularity);
      this.#bpm = this.#bpmProvider.next();
    }
  }

  #setAxisValues (ayva, angleSlice) {
    const axisValues = {};

    Object.keys(this.axes).forEach((axis) => {
      const params = this.axes[axis];

      axisValues[axis] = params.motion(
        params.$current.from,
        params.$current.to,
        params.phase,
        params.ecc,
        this.#bpm,
        params.shift + this.#angle,
      )({ index: -1, frequency: ayva.frequency });

      this.#generateNoise(params, this.#angle - angleSlice, angleSlice);
    });

    ayva.setValues(axisValues);
  }

  #createMoves () {
    const { granularity } = TempestStroke;
    const moves = Object.keys(this.axes).map((axis) => {
      const params = this.axes[axis];
      const seconds = 30 / granularity;

      const result = {
        axis,
        value: params.motion(
          params.$current.from,
          params.$current.to,
          params.phase,
          params.ecc,
          this.#bpm,
          params.shift + this.#angle,
        ),
        duration: seconds / this.#bpm,
      };

      this.#generateNoise(params, this.#angle, Math.PI / TempestStroke.granularity);

      return result;
    });

    return moves;
  }

  #generateNoise (params, angle, angleSlice) {
    if (params.noise) {
      const { PI } = Math;
      const deg = (radians) => (radians * 180) / PI;
      const getNoise = (which) => (validNumber(params.noise) ? params.noise : params.noise[which] || 0);
      const phaseAngle = (params.phase * PI) / 2;
      const absoluteAngle = phaseAngle + params.shift + angle;

      // We convert the angle to degrees and round so it's asthetically easier to find the transitions.
      const startDegrees = Math.round(deg(absoluteAngle % (PI * 2)));
      const endDegrees = Math.round(startDegrees + deg(angleSlice));
      const movingToStart = startDegrees < 360 && endDegrees >= 360;
      const movingToMid = startDegrees < 180 && endDegrees >= 180;

      if (movingToStart) {
        const noise = getNoise('to');
        const noiseRange = (params.from - params.to) / 2;
        params.$current.to = params.to + noise * noiseRange * Math.random();
      } else if (movingToMid) {
        const noise = getNoise('from');
        const noiseRange = (params.to - params.from) / 2;
        params.$current.from = params.from + noise * noiseRange * Math.random();
      }
    }
  }

  #validateNoise (params) {
    if (has(params, 'noise')) {
      const { noise } = params;
      const error = (value) => {
        throw new Error(`Invalid noise: ${value}`);
      };

      const isObject = typeof noise === 'object';

      if (isObject && has(noise, 'from') && !validNumber(noise.from, 0, 1)) {
        error(noise.from);
      }

      if (isObject && has(noise, 'to') && !validNumber(noise.to, 0, 1)) {
        error(noise.to);
      }

      if (!isObject && !validNumber(noise, 0, 1)) {
        error(noise);
      }
    }
  }
}

class TempestStrokeWithTransition extends TempestStroke {
  #config;

  #transition;

  #onTransitionStart;

  #onTransitionEnd;

  constructor (config, bpmProvider, source, duration, onTransitionStart, onTransitionEnd) {
    super(config, bpmProvider, 0, source.timer, source.startTime);
    this.angle = TempestStrokeTransition.computeTransitionStartAngle(source, duration, this.bpm);

    this.startAngle = this.angle;

    // Magic maths to make sure new stroke's start time meshes well with the
    // new start angle... <3
    const elapsedRadians = source.angle - source.startAngle;
    const elapsed = elapsedRadians / ((source.bpm * 2 * Math.PI) / 60);

    this.startTime += elapsed + duration;
    this.#transition = new TempestStrokeTransition(source, this, duration);
    this.#config = config;
    this.#onTransitionStart = onTransitionStart;
    this.#onTransitionEnd = onTransitionEnd;

    if (source.ayva) {
      this.bind(source.ayva);
      this.#transition.bind(source.ayva);
    }
  }

  * generate (ayva) {
    if (!this.#transition.complete) {
      if (this.#onTransitionStart instanceof Function) {
        this.#onTransitionStart(this.#transition.duration, this.bpm);
      }

      yield* this.#transition();

      if (this.#onTransitionEnd instanceof Function) {
        this.#onTransitionEnd(this.#config, this.bpm);
      }
    }

    yield* super.generate(ayva);
  }
}

class TempestStrokeTransition extends GeneratorBehavior {
  #source;

  #target;

  #duration;

  get duration () {
    return this.#duration;
  }

  constructor (sourceBehavior, targetBehavior, duration) {
    super();
    this.#source = sourceBehavior;
    this.#target = targetBehavior;
    this.#duration = duration;
  }

  * generate (ayva) {
    if (!(ayva instanceof Ayva)) {
      throw new TypeError(`Invalid Ayva instance: ${ayva}`);
    }

    const zeroParamsLinearRotation = {
      ...TempestStroke.DEFAULT_PARAMETERS,
      from: 0.5,
      to: 0.5,
      $current: {
        from: 0.5,
        to: 0.5,
      },
    };

    const zeroParamsAux = {
      ...TempestStroke.DEFAULT_PARAMETERS,
      from: 0,
      to: 0,
      $current: {
        from: 0,
        to: 0,
      },
    };

    const sourceAxes = this.#getAxisMapByName(this.#source.axes, ayva);
    const targetAxes = this.#getAxisMapByName(this.#target.axes, ayva);

    const transitionAxisMoves = {};

    Object.keys(targetAxes).forEach((axis) => {
      const zeroParams = ayva.getAxis(axis).type === 'auxiliary' ? zeroParamsAux : zeroParamsLinearRotation;

      const sourceAxis = sourceAxes[axis] ?? { ...zeroParams };
      const targetAxis = targetAxes[axis];

      transitionAxisMoves[axis] = this.#createTransitionAxisMove(sourceAxis, targetAxis);
    });

    // Catch any dangling axes that were part of source but not part of target.
    Object.keys(sourceAxes).forEach((axis) => {
      if (!transitionAxisMoves[axis]) {
        const zeroParams = ayva.getAxis(axis).type === 'auxiliary' ? zeroParamsAux : zeroParamsLinearRotation;

        const sourceAxis = sourceAxes[axis];
        const targetAxis = { ...zeroParams };

        transitionAxisMoves[axis] = this.#createTransitionAxisMove(sourceAxis, targetAxis);
      }
    });

    const moves = [];
    Object.keys(transitionAxisMoves).forEach((axis) => {
      moves.push({
        axis,
        ...transitionAxisMoves[axis],
      });
    });

    yield moves;
    this.complete = true;
  }

  #createTransitionAxisMove (sourceAxis, targetAxis) {
    const sourceBpm = this.#source.bpm;
    const averageBpm = (this.#source.bpm + this.#target.bpm) / 2;

    return {
      value: (params) => {
        const { x } = params;

        const from = Ayva.map(x, 0, 1, sourceAxis.$current.from, targetAxis.$current.from);
        const to = Ayva.map(x, 0, 1, sourceAxis.$current.to, targetAxis.$current.to);
        const phase = Ayva.map(x, 0, 1, sourceAxis.phase, targetAxis.phase);
        const ecc = Ayva.map(x, 0, 1, sourceAxis.ecc, targetAxis.ecc);
        const bpm = Ayva.map(x, 0, 1, sourceBpm, averageBpm);

        const provider = Ayva.blendMotion(
          sourceAxis.motion(from, to, phase, ecc, bpm, this.#source.angle),
          targetAxis.motion(from, to, phase, ecc, bpm, this.#source.angle),
          x
        );

        return provider(params);
      },
      duration: this.#duration,
    };
  }

  #getAxisMapByName (axes, ayva) {
    // Convert axes config to be by name instead of alias so it is easier to reason about.
    return Object.keys(axes).reduce((map, axis) => {
      const axisConfig = ayva.getAxis(axis);
      map[axisConfig.name] = axes[axis];
      return map;
    }, {});
  }

  static computeTransitionStartAngle (source, duration, targetBpm) {
    const averageBpm = (source.bpm + targetBpm) / 2;
    return source.angle + (Math.PI * 2 * (averageBpm / 60) * duration);
  }
}

export default TempestStroke;
