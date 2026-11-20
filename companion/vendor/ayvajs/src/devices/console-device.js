/**
 * Small convenience class to print TCode to console.
 */
class ConsoleDevice {
  connected = false;

  async requestConnection () {
    this.connected = true;
  }

  async disconnect () {
    this.connected = false;
  }

  write (output) {
    if (this.connected) {
      console.log(output); // eslint-disable-line no-console
    } else {
      throw new Error('Not connected.');
    }
  }
}

export default ConsoleDevice;
