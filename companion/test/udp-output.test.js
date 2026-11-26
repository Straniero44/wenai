import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

import { defaultConfigPath, loadConfig, normalizeUdpTarget } from '../src/config.js';
import { PositionBuffer } from '../src/position-buffer.js';
import { probeUdp, UdpOutput } from '../src/udp-output.js';

function fakeSocket() {
  return {
    sent: [],
    endpoint: null,
    connect(port, host) {
      this.endpoint = { port, host };
    },
    send(packet) {
      this.sent.push(String(packet));
    },
  };
}

function fakeScheduler() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, delay) {
      const handle = { fn, delay };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    fireNext() {
      const handle = pending.shift();
      if (!handle) throw new Error('no pending timer');
      handle.fn();
    },
  };
}

function createOutput(options = {}) {
  const buffer = options.buffer ?? new PositionBuffer({ log() {} });
  const socket = options.socket ?? fakeSocket();
  const output = new UdpOutput({
    config: {},
    buffer,
    socket,
    ...options,
    buffer,
    socket,
  });
  return { output, buffer, socket };
}

function unitsOf(packet, axis) {
  const match = packet.match(new RegExp(`${axis}(\\d{4})I`));
  assert.ok(match, packet);
  return Number(match[1]);
}

test('只接受六轴加四位数字，位置等于数字除以 9999', () => {
  const logs = [];
  const buffer = new PositionBuffer({ log: (message) => logs.push(message) });
  buffer.write('L00000 L19999 L25000 R00000 R11234 R29999 V09999 A01234 hello\n');
  assert.equal(buffer.get('L0'), 0);
  assert.equal(buffer.get('L1'), 1);
  assert.equal(buffer.get('L2'), 5000 / 9999);
  assert.equal(buffer.get('R0'), 0);
  assert.equal(buffer.get('R1'), 1234 / 9999);
  assert.equal(buffer.get('R2'), 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /V09999/);
  assert.match(logs[0], /A01234/);
  assert.match(logs[0], /hello/);

  buffer.write('L012345');
  buffer.write('L0123');
  buffer.write('l09999');
  buffer.write('XL05000');
  assert.equal(buffer.get('L0'), 0);
  assert.equal(logs.length, 5);
});

test('脏值过滤：相同值不重发，不足一个量化台阶不发送', () => {
  const { output, buffer, socket } = createOutput();
  buffer.write('L05000 L15000');
  output.sample(10);
  output.sample(10);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0], 'L05000I10 L15000I10\n');

  buffer.write('L15001');
  output.sample(10);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1], 'L15001I10\n');

  output.setSpeedCap({ enabled: false });
  buffer.write('L00000');
  output.sample(10);
  assert.equal(socket.sent.at(-1), 'L00000I10\n');
  output.setSpeedCap({ maxUnitsPerSecond: 0.004 });
  buffer.write('L09999');
  output.sample(10);
  output.sample(10);
  assert.equal(socket.sent.length, 3);
  output.sample(10);
  assert.equal(socket.sent.length, 4);
  assert.equal(unitsOf(socket.sent[3], 'L0'), 1);
  assert.equal(socket.sent[3].includes('L1'), false);
  assert.equal(socket.sent[3].includes('V0'), false);
  assert.equal(socket.sent[3].includes('A0'), false);
});

test('I 间隔使用 floor(elapsedMs + 0.75)，四位补零并以换行结束', () => {
  const { output, buffer, socket } = createOutput({ intervalMs: 33 });
  output.setSpeedCap({ enabled: false });
  const cases = [
    [10, 10],
    [9.3, 10],
    [9.2, 9],
    [10.3, 11],
    [0, 0],
  ];
  let digits = 0;
  for (const [elapsed, interval] of cases) {
    digits += 100;
    buffer.write(`R0${String(digits).padStart(4, '0')}`);
    output.sample(elapsed);
    assert.equal(socket.sent.at(-1), `R0${String(digits).padStart(4, '0')}I${interval}\n`);
  }
  buffer.write('L00000 R29999');
  output.sample(10);
  assert.equal(socket.sent.at(-1), 'L00000I10 R29999I10\n');
});

test('默认以 5 夹紧，整段跳变不会一拍走完', () => {
  const { output, buffer, socket } = createOutput({ intervalMs: 33 });
  assert.equal(output.speedCap.enabled, true);
  assert.equal(output.speedCap.maxUnitsPerSecond, 5);
  assert.equal(output.speedCap.ceiling, 10);
  assert.equal(output.intervalMs, 33);
  buffer.write('L00000');
  output.sample(10);
  buffer.write('L09999');
  output.sample(10);
  assert.equal(socket.sent.at(-1), 'L00500I10\n');
});

test('打开后夹紧，相邻报文不超过每拍最大步长', () => {
  const { output, buffer, socket } = createOutput({ intervalMs: 33 });
  buffer.write('L00000');
  output.sample(10);
  output.setSpeedCap({ enabled: true, maxUnitsPerSecond: 2 });
  assert.equal(output.speedCap.enabled, true);
  assert.equal(output.speedCap.maxUnitsPerSecond, 2);
  buffer.write('L09999');
  output.sample(10);
  output.sample(10);
  assert.equal(socket.sent[1], 'L00200I10\n');
  assert.equal(socket.sent[2], 'L00400I10\n');
  const step = (unitsOf(socket.sent[2], 'L0') - unitsOf(socket.sent[1], 'L0')) / 9999;
  assert.ok(step <= 2 * (10 / 1000) + 1 / 9999);
  assert.ok(step > 0);
});

test('超天花板拒绝，关闭时保留数值并且不再夹紧', () => {
  const { output, buffer, socket } = createOutput();
  assert.throws(() => output.setSpeedCap(11), RangeError);
  assert.throws(() => output.setSpeedCap({ maxUnitsPerSecond: 10.01 }), RangeError);
  assert.throws(() => output.setSpeedCap(0), RangeError);
  assert.throws(() => output.setSpeedCap(-1), RangeError);
  assert.equal(output.speedCap.enabled, true);
  assert.equal(output.speedCap.maxUnitsPerSecond, 5);
  assert.equal(output.speedCap.ceiling, 10);

  output.setSpeedCap(10);
  assert.equal(output.speedCap.enabled, true);
  assert.equal(output.speedCap.maxUnitsPerSecond, 10);
  assert.throws(() => output.setSpeedCap({ enabled: false, maxUnitsPerSecond: 11 }), RangeError);
  assert.equal(output.speedCap.enabled, true);
  assert.equal(output.speedCap.maxUnitsPerSecond, 10);

  output.setSpeedCap({ maxUnitsPerSecond: 3, enabled: false });
  assert.equal(output.speedCap.enabled, false);
  assert.equal(output.speedCap.maxUnitsPerSecond, 3);

  buffer.write('L00000');
  output.sample(10);
  buffer.write('L09999');
  output.sample(10);
  assert.equal(socket.sent.at(-1), 'L09999I10\n');

  const limited = createOutput();
  limited.output.setSpeedCap({ ceiling: 100, maxUnitsPerSecond: 4 });
  assert.equal(limited.output.speedCap.ceiling, 10);
  assert.equal(limited.output.speedCap.maxUnitsPerSecond, 4);
  assert.throws(() => limited.output.setSpeedCap(11), RangeError);
  assert.equal(limited.output.speedCap.maxUnitsPerSecond, 4);
  assert.equal(limited.output.speedCap.enabled, true);
});

test('自定义天花板，周期边界，以及注入时钟推进 I 间隔', async () => {
  const capped = createOutput({
    config: { speedCap: { ceiling: 4, maxUnitsPerSecond: 2, enabled: false } },
  });
  assert.throws(() => capped.output.setSpeedCap(4.1), RangeError);
  assert.equal(capped.output.speedCap.maxUnitsPerSecond, 2);
  capped.output.setSpeedCap(4);
  assert.equal(capped.output.speedCap.maxUnitsPerSecond, 4);
  assert.equal(capped.output.speedCap.enabled, true);

  assert.throws(() => createOutput({ intervalMs: 2 }), RangeError);
  assert.throws(() => createOutput({ intervalMs: 34 }), RangeError);
  assert.equal(createOutput({ intervalMs: 3 }).output.intervalMs, 3);
  assert.equal(createOutput({ intervalMs: 33 }).output.intervalMs, 33);

  let now = 0;
  const scheduler = fakeScheduler();
  const { output, buffer, socket } = createOutput({
    clock: { now: () => now },
    scheduler,
    host: '192.168.0.20',
    port: 8001,
  });
  buffer.write('L04000');
  await output.start();
  assert.equal(socket.sent.length, 0);
  assert.deepEqual(socket.endpoint, { port: 8001, host: '192.168.0.20' });
  assert.equal(scheduler.pending.length, 1);
  assert.equal(scheduler.pending[0].delay, 10);
  now = 9.3;
  scheduler.fireNext();
  assert.equal(socket.sent[0], 'L04000I10\n');
  output.stop();
  assert.equal(scheduler.pending.length, 0);
  assert.equal(output.status, 'stopped');
});

function bindUdp(host) {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, host, () => resolve(socket));
  });
}

test('探测拒绝关闭的端口，主机不可达时也不算开放', async () => {
  const open = await bindUdp('127.0.0.1');
  const silent = await bindUdp('127.0.0.1');
  try {
    const openPort = open.address().port;
    const silentPort = silent.address().port;
    open.on('message', (message, remote) => {
      open.send(Buffer.from('ok'), remote.port, remote.address);
    });

    await probeUdp('127.0.0.1', openPort, { timeoutMs: 50, ping: async () => false });
    await probeUdp('127.0.0.1', silentPort, { timeoutMs: 40, ping: async () => true });
    await assert.rejects(
      () => probeUdp('127.0.0.1', silentPort, { timeoutMs: 40, ping: async () => false }),
      /is not open/,
    );
    await assert.rejects(
      () => probeUdp('127.0.0.1', 1, { timeoutMs: 200, ping: async () => true }),
      /is not open/,
    );
    await assert.rejects(
      () => probeUdp('no-such-host.invalid', 8000, { timeoutMs: 200, ping: async () => false }),
      /Cannot resolve no-such-host.invalid/,
    );
  } finally {
    open.close();
    silent.close();
  }
});

test('空白设备地址落回 tcode.local:8000', () => {
  assert.deepEqual(normalizeUdpTarget('   ', ''), { host: 'tcode.local', port: 8000 });
  assert.deepEqual(normalizeUdpTarget(null, null), { host: 'tcode.local', port: 8000 });
  assert.throws(() => normalizeUdpTarget('device.local', 0), RangeError);
  assert.throws(() => normalizeUdpTarget(1, 8000), TypeError);
});

test('setDevice 在运行中改地址，失败时回到原地址且不进入 fault', async () => {
  const scheduler = fakeScheduler();
  let failNext = false;
  const socket = fakeSocket();
  socket.disconnected = 0;
  socket.disconnect = () => {
    socket.disconnected += 1;
  };
  const originalConnect = socket.connect.bind(socket);
  socket.connect = function connect(port, host) {
    if (failNext) {
      failNext = false;
      throw new Error('dns failed');
    }
    originalConnect(port, host);
  };
  const { output } = createOutput({
    socket,
    scheduler,
    host: 'tcode.local',
    port: 8000,
  });

  await output.setDevice({ host: '   ' });
  assert.equal(output.host, 'tcode.local');
  assert.equal(socket.endpoint, null);

  await output.start();
  assert.deepEqual(socket.endpoint, { port: 8000, host: 'tcode.local' });

  await output.setDevice({ host: '10.0.0.8', port: 9000 });
  assert.equal(socket.disconnected, 1);
  assert.deepEqual(socket.endpoint, { port: 9000, host: '10.0.0.8' });
  assert.equal(output.status, 'running');

  failNext = true;
  await assert.rejects(() => output.setDevice({ host: 'missing.local' }), /Could not use missing.local:9000/);
  assert.equal(output.host, '10.0.0.8');
  assert.equal(output.port, 9000);
  assert.equal(output.status, 'running');
  assert.deepEqual(socket.endpoint, { port: 9000, host: '10.0.0.8' });

  await assert.rejects(() => output.setDevice({ port: 0 }), RangeError);
  assert.equal(output.port, 9000);
  output.stop();
});

test('自有套接字可以改到另一个本机端口', async () => {
  const scheduler = fakeScheduler();
  const output = new UdpOutput({
    config: { udp: { host: '127.0.0.1', port: 9, intervalMs: 33 } },
    buffer: new PositionBuffer({ log() {} }),
    clock: { now: () => 0 },
    scheduler,
  });
  await output.start();
  try {
    await output.setDevice({ port: 10 });
    assert.equal(output.host, '127.0.0.1');
    assert.equal(output.port, 10);
    assert.equal(output.status, 'running');
  } finally {
    output.stop();
  }
});

test('发送失败进入 fault 后不再发送', () => {
  const socket = fakeSocket();
  const { output, buffer } = createOutput({ socket });
  buffer.write('L05000');
  socket.send = () => {
    throw new Error('network down');
  };
  assert.throws(() => output.sample(10), /network down/);
  assert.equal(output.status, 'fault');
  let calls = 0;
  socket.send = () => {
    calls += 1;
  };
  output.sample(10);
  assert.equal(calls, 0);
});

test('配置文件缺失时用第 11 节默认值，读到文件时覆盖对应字段', () => {
  assert.ok(defaultConfigPath.endsWith(`${sep}companion${sep}config.json`));
  const dir = mkdtempSync(join(tmpdir(), 'ayva-udp-'));
  try {
    const missing = loadConfig(join(dir, 'missing.json'));
    assert.deepEqual(missing.http, { host: '127.0.0.1', port: 8787 });
    assert.deepEqual(missing.udp, { host: 'tcode.local', port: 8000, intervalMs: 10 });
    assert.deepEqual(missing.speedCap, { enabled: true, maxUnitsPerSecond: 5, ceiling: 10 });
    assert.deepEqual(missing.travel.stroke, [0.2, 0.8]);
    assert.deepEqual(missing.travel.pitch, [0.2, 0.8]);
    missing.udp.host = 'mutated';
    missing.travel.stroke[0] = 0;
    const again = loadConfig(join(dir, 'missing.json'));
    assert.equal(again.udp.host, 'tcode.local');
    assert.equal(again.travel.stroke[0], 0.2);

    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({
      udp: { host: '   ', port: 9001, intervalMs: 16 },
      speedCap: { enabled: true, maxUnitsPerSecond: 1.5, ceiling: 6 },
    }));
    const loaded = loadConfig(file);
    assert.equal(loaded.udp.host, 'tcode.local');
    assert.equal(loaded.udp.port, 9001);
    assert.equal(loaded.udp.intervalMs, 16);
    assert.equal(loaded.speedCap.enabled, true);
    assert.equal(loaded.speedCap.maxUnitsPerSecond, 1.5);
    assert.equal(loaded.speedCap.ceiling, 6);
    assert.equal(loaded.http.port, 8787);

    const { output } = createOutput({ configPath: file, config: { udp: { host: 'ignored.example' } } });
    assert.equal(output.host, 'tcode.local');
    assert.equal(output.port, 9001);
    assert.equal(output.intervalMs, 16);
    assert.equal(output.speedCap.enabled, true);
    assert.equal(output.speedCap.ceiling, 6);

    writeFileSync(file, JSON.stringify({ udp: { intervalMs: 50 } }));
    assert.throws(() => loadConfig(file), RangeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('target: defaults to the device and reports it', () => {
  const { output } = createOutput();
  assert.equal(output.target, 'tcode.local');
});

test('target: emulator route keeps device packets off the device socket', () => {
  const { output, buffer, socket } = createOutput();
  output.setTarget(true);
  buffer.write('L05000');
  output.sample(10);
  assert.equal(output.target, 'emulator');
  // The injected device socket was never used.
  assert.equal(socket.sent.length, 0);
  output.stop();
});

test('target: switching back to the device resumes using the device socket', () => {
  const { output, buffer, socket } = createOutput();
  output.setSpeedCap({ enabled: false });
  output.setTarget(true);
  buffer.write('L05000');
  output.sample(10);
  output.setTarget(null);
  buffer.write('L06000');
  output.sample(10);
  assert.equal(output.target, 'tcode.local');
  assert.equal(socket.sent.length, 1);
  assert.match(socket.sent[0], /^L06000I10\n$/);
  output.stop();
});

test('target: setTarget rejects anything but null or true', () => {
  const { output } = createOutput();
  assert.throws(() => output.setTarget('emulator'), /null or true/);
  assert.throws(() => output.setTarget(1), /null or true/);
  assert.equal(output.target, 'tcode.local');
});

test('target: a dead emulator target never faults the session that drives the device', () => {
  const { output, buffer } = createOutput();
  output.setTarget(true);
  buffer.write('L05000');
  // Port 1 on loopback: nothing listens. An unconnected socket gets no
  // ICMP error event, so this must stay silent.
  output.sample(10);
  output.setTarget(null);
  buffer.write('L06000');
  output.sample(10);
  assert.equal(output.status, 'idle');
  assert.equal(output.lastError, null);
  output.stop();
});

test('voice.listen false stays on the loaded config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-voice-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({
      voice: { listen: false, python: 'python3', modelDir: '' },
    }));
    const loaded = loadConfig(file);
    assert.equal(loaded.voice.listen, false);
    assert.equal(loaded.voice.python, 'python3');
    assert.equal(loaded.udp.host, 'tcode.local');
    assert.equal(loadConfig(join(dir, 'missing.json')).voice, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('target: emulator config defaults to loopback and rejects remote hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-emu-'));
  try {
    const configPath = join(dir, 'config.json');

    // No file: the documented defaults.
    const absent = loadConfig(join(dir, 'absent.json'));
    assert.deepEqual(absent.emulator, { host: '127.0.0.1', port: 8000 });

    writeFileSync(configPath, JSON.stringify({ emulator: { host: 'localhost', port: 9001 } }));
    assert.deepEqual(loadConfig(configPath).emulator, { host: 'localhost', port: 9001 });

    // A remote host would turn the keyword into an arbitrary target.
    writeFileSync(configPath, JSON.stringify({ emulator: { host: '192.168.1.5' } }));
    assert.throws(() => loadConfig(configPath), /loopback/);

    writeFileSync(configPath, JSON.stringify({ emulator: { port: 0 } }));
    assert.throws(() => loadConfig(configPath), /emulator\.port/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
