/* eslint-disable guard-for-in */

import GeneratorBehavior from './generator-behavior.js';
import * as AyvaModules from '../util/script-whitelist.js';

/**
 * A behavior that allows the execution of scripts stored in a string.
 *
 * WARNING: Scripts are run inside of a rudimentary sandbox. The sandbox is NOT secure.
 *          Care should be taken to avoid running scripts from untrusted sources.
 *
 * For full details on how to use this class, see the {@tutorial behavior-api} tutorial.
 */
class ScriptBehavior extends GeneratorBehavior {
  #scope;

  #code;

  /**
   * Create a new ScriptBehavior.
   *
   * @param {String} script - the script.
   * @param {Object} scope - an object containing variables to include in the script's scope.
   */
  constructor (script, scope = {}) {
    super();

    this.#scope = { ...AyvaModules, ...scope };

    // Escape quotes and backslashes.
    this.#code = script.replace(/["'`\\]/g, (v) => `\\${v}`);
  }

  * generate (ayva) {
    const generator = this.#createSandboxGenerator(ayva);

    /* c8 ignore start */
    // We turn off code coverage for this block because the branch at
    // the end of the loop is never hit due to how generators work... or something like that :)
    while (!this.complete) {
      // We only perform this in a loop so we do not have to recreate the sandbox each iteration.
      yield* generator(ayva);

      // Force a yield in case the sandbox generator did not yield a value.
      // This prevents an infinite loop.
      yield;
    }
    /* c8 ignore stop */
  }

  #createSandboxGenerator () {
    const scopeValues = [];
    let sandboxFunction = 'new Function(';

    for (const scopeProp in this.#scope) {
      sandboxFunction += `"${scopeProp}", `;
      scopeValues.push(this.#scope[scopeProp]);
    }

    for (const prop in globalThis) {
      // Blacklist globals that haven't been put in scope.
      if (!Object.prototype.hasOwnProperty.call(this.#scope, prop)) {
        sandboxFunction += `"${prop}", `;
      }
    }

    // Blacklist eval and Function
    sandboxFunction += '"eval", "Function", ';

    // Create the generate function from script.
    sandboxFunction += `\`
      return (function*(ayva) { 
        ${this.#code} 
      }).bind(this);\`);`;

    try {
      const sandbox = eval(sandboxFunction); // eslint-disable-line no-eval
      return sandbox.call(this, ...scopeValues);
    } catch (error) {
      throw new SyntaxError('Invalid AyvaScript.');
    }
  }
}

export default ScriptBehavior;
