/**
 * A worker timer is a timer that delegates setTimeout to a Web Worker.
 * Performing a timeout in a Web Worker provides greater accuracy (it prevents
 * a timeout from being severely delayed when switching tabs for example).
 *
 * @ignore
 */
class WorkerTimer {
  #worker;

  #resolves = {};

  #nextResolveId = 1;

  constructor () {
    /* c8 ignore start */
    /* Web Worker Script - Ignored from test coverage as this only ever runs as a worker in a Browser. */
    const workerScript = function () {
      onmessage = function (message) {
        const { id, delay } = message.data;

        setTimeout(() => {
          postMessage(id);
        }, delay * 1000);
      };
    };
    /* c8 ignore stop */

    this.#worker = new Worker(this.#getWorkerUrl(workerScript));

    this.#worker.onmessage = ({ data }) => {
      const id = data;

      this.#resolves[id]();
      delete this.#resolves[id];
    };
  }

  /**
   * Returns a Promise that resolves when the specified delay has elapsed.
   *
   * @param {Number} delay - delay in seconds
   * @returns {Promise}
   */
  sleep (delay) {
    return new Promise((resolve) => {
      const id = this.#nextResolveId++;

      this.#resolves[id] = resolve;
      this.#worker.postMessage({ id, delay });
    });
  }

  /**
   * Get the current time in seconds.
   *
   * @returns - the current time in seconds.
   */
  now () {
    return performance.now() / 1000;
  }

  /**
   * Convert a function into a Blob, then generate an object URL from that blob to
   * be used for a Web Worker.
   *
   * https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
   */
  #getWorkerUrl (fn) {
    const blob = new Blob([`(${fn.toString()})()`], { type: 'text/javascript' });
    return URL.createObjectURL(blob);
  }
}

export default WorkerTimer;
