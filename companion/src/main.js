/**
 * Compose the companion process: UDP output, motion session, and local HTTP.
 * Nothing plays until a client posts play.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, defaultConfigPath } from './config.js';
import { createHttpServer, persistSpeedCap } from './http.js';
import { MotionSession } from './motion-session.js';
import { UdpOutput } from './udp-output.js';
import { createVoiceControl } from './voice-control.js';
import { matchIntent, startupSpeedUpdate } from './voice-intents.js';
import { createPhraseGate, startVoiceListener, voiceCommand } from './voice-listener.js';

function wireFault(session, udp) {
  const previous = udp.onFault;
  udp.onFault = (error) => {
    session.lastError = error;
    session.state = 'fault';
    if (session.ayva && typeof session.ayva.stop === 'function') {
      try {
        session.ayva.stop();
      } catch {
        // The output failure is already stored on the session.
      }
    }
    if (typeof previous === 'function') previous(error);
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.session] injected session. Production builds a MotionSession.
 * @param {object} [options.udp] injected output. Production builds a UdpOutput and starts it.
 * @param {object} [options.config]
 * @param {string} [options.configPath]
 * @param {number} [options.port]
 */
export async function start(options = {}) {
  const configPath = options.configPath ?? defaultConfigPath;
  const config = options.config ?? loadConfig(configPath);
  const ownsUdp = options.udp == null;
  const udp = options.udp ?? new UdpOutput({ config });
  const session = options.session ?? new MotionSession({
    output: udp.buffer,
    travel: config.travel,
    speedCap: {
      get: () => udp.speedCap,
      set: (patch) => udp.setSpeedCap(patch),
    },
  });
  wireFault(session, udp);

  if (ownsUdp) {
    const speedUpdate = startupSpeedUpdate(udp.speedCap);
    if (speedUpdate) {
      udp.setSpeedCap(speedUpdate);
      persistSpeedCap(configPath, udp.speedCap);
    }
    try {
      await udp.start();
    } catch (error) {
      if (session.state !== 'fault') {
        session.lastError = error;
        session.state = 'fault';
      }
    }
  }

  const httpServer = createHttpServer({
    session,
    udp,
    config,
    configPath,
    port: options.port ?? config.http.port,
  });
  const bound = await httpServer.listen();

  return {
    config,
    session,
    udp,
    httpServer,
    bound,
    async close() {
      await httpServer.close();
      if (ownsUdp && typeof udp.stop === 'function') udp.stop();
    },
  };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

function startHearing(runtime) {
  if (runtime.config.voice?.listen === false) return null;
  const control = createVoiceControl({
    udp: runtime.udp,
    session: runtime.session,
    persist: (speedCap) => persistSpeedCap(defaultConfigPath, speedCap),
  });
  const gate = createPhraseGate();
  return startVoiceListener({
    command: voiceCommand(runtime.config),
    onText(line) {
      const intent = matchIntent(line);
      if (!gate(intent)) return;
      control.applyIntent(intent).catch((error) => {
        console.error(error instanceof Error ? error.message : error);
      });
    },
    onError(message) {
      console.error(`voice: ${message}`);
    },
  });
}

async function main() {
  const runtime = await start();
  const hearing = startHearing(runtime);
  const address = runtime.bound;
  console.log(`companion listening on http://${address.address}:${address.port}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (hearing) hearing.stop();
    runtime.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
