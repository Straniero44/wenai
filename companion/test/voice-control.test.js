import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVoiceControl } from '../src/voice-control.js';

function fakeUdp(maxUnitsPerSecond, enabled = true) {
  const udp = {
    speedCap: { enabled, maxUnitsPerSecond, ceiling: 10 },
    setSpeedCap(update) {
      if (Object.hasOwn(update, 'maxUnitsPerSecond')) {
        udp.speedCap.maxUnitsPerSecond = update.maxUnitsPerSecond;
      }
      if (Object.hasOwn(update, 'enabled')) udp.speedCap.enabled = update.enabled;
      else if (Object.hasOwn(update, 'maxUnitsPerSecond')) udp.speedCap.enabled = true;
      return { ...udp.speedCap };
    },
  };
  return udp;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('太快、太慢和升降档会打开限速并写配置', async () => {
  const udp = fakeUdp(5);
  const saved = [];
  const control = createVoiceControl({
    udp,
    session: { state: 'idle', reset() { return Promise.resolve(); } },
    persist: (speedCap) => saved.push({ ...speedCap }),
  });

  await control.applyIntent('too_fast');
  await control.applyIntent('faster');
  await control.applyIntent('slower');
  await control.applyIntent('too_slow');

  assert.deepEqual(saved.map((item) => item.maxUnitsPerSecond), [2, 3, 2, 5]);
  assert.equal(saved.every((item) => item.enabled), true);
  assert.equal(udp.speedCap.maxUnitsPerSecond, 5);
});

test('停下来先用 2 复位，停稳后写成 5', async () => {
  const udp = fakeUdp(7);
  const home = deferred();
  const session = {
    state: 'playing',
    reset() {
      this.state = 'homing';
      return home.promise.then(() => {
        this.state = 'idle';
      });
    },
  };
  const saved = [];
  const control = createVoiceControl({
    udp,
    session,
    persist: (speedCap) => saved.push({ ...speedCap }),
    sleep: async () => {},
  });

  const pending = control.applyIntent('stop');
  assert.equal(udp.speedCap.maxUnitsPerSecond, 2);
  assert.equal(saved.length, 0);
  home.resolve();
  await pending;
  assert.equal(session.state, 'idle');
  assert.equal(udp.speedCap.enabled, true);
  assert.equal(udp.speedCap.maxUnitsPerSecond, 5);
  assert.deepEqual(saved, [{ enabled: true, maxUnitsPerSecond: 5, ceiling: 10 }]);
});

test('停下来的途中另有指令，或限速被关掉，就不再恢复成 5', async () => {
  const udp = fakeUdp(5);
  const home = deferred();
  const session = {
    state: 'playing',
    reset() {
      this.state = 'homing';
      return home.promise.then(() => {
        this.state = 'idle';
      });
    },
  };
  const saved = [];
  const control = createVoiceControl({
    udp,
    session,
    persist: (speedCap) => saved.push({ ...speedCap }),
    sleep: async () => {},
  });

  const stopping = control.applyIntent('stop');
  await control.applyIntent('faster');
  home.resolve();
  await stopping;
  assert.equal(udp.speedCap.maxUnitsPerSecond, 3);
  assert.deepEqual(saved.map((item) => item.maxUnitsPerSecond), [3]);

  const offHome = deferred();
  session.reset = () => {
    udp.setSpeedCap({ enabled: false, maxUnitsPerSecond: udp.speedCap.maxUnitsPerSecond });
    session.state = 'idle';
    return offHome.promise.then(() => {});
  };
  const turningOff = control.applyIntent('stop');
  offHome.resolve();
  await turningOff;
  assert.equal(udp.speedCap.enabled, false);
  assert.deepEqual(saved.map((item) => item.maxUnitsPerSecond), [3]);
});
