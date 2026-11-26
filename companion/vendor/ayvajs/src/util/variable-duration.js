import { clamp, validNumber } from './util.js';

/**
 * A variable duration is a timer that completes within some variable time range.
 */
class VariableDuration {
  #startTime;

  #targetElapsed;

  /**
   * Create and start the duration timer immediately.
   *
   * @example
   * // Create a duration that will be somewhere between 10 and 20 seconds.
   * const duration = new VariableDuration(10, 20);
   *
   * // ...
   *
   * if (!duration.complete) {
   *   // ...
   * }
   * @param {Number} from - start of the duration range in seconds.
   * @param {Number} [to] - end of the duration range in seconds.
   */
  constructor (from, to) {
    if (validNumber(from, 0) && to === undefined) {
      // Allow specifying only a single time unit duration.
      this.#targetElapsed = from * 1000;
    } else if (!validNumber(from, 0) || !validNumber(to, 0)) {
      throw new Error(`Invalid duration range: (${from}, ${to})`);
    } else {
      // Pick a random time within the specified range to complete.
      const min = Math.min(from, to);
      const max = Math.max(from, to);
      this.#targetElapsed = (Math.random() * (max - min) + min) * 1000;
    }

    this.#startTime = performance.now();
  }

  get targetElapsed () {
    return this.#targetElapsed;
  }

  /**
   * True if this duration's target time has been reached.
   */
  get complete () {
    return performance.now() - this.#startTime >= this.#targetElapsed;
  }

  /**
   * Returns the percent complete of this duration.
   */
  get percentage () {
    return clamp((performance.now() - this.#startTime) / this.#targetElapsed, 0, 1);
  }
}

export default VariableDuration;
