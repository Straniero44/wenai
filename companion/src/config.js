import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAVEL_KEYS = Object.freeze(['stroke', 'surge', 'sway', 'twist', 'roll', 'pitch']);

export const DEFAULT_CONFIG = {
  http: { host: '127.0.0.1', port: 8787 },
  udp: { host: 'tcode.local', port: 8000, intervalMs: 10 },
  // Where a POST with target: "emulator" goes. The bridge listens here.
  emulator: { host: '127.0.0.1', port: 8000 },
  speedCap: { enabled: true, maxUnitsPerSecond: 5, ceiling: 10 },
  travel: {
    stroke: [0.2, 0.8],
    surge: [0.2, 0.8],
    sway: [0.2, 0.8],
    twist: [0.2, 0.8],
    roll: [0.2, 0.8],
    pitch: [0.2, 0.8],
  },
};

export const defaultConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'config.json',
);

function freezeConfig(config) {
  Object.freeze(config.http);
  Object.freeze(config.udp);
  Object.freeze(config.emulator);
  Object.freeze(config.speedCap);
  Object.freeze(config.travel);
  for (const pair of Object.values(config.travel)) Object.freeze(pair);
  return Object.freeze(config);
}

freezeConfig(DEFAULT_CONFIG);

function assertPort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${label} must be an integer from 1 to 65535`);
  }
}

export function normalizeHost(host) {
  if (host == null) return 'tcode.local';
  if (typeof host !== 'string') {
    throw new TypeError('udp.host must be a string');
  }
  const trimmed = host.trim();
  return trimmed === '' ? 'tcode.local' : trimmed;
}

/**
 * The emulator lives on this machine, so its host must be a loopback name.
 * Accepting anything else would turn `target: "emulator"` into an arbitrary
 * remote target, which is exactly what the keyword design avoids.
 */
export function normalizeEmulatorHost(host) {
  if (typeof host !== 'string') {
    throw new TypeError('emulator.host must be a string');
  }
  const trimmed = host.trim();
  if (trimmed === '') return DEFAULT_CONFIG.emulator.host;
  if (trimmed !== '127.0.0.1' && trimmed !== 'localhost' && trimmed !== '::1') {
    throw new RangeError('emulator.host must be a loopback address');
  }
  return trimmed;
}

function assertSpeedCap(speedCap) {
  if (typeof speedCap.enabled !== 'boolean') {
    throw new TypeError('speedCap.enabled must be a boolean');
  }
  if (typeof speedCap.ceiling !== 'number' || !Number.isFinite(speedCap.ceiling) || speedCap.ceiling <= 0) {
    throw new RangeError('speedCap.ceiling must be greater than 0');
  }
  if (
    typeof speedCap.maxUnitsPerSecond !== 'number'
    || !Number.isFinite(speedCap.maxUnitsPerSecond)
    || speedCap.maxUnitsPerSecond <= 0
    || speedCap.maxUnitsPerSecond > speedCap.ceiling
  ) {
    throw new RangeError(
      `speedCap.maxUnitsPerSecond must be greater than 0 and at most ${speedCap.ceiling}`,
    );
  }
}

function assertIntervalMs(intervalMs) {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 3 || intervalMs > 33) {
    throw new RangeError('intervalMs must be between 3 and 33');
  }
}

function assertTravelPair(key, value) {
  if (
    !Array.isArray(value)
    || value.length < 2
    || !value.slice(0, 2).every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new TypeError(`travel.${key} must be a pair of numbers`);
  }
  const [from, to] = value;
  if (from < 0 || from > 1 || to < 0 || to > 1 || from === to) {
    throw new RangeError(`travel.${key} must be two different numbers from 0 to 1`);
  }
  return [from, to];
}

function copyTravel(travel) {
  const result = {};
  for (const key of TRAVEL_KEYS) {
    const value = travel?.[key] == null ? DEFAULT_CONFIG.travel[key] : travel[key];
    result[key] = assertTravelPair(key, value);
  }
  return result;
}

/** Full six-axis travel. Missing keys use the 0.20–0.80 defaults. Order is kept. */
export function normalizeTravel(travel) {
  return copyTravel(travel);
}

/**
 * Axes named in a config-page update.
 * Each stored pair is ordered low to high so a slider and the device agree.
 */
export function normalizeTravelPatch(travel) {
  if (travel == null || typeof travel !== 'object' || Array.isArray(travel)) {
    throw new TypeError('travel must be an object');
  }
  const result = {};
  for (const [key, value] of Object.entries(travel)) {
    if (!TRAVEL_KEYS.includes(key)) {
      throw new TypeError(`Unknown travel axis: ${key}`);
    }
    const [from, to] = assertTravelPair(key, value);
    result[key] = [Math.min(from, to), Math.max(from, to)];
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError('travel must include an axis');
  }
  return result;
}

function copyVoice(voice) {
  if (voice == null) return undefined;
  if (typeof voice !== 'object' || Array.isArray(voice)) {
    throw new TypeError('voice must be an object');
  }
  const copy = {};
  if (Object.hasOwn(voice, 'listen')) {
    if (typeof voice.listen !== 'boolean') {
      throw new TypeError('voice.listen must be a boolean');
    }
    copy.listen = voice.listen;
  }
  if (typeof voice.python === 'string') copy.python = voice.python;
  if (typeof voice.modelDir === 'string') copy.modelDir = voice.modelDir;
  return copy;
}

/**
 * Device address from the config page.
 * A blank host becomes tcode.local. A blank port becomes 8000.
 */
export function normalizeUdpTarget(host, port) {
  const normalizedHost = normalizeHost(host);
  const resolvedPort = port == null || port === '' ? DEFAULT_CONFIG.udp.port : port;
  assertPort(resolvedPort, 'udp.port');
  return { host: normalizedHost, port: resolvedPort };
}

export function normalizeConfig(override = {}) {
  if (override == null || typeof override !== 'object' || Array.isArray(override)) {
    throw new TypeError('config must be an object');
  }
  const http = override.http ?? {};
  const udp = override.udp ?? {};
  const emulator = override.emulator ?? {};
  const speedCap = override.speedCap ?? {};
  const config = {
    http: {
      host: http.host == null || http.host === '' ? DEFAULT_CONFIG.http.host : http.host,
      port: http.port == null ? DEFAULT_CONFIG.http.port : http.port,
    },
    udp: {
      host: normalizeHost(udp.host == null ? DEFAULT_CONFIG.udp.host : udp.host),
      port: udp.port == null ? DEFAULT_CONFIG.udp.port : udp.port,
      intervalMs: udp.intervalMs == null ? DEFAULT_CONFIG.udp.intervalMs : udp.intervalMs,
    },
    emulator: {
      host: normalizeEmulatorHost(
        emulator.host == null ? DEFAULT_CONFIG.emulator.host : emulator.host,
      ),
      port: emulator.port == null ? DEFAULT_CONFIG.emulator.port : emulator.port,
    },
    speedCap: {
      enabled: speedCap.enabled == null ? DEFAULT_CONFIG.speedCap.enabled : speedCap.enabled,
      maxUnitsPerSecond: speedCap.maxUnitsPerSecond == null
        ? DEFAULT_CONFIG.speedCap.maxUnitsPerSecond
        : speedCap.maxUnitsPerSecond,
      ceiling: speedCap.ceiling == null ? DEFAULT_CONFIG.speedCap.ceiling : speedCap.ceiling,
    },
    travel: copyTravel(override.travel),
  };
  const voice = copyVoice(override.voice);
  if (voice != null) config.voice = voice;
  if (typeof config.http.host !== 'string' || config.http.host.trim() === '') {
    throw new TypeError('http.host must be a non-empty string');
  }
  assertPort(config.http.port, 'http.port');
  assertPort(config.udp.port, 'udp.port');
  assertPort(config.emulator.port, 'emulator.port');
  assertIntervalMs(config.udp.intervalMs);
  assertSpeedCap(config.speedCap);
  return config;
}

export function loadConfig(configPath = defaultConfigPath) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeConfig({});
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${configPath}: ${error.message}`);
  }
  return normalizeConfig(parsed);
}
