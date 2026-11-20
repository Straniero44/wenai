/**
 * Small convenience class for easily connecting to a serial device from a browser
 * using the [Web Serial API]{@link https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API}.
 */
class WebSerialDevice {
  connected = false;

  _baudRate;

  _output = null;

  _input = null;

  _serial = null;

  _outputClosedPromise = null;

  _inputClosedPromise = null;

  /**
   * Create a new WebSerialDevice.
   *
   * @example
   * const device = new WebSerialDevice();
   *
   * @param {Number} [baudRate=115200] - Communication rate.
   * @param {Serial} [serial=navigator.serial] - Web Serial API interface.
   */
  constructor (baudRate = 115200, serial = null) {
    this._baudRate = baudRate;
    this._serial = serial || (globalThis.navigator ? globalThis.navigator.serial : null);
  }

  /**
   * Opens a request to connect to a serial device.
   *
   * @example
   * const device = new WebSerialDevice();
   * device.requestConnection().then(() => {
   *   // ...
   * });
   *
   * @returns {Promise} a promise that resolves when the device is connected, and rejects if the device failed to connect.
   */
  async requestConnection () {
    if (!this._serial) {
      throw new Error('Web Serial is not supported in this browser.');
    }

    const port = await this._serial.requestPort();

    await port.open({ baudRate: this._baudRate });

    const encoder = new TextEncoderStream();
    this._outputClosedPromise = encoder.readable.pipeTo(port.writable);

    const decoder = new TextDecoderStream();
    this._inputClosedPromise = port.readable.pipeTo(decoder.writable);

    this._output = encoder.writable.getWriter();
    this._input = decoder.readable.getReader();
    this._port = port;
    this.connected = true;

    const disconnectListener = (event) => {
      if (event.target === port) {
        this.connected = false;

        this._serial.removeEventListener('disconnect', disconnectListener);
      }
    };

    this._serial.addEventListener('disconnect', disconnectListener);

    // Add a small delay so that the OSR has time to "boot" or w/e...
    return new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }

  async disconnect () {
    this.connected = false;

    this._input.cancel();
    this._output.close();

    await this._inputClosedPromise.catch(() => { /* Ignore the error */ });
    await this._outputClosedPromise;
    await this._port.close();

    this._output = null;
    this._input = null;
    this._inputClosedPromise = null;
    this._outputClosedPromise = null;
  }

  /**
   * Write output to the device.
   *
   * @param {String} output - string to send to the device.
   */
  write (output) {
    if (this.connected) {
      this._output.write(output);
    } else {
      throw new Error('No device connected.');
    }
  }
}

export default WebSerialDevice;
