/* eslint-disable no-await-in-loop */
import MoveBuilder from './util/move-builder.js';
import WorkerTimer from './util/worker-timer.js';
import {
  clamp, round, has, createConstantProperty, validNumber, isGeneratorFunction
} from './util/util.js';
import validator from './util/validator.js';
import OSR_CONFIG from './util/osr-config.js';
import GeneratorBehavior from './behaviors/generator-behavior.js'; // eslint-disable-line import/no-cycle

class Ayva {
  #devices = [];

  #axes = {};

  #frequency = 50; // Hz

  #movements = new Set();

  #nextMovementId = 1;

  #nextBehaviorId = 1;

  #currentBehaviorId = null;

  #performing = false;

  #timer;

  #sleepResolves = new Set();

  #readyResolves = new Set();

  defaultRamp = Ayva.RAMP_COS;

  static get precision () {
    // Decimals to round to for internal values.
    return 10;
  }

  static get maxFrequency () {
    return 250;
  }

  get performing () {
    return this.#performing;
  }

  get axes () {
    const result = {};

    Object.keys(this.#axes).forEach((key) => {
      // Ensure that the result object is immutable by using getAxis()
      result[key] = this.getAxis(key);
    });

    return result;
  }

  get frequency () {
    return this.#frequency;
  }

  set frequency (value) {
    if (!validNumber(value, 1, Ayva.maxFrequency)) {
      throw new Error(`Invalid frequency ${value}. Frequency must be a number between 1 and ${Ayva.maxFrequency}.`);
    }

    this.#frequency = value;
  }

  get period () {
    return this.#period;
  }

  get #period () {
    return 1 / this.#frequency;
  }

  /**
   * Create a new instance of Ayva with the specified configuration.
   *
   * @param {Object} [config]
   * @param {String} [config.name] - the name of this configuration
   * @param {String} [config.defaultAxis] - the default axis to command when no axis is specified
   * @param {Object[]} [config.axes] - an array of axis configurations (see {@link Ayva#configureAxis})
   * @class Ayva
   */
  constructor (config) {
    createConstantProperty(this, '$', {});

    if (config) {
      this.#configure(config);
    }

    if (typeof Worker === 'undefined') {
      this.#timer = {
        // Default timer is just a basic timeout.
        sleep (seconds) {
          return new Promise((resolve) => {
            setTimeout(resolve, seconds * 1000);
          });
        },

        now () {
          return performance.now() / 1000;
        },
      };
    } else {
      this.#timer = new WorkerTimer();
    }
  }

  /**
   * Setup this Ayva instance with the default configuration (a six axis stroker).
   *
   * @example
   * const ayva = new Ayva().defaultConfiguration();
   *
   * @returns the instance of Ayva
   */
  defaultConfiguration () {
    this.#configure(OSR_CONFIG);
    return this;
  }

  /**
   * Get the timer that Ayva uses to time movements.
   *
   * @returns the timer
   */
  getTimer () {
    return this.#timer;
  }

  /**
   * Set the timer that Ayva uses to time movements.
   */
  setTimer (timer) {
    this.#timer = timer;
  }

  /**
   * Perform the specified behavior until it completes or is explicitly stopped.
   * If another behavior is running, it will be stopped.
   *
   * For full details on how to use this method, see the {@tutorial behavior-api} tutorial.
   *
   * @param {GeneratorBehavior|Function|Object} behavior - the behavior to perform.
   */
  async do (behavior) {
    this.#stop();

    const behaviorId = this.#nextBehaviorId++;
    this.#currentBehaviorId = behaviorId;

    while (this.#performing) {
      await this.sleep();
    }

    this.#performing = true;

    const computedBehavior = this.#computeBehavior(behavior);

    while (this.#currentBehaviorId === behaviorId && !computedBehavior.complete) {
      try {
        await computedBehavior.perform(this);

        // Allow any moves or sleeps that were queued to complete.
        await this.ready();
      } catch (error) {
        console.error('Error performing behavior:', error?.stack); // eslint-disable-line no-console
        break;
      }
    }

    this.#performing = false;

    if (this.#currentBehaviorId !== behaviorId) {
      // Behavior was stopped before it completed.
      return false;
    }

    this.#currentBehaviorId = null;
    return true;
  }

  /**
   * Performs movements along one or more axes. This is a powerful method that can synchronize
   * axis movement while allowing for fine control over position, speed, or move duration.
   * For full details on how to use this method, see the {@tutorial motion-api} tutorial.
   *
   * @example
   * ayva.move({
   *   axis: 'stroke',
   *   to: 0,
   *   speed: 1,
   * },{
   *   axis: 'twist',
   *   to: 0.5,
   *   duration: 1,
   * });
   *
   * @param  {...Object} movements
   * @return {Promise} a promise that resolves with the boolean value true when all movements have finished, or false if the move was cancelled.
   */

  move (...movements) {
    if (!this.#devices || !this.#devices.length) {
      throw new Error('No output devices have been added.');
    }

    validator.validateMovements(movements, this.#axes, this.defaultAxis);

    return this.#asyncMove(...movements);
  }

  /**
   * Wait until ayva is not doing anything (neither moving nor sleeping).
   *
   * @return {Promise} a promise that resolves when there are no more moves or sleeps queued.
   */
  ready () {
    if (this.#sleepResolves.size || this.#movements.size) {
      return new Promise((resolve) => {
        this.#readyResolves.add(resolve);
      });
    }

    return this.sleep();
  }

  /**
   * Creates a MoveBuilder for this instance.
   *
   * @returns the new move builder.
   */
  moveBuilder () {
    return new MoveBuilder(this);
  }

  /**
   * Moves all axes to their default positions.
   *
   * @param {Number} [speed = 0.5] - optional speed of the movement.
   * @return {Promise} A promise that resolves when the movements are finished.
   */
  async home (speed = 0.5) {
    const movements = this.#getAxesArray()
      .map((axis) => {
        const movement = {
          axis: axis.name,
          to: axis.defaultValue,
        };

        if (axis.type !== 'boolean') {
          movement.speed = speed;
        }

        return movement;
      });

    if (movements.length) {
      return this.move(...movements);
    }

    console.warn('No linear or rotation axes configured.'); // eslint-disable-line no-console
    return Promise.resolve(false);
  }

  /**
   * Cancels all running or pending movements, clears the current behavior (if any), and cancels any sleeps.
   */
  stop () {
    // TODO: Add on stop notification here once event listening is implemented.
    this.#stop();
  }

  /**
   * Asynchronously sleep for the specified number of seconds (or until stop() is called).
   *
   * @param {Number} seconds
   * @returns {Promise} a Promise that resolves with the value true if the time elapses. false if the sleep is cancelled.
   */
  sleep (seconds) {
    let sleepResolve;

    const sleepCanceller = new Promise((resolve) => {
      this.#sleepResolves.add(resolve);
      sleepResolve = resolve;
    });

    return Promise.any([
      this.#timer.sleep(seconds).then(() => true),
      sleepCanceller.then(() => false),
    ]).finally(() => {
      this.#sleepResolves.delete(sleepResolve);
      this.#checkNotifyReady();
    });
  }

  /**
   * Configures a new axis. If an axis with the same name has already been configured, it will be overridden.
   *
   * @example
   * const ayva = new Ayva();
   *
   * ayva.configureAxis({
   *   name: 'L0',
   *   type: 'linear',
   *   alias: 'stroke',
   *   max: 0.9,
   *   min: 0.3,
   * });
   *
   * @param {Object} axisConfig - axis configuration object
   * @param {String} axisConfig.name - the machine name of this axis (such as L0, R0, etc...)
   * @param {String} axisConfig.type - linear, rotation, or auxiliary
   * @param {String} [axisConfig.alias] - an alias used to refer to this axis
   * @param {Number} [axisConfig.max = 1] - specifies maximum value for this axis
   * @param {Number} [axisConfig.min = 0] - specifies minimum value for this axis
   */
  configureAxis (axisConfig) {
    // TODO: Disallow 'execute' as an axis name.
    const resultConfig = validator.validateAxisConfig(axisConfig);

    const oldConfig = this.#axes[axisConfig.name];

    if (oldConfig) {
      resultConfig.value = oldConfig.value;
      resultConfig.lastValue = oldConfig.lastValue;
      delete this.#axes[oldConfig.alias];
      delete this.$[oldConfig.alias];
    }

    this.#axes[axisConfig.name] = resultConfig;
    this.#createAxisMoveBuilder(axisConfig.name);

    if (axisConfig.alias) {
      if (this.#axes[axisConfig.alias]) {
        throw new Error(`Alias already refers to another axis: ${axisConfig.alias}`);
      }

      this.#axes[axisConfig.alias] = resultConfig;
      this.#createAxisMoveBuilder(axisConfig.alias);
    }
  }

  /**
   * Fetch an immutable object containing the properties for an axis.
   *
   * @param {String} name - the name or alias of the axis to get.
   * @return {Object} axisConfig - an immutable object of axis properties.
   */
  getAxis (name) {
    const fetchedAxis = this.#axes[name];

    if (fetchedAxis) {
      const axis = {};

      Object.keys(fetchedAxis).forEach((key) => {
        createConstantProperty(axis, key, fetchedAxis[key]);
      });

      return axis;
    }

    return undefined;
  }

  /**
   * Fetch an array of the axes.
   */
  getAxes () {
    return this.#getAxesArray().map((axis) => ({
      // Ghetto deep copy, but its the most optimal.
      name: axis.name,
      alias: axis.alias,
      type: axis.type,
      defaultValue: axis.defaultValue,
      max: axis.max,
      min: axis.min,
      value: axis.value,
      lastValue: axis.lastValue,
      resetOnStop: axis.resetOnStop,
    }));
  }

  /**
   * Update the limits for the specified axis.
   *
   * @param {String} axis
   * @param {Number} from - value between 0 and 1
   * @param {Number} to - value between 0 and 1
   */
  updateLimits (axis, from, to) {
    const isInvalid = (value) => !Number.isFinite(value) || value < 0 || value > 1;

    if (isInvalid(from) || isInvalid(to) || from === to) {
      throw new Error(`Invalid limits: min = ${from}, max = ${to}`);
    }

    if (!this.#axes[axis]) {
      throw new Error(`Invalid axis: ${axis}`);
    }

    this.#axes[axis].min = Math.min(from, to);
    this.#axes[axis].max = Math.max(from, to);
  }

  /**
   * Live update axis values.
   *
   * @param {Object} axisValueMap - axis to value map
   */
  setValues (axisValueMap) {
    // TODO: Validate instead of silently ignoring invalid values?
    const axisValues = Object.entries(axisValueMap).map(([axis, value]) => ({ axis, value }));

    this.#writeAxisValues(axisValues);
  }

  /**
   * Registers a new output. Ayva outputs commands to all connected outputs.
   * More than one output can be specified.
   *
   * @param {...Function|Object} output - a function or an object with a write() method.
   */
  addOutput (...output) {
    this.addOutputDevice(...output);
  }

  /**
   * Return a list of all outputs.
   */
  getOutput () {
    return this.getOutputDevices();
  }

  /**
   * Remove the specified output.
   *
   * @param {Object} output - the output to remove.
   */
  removeOutput (output) {
    this.removeOutputDevice(output);
  }

  /**
   * Registers a new output device. Ayva outputs commands to all connected devices.
   * More than one device can be specified.
   *
   * @deprecated since version 0.13.0. Use addOutput() instead.
   * @param {...Object} device - a function or an object with a write method.
   */
  addOutputDevice (...devices) {
    const resultDevices = devices.map((device) => {
      const isWritable = device && device.write && device.write instanceof Function;
      const isFunction = device instanceof Function;

      if (!isWritable && !isFunction) {
        throw new Error(`Invalid device: ${device}`);
      }

      return isWritable ? device : { write: device };
    });

    this.#devices.push(...resultDevices);
  }

  /**
   * Return a list of all output devices.
   * @deprecated since version 0.13.0. Use getOutput() instead.
   */
  getOutputDevices () {
    return [...this.#devices];
  }

  /**
   * Remove the specified device.
   *
   * @deprecated since version 0.13.0. Use removeOutput() instead.
   * @param {Object} device - the device to remove.
   */
  removeOutputDevice (device) {
    const index = this.#devices.indexOf(device);

    if (index !== -1) {
      this.#devices.splice(index, 1);
    }
  }

  async #asyncMove (...movements) {
    const movementId = this.#nextMovementId++;
    this.#movements.add(movementId);

    while (this.#movements.has(movementId) && this.#movements.values().next().value !== movementId) {
      // Wait until current movements have completed to proceed.
      await this.sleep();
    }

    if (!this.#movements.has(movementId)) {
      // This move must have been cancelled.
      return false;
    }

    return this.#performMovements(movementId, movements).finally(() => {
      this.#movements.delete(movementId);
      this.#checkNotifyReady();
    });
  }

  #stop () {
    this.#currentBehaviorId = null;
    this.#movements.clear();
    this.#sleepResolves.forEach((resolve) => resolve());

    const resetValues = {};

    this.#getAxesArray().forEach((axis) => {
      if (axis.resetOnStop) {
        resetValues[axis.name] = axis.defaultValue;
      }
    });

    if (Object.keys(resetValues).length) {
      this.setValues(resetValues);
    }
  }

  /**
   * Add the start of a move builder chain to $ for the specified axis.
   * Also add shortcut properties for value, min, and max to each axis.
   */
  #createAxisMoveBuilder (axis) {
    Object.defineProperty(this.$, axis, {
      value: (...args) => this.moveBuilder()[axis](...args),
      writeable: false,
      configurable: true,
      enumerable: true,
    });

    Object.defineProperty(this.$[axis], 'value', {
      get: () => this.#axes[axis].value,
      set: (target) => {
        const { type } = this.#axes[axis];

        if (type !== 'boolean' && !validNumber(target, 0, 1)) {
          // TODO: Move this validation out into a place it can be reused for setValues() method?
          throw new Error(`Invalid value: ${target}`);
        }

        this.#writeAxisValues([{
          axis,
          value: target,
        }]);
      },
    });

    Object.defineProperty(this.$[axis], 'lastValue', {
      get: () => this.#axes[axis].lastValue,
    });

    Object.defineProperty(this.$[axis], 'defaultValue', {
      get: () => this.#axes[axis].defaultValue,
    });

    Object.defineProperty(this.$[axis], 'min', {
      get: () => this.#axes[axis].min,
    });

    Object.defineProperty(this.$[axis], 'max', {
      get: () => this.#axes[axis].max,
    });
  }

  /**
   * Setup the configuration.
   */
  #configure (config) {
    this.name = config.name;
    this.defaultAxis = config.defaultAxis;
    this.#frequency = (config.frequency || this.#frequency);

    if (config.axes) {
      config.axes.forEach((axis) => {
        this.configureAxis(axis);
      });
    }
  }

  #computeBehavior (value) {
    if (typeof value === 'function' && !(value instanceof GeneratorBehavior)) {
      if (isGeneratorFunction(value)) {
        return new GeneratorBehavior(value);
      }

      return {
        perform: value,
      };
    }

    return value;
  }

  /**
   * Writes the specified command out to all connected devices.
   */
  #write (command) {
    for (const device of this.#devices) {
      device.write(command);
    }
  }

  async #performMovements (movementId, movements) {
    const allProviders = this.#createValueProviders(movements);
    const { duration, stepCount } = this.#computeMaxDurationAndStepCount(allProviders);
    const immediateProviders = allProviders.filter((provider) => !provider.parameters.stepCount);
    const stepProviders = allProviders.filter((provider) => !!provider.parameters.stepCount);

    this.#executeProviders(immediateProviders, 0);

    let errorCorrection = 0;
    const startTime = this.#timer.now();

    if (stepCount) {
      for (let index = 0; index < stepCount; index++) {
        const unfinishedProviders = stepProviders.filter((provider) => index < provider.parameters.stepCount);
        this.#executeProviders(unfinishedProviders, index);

        errorCorrection = await this.#stepSleep(index, stepCount, duration, startTime, errorCorrection);

        if (!this.#movements.has(movementId)) {
          // This move was cancelled.
          return false;
        }
      }
    } else {
      // Always sleep at least a tick even when all providers are immediate.
      await this.sleep(this.#period);
    }

    return true;
  }

  /**
   * Sleep for a single step. Aims to sleep for this.#period seconds on average. This method corrects for
   * deviations in the underlying timer.
   *
   * TODO: Maybe add a threshold for the error.
   *
   * @returns the new error correction
   */
  async #stepSleep (index, stepCount, duration, startTime, errorCorrection) {
    const clampPeriod = (period) => Math.max(period, 1 / Ayva.maxFrequency);

    if (index === stepCount - 1) {
      // This shenanigans is to (attempt to) account for the fact that a move is
      // an integer number of steps but a duration may be fractional. In the final step
      // we may have time remaining that is less than the period.
      const currentElapsed = this.#timer.now() - startTime;
      const remaining = Math.min(Math.max(duration - currentElapsed, 0), this.#period);
      await this.sleep(clampPeriod(remaining));
    } else {
      await this.sleep(clampPeriod(this.#period - errorCorrection));
    }

    const actualElapsed = this.#timer.now() - startTime;
    const expectedElapsed = (index + 1) * this.#period;

    return actualElapsed - expectedElapsed;
  }

  #executeProviders (providers, index) {
    const axisValues = providers.map((provider) => this.#executeProvider(provider, index));

    this.#writeAxisValues(axisValues);
  }

  #executeProvider (provider, index) {
    const time = index * this.#period;
    const { parameters, valueProvider } = provider;
    const { duration } = parameters;

    const nextValue = valueProvider({
      ...parameters,
      time,
      index,
      period: this.#period,
      frequency: this.#frequency,
      currentValue: this.#axes[parameters.axis].value,
      x: Math.min(1, (index + 1) / (duration * this.#frequency)),
    });

    const notNullOrUndefined = nextValue !== null && nextValue !== undefined; // Allow null or undefined to indicate no movement.

    if (!this.#isValidAxisValue(nextValue) && notNullOrUndefined) {
      console.warn(`Invalid value provided: ${nextValue}`); // eslint-disable-line no-console
    }

    return {
      axis: parameters.axis,
      value: Number.isFinite(nextValue) ? clamp(round(nextValue, Ayva.precision), 0, 1) : nextValue,
    };
  }

  #writeAxisValues (axisValues) {
    const filteredAxisValues = axisValues.filter(({ value }) => this.#isValidAxisValue(value));
    const tcodes = filteredAxisValues.map(({ axis, value }) => this.#tcode(axis, value));

    if (tcodes.length) {
      this.#write(`${tcodes.join(' ')}\n`);

      filteredAxisValues.forEach(({ axis, value }) => {
        this.#axes[axis].lastValue = this.#axes[axis].value;
        this.#axes[axis].value = value;
      });
    }
  }

  #isValidAxisValue (value) {
    return Number.isFinite(value) || typeof value === 'boolean';
  }

  /**
   * Converts the value into a standard live command TCode string for the specified axis. (i.e. 0.5 -> L0500)
   * If the axis is a boolean axis, true values get mapped to 999 and false gets mapped to 000.
   *
   * @param {String} axis
   * @param {Number} value
   * @returns {String} the TCode string
   */
  #tcode (axis, value) {
    let valueText;

    if (typeof value === 'boolean') {
      valueText = value ? '9999' : '0000';
    } else {
      const { min, max } = this.#axes[axis];
      const normalizedValue = round(value * 0.9999, 4); // Convert values from range (0, 1) to (0, 0.9999)
      const scaledValue = (max - min) * normalizedValue + min;

      valueText = `${clamp(round(scaledValue * 10000), 0, 9999)}`.padStart(4, '0');
    }

    return `${this.#axes[axis].name}${valueText}`;
  }

  /**
   * Create value providers with initial parameters.
   *
   * Precondition: Each movement is a valid movement per the Motion API.
   * @param {Object[]} movements
   * @returns {Object[]} - array of value providers with parameters.
   */
  #createValueProviders (movements) {
    const { parameterObjects, maxDuration } = this.#createParameterObjects(movements);

    this.#populateDurationAndStepCount(parameterObjects, maxDuration);

    // Create the actual value providers.
    return parameterObjects.map((parameters) => {
      const provider = {};

      if (!has(parameters, 'value')) {
        // Create a value provider from parameters.
        if (this.#axes[parameters.axis].type === 'boolean') {
          provider.valueProvider = () => parameters.to;
        } else if (parameters.to !== parameters.from) {
          provider.valueProvider = this.defaultRamp;
        } else {
          // No movement.
          provider.valueProvider = () => {};
        }
      } else {
        // User provided value provider.
        provider.valueProvider = parameters.value;
      }

      delete parameters.sync;
      delete parameters.value;
      provider.parameters = parameters;

      return provider;
    });
  }

  #createParameterObjects (movements) {
    let maxDuration = 0;

    const parameterObjects = movements.map((movement) => {
      // Initialize all parameters that we can deduce.
      const axis = movement.axis || this.defaultAxis;

      const parameters = {
        ...movement,
        axis,
        from: this.#axes[axis].value,
        period: this.#period,
      };

      if (has(movement, 'to')) {
        const distance = movement.to - parameters.from;
        const absoluteDistance = Math.abs(distance);

        if (has(movement, 'duration')) {
          // { to: <number>, duration: <number> }
          parameters.speed = round(absoluteDistance / movement.duration, Ayva.precision);
        } else if (has(movement, 'speed')) {
          // { to: <number>, speed: <number> }
          // Uncomment the below to re-enable speed scaling.
          // const axisScale = 1 / Math.abs(this.#axes[axis].max - this.#axes[axis].min);
          // result.speed = movement.speed * axisScale;
          parameters.duration = round(absoluteDistance / parameters.speed, Ayva.precision);
        }

        parameters.direction = distance > 0 ? 1 : distance < 0 ? -1 : 0; // eslint-disable-line no-nested-ternary
      }

      if (has(parameters, 'duration')) {
        maxDuration = Math.max(parameters.duration, maxDuration);
      }

      return parameters;
    });

    return { maxDuration, parameterObjects };
  }

  #populateDurationAndStepCount (parameterObjects, maxDuration) {
    const movementsByAxis = parameterObjects.reduce((map, p) => {
      map[p.axis] = p;

      if (this.#axes[p.axis].alias) {
        map[this.#axes[p.axis].alias] = p;
      }

      return map;
    }, {});

    parameterObjects.forEach((parameters) => {
      // We need to compute the duration for any movements we couldn't in the first pass.
      // This will be either implicit or explicit sync movements.
      if (has(parameters, 'sync')) {
        // Excplicit sync.
        let syncMovement = parameters;

        while (has(syncMovement, 'sync')) {
          syncMovement = movementsByAxis[syncMovement.sync];
        }

        parameters.duration = syncMovement.duration || maxDuration;

        if (has(parameters, 'to')) {
          // Now we can compute a speed.
          parameters.speed = round(Math.abs(parameters.to - parameters.from) / parameters.duration, Ayva.precision);
        }
      } else if (!has(parameters, 'duration') && this.#axes[parameters.axis].type !== 'boolean') {
        // Implicit sync to max duration.
        parameters.duration = maxDuration;
      }

      if (has(parameters, 'duration')) {
        parameters.stepCount = Math.ceil(parameters.duration * this.#frequency);
      } // else if (this.#axes[movement.axis].type !== 'boolean') {
      // By this point, the only movements without a duration should be boolean.
      // This should literally never happen because of validation. But including here for debugging and clarity.
      // fail(`Unable to compute duration for movement along axis: ${movement.axis}`);
      // }
    });
  }

  #computeMaxDurationAndStepCount (valueProviders) {
    let stepCount = 0;
    let duration = 0;

    valueProviders.forEach((provider) => {
      const nextStepCount = provider.parameters.stepCount;
      const nextDuration = provider.parameters.duration;

      if (nextStepCount) {
        stepCount = Math.max(nextStepCount, stepCount);
      }

      if (nextDuration) {
        duration = Math.max(nextDuration, duration);
      }
    });

    return { duration, stepCount };
  }

  #getAxesArray () {
    const uniqueAxes = {};

    Object.values(this.#axes).forEach((axis) => {
      uniqueAxes[axis.name] = axis;
    });

    function sortByName (a, b) {
      return a.name > b.name ? 1 : -1;
    }

    return Object.values(uniqueAxes).sort(sortByName);
  }

  #checkNotifyReady () {
    if (this.#sleepResolves.size === 0 && this.#movements.size === 0 && this.#readyResolves.size) {
      for (const resolve of this.#readyResolves) {
        resolve();
      }

      this.#readyResolves.clear();
    }
  }

  /**
   * Convert the function provided into a ramp function.
   *
   * @param {Function} fn
   * @returns the new ramp function
   */
  static ramp (fn) {
    return (parameters) => {
      const { from, to } = parameters;

      return from + ((to - from) * fn(parameters));
    };
  }

  /**
   * Value provider that generates motion towards a target position with constant velocity.
   */
  static RAMP_LINEAR (parameters) {
    const fn = ({ x }) => x;

    return Ayva.ramp(fn)(parameters);
  }

  /**
   * Value provider that generates motion towards a target position that resembles part of a cos wave (0 - 180 degrees).
   */
  static RAMP_COS (parameters) {
    const fn = ({ x }) => (-Math.cos(Math.PI * x) / 2) + 0.5;

    return Ayva.ramp(fn)(parameters);
  }

  /**
   * Value provider that generates motion towards a target position in the shape of the latter half of a parabola.
   * This creates the effect of "falling" towards the target position.
   */
  static RAMP_PARABOLIC (parameters) {
    const fn = ({ x }) => x * x;

    return Ayva.ramp(fn)(parameters);
  }

  /**
   * Value provider that generates motion towards a target position in the shape of the first half of an upside down parabola.
   * This creates the effect of "launching" towards the target position.
   */
  static RAMP_NEGATIVE_PARABOLIC (parameters) {
    const fn = ({ x }) => -((x - 1) ** 2) + 1;

    return Ayva.ramp(fn)(parameters);
  }

  /**
   * Creates a value provider that generates oscillatory motion. The formula is:
   *
   * cos(θ + phase·π/2 + ecc·sin(θ + phase·π/2))
   *
   * The result is translated and scaled to fit the range and beats per minute specified.
   * This formula was created by [Tempest MAx]{@link https://www.patreon.com/tempestvr}—loosely based
   * on orbital motion calculations. Hence, tempestMotion.
   *
   * See [this graph]{@link https://www.desmos.com/calculator/vnfke1rprt} of the function
   * where you can adjust the parameters to see how they affect the motion.
   *
   * @example
   * // Note: These examples use Move Builders from the Motion API.
   *
   * // Simple up/down stroke for 10 seconds.
   * ayva.$.stroke(Ayva.tempestMotion(1, 0), 10).execute();
   *
   * // ... out of phase with a little eccentricity.
   * ayva.$.stroke(Ayva.tempestMotion(1, 0, 1, 0.2), 10).execute();
   *
   * // ... at 30 BPM.
   * ayva.$.stroke(Ayva.tempestMotion(1, 0, 1, 0.2, 30), 10).execute();
   *
   * @param {Number} from - the start of the range of motion
   * @param {Number} to - the end of the range of motion
   * @param {Number} [phase] - the phase of the wave in multiples of π/2
   * @param {Number} [ecc] - the eccentricity of the wave
   * @param {Number} [bpm] - beats per minute
   * @param {Number} [shift] - additional phase shift of the wave in radians
   * @returns the value provider.
   *//**
   * Creates a value provider that generates oscillatory motion. The formula is:
   *
   * cos(θ + phase·π/2 + ecc·sin(θ + phase·π/2))
   *
   * The result is translated and scaled to fit the range and beats per minute specified.
   * This formula was created by [Tempest MAx]{@link https://www.patreon.com/tempestvr}—loosely based
   * on orbital motion calculations. Hence, tempestMotion.
   *
   * See [this graph]{@link https://www.desmos.com/calculator/vnfke1rprt} of the function
   * where you can adjust the parameters to see how they affect the motion.
   *
   * @example
   * // Note: These examples use Move Builders from the Motion API.
   *
   * // Simple up/down stroke for 10 seconds.
   * ayva.$.stroke(Ayva.tempestMotion({ from: 1, to: 0}), 10).execute();
   *
   * // ... out of phase with a little eccentricity.
   * ayva.$.stroke(Ayva.tempestMotion({ from: 1, to: 0, phase: 1, ecc: 0.2 }), 10).execute();
   *
   * // ... at 30 BPM.
   * ayva.$.stroke(Ayva.tempestMotion({ from: 1, to: 0, phase: 1, ecc: 0.2, bpm: 30 }), 10).execute();
   *
   * @param {Object} params - the parameters of the motion.
   * @returns the value provider.
   */
  static tempestMotion (from, to, phase = 0, ecc = 0, bpm = 60, shift = 0) {
    const params = typeof from === 'object' ? from : {
      from, to, phase, ecc, bpm, shift,
    };

    return Ayva.#tempestMotion(params);
  }

  static #tempestMotion (params) {
    params = { // eslint-disable-line no-param-reassign
      from: 0,
      to: 1,
      phase: 0,
      ecc: 0,
      shift: 0,
      bpm: 60,
      ...params,
    };

    validator.validateMotionParameters(params);

    const {
      from, to, phase, ecc, bpm, shift,
    } = params;

    const angularVelocity = (2 * Math.PI * bpm) / 60;
    const scale = 0.5 * (to - from);
    const midpoint = 0.5 * (to + from);

    const provider = ({ index, frequency }) => {
      const angle = (((index + 1) * angularVelocity) / frequency) + (0.5 * Math.PI * phase) + shift;
      return midpoint - scale * Math.cos(angle + (ecc * Math.sin(angle)));
    };

    Ayva.#createConstantMotionProperties(provider, from, to, phase, ecc, bpm);
    return provider;
  }

  /**
   * Eccentric Parametric Oscillatory Parabolic Motion™
   *
   * @param {Number} from - the start of the range of motion
   * @param {Number} to - the end of the range of motion
   * @param {Number} [phase] - the phase of the motion in multiples of π/2
   * @param {Number} [ecc] - the eccentricity of the motion
   * @param {Number} [bpm] - beats per minute
   * @param {Number} [shift] - additional phase shift of the motion in radians
   * @returns the value provider
   *//**
   * Eccentric Parametric Oscillatory Parabolic Motion™
   *
   * @param {Object} params - the parameters of the motion.
   * @returns the value provider
   */
  static parabolicMotion (from, to, phase = 0, ecc = 0, bpm = 60, shift = 0) {
    const params = typeof from === 'object' ? from : {
      from, to, phase, ecc, bpm, shift,
    };

    return Ayva.#parabolicMotion(params);
  }

  static #parabolicMotion (params) {
    // TODO: Thou shalt not repeat thyself.
    params = { // eslint-disable-line no-param-reassign
      from: 0,
      to: 1,
      phase: 0,
      ecc: 0,
      shift: 0,
      bpm: 60,
      ...params,
    };

    validator.validateMotionParameters(params);

    const {
      from, to, phase, ecc, bpm, shift,
    } = params;

    const { sin, PI } = Math;

    const angularVelocity = (2 * PI * bpm) / 60;
    const scale = to - from;
    const offset = to;
    const mod = (a, b) => ((a % b) + b) % b; // Proper mathematical modulus operator.

    const provider = ({ index, frequency }) => {
      const angle = (((index + 1) * angularVelocity) / frequency) + (0.5 * PI * phase) + shift;

      const x = (mod(angle, (2 * PI)) / PI) - 1 + (ecc / PI) * sin(angle);
      return offset - scale * x * x;
    };

    Ayva.#createConstantMotionProperties(provider, from, to, phase, ecc, bpm);
    return provider;
  }

  /**
   * Eccentric Parametric Oscillatory Linear Motion™
   *
   * @param {Number} from - the start of the range of motion
   * @param {Number} to - the end of the range of motion
   * @param {Number} [phase] - the phase of the motion in multiples of π/2
   * @param {Number} [ecc] - the eccentricity of the motion
   * @param {Number} [bpm] - beats per minute
   * @param {Number} [shift] - additional phase shift of the motion in radians
   * @returns the value provider
   *//**
   * Eccentric Parametric Oscillatory Linear Motion™
   *
   * @param {Object} params - the parameters of the motion.
   * @returns the value provider
   */
  static linearMotion (from, to, phase = 0, ecc = 0, bpm = 60, shift = 0) {
    const params = typeof from === 'object' ? from : {
      from, to, phase, ecc, bpm, shift,
    };

    return Ayva.#linearMotion(params);
  }

  static #linearMotion (params) {
    // TODO: Thou shalt not repeat thyself.
    params = { // eslint-disable-line no-param-reassign
      from: 0,
      to: 1,
      phase: 0,
      ecc: 0,
      shift: 0,
      bpm: 60,
      ...params,
    };

    validator.validateMotionParameters(params);

    const {
      from, to, phase, ecc, bpm, shift,
    } = params;

    const { abs, sin, PI } = Math;

    const angularVelocity = (2 * PI * bpm) / 60;
    const scale = to - from;
    const offset = to;
    const mod = (a, b) => ((a % b) + b) % b; // Proper mathematical modulus operator.

    const provider = ({ index, frequency }) => {
      const angle = (((index + 1) * angularVelocity) / frequency) + (0.5 * PI * phase) + shift;

      const x = (mod(angle, (2 * PI)) / PI) - 1 + (ecc / PI) * sin(angle);
      return offset - scale * abs(x);
    };

    Ayva.#createConstantMotionProperties(provider, from, to, phase, ecc, bpm);
    return provider;
  }

  static #createConstantMotionProperties (provider, from, to, phase, ecc, bpm) {
    createConstantProperty(provider, 'from', from);
    createConstantProperty(provider, 'to', to);
    createConstantProperty(provider, 'phase', phase);
    createConstantProperty(provider, 'ecc', ecc);
    createConstantProperty(provider, 'bpm', bpm);
  }

  /**
   * Creates a value provider that is a blend of the two value providers passed.
   * The factor is the multiplier for the values generated by the second provider.
   * The first provider's values will be multiplied by 1 - factor.
   *
   * @param {Function} firstProvider
   * @param {Function} secondProvider
   * @param {Number} factor - value between 0 and 1
   */
  static blendMotion (firstProvider, secondProvider, factor) {
    return (...args) => round((1 - factor) * firstProvider(...args) + factor * secondProvider(...args), Ayva.precision);
  }

  /**
   * Return a copy of the default configuration.
   */
  static get defaultConfiguration () {
    return {
      ...OSR_CONFIG,
    };
  }

  /**
   * Maps a value from one range to another. The default target range is [0, 1].
   * Does not constrain values to within the range.
   *
   * This function is analagous to the map() function in the arduino's math library:
   *
   * {@link https://www.arduino.cc/reference/en/language/functions/math/map/}
   *
   * @param {Number} value
   * @param {Number} inMin
   * @param {Number} inMax
   * @param {Number} [outMin=0]
   * @param {Number} [outMax=1]
   */
  static map (value, inMin, inMax, outMin = 0, outMax = 1) {
    return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
  }
}

// Separate default export from the class declaration because of jsdoc shenanigans...
export default Ayva;
