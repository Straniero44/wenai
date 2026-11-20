/* eslint-disable max-classes-per-file */
import Ayva from '../ayva.js';
import GeneratorBehavior from './generator-behavior.js';
import { has, validNumber } from '../util/util.js';
import StrokeParameterProvider from '../util/stroke-parameter-provider.js';

/**
 * So named for its timelessness. The OG stroke. Simple up and down movement with some (optional) variation on a few parameters
 * such as speed, positions, shape, and twist.
 *
 * A classic stroke consists of a single function action that computes and inserts a move to either the top or the bottom of the stroke based on
 * where the device is currently located, and what the most recent movement along the stroke axis was.
 *
 * See the [Classic Stroke Tutorial]{@link https://ayvajs.github.io/ayvajs-docs/tutorial-behavior-api-classic-stroke.html}.
 */
class ClassicStroke extends GeneratorBehavior {
  #top;

  #bottom;

  #speed;

  #duration;

  #config;

  get speed () {
    return this.#speed;
  }

  get top () {
    return this.#top;
  }

  get bottom () {
    return this.#bottom;
  }

  get duration () {
    return this.#duration;
  }

  static get DEFAULT_CONFIG () {
    return {
      top: 1,
      bottom: 0,
      speed: 1,
      shape: Ayva.RAMP_COS,
      relativeSpeeds: [1, 1],
      suck: null,
      twist: null,
      pitch: null,
    };
  }

  /**
   * Create a new ClassicStroke.
   *
   * @example
   * // Bounce stroke.
   * ayva.do(new ClassicStroke(0, 1, 1, [ Ayva.RAMP_NEGATIVE_PARABOLIC, Ayva.RAMP_PARABOLIC ]));
   *
   * @param {Number|Array|Function} bottom - bottom of the stroke, array of bottoms, or a function that computes the bottom for each down stroke
   * @param {Number|Array|Function} top - top of the stroke, array of tops, or a function that computes the top for each up stroke
   * @param {Number|Array|Function} speed - speed of the stroke, array of speeds, or a function that computes the speed for each stroke
   * @param {Function|Array} shape - a value provider for the shape or an even-lengthed array of value providers
   *//**
   * Create a new ClassicStroke.
   *
   * @example
   * ayva.do(new ClassicStroke({
   *   bottom: 0,
   *   top: 1,
   *   speed: 1,
   * }));
   *
   * @param {Object} config - stroke configuration
   */
  constructor (bottom = 0, top = 1, speed = 1, shape = Ayva.RAMP_COS) {
    super();

    let config;
    if (typeof bottom === 'object' && !(bottom instanceof Array)) {
      config = bottom;
    } else {
      config = {
        top,
        bottom,
        speed,
        shape,
      };
    }

    this.#init(config);
  }

  * generate (ayva) {
    const { value, lastValue } = ayva.$.stroke;
    const {
      target, shape, direction, relativeSpeed,
    } = this.#getTargetShape(value, lastValue);
    const speed = this.#speed * relativeSpeed;

    const strokeMove = {
      to: target,
      value: shape,
    };

    if (this.#config.speed !== undefined) {
      strokeMove.speed = speed;
      this.#speed = this.#config.speed.next();
    } else {
      strokeMove.duration = this.#duration / relativeSpeed;
      this.#duration = this.#config.duration.next();
    }

    const moves = [strokeMove];

    if (this.#config.twist) {
      moves.push(this.#computeAxisMove('twist', {
        direction,
        value,
        target,
        ayva,
        speed: this.#config.speed !== undefined ? speed : Math.abs(target - value) / strokeMove.duration,
      }));
    }

    if (this.#config.pitch) {
      moves.push(this.#computeAxisMove('pitch', {
        direction,
        value,
        target,
        ayva,
        speed: this.#config.speed !== undefined ? speed : Math.abs(target - value) / strokeMove.duration,
      }));
    }

    if (validNumber(this.#config.suck, 0, 1)) {
      ayva.$.suck.value = this.#config.suck;
    }

    yield moves;
  }

  #init (config) {
    const defaultConfig = ClassicStroke.DEFAULT_CONFIG;

    if (has(config, 'duration')) {
      delete defaultConfig.speed;
    }

    const strokeConfig = {
      ...defaultConfig,
      ...config,
    };

    this.#validate(strokeConfig);

    strokeConfig.top = StrokeParameterProvider.createFrom(strokeConfig.top);
    strokeConfig.bottom = StrokeParameterProvider.createFrom(strokeConfig.bottom);
    strokeConfig.relativeSpeeds = StrokeParameterProvider.createFrom(strokeConfig.relativeSpeeds);

    if (has(strokeConfig, 'duration')) {
      strokeConfig.duration = StrokeParameterProvider.createFrom(strokeConfig.duration);
    } else {
      strokeConfig.speed = StrokeParameterProvider.createFrom(strokeConfig.speed);
    }

    const { shape } = strokeConfig;

    if (shape instanceof Array) {
      strokeConfig.shape = new StrokeParameterProvider((index) => shape[index % shape.length]);
    } else {
      strokeConfig.shape = new StrokeParameterProvider(() => shape);
    }

    this.#config = strokeConfig;

    // Compute initial stroke values.
    this.#top = this.#config.top.next();
    this.#bottom = this.#config.bottom.next();

    if (this.#config.speed !== undefined) {
      this.#speed = this.#config.speed.next();
    } else {
      this.#duration = this.#config.duration.next();
    }
  }

  #computeAxisMove (axis, { direction, value, target, speed, ayva }) { // eslint-disable-line object-curly-newline
    const { frequency } = ayva;
    const phase = (direction === 'up' ? 0 : 2) + (this.#config[axis].phase || 0);
    const ecc = this.#config[axis].ecc || 0;
    const distance = Math.abs(value - target);
    const bpm = (speed * 60) / (2 * distance);
    const motion = Ayva.tempestMotion(this.#config[axis].from, this.#config[axis].to, phase, ecc, bpm);
    const expectedValue = motion({ index: -1, frequency });

    if (Math.abs(expectedValue - ayva.$[axis].value) > 0.05) {
      // I'm starting off axis. Just do a smooth move to the next position rather than jerking back.
      const nextMotion = Ayva.tempestMotion(this.#config[axis].from, this.#config[axis].to, phase + 2, ecc, bpm);
      const targetValue = nextMotion({ index: -1, frequency });

      return {
        axis,
        to: targetValue,
        value: Ayva.RAMP_COS,
      };
    }

    return {
      axis,
      value: motion,
    };
  }

  /**
   * Decide where to stroke next based on the current position.
   * Applies some common sense so there are smoother transitions between patterns.
   */
  #getTargetShape (currentValue, lastValue) {
    const lastStrokeWasUp = (currentValue - lastValue) >= 0;
    const nextShapeDirection = this.#config.shape.index % 2 === 0 ? 'up' : 'down';
    const nextRelativeSpeedDirection = this.#config.relativeSpeeds.index % 2 === 0 ? 'up' : 'down';

    let target;
    let direction;

    if (currentValue <= this.#bottom || (currentValue < this.#top && !lastStrokeWasUp)) {
      direction = 'up';
      target = this.#top;
      this.#top = this.#config.top.next();

      if (nextShapeDirection === 'down') {
        this.#config.shape.next(); // Skip to the next up shape.
      }

      if (nextRelativeSpeedDirection === 'down') {
        this.#config.relativeSpeeds.next(); // Skip to the next up speed
      }
    } else {
      direction = 'down';
      target = this.#bottom;
      this.#bottom = this.#config.bottom.next();

      if (nextShapeDirection === 'up') {
        this.#config.shape.next(); // Skip to the next down shape.
      }

      if (nextRelativeSpeedDirection === 'up') {
        this.#config.relativeSpeeds.next(); // Skip to the next down speed.
      }
    }

    return {
      target, shape: this.#config.shape.next(), direction, relativeSpeed: this.#config.relativeSpeeds.next(),
    };
  }

  // TODO: We really need to standardize / generalize validation... :(
  #validate (config) {
    const fail = (parameter, value) => {
      throw new Error(`Invalid stroke ${parameter}: ${value}`);
    };

    if (!validNumber(config.bottom, 0, 1) && typeof config.bottom !== 'function' && !(config.bottom instanceof Array)) {
      fail('bottom', config.bottom);
    }

    if (!validNumber(config.top, 0, 1) && typeof config.top !== 'function' && !(config.top instanceof Array)) {
      fail('top', config.top);
    }

    if (config.bottom === config.top) {
      throw new Error(`Invalid stroke range specified: (${config.bottom}, ${config.top})`);
    }

    if (has(config, 'speed') && has(config, 'duration')) {
      throw new Error('Cannot specify both a speed and duration');
    }

    if (has(config, 'speed')
      && (!validNumber(config.speed) || config.speed <= 0)
      && typeof config.speed !== 'function' && !(config.speed instanceof Array)) {
      fail('speed', config.speed);
    }

    if (has(config, 'duration') && (!validNumber(config.duration) || config.duration <= 0)
      && typeof config.duration !== 'function'
      && !(config.duration instanceof Array)) {
      fail('duration', config.duration);
    }

    if (typeof config.shape !== 'function' && !(config.shape instanceof Array)) {
      fail('shape', config.shape);
    }

    if (has(config, 'relativeSpeeds') && !(config.relativeSpeeds instanceof Array)) {
      fail('relative speeds', config.relativeSpeeds);
    }

    const otherAxes = ['twist', 'pitch'];

    otherAxes.forEach((axis) => {
      if (typeof config[axis] !== 'object') {
        fail(axis, config[axis]);
      }

      if (config[axis]) {
        if (!validNumber(config[axis].from, 0, 1)) {
          fail(`${axis} from`, config[axis].from);
        }

        if (!validNumber(config[axis].to, 0, 1)) {
          fail(`${axis} to`, config[axis].to);
        }

        if (has(config[axis], 'phase') && !validNumber(config[axis].phase)) {
          fail(`${axis} phase`, config[axis].phase);
        }
      }
    });

    if (config.shape instanceof Array) {
      if (!config.shape.length) {
        throw new Error('Missing stroke shape.');
      }

      if (config.shape.length % 2 !== 0) {
        throw new Error('Must specify an even number of stroke shapes.');
      }

      config.shape.forEach((shape) => {
        if (typeof shape !== 'function') {
          fail('shape', shape);
        }
      });
    }

    if (config.relativeSpeeds instanceof Array) {
      if (config.relativeSpeeds.length % 2 !== 0) {
        throw new Error('Must specify an even number of relative speeds.');
      }

      config.relativeSpeeds.forEach((relativeSpeed) => {
        if (!validNumber(relativeSpeed) || relativeSpeed <= 0) {
          fail('relative speed', relativeSpeed);
        }
      });
    }

    if (has(config, 'suck') && !validNumber(config.suck, 0, 1) && config.suck !== null) {
      fail('suck', config.suck);
    }
  }
}

export default ClassicStroke;
