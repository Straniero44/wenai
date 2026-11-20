import Callable from '../util/callable.js';
import MoveBuilder from '../util/move-builder.js';
import Ayva from '../ayva.js'; // eslint-disable-line import/no-cycle

/**
 * Base class for Generator Behaviors.
 *
 * For full details on how to use this class, see the {@tutorial behavior-api} tutorial.
 */
class GeneratorBehavior extends Callable {
  #generator;

  #done = false;

  #ayva = null;

  #unboundStart;

  #unboundGenerate;

  #unboundIterated;

  get ayva () {
    return this.#ayva;
  }

  constructor (generate) {
    super();

    if (generate) {
      if (generate.constructor.name !== 'GeneratorFunction') {
        throw Error(`Not a generator function: ${generate}`);
      }

      this.generate = generate;
    }
  }

  /**
   * Generate any actions that setup this behavior. Typically this is moving the device into
   * some starting position. Subclasses can implement this method, although it is optional.
   *
   * For full details on how to implement this method, see the {@tutorial behavior-api} tutorial.
   *
   * @param {Ayva} [ayva] - instance of Ayva to generate actions for. Defaults to the Ayva instance bound to this behavior (if it exists).
   *//* c8 ignore start */
  * start (ayva) { // eslint-disable-line require-yield, no-unused-vars
    // Optional
  }/* c8 ignore stop */

  /**
   * Generate the actions that make up this behavior. Subclasses must implement this method.
   *
   * For full details on how to implement this method, see the {@tutorial behavior-api} tutorial.
   *
   * @param {Ayva} [ayva] - instance of Ayva to generate actions for. Defaults to the Ayva instance bound to this behavior (if it exists).
   */
  * generate (ayva) { // eslint-disable-line require-yield, no-unused-vars
    throw new Error('generate() not implemented.');
  }

  /**
   * Repeats the actions that make up this behavior the specified number of iterations.
   *
   * @param {Ayva} [ayva] - instance of Ayva to generate actions for. Defaults to the Ayva instance bound to this behavior (if it exists).
   * @param {Number} count - the number of iterations
   */
  * iterated (ayva, count = 1) {
    for (let i = 0; i < count; i++) {
      yield* this.generate(ayva);
    }
  }

  /**
   * Perform one step of this behavior.
   *
   * @param {Ayva} [ayva] - instance of Ayva to use. Defaults to the Ayva instance bound to this behavior (if it exists).
   * @returns Promise that resolves when the step is complete.
   */
  perform (ayva = this.#ayva) {
    const value = this.next(ayva);

    if (value) {
      if (Array.isArray(value)) {
        return ayva.move(...value);
      } else if (Number.isFinite(value) && value >= 0) {
        return ayva.ready().then(() => ayva.sleep(value));
      } else if (value instanceof MoveBuilder) {
        return value.execute();
      } else if (value instanceof Promise) {
        return value;
      }

      return ayva.move(value);
    }

    return Promise.resolve();
  }

  /**
   * Binds this behavior to the specified Ayva instance.
   *
   * Not to be confused with Function.prototype.bind(). Although the effect is similar.
   * This affects start(), generate(), iterated(), and when calling this behavior
   * using the shorthand callable syntax.
   *
   * @param {Ayva} ayva
   * @returns this behavior
   */
  bind (ayva) {
    this.unbind();
    this.#ayva = ayva;

    this.#unboundStart = this.start;
    this.#unboundGenerate = this.generate;
    this.#unboundIterated = this.iterated;

    this.start = this.start.bind(this, ayva);
    this.generate = this.generate.bind(this, ayva);
    this.iterated = this.iterated.bind(this, ayva);

    return this;
  }

  /**
   * Unbind this behavior from any Ayva instance.
   */
  unbind () {
    if (this.#ayva) {
      this.#ayva = null;
      this.start = this.#unboundStart;
      this.generate = this.#unboundGenerate;
      this.iterated = this.#unboundIterated;
    }
  }

  /**
   * Generate and return the next action of this behavior.
   *
   * @param {Ayva} ayva - defaults to the bound instance (if any)
   * @returns - the next action.
   */
  next (ayva = this.#ayva) {
    if (!this.#generator || this.#done) {
      this.#generator = this.generate(ayva);
      this.#done = false;
    }

    const { value, done } = this.#generator.next();

    this.#done = done;

    return !done ? value : null;
  }

  /**
   * Implementation for Callable.
   */
  __call__ (...args) {
    const countArg = this.#ayva ? args[0] : args[1];
    const ayva = this.#ayva || args[0];

    const count = Number.isFinite(countArg) && countArg >= 1 ? countArg : undefined;

    if (ayva !== undefined) {
      if (!(ayva instanceof Ayva)) {
        throw new TypeError(`Invalid Ayva instance: ${ayva}`);
      }
    }

    if (this.#ayva) {
      return count ? this.iterated(count) : this.generate();
    }

    return count ? this.iterated(ayva, count) : this.generate(ayva);
  }

  [Symbol.iterator] () {
    return this.generate();
  }
}

export default GeneratorBehavior;
