import { execFile } from 'node:child_process';
import dgram from 'node:dgram';

import { loadConfig, normalizeConfig, normalizeHost, normalizeUdpTarget } from './config.js';
import { AXES, PositionBuffer } from './position-buffer.js';

/** How long a silent UDP port gets before the host itself has to answer. */
export const UDP_PROBE_TIMEOUT_MS = 700;

const PROBE_PAYLOAD = Buffer.from('D0\n');

function pingHost(host) {
  return new Promise((resolve) => {
    if (typeof host !== 'string' || host === '' || host.startsWith('-') || /\s/.test(host)) {
      resolve(false);
      return;
    }
    execFile('ping', ['-c', '1', '-W', '1', host], { timeout: 1500 }, (error) => {
      resolve(!error);
    });
  });
}

function closeProbeSocket(socket) {
  socket.removeAllListeners('error');
  socket.on('error', () => {});
  try {
    socket.close();
  } catch {
    // The socket may already be closed.
  }
}

/**
 * Check that a device UDP port is open.
 * A refused or unreachable port fails. A TCode device often stays silent, so a
 * port that does not refuse still counts as open when the host answers a ping.
 *
 * @param {string} host
 * @param {number} port
 * @param {{ timeoutMs?: number, ping?: (host: string) => Promise<boolean> }} [options]
 */
export function probeUdp(host, port, options = {}) {
  const timeoutMs = options.timeoutMs ?? UDP_PROBE_TIMEOUT_MS;
  const ping = options.ping ?? pingHost;
  const reachability = ping(host);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeProbeSocket(socket);
      if (error) reject(error);
      else resolve();
    };
    const fail = (message) => finish(new RangeError(message));
    const timer = setTimeout(() => {
      reachability.then((alive) => {
        if (alive) finish();
        else fail(`UDP ${host}:${port} is not open`);
      }, () => fail(`UDP ${host}:${port} is not open`));
    }, timeoutMs);

    socket.on('message', () => finish());
    socket.on('error', (error) => {
      if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') {
        fail(`Cannot resolve ${host}`);
        return;
      }
      if (error?.code === 'EHOSTUNREACH' || error?.code === 'ENETUNREACH' || error?.code === 'EHOSTDOWN') {
        fail(`UDP host ${host} is unreachable`);
        return;
      }
      fail(`UDP ${host}:${port} is not open`);
    });

    try {
      socket.connect(port, host);
    } catch {
      fail(`UDP ${host}:${port} is not open`);
      return;
    }
    socket.once('connect', () => {
      try {
        socket.send(PROBE_PAYLOAD);
      } catch {
        fail(`UDP ${host}:${port} is not open`);
      }
    });
  });
}

const defaultScheduler = {
  setTimeout(fn, delay) {
    return setTimeout(fn, delay);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

// TCode 0.3: DeviceAxis.IsValueDirty scales by (outputMaximum + 1), which is 10000.
const DIRTY_SCALE = 10000;

/** Keyword that routes one command to the emulator bridge instead of the device. */
export const EMULATOR_TARGET = 'emulator';

/** Token that routes one command to the configured device. This is also the default. */
export const DEVICE_TARGET = 'tcode.local';

/**
 * Map a POST `target` field to a routing decision.
 *
 * `null` means "use the configured device", which is what an absent field does.
 * `true` means the emulator. Anything other than the two keywords is rejected,
 * so a request can never make the service emit UDP to an arbitrary host.
 *
 * @param {unknown} value raw `target` field
 * @returns {null|true} null for the device, true for the emulator
 * @throws {TypeError|RangeError} for any other value
 */
export function parseTarget(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new TypeError('target must be a string');
  }
  if (value === EMULATOR_TARGET) return true;
  if (value === DEVICE_TARGET) return null;
  throw new RangeError(`target must be "${EMULATOR_TARGET}" or "${DEVICE_TARGET}"`);
}

function isValueDirty(value, lastValue) {
  const valueFinite = Number.isFinite(value);
  const lastFinite = Number.isFinite(lastValue);
  if (valueFinite !== lastFinite) return true;
  if (!valueFinite) return false;
  return Math.abs(lastValue - value) * DIRTY_SCALE >= 1;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function formatPacket(entries, elapsedMs) {
  // MultiFunPlayer appends I{floor(elapsedMs + 0.75)} on every axis in the line.
  const interval = Math.floor(elapsedMs + 0.75);
  const body = entries.map(([axis, position]) => {
    const units = Math.min(9999, Math.max(0, Math.round(position * 9999)));
    return `${axis}${String(units).padStart(4, '0')}I${interval}`;
  }).join(' ');
  return `${body}\n`;
}

function resolveClock(clock) {
  if (typeof clock === 'function') return { now: clock };
  if (clock == null) return { now: () => Date.now() };
  if (typeof clock.now !== 'function') {
    throw new TypeError('clock.now() is required');
  }
  return clock;
}

/**
 * Fixed-period TCode 0.3 UDP output.
 * Pass a socket and a clock so tests can sample without a real device or timer.
 */
export class UdpOutput {
  #speedCap;
  #scheduler;
  #sampled = new Map();
  #lastSent = new Map();
  #timer = null;
  #lastNow = null;
  #running = false;
  #ownsSocket = false;
  #routeEmulator = false;
  #emulatorSocket = null;
  #emulatorFailed = false;
  #suppressFault = false;

  constructor(options = {}) {
    if (options == null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('UdpOutput options must be an object');
    }
    const base = Object.hasOwn(options, 'configPath')
      ? loadConfig(options.configPath)
      : Object.hasOwn(options, 'config')
        ? normalizeConfig(options.config ?? {})
        : loadConfig();
    const resolved = normalizeConfig({
      http: base.http,
      udp: {
        ...base.udp,
        ...(options.host != null ? { host: options.host } : {}),
        ...(options.port != null ? { port: options.port } : {}),
        ...(options.intervalMs != null ? { intervalMs: options.intervalMs } : {}),
      },
      emulator: {
        ...base.emulator,
        ...(options.emulatorHost != null ? { host: options.emulatorHost } : {}),
        ...(options.emulatorPort != null ? { port: options.emulatorPort } : {}),
      },
      speedCap: { ...base.speedCap, ...options.speedCap },
      travel: base.travel,
    });

    this.intervalMs = resolved.udp.intervalMs;
    this.host = resolved.udp.host;
    this.port = resolved.udp.port;
    this.emulatorHost = resolved.emulator.host;
    this.emulatorPort = resolved.emulator.port;
    this.#speedCap = { ...resolved.speedCap };
    this.buffer = options.buffer ?? new PositionBuffer();
    this.socket = options.socket ?? null;
    this.clock = resolveClock(options.clock);
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.onFault = options.onFault ?? null;
    this.status = 'idle';
    this.lastError = null;
  }

  get speedCap() {
    return { ...this.#speedCap };
  }

  /**
   * Where the next packet goes. Set by every accepted command; an absent
   * `target` in the POST resets this to the configured device.
   */
  get target() {
    return this.#routeEmulator ? EMULATOR_TARGET : DEVICE_TARGET;
  }

  /**
   * Route subsequent output. Only the keywords parseTarget() accepts get here,
   * so this can never point the service at an arbitrary host.
   *
   * @param {null|true} decision null for the device, true for the emulator
   */
  setTarget(decision) {
    if (decision !== null && decision !== true) {
      throw new TypeError('setTarget expects null or true');
    }
    this.#routeEmulator = decision === true;
  }

  setSpeedCap(update) {
    const patch = typeof update === 'number' ? { maxUnitsPerSecond: update } : update;
    if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('setSpeedCap expects a number or an object');
    }
    const hasValue = Object.hasOwn(patch, 'maxUnitsPerSecond');
    const hasEnabled = Object.hasOwn(patch, 'enabled');
    const ceiling = this.#speedCap.ceiling;
    let maxUnitsPerSecond = this.#speedCap.maxUnitsPerSecond;
    let enabled = this.#speedCap.enabled;

    if (hasValue) {
      const value = patch.maxUnitsPerSecond;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ceiling) {
        throw new RangeError(`maxUnitsPerSecond must be greater than 0 and at most ${ceiling}`);
      }
      maxUnitsPerSecond = value;
    }
    if (hasEnabled) {
      if (typeof patch.enabled !== 'boolean') {
        throw new TypeError('speedCap.enabled must be a boolean');
      }
      enabled = patch.enabled;
    } else if (hasValue) {
      enabled = true;
    }

    this.#speedCap = { enabled, maxUnitsPerSecond, ceiling };
    return this.speedCap;
  }

  /**
   * Point the device socket at a new host or port.
   * A blank host becomes tcode.local. A blank port becomes 8000.
   * While the output is running, the owned socket disconnects and connects again.
   * A failed reconnect restores the previous address and does not fault the session.
   */
  async setDevice(update = {}) {
    if (update == null || typeof update !== 'object' || Array.isArray(update)) {
      throw new TypeError('setDevice expects an object');
    }
    const host = Object.hasOwn(update, 'host') ? update.host : this.host;
    const port = Object.hasOwn(update, 'port') ? update.port : this.port;
    const next = normalizeUdpTarget(host, port);
    if (next.host === this.host && next.port === this.port) {
      return { host: this.host, port: this.port };
    }
    const previous = { host: this.host, port: this.port };
    this.host = next.host;
    this.port = next.port;
    if (this.status !== 'running' || !this.socket || typeof this.socket.connect !== 'function') {
      return { host: this.host, port: this.port };
    }
    try {
      await this.#rebind();
    } catch (error) {
      this.host = previous.host;
      this.port = previous.port;
      try {
        await this.#rebind();
      } catch (rollbackError) {
        this.#fail(rollbackError);
      }
      const detail = typeof error?.message === 'string' && error.message !== ''
        ? error.message
        : 'connect failed';
      throw new Error(`Could not use ${next.host}:${next.port}: ${detail}`);
    }
    return { host: this.host, port: this.port };
  }

  sample(elapsedMs) {
    if (this.status === 'fault') return;
    if (!Number.isFinite(elapsedMs)) {
      throw new RangeError('elapsedMs must be a finite number');
    }
    const dt = elapsedMs / 1000;
    const dirty = [];
    for (const axis of AXES) {
      const target = this.buffer.get(axis);
      if (!Number.isFinite(target)) continue;
      const next = this.#limit(axis, target, dt);
      if (!isValueDirty(next, this.#lastSent.get(axis))) continue;
      this.#lastSent.set(axis, next);
      dirty.push([axis, next]);
    }
    if (dirty.length === 0) return;
    try {
      this.#send(formatPacket(dirty, elapsedMs));
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async start() {
    if (this.#running) return;
    if (this.status === 'fault') {
      throw new Error('UdpOutput is in fault and will not send');
    }
    if (!this.socket) {
      this.socket = dgram.createSocket('udp4');
      this.#ownsSocket = true;
    }
    try {
      await this.#connect();
      const now = this.clock.now();
      if (!Number.isFinite(now)) {
        throw new TypeError('clock.now() must return finite milliseconds');
      }
      this.#lastNow = now;
    } catch (error) {
      this.#fail(error);
      throw error;
    }
    if (this.#ownsSocket) {
      this.socket.on('error', (error) => this.#fail(error));
    }
    this.status = 'running';
    this.#running = true;
    this.#schedule();
  }

  stop() {
    this.#running = false;
    this.#clearTimer();
    this.#closeOwnedSocket();
    this.#closeEmulatorSocket();
    if (this.status !== 'fault') this.status = 'stopped';
  }

  #limit(axis, target, dt) {
    const previous = this.#sampled.get(axis);
    let next = target;
    if (this.#speedCap.enabled && Number.isFinite(previous)) {
      const delta = target - previous;
      const maxStep = this.#speedCap.maxUnitsPerSecond * dt;
      if (Math.abs(delta) > maxStep) {
        next = previous + Math.sign(delta) * maxStep;
      }
    }
    next = clamp01(next);
    this.#sampled.set(axis, next);
    return next;
  }

  async #rebind() {
    const socket = this.socket;
    if (!socket || typeof socket.connect !== 'function') return;
    this.#suppressFault = true;
    try {
      if (typeof socket.disconnect === 'function') {
        try {
          socket.disconnect();
        } catch {
          // An idle socket, or one that is already disconnected, refuses disconnect.
        }
      }
      if (this.#ownsSocket) await this.#connect();
      else await socket.connect(this.port, normalizeHost(this.host));
    } finally {
      this.#suppressFault = false;
    }
  }

  async #connect() {
    if (typeof this.socket.connect !== 'function') return;
    const host = normalizeHost(this.host);
    if (this.#ownsSocket) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          this.socket.off('error', onError);
          this.socket.off('connect', onConnect);
        };
        this.socket.once('error', onError);
        this.socket.once('connect', onConnect);
        this.socket.connect(this.port, host);
      });
      return;
    }
    await this.socket.connect(this.port, host);
  }

  #send(packet) {
    if (this.#routeEmulator) {
      this.#sendToEmulator(packet);
      return;
    }
    if (!this.socket || typeof this.socket.send !== 'function') {
      throw new TypeError('UdpOutput requires a socket with send()');
    }
    if (this.#ownsSocket) {
      this.socket.send(packet, (error) => {
        if (error) this.#fail(error);
      });
      return;
    }
    this.socket.send(packet);
  }

  /**
   * Emulator traffic uses its own unconnected socket.
   *
   * Unconnected sockets do not receive ICMP port-unreachable as an error event,
   * so a stopped bridge cannot fault the session that drives the real device.
   * Failures here are recorded but never escalate: the emulator is a viewer.
   */
  #sendToEmulator(packet) {
    if (this.#emulatorSocket == null) {
      this.#emulatorSocket = dgram.createSocket('udp4');
      this.#emulatorSocket.on('error', (error) => {
        this.#emulatorFailed = true;
        this.lastEmulatorError = error;
      });
    }
    this.#emulatorSocket.send(
      packet,
      this.emulatorPort,
      this.emulatorHost,
      (error) => {
        if (error) {
          this.#emulatorFailed = true;
          this.lastEmulatorError = error;
        }
      },
    );
  }

  #closeEmulatorSocket() {
    const socket = this.#emulatorSocket;
    this.#emulatorSocket = null;
    if (socket && typeof socket.close === 'function') {
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
    }
  }

  #schedule() {
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = null;
      this.#onTick();
    }, this.intervalMs);
  }

  #onTick() {
    if (!this.#running) return;
    try {
      const now = this.clock.now();
      if (!Number.isFinite(now)) {
        throw new TypeError('clock.now() must return finite milliseconds');
      }
      const elapsed = now - this.#lastNow;
      this.#lastNow = now;
      this.sample(elapsed);
    } catch (error) {
      if (this.status !== 'fault') this.#fail(error);
      return;
    }
    if (this.#running) this.#schedule();
  }

  #clearTimer() {
    if (this.#timer == null) return;
    this.#scheduler.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #closeOwnedSocket() {
    if (!this.#ownsSocket) return;
    const socket = this.socket;
    this.#ownsSocket = false;
    this.socket = null;
    if (socket && typeof socket.close === 'function') {
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
    }
  }

  #fail(error) {
    if (this.#suppressFault) return;
    if (this.status === 'fault') return;
    this.status = 'fault';
    this.#running = false;
    this.lastError = error;
    this.#clearTimer();
    this.#closeOwnedSocket();
    this.#closeEmulatorSocket();
    if (typeof this.onFault === 'function') this.onFault(error);
  }
}
