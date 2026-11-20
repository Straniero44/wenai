export default class StrokeParameterProvider {
  #index = 0;

  #value;

  constructor (valueFunction) {
    this.#value = valueFunction;
  }

  next () {
    return this.#value(this.#index++);
  }

  get index () {
    return this.#index;
  }

  static createFrom (value) {
    if (value instanceof Array) {
      return new StrokeParameterProvider((index) => value[index % value.length]);
    }

    if (typeof value !== 'function') {
      return new StrokeParameterProvider(() => value);
    }

    return new StrokeParameterProvider(value);
  }
}
