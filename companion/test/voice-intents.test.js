import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gearAbove,
  gearBelow,
  matchIntent,
  startupSpeedUpdate,
} from '../src/voice-intents.js';

test('词表认五条指令，并丢掉否定和多出来的话', () => {
  const accepted = [
    ['太快了', 'too_fast'],
    ['太快啦', 'too_fast'],
    ['有点太快了', 'too_fast'],
    ['太快了。', 'too_fast'],
    ['请太快了', 'too_fast'],
    ['太慢了', 'too_slow'],
    ['太慢啦', 'too_slow'],
    ['有点太慢了', 'too_slow'],
    ['快一点', 'faster'],
    ['再快一点', 'faster'],
    ['快一些', 'faster'],
    ['慢一点', 'slower'],
    ['再慢一点', 'slower'],
    ['慢一些', 'slower'],
    ['停下来', 'stop'],
    ['停下', 'stop'],
    ['停止', 'stop'],
    ['停下来吧', 'stop'],
    ['帮我停下来', 'stop'],
    ['停下来太快了', 'stop'],
    ['太快了快一点', 'too_fast'],
  ];
  for (const [text, intent] of accepted) {
    assert.equal(matchIntent(text), intent, text);
  }

  for (const text of ['不要太快了', '别停下来', '先别停', '快点说', '快一点告诉我', '', '嗯', '特别快']) {
    assert.equal(matchIntent(text), null, text);
  }
});

test('档位按整数升降，到头就停', () => {
  assert.equal(gearAbove(2.4, 10), 3);
  assert.equal(gearBelow(2.4, 10), 2);
  assert.equal(gearAbove(5, 10), 6);
  assert.equal(gearBelow(5, 10), 4);
  assert.equal(gearAbove(10, 10), 10);
  assert.equal(gearBelow(1, 10), 1);
});

test('启动时关掉的限速改成打开并且是 5，已经打开的保留数值', () => {
  assert.deepEqual(startupSpeedUpdate({ enabled: false, maxUnitsPerSecond: 2, ceiling: 10 }), {
    enabled: true,
    maxUnitsPerSecond: 5,
  });
  assert.equal(startupSpeedUpdate({ enabled: true, maxUnitsPerSecond: 3, ceiling: 10 }), null);
  assert.deepEqual(startupSpeedUpdate({ enabled: false, maxUnitsPerSecond: 2, ceiling: 4 }), {
    enabled: true,
    maxUnitsPerSecond: 4,
  });
});
