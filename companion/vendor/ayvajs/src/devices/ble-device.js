/**
 * Small convenience class for easily connecting to a Bluetooth LE device from a browser
 * using the [Web Bluetooth API]{@link https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API}.
 */
class BLEDevice {
  static SERVICE_UUID = 'ff1b451d-3070-4276-9c81-5dc5ea1043bc';

  static CHARACTERISTIC_UUID = 'c5f1543e-338d-47a0-8525-01e3c621359d';

  connected = false;

  _bluetooth = null;

  _characteristic = null;

  _encoder = new TextEncoder();

  /**
   * Create a new BLEDevice.
   *
   * @example
   * const device = new BLEDevice();
   *
   * @param {Bluetooth} [bluetooth=navigator.bluetooth] - Web Bluetooth API interface.
   */
  constructor (bluetooth = null) {
    this._bluetooth = bluetooth || (globalThis.navigator ? globalThis.navigator.bluetooth : null);
  }

  /**
   * Opens a request to connect to a BLE device.
   *
   * @example
   * const device = new BLEDevice();
   * device.requestConnection().then(() => {
   *   // ...
   * });
   *
   * @returns {Promise} a promise that resolves when the device is connected, and rejects if the device failed to connect.
   */
  async requestConnection () {
    if (!this._bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }

    const device = await this._bluetooth.requestDevice({
      filters: [{
        services: [BLEDevice.SERVICE_UUID],
      }],
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLEDevice.SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLEDevice.CHARACTERISTIC_UUID);

    this.connected = true;

    const disconnectListener = () => {
      this.connected = false;

      this._device?.removeEventListener('disconnect', disconnectListener);
      this._device = null;
      this._characteristic = null;
    };

    device.addEventListener('gattserverdisconnected', disconnectListener);

    this._characteristic = characteristic;
    this._device = device;

    // Add a small delay so that the OSR has time to "boot" or w/e...
    return new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }

  async disconnect () {
    this.connected = false;

    this._device.gatt.disconnect();
  }

  /**
   * Write output to the device.
   *
   * @param {String} output - string to send to the device.
   */
  write (output) {
    if (this.connected) {
      this._characteristic.writeValueWithoutResponse(this._encoder.encode(output)).catch(() => {
        /* Ignore GATT operation already in progress errors. */
      });
    } else {
      throw new Error('No device connected.');
    }
  }
}

export default BLEDevice;
