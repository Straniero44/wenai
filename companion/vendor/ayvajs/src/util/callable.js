/**
 * This class can be extended to make an object "callable" like a function.
 * It uses the first hacky technique found in this article:
 *
 * https://medium.com/@adrien.za/creating-callable-objects-in-javascript-fbf88db9904c
 */
/* c8 ignore start */
class Callable extends Function {
  constructor () {
    super('...args', 'return this.__bound__.__call__(...args)');

    // We use the prototype version of bind in case a subclass wants to override bind().
    this.__bound__ = Function.prototype.bind.call(this, this);

    // eslint-disable-next-line no-constructor-return
    return this.__bound__;
  }

  /**
   * Subclasses should implement this method to act as the function that
   * is called when the Callable is invoked.
   */
  __call__ (...args) { // eslint-disable-line no-unused-vars
    throw new Error('__call__ not implemented.');
  }
}
/* c8 ignore stop */
export default Callable;
