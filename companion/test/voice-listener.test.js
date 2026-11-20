import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPhraseGate, startVoiceListener } from '../src/voice-listener.js';

const fixture = fileURLToPath(new URL('../voice/fixture-lines.js', import.meta.url));

test('同一句两秒内只放行一次，停下来每次都放行', () => {
  let now = 0;
  const accept = createPhraseGate({ now: () => now, windowMs: 2000 });
  assert.equal(accept('too_fast', 0), true);
  assert.equal(accept('too_fast', 1999), false);
  assert.equal(accept('too_fast', 2000), true);
  assert.equal(accept('stop', 2000), true);
  assert.equal(accept('stop', 2001), true);
  assert.equal(accept(null, 3000), false);
});

test('听筒按行交出 sidecar 打出来的句子', async () => {
  const lines = [];
  const listener = startVoiceListener({
    command: [process.execPath, fixture, '太快了', '停下来'],
    onText(line) {
      lines.push(line);
    },
  });
  const deadline = Date.now() + 2000;
  while (lines.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  listener.stop();
  assert.deepEqual(lines, ['太快了', '停下来']);
});
