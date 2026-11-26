/**
 * Various utility functions
 *
 * @module
 * @ignore
 */

/**
 * Round a number to the specified number of decimals.
 */
export function round (value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(factor * value) / factor;
}

/**
 * Clamp a value to within the specified range.
 */
export function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Check if a value is numeric and within a certain range.
 */
export function validNumber (value, min, max) {
  if (!Number.isFinite(value)) {
    return false;
  }

  if (min !== undefined && value < min) {
    return false;
  }

  if (max !== undefined && value > max) {
    return false;
  }

  return true;
}

/**
 * Shorthand for defining a readonly property.
 */
export function createConstantProperty (object, name, value) {
  Object.defineProperty(object, name, {
    value: value,
    writeable: false,
    configurable: false,
    enumerable: true,
  });
}

/**
 * Shorthand for Object.prototype.hasOwnProperty.call()
 */
export function has (obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

/**
 * Shorthand for throwing an error during validation.
 */
export function fail (error) {
  throw new Error(error);
}

/**
 * Tests exactly what it says.
 */
export function isGeneratorFunction (value) {
  return value.constructor.name === 'GeneratorFunction';
}

export { default as cloneDeep } from './lodash.clonedeep.js';
