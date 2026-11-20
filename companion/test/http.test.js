import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { defaultConfigPath } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { start } from '../src/main.js';
import {
  DEFAULT_BPM,
  DEFAULT_DURATION_S,
  INITIAL_PARAMETERS,
  STROKE_NAMES,
  cloneParameters,
  normalizePlay,
} from '../src/parameters.js';

const TCODE = 'L01234I10 R05678I10\n';
const repoConfigExisted = existsSync(defaultConfigPath);

function present(clip) {
  return {
    name: clip.name,
    duration_s: clip.duration_s,
    bpm: clip.bpmSpecified ? clip.specifiedBpm : DEFAULT_BPM,
  };
}

function createFakes(options = {}) {
  const calls = [];
  const session = {
    state: 'idle',
    current: null,
    queue: [],
    bpm: null,
    parameters: cloneParameters(INITIAL_PARAMETERS),
    lastError: null,
    leak: TCODE,
    calls,
    motionSettled: false,
    play(input) {
      const normalized = normalizePlay(input, session.parameters);
      calls.push({ op: 'play', input });
      session.parameters = normalized.parameters;
      const shown = normalized.clips.map(present);
      if (session.state === 'playing' || session.state === 'braking' || session.state === 'homing') {
        session.state = session.state === 'homing' ? 'homing' : 'braking';
        if (session.state === 'homing') {
          session.current = null;
          session.bpm = null;
        }
        session.queue = shown;
      } else {
        session.state = 'playing';
        session.current = shown[0];
        session.bpm = shown[0].bpm;
        session.queue = shown.slice(1);
      }
      session.motionSettled = false;
      return new Promise((resolve) => {
        session.finishMotion = () => {
          session.motionSettled = true;
          if (session.state === 'homing' && session.queue.length > 0) {
            const [first, ...rest] = session.queue;
            session.state = 'playing';
            session.current = first;
            session.bpm = first.bpm;
            session.queue = rest;
          }
          resolve();
        };
      });
    },
    setTravel(update) {
      calls.push({ op: 'travel', update });
      const base = session.travel ?? {
        stroke: [0.2, 0.8],
        surge: [0.2, 0.8],
        sway: [0.2, 0.8],
        twist: [0.2, 0.8],
        roll: [0.2, 0.8],
        pitch: [0.2, 0.8],
      };
      const next = {};
      for (const [key, pair] of Object.entries(base)) next[key] = [...pair];
      for (const [key, pair] of Object.entries(update)) next[key] = [...pair];
      session.travel = next;
      return next;
    },
    reset() {
      calls.push({ op: 'reset' });
      session.queue = [];
      if (session.state === 'playing' || session.state === 'braking') {
        session.state = 'braking';
      } else {
        session.current = null;
        session.bpm = null;
        session.state = 'homing';
      }
      session.motionSettled = false;
      return new Promise((resolve) => {
        session.finishMotion = () => {
          session.state = 'idle';
          session.current = null;
          session.bpm = null;
          session.motionSettled = true;
          resolve();
        };
      });
    },
  };

  const udp = {
    host: 'tcode.local',
    port: 8000,
    lastError: null,
    leak: TCODE,
    calls,
    targets: [],
    target: 'tcode.local',
    speedCap: {
      enabled: false,
      maxUnitsPerSecond: 2,
      ceiling: options.ceiling ?? 10,
      leak: TCODE,
    },
    setTarget(decision) {
      // Kept apart from `calls`: those arrays assert the command sequence.
      udp.targets.push(decision);
      udp.target = decision === true ? 'emulator' : 'tcode.local';
    },
    setSpeedCap(update) {
      calls.push({ op: 'speed', update });
      const next = {
        enabled: udp.speedCap.enabled,
        maxUnitsPerSecond: udp.speedCap.maxUnitsPerSecond,
        ceiling: udp.speedCap.ceiling,
        leak: TCODE,
      };
      if (Object.hasOwn(update, 'maxUnitsPerSecond')) next.maxUnitsPerSecond = update.maxUnitsPerSecond;
      if (Object.hasOwn(update, 'enabled')) next.enabled = update.enabled;
      udp.speedCap = next;
      return { ...next };
    },
    async setDevice(update) {
      calls.push({ op: 'device', update });
      if (Object.hasOwn(update, 'host')) udp.host = update.host;
      if (Object.hasOwn(update, 'port')) udp.port = update.port;
      return { host: udp.host, port: udp.port };
    },
  };

  return { session, udp, calls };
}

async function createHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-http-'));
  const configPath = join(dir, 'config.json');
  const ceiling = options.ceiling ?? 10;
  const initial = {
    http: { host: '127.0.0.1', port: 8787 },
    udp: { host: 'tcode.local', port: 8000, intervalMs: 10 },
    speedCap: { enabled: false, maxUnitsPerSecond: 2, ceiling },
    marker: 'keep',
  };
  if (options.writeConfig !== false) {
    writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`);
  }
  const { session, udp, calls } = createFakes(options);
  const gateway = createHttpServer({
    session,
    udp,
    port: 0,
    configPath: options.configPath ?? configPath,
    probe: options.probe ?? (async () => {}),
  });
  try {
    const bound = await gateway.listen();
    return {
      dir,
      session,
      udp,
      calls,
      gateway,
      configPath: options.configPath ?? configPath,
      port: bound.port,
      bound,
      async close() {
        gateway.server.closeAllConnections?.();
        await gateway.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function request(port, method, path, body, headers = {}) {
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        connection: 'close',
        ...(payload
          ? {
            'content-type': headers['content-type'] ?? 'application/json',
            'content-length': payload.length,
          }
          : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function post(harness, body, headers) {
  return request(harness.port, 'POST', '/command', body, headers);
}

function assertNoTcode(text) {
  assert.equal(text.includes(TCODE.trim()), false);
  assert.equal(/[LR][012]\d{4}I\d+/.test(text), false);
}

const STATE_KEYS = ['bpm', 'current', 'lastError', 'parameters', 'queue', 'speedCap', 'state', 'udp'];

describe('http command gateway', { concurrency: 1 }, () => {
  test('listens only on 127.0.0.1 and the port is configurable', async () => {
    assert.throws(() => createHttpServer({ host: '0.0.0.0' }), /127\.0\.0\.1/);
    assert.throws(
      () => createHttpServer({ config: { http: { host: '0.0.0.0', port: 8787 } } }),
      /127\.0\.0\.1/,
    );

    const { session, udp } = createFakes();
    const configured = createHttpServer({
      session,
      udp,
      config: { http: { host: '127.0.0.1', port: 9091 } },
      configPath: join(tmpdir(), 'unused-companion-config.json'),
    });
    assert.equal(configured.host, '127.0.0.1');
    assert.equal(configured.port, 9091);
    const overridden = createHttpServer({
      session,
      udp,
      port: 0,
      config: { http: { port: 9091 } },
      configPath: join(tmpdir(), 'unused-companion-config.json'),
    });
    assert.equal(overridden.port, 0);

    const harness = await createHarness();
    try {
      assert.equal(harness.bound.address, '127.0.0.1');
      assert.notEqual(harness.port, 8787);
      assert.equal(harness.gateway.host, '127.0.0.1');
    } finally {
      await harness.close();
    }
  });

  test('debug strokes lists 42 names and debug state omits TCode without starting playback', async () => {
    const harness = await createHarness();
    try {
      harness.session.parameters.script = TCODE;
      harness.session.current = {
        name: 'orbit-grind',
        bpm: DEFAULT_BPM,
        duration_s: DEFAULT_DURATION_S,
        tcode: TCODE,
      };
      const strokes = await request(harness.port, 'GET', '/debug/strokes');
      const state = await request(harness.port, 'GET', '/debug/state');
      const wrong = await request(harness.port, 'POST', '/debug/strokes', { command: 'play' });

      assert.equal(strokes.status, 200);
      assert.equal(strokes.body.strokes.length, 42);
      assert.deepEqual(strokes.body.strokes, [...STROKE_NAMES]);
      assert.equal(state.status, 200);
      assert.deepEqual(Object.keys(state.body).sort(), STATE_KEYS);
      assert.equal(state.body.state, 'idle');
      assert.deepEqual(state.body.current, {
        name: 'orbit-grind',
        bpm: DEFAULT_BPM,
        duration_s: DEFAULT_DURATION_S,
      });
      assert.equal(Object.hasOwn(state.body.current, 'tcode'), false);
      assert.deepEqual(Object.keys(state.body.speedCap).sort(), ['ceiling', 'enabled', 'maxUnitsPerSecond']);
      assert.deepEqual(state.body.udp, { host: 'tcode.local', port: 8000, target: 'tcode.local' });
      assertNoTcode(strokes.text);
      assertNoTcode(state.text);
      assert.equal(wrong.status, 405);
      assert.deepEqual(harness.calls, []);
      assert.equal(harness.session.state, 'idle');
    } finally {
      await harness.close();
    }
  });

  test('play accepts one clip or many and returns defaults immediately', async () => {
    const harness = await createHarness();
    try {
      const started = Date.now();
      const single = await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
      });
      const elapsed = Date.now() - started;
      const followed = await request(harness.port, 'GET', '/debug/state');

      assert.equal(single.status, 200);
      assert.ok(elapsed < 500, `play response took ${elapsed}ms`);
      assert.equal(harness.session.motionSettled, false);
      assert.equal(single.body.state, 'playing');
      assert.deepEqual(single.body.current, {
        name: 'orbit-grind',
        bpm: DEFAULT_BPM,
        duration_s: DEFAULT_DURATION_S,
      });
      assert.equal(single.body.bpm, DEFAULT_BPM);
      assert.deepEqual(single.body.queue, []);
      assert.deepEqual(single.body, followed.body);
      assert.deepEqual(Object.keys(single.body).sort(), STATE_KEYS);
      assertNoTcode(single.text);
      assert.equal(harness.calls.length, 1);
      assert.equal(harness.calls[0].op, 'play');

      const fresh = await createHarness();
      try {
        const many = await post(fresh, {
          command: 'play',
          clips: [
            { name: 'orbit-grind' },
            { name: 'orbit-grind', bpm: 45, duration_s: 20 },
          ],
        });
        assert.equal(many.status, 200);
        assert.equal(fresh.session.motionSettled, false);
        assert.deepEqual(many.body.current, {
          name: 'orbit-grind',
          bpm: 60,
          duration_s: 30,
        });
        assert.deepEqual(many.body.queue, [
          { name: 'orbit-grind', bpm: 45, duration_s: 20 },
        ]);
        assert.equal(many.body.parameters.transition_s, 2);
        assert.deepEqual(many.body, (await request(fresh.port, 'GET', '/debug/state')).body);
      } finally {
        await fresh.close();
      }
    } finally {
      await harness.close();
    }
  });

  test('a play during playback returns the homing snapshot before the new list starts', async () => {
    const harness = await createHarness();
    try {
      await post(harness, {
        command: 'play',
        clips: [
          { name: 'orbit-grind', duration_s: 30 },
          { name: 'long-stroke-1', duration_s: 30 },
        ],
      });
      assert.equal(harness.session.state, 'playing');

      const started = Date.now();
      const again = await post(harness, {
        command: 'play',
        clips: [{ name: 'vortex-tease' }],
      });
      const elapsed = Date.now() - started;

      assert.equal(again.status, 200);
      assert.ok(elapsed < 500, `second play took ${elapsed}ms`);
      assert.equal(harness.session.motionSettled, false);
      assert.equal(again.body.state, 'braking');
      assert.equal(again.body.current.name, 'orbit-grind');
      assert.deepEqual(again.body.queue, [
        { name: 'vortex-tease', bpm: DEFAULT_BPM, duration_s: DEFAULT_DURATION_S },
      ]);
      assert.deepEqual(harness.calls.map((call) => call.op), ['play', 'play']);
      assert.deepEqual(again.body, (await request(harness.port, 'GET', '/debug/state')).body);
      assert.equal(harness.session.state, 'braking');
    } finally {
      await harness.close();
    }
  });

  test('reset returns before home finishes, then the session is idle', async () => {
    const harness = await createHarness();
    try {
      await post(harness, {
        command: 'play',
        clips: [
          { name: 'orbit-grind' },
          { name: 'long-stroke-1', bpm: 45, duration_s: 20 },
        ],
      });

      const started = Date.now();
      const reset = await post(harness, { command: 'reset' });
      const elapsed = Date.now() - started;
      const during = await request(harness.port, 'GET', '/debug/state');

      assert.equal(reset.status, 200);
      assert.ok(elapsed < 500, `reset took ${elapsed}ms`);
      assert.equal(harness.session.motionSettled, false);
      assert.equal(reset.body.state, 'braking');
      assert.equal(reset.body.current.name, 'orbit-grind');
      assert.deepEqual(reset.body.queue, []);
      assert.equal(reset.body.bpm, 60);
      assert.deepEqual(reset.body, during.body);
      assert.deepEqual(harness.calls.map((call) => call.op), ['play', 'reset']);

      harness.session.finishMotion();
      const after = await request(harness.port, 'GET', '/debug/state');
      assert.equal(after.body.state, 'idle');
      assert.equal(after.body.current, null);
      assert.deepEqual(after.body.queue, []);
      assert.notEqual(after.body.state, reset.body.state);
    } finally {
      await harness.close();
    }
  });

  test('speed_limit updates the clamp, persists speedCap, and leaves the animation running', async () => {
    const harness = await createHarness();
    try {
      await post(harness, { command: 'play', clips: [{ name: 'orbit-grind' }] });
      const before = readFileSync(harness.configPath, 'utf8');

      const opened = await post(harness, {
        command: 'speed_limit',
        max_units_per_second: 2.5,
      });
      const openedFile = JSON.parse(readFileSync(harness.configPath, 'utf8'));
      assert.equal(opened.status, 200);
      assert.equal(opened.body.state, 'playing');
      assert.equal(opened.body.current.name, 'orbit-grind');
      assert.deepEqual(opened.body.speedCap, {
        enabled: true,
        maxUnitsPerSecond: 2.5,
        ceiling: 10,
      });
      assert.equal(openedFile.marker, 'keep');
      assert.equal(openedFile.udp.host, 'tcode.local');
      assert.deepEqual(openedFile.speedCap, opened.body.speedCap);
      assert.deepEqual(opened.body, (await request(harness.port, 'GET', '/debug/state')).body);
      assert.equal(before.includes('"enabled": false'), true);

      const closed = await post(harness, { command: 'speed_limit', enabled: false });
      assert.equal(closed.body.state, 'playing');
      assert.deepEqual(closed.body.speedCap, {
        enabled: false,
        maxUnitsPerSecond: 2.5,
        ceiling: 10,
      });
      assert.deepEqual(
        JSON.parse(readFileSync(harness.configPath, 'utf8')).speedCap,
        closed.body.speedCap,
      );

      const reopened = await post(harness, { command: 'speed_limit' });
      assert.equal(reopened.body.speedCap.enabled, true);
      assert.equal(reopened.body.speedCap.maxUnitsPerSecond, 2.5);
      assert.deepEqual(harness.calls.map((call) => call.op), ['play', 'speed', 'speed', 'speed']);
    } finally {
      await harness.close();
    }
  });

  test('a missing config file receives speedCap without using the repo config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-http-'));
    const configPath = join(dir, 'nested', 'config.json');
    const { session, udp } = createFakes();
    const gateway = createHttpServer({ session, udp, port: 0, configPath });
    try {
      const bound = await gateway.listen();
      const response = await request(bound.port, 'POST', '/command', {
        command: 'speed_limit',
        max_units_per_second: 4,
      });
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(response.status, 200);
      assert.equal(saved.http.port, 8787);
      assert.equal(saved.udp.host, 'tcode.local');
      assert.deepEqual(saved.speedCap, {
        enabled: true,
        maxUnitsPerSecond: 4,
        ceiling: 10,
      });
      assert.equal(session.state, 'idle');
      if (!repoConfigExisted) assert.equal(existsSync(defaultConfigPath), false);
    } finally {
      gateway.server.closeAllConnections?.();
      await gateway.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid commands return 400 and do not play, reset, or change the cap', async () => {
    const harness = await createHarness({ ceiling: 4 });
    try {
      const accepted = await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind', duration_s: 12 }],
      });
      assert.equal(accepted.status, 200);
      const callsAfterPlay = harness.calls.length;
      const fileAfterPlay = readFileSync(harness.configPath, 'utf8');
      const speedAfterPlay = { ...harness.udp.speedCap };

      const rejected = [
        [{ command: 'dance' }, /Unknown command/],
        [{ command: 'L05000I10' }, /Unknown command/],
        [{ command: 'play', clips: [] }, /at least one animation/],
        [{ command: 'play' }, /at least one animation/],
        [{ command: 'play', clips: [{ name: 'not-a-stroke' }] }, /Unknown stroke/],
        [{ command: 'play', clips: [{ name: 'orbit-grind', bpm: 0 }] }, /bpm/],
        [{ command: 'play', clips: [{ name: 'orbit-grind', bpm: 201 }] }, /bpm/],
        [{ command: 'play', clips: [{ name: 'orbit-grind', bpm: '60' }] }, /bpm/],
        [{ command: 'play', clips: [{ name: 'orbit-grind' }], script: 'ayva.do()' }, /Unknown field/],
        [{ command: 'play', clips: [{ name: 'orbit-grind', code: 'L05000I10' }] }, /Unknown clip field/],
        [{ command: 'reset', tcode: TCODE }, /Unknown field/],
        [{ command: 'speed_limit', max_units_per_second: 4.1 }, /at most 4/],
        [{ command: 'speed_limit', max_units_per_second: 0 }, /greater than 0/],
        [{ command: 'speed_limit', max_units_per_second: 11 }, /at most 4/],
        [{ command: 'speed_limit', packet: TCODE }, /Unknown field/],
        [{ command: 'speed_limit', enabled: 'false' }, /boolean/],
      ];

      for (const [body, pattern] of rejected) {
        const response = await post(harness, body);
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(response.body.error, pattern);
        assert.equal(response.body.state, undefined);
      }

      const notJson = await post(harness, '{', { 'content-type': 'application/json' });
      const textBody = await request(harness.port, 'POST', '/command', 'play', {
        'content-type': 'text/plain',
      });
      const getCommand = await request(harness.port, 'GET', '/command');
      const missing = await request(harness.port, 'GET', '/play');

      assert.equal(notJson.status, 400);
      assert.equal(textBody.status, 400);
      assert.equal(getCommand.status, 405);
      assert.equal(missing.status, 404);
      assert.equal(harness.calls.length, callsAfterPlay);
      assert.equal(harness.calls[0].op, 'play');
      assert.equal(harness.session.state, 'playing');
      assert.equal(harness.session.current.name, 'orbit-grind');
      assert.equal(harness.session.current.duration_s, 12);
      assert.equal(harness.udp.speedCap.enabled, speedAfterPlay.enabled);
      assert.equal(harness.udp.speedCap.maxUnitsPerSecond, speedAfterPlay.maxUnitsPerSecond);
      assert.equal(readFileSync(harness.configPath, 'utf8'), fileAfterPlay);

      const atCeiling = await post(harness, {
        command: 'speed_limit',
        max_units_per_second: 4,
      });
      assert.equal(atCeiling.status, 200);
      assert.equal(atCeiling.body.speedCap.maxUnitsPerSecond, 4);
      assert.equal(atCeiling.body.speedCap.enabled, true);
      assert.equal(atCeiling.body.state, 'playing');
      assert.equal(harness.session.current.name, 'orbit-grind');
    } finally {
      await harness.close();
    }
  });

  test('start serves debug data on an injected session and does not play or open udp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-http-'));
    const { session, udp, calls } = createFakes();
    let runtime;
    try {
      runtime = await start({
        session,
        udp,
        port: 0,
        configPath: join(dir, 'absent.json'),
      });
      assert.equal(runtime.udp, udp);
      assert.equal(runtime.session, session);
      assert.equal(session.state, 'idle');
      assert.deepEqual(calls, []);
      assert.equal(existsSync(join(dir, 'absent.json')), false);

      const strokes = await request(runtime.bound.port, 'GET', '/debug/strokes');
      assert.equal(strokes.body.strokes.length, 42);

      udp.onFault(new Error('dns failed'));
      const state = await request(runtime.bound.port, 'GET', '/debug/state');
      assert.equal(state.body.state, 'fault');
      assert.equal(state.body.lastError, 'dns failed');
      assertNoTcode(state.text);

      const refused = await request(runtime.bound.port, 'POST', '/command', {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
      });
      assert.equal(refused.status, 409);
      assert.deepEqual(calls, []);
      if (!repoConfigExisted) assert.equal(existsSync(defaultConfigPath), false);
    } finally {
      if (runtime) await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST target routing', () => {
  test('omitting target sends to the device and resets a previous emulator route', async () => {
    const harness = await createHarness();
    try {
      const toEmulator = await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
        target: 'emulator',
      });
      assert.equal(toEmulator.status, 200);
      assert.equal(toEmulator.body.udp.target, 'emulator');

      const backToDevice = await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
      });
      assert.equal(backToDevice.status, 200);
      assert.equal(backToDevice.body.udp.target, 'tcode.local');
    } finally {
      await harness.close();
    }
  });

  test('target tcode.local means the device', async () => {
    const harness = await createHarness();
    try {
      const response = await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
        target: 'tcode.local',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.udp.target, 'tcode.local');
    } finally {
      await harness.close();
    }
  });

  test('reset and speed_limit accept target', async () => {
    const harness = await createHarness();
    try {
      const reset = await post(harness, { command: 'reset', target: 'emulator' });
      assert.equal(reset.status, 200);
      assert.equal(reset.body.udp.target, 'emulator');

      const speed = await post(harness, { command: 'speed_limit', max_units_per_second: 3, target: 'tcode.local' });
      assert.equal(speed.status, 200);
      assert.equal(speed.body.udp.target, 'tcode.local');
      assert.equal(speed.body.speedCap.maxUnitsPerSecond, 3);
    } finally {
      await harness.close();
    }
  });

  test('an unknown target is rejected without playing or moving the route', async () => {
    const harness = await createHarness();
    try {
      await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
        target: 'emulator',
      });

      for (const bad of ['127.0.0.1', '192.0.2.15', 'localhost', '', 42, true, {}]) {
        const response = await post(harness, {
          command: 'play',
          clips: [{ name: 'orbit-grind' }],
          target: bad,
        });
        assert.equal(response.status, 400, `target ${JSON.stringify(bad)} should be rejected`);
      }

      // The rejected requests must not have moved the route or started playback.
      const state = await request(harness.bound.port, 'GET', '/debug/state');
      assert.equal(state.body.udp.target, 'emulator');
    } finally {
      await harness.close();
    }
  });

  test('a rejected play does not change the route', async () => {
    const harness = await createHarness();
    try {
      const response = await post(harness, {
        command: 'play',
        clips: [],
        target: 'emulator',
      });
      assert.equal(response.status, 400);
      const state = await request(harness.bound.port, 'GET', '/debug/state');
      assert.equal(state.body.udp.target, 'tcode.local');
      assert.equal(harness.session.state, 'idle');
    } finally {
      await harness.close();
    }
  });

  test('target is not forwarded to the motion session as a clip field', async () => {
    const harness = await createHarness();
    try {
      await post(harness, {
        command: 'play',
        clips: [{ name: 'orbit-grind' }],
        target: 'emulator',
      });
      const playCall = harness.calls.find((call) => call.op === 'play');
      assert.equal(Object.hasOwn(playCall.input, 'target'), false);
    } finally {
      await harness.close();
    }
  });
});

describe('config page', () => {
  test('GET / serves the config page on the service port', async () => {
    const harness = await createHarness();
    try {
      const page = await request(harness.port, 'GET', '/');
      const alias = await request(harness.port, 'GET', '/index.html');
      const icon = await request(harness.port, 'GET', '/favicon.ico');
      const wrong = await request(harness.port, 'POST', '/', {});
      assert.equal(page.status, 200);
      assert.equal(alias.status, 200);
      assert.equal(page.text.includes('<title>设备配置</title>'), true);
      assert.equal(page.text.includes('最大限速'), true);
      assert.equal(page.text.includes('id="speed-slider"'), true);
      assert.equal(page.text.includes('这里不能关掉'), true);
      assert.equal(page.text.includes('placeholder="tcode.local"'), true);
      assert.equal(page.text.includes('placeholder="8000"'), true);
      assert.equal(page.text.includes('行程'), true);
      assert.equal(page.text.includes("['stroke', 'L0', '行程']"), true);
      assert.equal(page.text.includes("['pitch', 'R2', '俯仰']"), true);
      assert.equal(page.text.includes('/api/config'), true);
      assert.equal(alias.text, page.text);
      assert.equal(icon.status, 204);
      assert.equal(wrong.status, 405);
      assert.deepEqual(harness.calls, []);
      assert.equal(harness.session.state, 'idle');
    } finally {
      await harness.close();
    }
  });

  test('GET /api/config returns the live speed, travel, and device address', async () => {
    const harness = await createHarness();
    try {
      const fresh = await request(harness.port, 'GET', '/api/config');
      assert.equal(fresh.status, 200);
      assert.deepEqual(fresh.body.udp, { host: 'tcode.local', port: 8000 });
      assert.deepEqual(fresh.body.speedCap, {
        enabled: false,
        maxUnitsPerSecond: 2,
        ceiling: 10,
      });
      assert.deepEqual(fresh.body.travel.stroke, [0.2, 0.8]);
      assert.deepEqual(fresh.body.travel.pitch, [0.2, 0.8]);
      assert.equal(fresh.text.includes(TCODE.trim()), false);

      harness.session.travel = {
        stroke: [0.1, 0.9],
        surge: [0.2, 0.8],
        sway: [0.2, 0.8],
        twist: [0.2, 0.8],
        roll: [0.2, 0.8],
        pitch: [0.3, 0.7],
      };
      const live = await request(harness.port, 'GET', '/api/config');
      assert.deepEqual(live.body.travel.stroke, [0.1, 0.9]);
      assert.deepEqual(live.body.travel.pitch, [0.3, 0.7]);
      assert.deepEqual(harness.calls, []);
    } finally {
      await harness.close();
    }
  });

  test('sliders and the device address persist without touching unrelated fields', async () => {
    const harness = await createHarness();
    try {
      const stored = JSON.parse(readFileSync(harness.configPath, 'utf8'));
      stored.udp.intervalMs = 16;
      stored.emulator = { host: '127.0.0.1', port: 8000 };
      writeFileSync(harness.configPath, `${JSON.stringify(stored, null, 2)}\n`);

      const speed = await request(harness.port, 'POST', '/api/config', {
        speedCap: { maxUnitsPerSecond: 3.5, enabled: true },
      });
      assert.equal(speed.status, 200);
      assert.deepEqual(speed.body.speedCap, {
        enabled: true,
        maxUnitsPerSecond: 3.5,
        ceiling: 10,
      });
      assert.equal(harness.session.state, 'idle');

      const travel = await request(harness.port, 'POST', '/api/config', {
        travel: { stroke: [0.9, 0.15], roll: [0.4, 0.6] },
      });
      assert.equal(travel.status, 200);
      assert.deepEqual(travel.body.travel.stroke, [0.15, 0.9]);
      assert.deepEqual(travel.body.travel.roll, [0.4, 0.6]);
      assert.deepEqual(travel.body.travel.surge, [0.2, 0.8]);
      assert.deepEqual(harness.session.travel.stroke, [0.15, 0.9]);

      const device = await request(harness.port, 'POST', '/api/config', {
        udp: { host: '   ', port: '' },
      });
      assert.equal(device.status, 200);
      assert.deepEqual(device.body.udp, { host: 'tcode.local', port: 8000 });

      const moved = await request(harness.port, 'POST', '/api/config', {
        udp: { host: '10.1.2.3', port: 9000 },
      });
      assert.equal(moved.status, 200);
      assert.deepEqual(moved.body.udp, { host: '10.1.2.3', port: 9000 });

      const saved = JSON.parse(readFileSync(harness.configPath, 'utf8'));
      assert.equal(saved.marker, 'keep');
      assert.equal(saved.udp.intervalMs, 16);
      assert.deepEqual(saved.emulator, { host: '127.0.0.1', port: 8000 });
      assert.equal(saved.udp.host, '10.1.2.3');
      assert.equal(saved.udp.port, 9000);
      assert.deepEqual(saved.speedCap, speed.body.speedCap);
      assert.deepEqual(saved.travel.stroke, [0.15, 0.9]);
      assert.deepEqual(saved.travel.pitch, [0.2, 0.8]);
      assert.deepEqual(harness.calls.map((call) => call.op), ['speed', 'travel', 'device', 'device']);
    } finally {
      await harness.close();
    }
  });

  test('invalid config is rejected and a failed address change rolls back', async () => {
    const harness = await createHarness();
    try {
      const before = readFileSync(harness.configPath, 'utf8');
      const rejected = [
        [{}, /include a setting/],
        [{ ceiling: 20 }, /Unknown field/],
        [{ speedCap: { maxUnitsPerSecond: 11 } }, /at most 10/],
        [{ speedCap: { enabled: 'yes' } }, /boolean/],
        [{ speedCap: { enabled: false } }, /speed_limit command turns it off/],
        [{ travel: { stroke: [0.4, 0.4] } }, /two different numbers/],
        [{ travel: { valve: [0, 1] } }, /Unknown travel axis/],
        [{ udp: { host: 'device.local', port: 0 } }, /udp\.port/],
        [{ udp: { port: '8000' } }, /udp\.port/],
      ];
      for (const [body, pattern] of rejected) {
        const response = await request(harness.port, 'POST', '/api/config', body);
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(response.body.error, pattern);
      }

      const command = await request(harness.port, 'POST', '/command', {
        udp: { host: '10.1.2.3', port: 9000 },
      });
      assert.equal(command.status, 400);
      assert.equal(harness.udp.host, 'tcode.local');
      assert.equal(readFileSync(harness.configPath, 'utf8'), before);

      const original = harness.udp.setDevice.bind(harness.udp);
      harness.udp.setDevice = async (update) => {
        await original(update);
        if (update.host === 'missing.local') throw new Error('dns failed');
      };
      const failed = await request(harness.port, 'POST', '/api/config', {
        speedCap: { maxUnitsPerSecond: 4, enabled: true },
        udp: { host: 'missing.local', port: 9000 },
      });
      assert.equal(failed.status, 500);
      assert.match(failed.body.error, /dns failed/);
      assert.equal(harness.udp.host, 'tcode.local');
      assert.equal(harness.udp.port, 8000);
      assert.equal(harness.udp.speedCap.maxUnitsPerSecond, 2);
      assert.equal(harness.udp.speedCap.enabled, false);
      assert.equal(readFileSync(harness.configPath, 'utf8'), before);
      assert.equal(harness.session.state, 'idle');
    } finally {
      await harness.close();
    }
  });

  test('a closed udp port is rejected and the config file stays unchanged', async () => {
    const probed = [];
    const harness = await createHarness({
      probe(host, port) {
        probed.push({ host, port });
        throw new RangeError(`UDP ${host}:${port} is not open`);
      },
    });
    try {
      const before = readFileSync(harness.configPath, 'utf8');
      const response = await request(harness.port, 'POST', '/api/config', {
        udp: { host: '10.1.2.3', port: 9000 },
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /UDP 10\.1\.2\.3:9000 is not open/);
      assert.deepEqual(probed, [{ host: '10.1.2.3', port: 9000 }]);
      assert.equal(harness.udp.host, 'tcode.local');
      assert.equal(harness.udp.port, 8000);
      assert.equal(readFileSync(harness.configPath, 'utf8'), before);
      assert.equal(harness.calls.some((call) => call.op === 'device'), false);
      assert.equal(harness.session.state, 'idle');
    } finally {
      await harness.close();
    }
  });
});
