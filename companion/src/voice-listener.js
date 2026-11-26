/**
 * Run the microphone sidecar and hand each finished line to the caller.
 * The sidecar prints one sentence per line. It does not change the speed cap.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VOICE_REPEAT_MS = 2000;

export function voiceScriptPath() {
  return fileURLToPath(new URL('../voice/listen.py', import.meta.url));
}

export function voiceCommand(config, scriptPath = voiceScriptPath()) {
  const voice = config?.voice ?? {};
  const python = typeof voice.python === 'string' && voice.python.trim() !== ''
    ? voice.python.trim()
    : 'python3';
  const modelDir = typeof voice.modelDir === 'string' ? voice.modelDir.trim() : '';
  return [python, scriptPath, '--model-dir', modelDir];
}

/**
 * Drop a repeated intent inside the window. stop always passes.
 * @param {{ now?: () => number, windowMs?: number }} [options]
 */
export function createPhraseGate(options = {}) {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? VOICE_REPEAT_MS;
  const last = new Map();
  return function accept(intent, at = now()) {
    if (intent == null) return false;
    if (intent === 'stop') return true;
    const previous = last.get(intent);
    if (previous != null && at - previous < windowMs) return false;
    last.set(intent, at);
    return true;
  };
}

/**
 * @param {object} options
 * @param {string[]} options.command
 * @param {(line: string) => void} options.onText
 * @param {(message: string) => void} [options.onError]
 */
export function startVoiceListener(options) {
  const command = options?.command;
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== 'string') {
    throw new TypeError('voice listener requires a command');
  }
  if (typeof options.onText !== 'function') {
    throw new TypeError('voice listener requires onText()');
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const take = (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') options.onText(line);
      newline = buffer.indexOf('\n');
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString('utf8').trim();
    if (message !== '' && typeof options.onError === 'function') options.onError(message);
  });
  child.on('error', (error) => {
    if (typeof options.onError === 'function') options.onError(error.message);
  });
  return {
    stop() {
      if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
    },
  };
}
