/**
 * Local HTTP command gateway.
 * Behavior source: docs/ai-companion-design.md sections 7, 8, 10, and 11.
 * Playback and clamping stay in MotionSession and UdpOutput.
 */

import http from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  defaultConfigPath,
  normalizeTravel,
  normalizeTravelPatch,
  normalizeUdpTarget,
} from './config.js';
import {
  MotionInputError,
  STROKE_NAMES,
  cloneParameters,
  normalizePlay,
} from './parameters.js';
import { parseTarget, probeUdp } from './udp-output.js';
const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;
const CONFIG_PAGE_PATH = fileURLToPath(new URL('../public/index.html', import.meta.url));

const CONFIG_FIELDS = new Set(['udp', 'speedCap', 'travel']);
const CONFIG_UDP_FIELDS = new Set(['host', 'port']);
const CONFIG_SPEED_FIELDS = new Set(['enabled', 'maxUnitsPerSecond']);

const PLAY_FIELDS = new Set([
  'command',
  'clips',
  'transition_s',
  'bpm_mode',
  'bpm_range',
  'acceleration_range',
  'twist_enabled',
  'twist_range',
  'twist_phase',
  'twist_ecc',
  'target',
]);

const RESET_FIELDS = new Set(['command', 'target']);
const SPEED_FIELDS = new Set(['command', 'max_units_per_second', 'enabled', 'target']);

class HttpCommandError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HttpCommandError';
    this.status = status;
  }
}

function resolveHost(options) {
  const host = options.host ?? options.config?.http?.host ?? BIND_HOST;
  if (host !== BIND_HOST) {
    throw new Error('HTTP listens only on 127.0.0.1');
  }
  return BIND_HOST;
}

function resolvePort(options) {
  if (options.port != null) return options.port;
  if (options.config?.http?.port != null) return options.config.http.port;
  return DEFAULT_PORT;
}

function errorText(error) {
  if (error == null || error === '') return null;
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * Fields shared by POST /command and GET /debug/state.
 * Device packets stay on the output objects and are not copied here.
 */
export function snapshotState(session, udp) {
  const current = session.current == null
    ? null
    : {
      name: session.current.name,
      bpm: session.current.bpm,
      duration_s: session.current.duration_s,
    };
  const queue = Array.isArray(session.queue)
    ? session.queue.map((clip) => ({
      name: clip.name,
      bpm: clip.bpm,
      duration_s: clip.duration_s,
    }))
    : [];

  return {
    state: session.state,
    current,
    queue,
    bpm: session.bpm ?? null,
    parameters: cloneParameters(session.parameters),
    speedCap: {
      enabled: udp.speedCap.enabled,
      maxUnitsPerSecond: udp.speedCap.maxUnitsPerSecond,
      ceiling: udp.speedCap.ceiling,
    },
    udp: {
      host: udp.host,
      port: udp.port,
      target: typeof udp.target === 'string' ? udp.target : null,
    },
    lastError: errorText(session.lastError ?? udp.lastError),
  };
}

function assertFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpCommandError(`Unknown field: ${unknown.join(', ')}`);
  }
}

function ignoreCompletion(value) {
  if (value && typeof value.then === 'function') {
    value.then(() => {}, () => {});
  }
}

function rethrowSession(error) {
  if (error instanceof MotionInputError || error instanceof HttpCommandError) {
    throw error instanceof HttpCommandError ? error : new HttpCommandError(error.message);
  }
  if (error instanceof RangeError) throw new HttpCommandError(error.message);
  if (error?.message === 'Session is faulted') throw new HttpCommandError(error.message, 409);
  throw error;
}

/**
 * Read a POST `target` field.
 * Absent or "tcode.local" means the configured device; "emulator" means the bridge.
 * Rejecting everything else keeps a request from aiming the service at any host.
 *
 * @returns {null|true} null for the device, true for the emulator
 */
function readTarget(body) {
  if (!Object.hasOwn(body, 'target')) return null;
  try {
    return parseTarget(body.target);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new HttpCommandError(error.message);
    }
    throw error;
  }
}

/**
 * Apply routing for one accepted command.
 * Called only after validation passes, so a rejected request never moves the target.
 */
function applyTarget(udp, decision) {
  if (typeof udp.setTarget === 'function') udp.setTarget(decision);
}

function runPlay(body, session, udp) {
  assertFields(body, PLAY_FIELDS);
  const payload = { ...body };
  delete payload.command;
  delete payload.target;
  try {
    normalizePlay(payload, session.parameters);
  } catch (error) {
    rethrowSession(error);
  }
  if (session.state === 'fault') {
    throw new HttpCommandError('Session is faulted', 409);
  }
  applyTarget(udp, readTarget(body));
  try {
    // play() accepts synchronously. Homing and the clip timeline keep running after the response.
    ignoreCompletion(session.play(payload));
  } catch (error) {
    rethrowSession(error);
  }
}

function runReset(body, session, udp) {
  assertFields(body, RESET_FIELDS);
  if (session.state === 'fault') {
    throw new HttpCommandError('Session is faulted', 409);
  }
  applyTarget(udp, readTarget(body));
  try {
    ignoreCompletion(session.reset());
  } catch (error) {
    rethrowSession(error);
  }
}

function readSpeedUpdate(body, current) {
  assertFields(body, SPEED_FIELDS);
  const hasValue = Object.hasOwn(body, 'max_units_per_second');
  const hasEnabled = Object.hasOwn(body, 'enabled');
  const ceiling = current.ceiling;
  let maxUnitsPerSecond = current.maxUnitsPerSecond;

  if (hasValue) {
    const value = body.max_units_per_second;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ceiling) {
      throw new HttpCommandError(
        `max_units_per_second must be greater than 0 and at most ${ceiling}`,
      );
    }
    maxUnitsPerSecond = value;
  }

  if (hasEnabled && typeof body.enabled !== 'boolean') {
    throw new HttpCommandError('enabled must be a boolean');
  }

  const update = {};
  if (hasValue) update.maxUnitsPerSecond = maxUnitsPerSecond;
  update.enabled = hasEnabled ? body.enabled : true;
  return update;
}

function configTemplate() {
  return {
    http: { ...DEFAULT_CONFIG.http },
    udp: { ...DEFAULT_CONFIG.udp },
    speedCap: { ...DEFAULT_CONFIG.speedCap },
    travel: Object.fromEntries(
      Object.entries(DEFAULT_CONFIG.travel).map(([key, pair]) => [key, [...pair]]),
    ),
  };
}

function readConfigObject(configPath) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return configTemplate();
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${configPath}: ${error.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('config must be an object');
  }
  return parsed;
}

function writeConfigFile(configPath, config) {
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, configPath);
}

export function persistSpeedCap(configPath, speedCap) {
  const config = readConfigObject(configPath);
  config.speedCap = {
    enabled: speedCap.enabled,
    maxUnitsPerSecond: speedCap.maxUnitsPerSecond,
    ceiling: speedCap.ceiling,
  };
  writeConfigFile(configPath, config);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asInputError(error) {
  if (error instanceof TypeError || error instanceof RangeError) {
    throw new HttpCommandError(error.message);
  }
  throw error;
}

function currentTravel(session, configPath) {
  if (isPlainObject(session?.travel)) {
    try {
      return normalizeTravel(session.travel);
    } catch (error) {
      asInputError(error);
    }
  }
  try {
    return normalizeTravel(readConfigObject(configPath).travel);
  } catch {
    return normalizeTravel(undefined);
  }
}

function configView(session, udp, configPath) {
  return {
    udp: {
      host: udp.host,
      port: udp.port,
    },
    speedCap: {
      enabled: udp.speedCap.enabled,
      maxUnitsPerSecond: udp.speedCap.maxUnitsPerSecond,
      ceiling: udp.speedCap.ceiling,
    },
    travel: currentTravel(session, configPath),
  };
}

function readSpeedPatch(body, current) {
  if (!isPlainObject(body)) throw new HttpCommandError('speedCap must be an object');
  assertFields(body, CONFIG_SPEED_FIELDS);
  const hasValue = Object.hasOwn(body, 'maxUnitsPerSecond');
  const hasEnabled = Object.hasOwn(body, 'enabled');
  if (!hasValue && !hasEnabled) {
    throw new HttpCommandError('speedCap must include enabled or maxUnitsPerSecond');
  }
  const update = {};
  if (hasValue) {
    const value = body.maxUnitsPerSecond;
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value <= 0
      || value > current.ceiling
    ) {
      throw new HttpCommandError(
        `maxUnitsPerSecond must be greater than 0 and at most ${current.ceiling}`,
      );
    }
    update.maxUnitsPerSecond = value;
  }
  if (hasEnabled) {
    if (typeof body.enabled !== 'boolean') throw new HttpCommandError('enabled must be a boolean');
    if (body.enabled === false) {
      throw new HttpCommandError(
        'The speed limit stays on until a speed_limit command turns it off',
      );
    }
    update.enabled = true;
  } else if (hasValue) {
    update.enabled = current.enabled;
  }
  return update;
}

function readUdpPatch(body, current) {
  if (!isPlainObject(body)) throw new HttpCommandError('udp must be an object');
  assertFields(body, CONFIG_UDP_FIELDS);
  if (!Object.hasOwn(body, 'host') && !Object.hasOwn(body, 'port')) {
    throw new HttpCommandError('udp must include host or port');
  }
  const host = Object.hasOwn(body, 'host') ? body.host : current.host;
  const port = Object.hasOwn(body, 'port') ? body.port : current.port;
  try {
    return normalizeUdpTarget(host, port);
  } catch (error) {
    asInputError(error);
  }
  return null;
}

function readTravelPatch(body) {
  try {
    return normalizeTravelPatch(body);
  } catch (error) {
    asInputError(error);
  }
  return null;
}

/**
 * Fields the local config page may change.
 * The model command path stays play, reset, and speed_limit.
 */
function readConfigPatch(body, udp) {
  assertFields(body, CONFIG_FIELDS);
  if (!Object.hasOwn(body, 'udp') && !Object.hasOwn(body, 'speedCap') && !Object.hasOwn(body, 'travel')) {
    throw new HttpCommandError('Request body must include a setting');
  }
  const patch = {};
  if (Object.hasOwn(body, 'udp')) patch.udp = readUdpPatch(body.udp, udp);
  if (Object.hasOwn(body, 'speedCap')) patch.speedCap = readSpeedPatch(body.speedCap, udp.speedCap);
  if (Object.hasOwn(body, 'travel')) patch.travel = readTravelPatch(body.travel);
  return patch;
}

function persistSettings(configPath, applied) {
  const config = readConfigObject(configPath);
  if (applied.udp) {
    const udp = isPlainObject(config.udp) ? config.udp : {};
    udp.host = applied.udp.host;
    udp.port = applied.udp.port;
    if (udp.intervalMs == null) udp.intervalMs = DEFAULT_CONFIG.udp.intervalMs;
    config.udp = udp;
  }
  if (applied.speedCap) {
    config.speedCap = {
      enabled: applied.speedCap.enabled,
      maxUnitsPerSecond: applied.speedCap.maxUnitsPerSecond,
      ceiling: applied.speedCap.ceiling,
    };
  }
  if (applied.travel) {
    const travel = isPlainObject(config.travel) ? config.travel : {};
    for (const [key, pair] of Object.entries(applied.travel)) {
      travel[key] = [pair[0], pair[1]];
    }
    config.travel = travel;
  }
  writeConfigFile(configPath, config);
}

async function applyConfig(body, session, udp, configPath, probe) {
  const patch = readConfigPatch(body, udp);
  const previous = {
    speedCap: {
      enabled: udp.speedCap.enabled,
      maxUnitsPerSecond: udp.speedCap.maxUnitsPerSecond,
    },
    travel: currentTravel(session, configPath),
    udp: { host: udp.host, port: udp.port },
  };
  let deviceApplied = false;

  try {
    if (patch.speedCap) udp.setSpeedCap(patch.speedCap);
    if (patch.travel) {
      if (typeof session.setTravel !== 'function') {
        throw new HttpCommandError('Session cannot update travel', 500);
      }
      session.setTravel(patch.travel);
    }
    if (patch.udp) {
      if (typeof udp.setDevice !== 'function') {
        throw new HttpCommandError('UDP output cannot change address', 500);
      }
      try {
        await probe(patch.udp.host, patch.udp.port);
      } catch (error) {
        const message = error instanceof Error && error.message !== ''
          ? error.message
          : 'UDP port is not open';
        throw new HttpCommandError(message);
      }
      deviceApplied = true;
      await udp.setDevice(patch.udp);
    }
    persistSettings(configPath, {
      udp: patch.udp ? { host: udp.host, port: udp.port } : null,
      speedCap: patch.speedCap ? udp.speedCap : null,
      travel: patch.travel ? currentTravel(session, configPath) : null,
    });
  } catch (error) {
    if (patch.speedCap) {
      try {
        udp.setSpeedCap(previous.speedCap);
      } catch {
        // The original error is the one reported to the caller.
      }
    }
    if (patch.travel && typeof session.setTravel === 'function') {
      try {
        session.setTravel(previous.travel);
      } catch {
        // The original error is the one reported to the caller.
      }
    }
    if (deviceApplied && patch.udp && typeof udp.setDevice === 'function') {
      try {
        await udp.setDevice(previous.udp);
      } catch {
        // The original error is the one reported to the caller.
      }
    }
    if (error instanceof HttpCommandError) throw error;
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new HttpCommandError(error.message);
    }
    console.error(error);
    const detail = typeof error?.message === 'string' && error.message !== ''
      ? error.message
      : 'Could not apply settings';
    throw new HttpCommandError(`Could not apply settings: ${detail}`, 500);
  }

  return configView(session, udp, configPath);
}

function runSpeed(body, udp, configPath) {
  const previous = {
    enabled: udp.speedCap.enabled,
    maxUnitsPerSecond: udp.speedCap.maxUnitsPerSecond,
  };
  const update = readSpeedUpdate(body, udp.speedCap);
  const decision = readTarget(body);
  udp.setSpeedCap(update);
  try {
    persistSpeedCap(configPath, udp.speedCap);
  } catch (error) {
    try {
      udp.setSpeedCap(previous);
    } catch {
      // The original save error is the one reported to the caller.
    }
    console.error(error);
    throw new HttpCommandError('Could not save speedCap', 500);
  }
  applyTarget(udp, decision);
}

function dispatch(body, session, udp, configPath) {
  const { command } = body;
  if (command !== 'play' && command !== 'reset' && command !== 'speed_limit') {
    throw new HttpCommandError(`Unknown command: ${String(command)}`);
  }
  if (command === 'play') runPlay(body, session, udp);
  else if (command === 'reset') runReset(body, session, udp);
  else runSpeed(body, udp, configPath);
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(payload);
}

function sendHtml(res, html) {
  if (res.writableEnded) return;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpCommandError('Request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

function parseCommandBody(text, contentType) {
  if (contentType != null && contentType !== '' && !/^application\/json\b/i.test(contentType)) {
    throw new HttpCommandError('Content-Type must be application/json');
  }
  if (text.trim() === '') throw new HttpCommandError('Request body must be JSON');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpCommandError('Request body must be JSON');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpCommandError('Request body must be an object');
  }
  return parsed;
}

async function route(req, res, session, udp, configPath, probe) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const { pathname } = url;

  if (pathname === '/debug/strokes') {
    if (req.method !== 'GET') throw new HttpCommandError('Method not allowed', 405);
    sendJson(res, 200, { strokes: [...STROKE_NAMES] });
    return;
  }

  if (pathname === '/debug/state') {
    if (req.method !== 'GET') throw new HttpCommandError('Method not allowed', 405);
    sendJson(res, 200, snapshotState(session, udp));
    return;
  }

  if (pathname === '/favicon.ico') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpCommandError('Method not allowed', 405);
    }
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (req.method !== 'GET') throw new HttpCommandError('Method not allowed', 405);
    sendHtml(res, readFileSync(CONFIG_PAGE_PATH, 'utf8'));
    return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      sendJson(res, 200, configView(session, udp, configPath));
      return;
    }
    if (req.method !== 'POST') throw new HttpCommandError('Method not allowed', 405);
    const text = await readBody(req);
    const body = parseCommandBody(text, req.headers['content-type']);
    const view = await applyConfig(body, session, udp, configPath, probe);
    sendJson(res, 200, view);
    return;
  }

  if (pathname === '/command') {
    if (req.method !== 'POST') throw new HttpCommandError('Method not allowed', 405);
    const text = await readBody(req);
    const body = parseCommandBody(text, req.headers['content-type']);
    dispatch(body, session, udp, configPath);
    sendJson(res, 200, snapshotState(session, udp));
    return;
  }

  throw new HttpCommandError('Not found', 404);
}

/**
 * @param {object} options
 * @param {object} options.session MotionSession, or a test double with play() and reset()
 * @param {object} options.udp UdpOutput, or a test double with setSpeedCap() and speedCap
 * @param {string} [options.configPath] file whose speedCap is updated by speed_limit
 * @param {number} [options.port] defaults to config.http.port or 8787. 0 selects an ephemeral port.
 * @param {string} [options.host] must be 127.0.0.1 when provided
 */
export function createHttpServer(options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('HTTP options must be an object');
  }
  const host = resolveHost(options);
  const port = resolvePort(options);
  const session = options.session;
  const udp = options.udp;
  const configPath = options.configPath ?? defaultConfigPath;

  if (!session || typeof session.play !== 'function' || typeof session.reset !== 'function') {
    throw new TypeError('HTTP server requires a session with play() and reset()');
  }
  if (!udp || typeof udp.setSpeedCap !== 'function' || udp.speedCap == null) {
    throw new TypeError('HTTP server requires a udp output with setSpeedCap() and speedCap');
  }

  const probe = options.probe ?? probeUdp;
  if (typeof probe !== 'function') {
    throw new TypeError('HTTP probe must be a function');
  }

  const server = http.createServer((req, res) => {
    route(req, res, session, udp, configPath, probe).catch((error) => {
      const status = error instanceof HttpCommandError ? error.status : 500;
      const message = error instanceof HttpCommandError ? error.message : 'Internal error';
      if (!(error instanceof HttpCommandError)) console.error(error);
      sendJson(res, status, { error: message });
    });
  });

  const gateway = {
    server,
    host,
    port,
    configPath,
    listening: false,
    bound: null,
    listen() {
      if (gateway.listening) return Promise.resolve(gateway.bound);
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          gateway.listening = true;
          gateway.bound = server.address();
          resolve(gateway.bound);
        });
      });
    },
    close() {
      if (!gateway.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          gateway.listening = false;
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };

  return gateway;
}
