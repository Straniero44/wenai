/**
 * Small convenience class for easily connecting to a web socket.
 */
class WebSocketDevice {
  connected = false;

  _host = null;

  _port = null;

  _socket = null;

  /**
   * Create a new WebSocketDevice.
   *
   * @example
   * const device = new WebSocketDevice('localhost', 8080);
   *
   * @param {String} host
   * @param {String} port
   * @param {Function} errorHandler
   */
  constructor (host, port, errorHandler = () => {}) {
    this._host = host;
    this._port = port;
    this._errorHandler = errorHandler;
  }

  /**
   * Opens a request to connect to a Web Socket device.
   *
   * @example
   * const device = new WebSocketDevice('localhost', 8080);
   *
   * device.requestConnection().then(() => {
   *   // ...
   * });
   *
   * @returns {Promise} a promise that resolves when the device is connected, and rejects if the device failed to connect.
   */
  async requestConnection () {
    let resolved = false;

    return new Promise((resolve, reject) => {
      const protocol = this._host === 'localhost' ? 'ws' : 'wss';
      const socket = new WebSocket(`${protocol}://${this._host}:${this._port}/ws`);

      socket.onopen = () => {
        resolve();
        resolved = true;
        this.connected = true;
      };

      socket.onclose = () => {
        this.connected = false;
      };

      socket.onerror = () => {
        this._errorHandler();
        this.connected = false;

        if (!resolved) {
          reject(new Error(`Unable to establish connection to host ${this._host} on port ${this._port}.`));
        }
      };

      this._socket = socket;
    });
  }

  async disconnect () {
    this._socket.close();
  }

  write (output) {
    if (this.connected) {
      this._socket.send(output);
    } else {
      throw new Error('No device connected.');
    }
  }
}

export default WebSocketDevice;
