/**
 * Apply a voice intent to the live speed cap and, for stop, to reset.
 * The temporary cap of 2 during a stop is not written. The restored 5 is.
 */

import { gearAbove, gearBelow } from './voice-intents.js';

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createVoiceControl({ udp, session, persist, sleep = wait }) {
  if (!udp || typeof udp.setSpeedCap !== 'function' || udp.speedCap == null) {
    throw new TypeError('voice control requires a udp output with setSpeedCap()');
  }
  if (!session || typeof session.reset !== 'function') {
    throw new TypeError('voice control requires a session with reset()');
  }
  if (typeof persist !== 'function') {
    throw new TypeError('voice control requires persist()');
  }

  let generation = 0;

  function commit(maxUnitsPerSecond) {
    const applied = udp.setSpeedCap({ enabled: true, maxUnitsPerSecond });
    persist(applied);
    return applied;
  }

  async function stop(ticket) {
    let turnedOff = false;
    const original = udp.setSpeedCap.bind(udp);
    udp.setSpeedCap = (update) => {
      const applied = original(update);
      if (applied?.enabled === false) turnedOff = true;
      return applied;
    };
    try {
      original({ enabled: true, maxUnitsPerSecond: 2 });
      await session.reset();
      while (session.state !== 'idle' && session.state !== 'fault') {
        if (generation !== ticket || turnedOff) return null;
        await sleep(20);
      }
    } finally {
      udp.setSpeedCap = original;
    }
    if (generation !== ticket || turnedOff || session.state === 'fault') return null;
    if (udp.speedCap.enabled === false) return null;
    return commit(5);
  }

  return {
    /**
     * @param {'stop'|'too_fast'|'too_slow'|'faster'|'slower'|null} intent
     */
    async applyIntent(intent) {
      generation += 1;
      const ticket = generation;
      if (intent === 'too_fast') return commit(2);
      if (intent === 'too_slow') return commit(5);
      if (intent === 'faster') return commit(gearAbove(udp.speedCap.maxUnitsPerSecond, udp.speedCap.ceiling));
      if (intent === 'slower') return commit(gearBelow(udp.speedCap.maxUnitsPerSecond, udp.speedCap.ceiling));
      if (intent === 'stop') return stop(ticket);
      return null;
    },
  };
}
