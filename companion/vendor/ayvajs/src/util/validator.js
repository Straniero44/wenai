import {
  has, fail, validNumber
} from './util.js';

export default {
  /**
   * All the validation on movement descriptors :O
   *
   * @param {Array} movements
   */
  validateMovements (movements, axes, defaultAxis) {
    const movementMap = {};
    let atLeastOneDuration = false;
    let atLeastOneNonBoolean = false;

    if (!movements || !movements.length) {
      fail('Must supply at least one movement.');
    }

    movements.forEach((movement) => {
      if (!movement || typeof movement !== 'object') {
        fail(`Invalid movement: ${movement}`);
      }

      const invalidValue = (name) => fail(`Invalid value for parameter '${name}': ${movement[name]}`);
      const hasTo = has(movement, 'to');
      const hasSpeed = has(movement, 'speed');
      const hasDuration = has(movement, 'duration');
      const hasValue = has(movement, 'value');
      const axis = movement.axis || defaultAxis;

      if (!axis) {
        fail('No default axis configured. Must specify an axis for each movement.');
      }

      if (has(movement, 'axis')) {
        if (typeof movement.axis !== 'string' || !movement.axis.trim() || !axes[movement.axis]) {
          invalidValue('axis');
        }
      }

      if (hasTo) {
        let invalidTo = false;

        if (axes[axis].type === 'boolean') {
          invalidTo = typeof movement.to !== 'boolean';
        } else {
          invalidTo = !Number.isFinite(movement.to) || (movement.to < 0 || movement.to > 1);
        }

        if (invalidTo) {
          invalidValue('to');
        }
      } else if (!hasValue) {
        fail('Must provide a \'to\' property or \'value\' function.');
      }

      if (hasSpeed && hasDuration) {
        fail('Cannot supply both speed and duration.');
      }

      if (hasSpeed || hasDuration) {
        atLeastOneDuration = true;

        if (hasSpeed && (!Number.isFinite(movement.speed) || movement.speed <= 0)) {
          invalidValue('speed');
        } else if (hasDuration && (!Number.isFinite(movement.duration) || movement.duration <= 0)) {
          invalidValue('duration');
        }
      }

      if (hasSpeed && !hasTo) {
        fail('Must provide a target position when specifying speed.');
      }

      if (hasValue && typeof movement.value !== 'function') {
        fail('\'value\' must be a function.');
      }

      if (has(movement, 'sync')) {
        if (typeof movement.sync !== 'string' || !movement.sync.trim()) {
          invalidValue('sync');
        }

        if (has(movement, 'speed') || has(movement, 'duration')) {
          fail(`Cannot specify a speed or duration when sync property is present: ${movement.axis}`);
        }
      }

      if (axes[axis].type !== 'boolean') {
        atLeastOneNonBoolean = true;
      } else {
        if (has(movement, 'speed')) {
          fail(`Cannot specify speed for boolean axes: ${axis}`);
        }

        if (has(movement, 'duration') && hasTo && !hasValue) {
          // { to: <boolean>, duration: <number> } is invalid (for now).
          fail('Cannot specify a duration for a boolean axis movement with constant value.');
        }
      }

      if (movementMap[axis]) {
        fail(`Duplicate axis movement: ${axis}`);
      }

      movementMap[axis] = movement;

      if (axes[axis].alias) {
        movementMap[axes[axis].alias] = movement;
      }
    });

    movements.forEach((movement) => {
      let syncMovement = movement;
      const originalMovementAxis = movement.axis;

      while (has(syncMovement, 'sync')) {
        if (!movementMap[syncMovement.sync]) {
          fail(`Cannot sync with axis not specified in movement: ${syncMovement.axis} -> ${syncMovement.sync}`);
        }

        syncMovement = movementMap[syncMovement.sync];

        if (syncMovement.sync === originalMovementAxis) {
          fail('Sync axes cannot form a cycle.');
        }
      }
    });

    if (!atLeastOneDuration && atLeastOneNonBoolean) {
      fail('At least one movement must have a speed or duration.');
    }
  },

  /**
   * Ensure all required fields are present in the configuration and that all are of valid types.
   *
   * @param {Object} axisConfig
   */
  validateAxisConfig (axisConfig) {
    if (!axisConfig || typeof axisConfig !== 'object') {
      fail(`Invalid configuration object: ${axisConfig}`);
    }

    const required = ['name', 'type'];

    const types = {
      name: 'string',
      type: 'string',
      alias: 'string',
      max: 'number',
      min: 'number',
    };

    const missing = required.filter(
      (property) => axisConfig[property] === undefined || axisConfig[property] === null
    ).sort();

    if (missing.length) {
      fail(`Configuration is missing properties: ${missing.join(', ')}`);
    }

    const invalid = [];

    Object.keys(types).forEach((property) => {
      const value = axisConfig[property];

      // Since we've already caught missing required fields by this point,
      // we only need to check types of optional fields if they are actually present.
      if (value !== undefined && value !== null) {
        // eslint-disable-next-line valid-typeof
        if (typeof value !== types[property]) {
          invalid.push(property);
        } else if (property === 'min' || property === 'max') {
          if (!Number.isFinite(value) || value < 0 || value > 1) {
            invalid.push(property);
          }
        } else if (property === 'alias' || property === 'name') {
          if (!/^[a-zA-Z]+[a-zA-Z0-9]*$/.test(value)) {
            invalid.push(property);
          }
        }
      }
    });

    let { defaultValue } = axisConfig;

    if (defaultValue !== undefined && defaultValue !== null) {
      // Validate user supplied default value.
      if (axisConfig.type === 'boolean') {
        if (typeof defaultValue !== 'boolean') {
          invalid.push('defaultValue');
        }
      } else if (!Number.isFinite(defaultValue) || defaultValue < 0 || defaultValue > 1) {
        invalid.push('defaultValue');
      }
    } else if (axisConfig.type === 'boolean') {
      defaultValue = false;
    } else if (axisConfig.type === 'auxiliary') {
      defaultValue = 0;
    } else {
      // 0.5 is home position for linear and rotation axes.
      defaultValue = 0.5;
    }

    if (invalid.length) {
      const message = invalid.sort().map((property) => `${property} = ${axisConfig[property]}`).join(', ');
      fail(`Invalid configuration parameter(s): ${message}`);
    }

    if (['linear', 'rotation', 'auxiliary', 'boolean'].indexOf(axisConfig.type) === -1) {
      fail(`Invalid type. Must be linear, rotation, auxiliary, or boolean: ${axisConfig.type}`);
    }

    const resultConfig = {
      ...axisConfig,
      defaultValue,
      max: axisConfig.max || 1,
      min: axisConfig.min || 0,
      value: defaultValue,
      lastValue: defaultValue,
    };

    if (resultConfig.max === resultConfig.min || resultConfig.min > resultConfig.max) {
      fail(`Invalid configuration parameter(s): max = ${resultConfig.max}, min = ${resultConfig.min}`);
    }

    return resultConfig;
  },

  validateMotionParameters ({
    from, to, phase, ecc, bpm, shift,
  }) {
    const valid = validNumber(from, 0, 1)
      && validNumber(to, 0, 1)
      && validNumber(phase)
      && validNumber(ecc)
      && validNumber(bpm) && bpm > 0
      && validNumber(shift);

    if (!valid) {
      throw new Error(`One or more motion parameters are invalid (${from}, ${to}, ${phase}, ${ecc}, ${bpm}, ${shift})`);
    }
  },
};
