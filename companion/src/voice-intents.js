/**
 * Map a heard sentence onto one speed intent.
 * The microphone may mis-hear a syllable; those spellings belong to the
 * listener's keyword list. This function only accepts a finished sentence.
 */

export const VOICE_INTENTS = Object.freeze([
  'stop',
  'too_fast',
  'too_slow',
  'faster',
  'slower',
]);

const RANK = Object.freeze({
  stop: 0,
  too_fast: 1,
  too_slow: 2,
  faster: 3,
  slower: 4,
});

const PHRASES = Object.freeze([
  ['有点太快了', 'too_fast'],
  ['有点太慢了', 'too_slow'],
  ['再快一点', 'faster'],
  ['再慢一点', 'slower'],
  ['快一点', 'faster'],
  ['快一些', 'faster'],
  ['慢一点', 'slower'],
  ['慢一些', 'slower'],
  ['太快啦', 'too_fast'],
  ['太快了', 'too_fast'],
  ['太慢啦', 'too_slow'],
  ['太慢了', 'too_slow'],
  ['停下来', 'stop'],
  ['停止', 'stop'],
  ['停下', 'stop'],
].sort((left, right) => right[0].length - left[0].length));

const FILLERS = Object.freeze(['帮我', '那个', '请', '嗯', '啊', '呢', '吧', '呀', '哦', '噢']);

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s，。！？、,.!?;；：:""''「」~～]+/g, '')
    .trim();
}

function hasNegation(text) {
  return text.includes('不要') || text.includes('先别') || /(?<!特)别/.test(text);
}

function stripFillers(text) {
  let next = text;
  let changed = true;
  while (changed && next !== '') {
    changed = false;
    for (const filler of FILLERS) {
      if (next.startsWith(filler)) {
        next = next.slice(filler.length);
        changed = true;
      }
      if (next.endsWith(filler)) {
        next = next.slice(0, -filler.length);
        changed = true;
      }
    }
  }
  return next;
}

function prefer(intents) {
  return intents.slice().sort((left, right) => RANK[left] - RANK[right])[0] ?? null;
}

/**
 * @param {unknown} text
 * @returns {'stop'|'too_fast'|'too_slow'|'faster'|'slower'|null}
 */
export function matchIntent(text) {
  const compact = normalize(text);
  if (compact === '' || hasNegation(compact)) return null;
  let rest = stripFillers(compact);
  if (rest === '') return null;
  const found = [];
  while (rest !== '') {
    const phrase = PHRASES.find(([saying]) => rest.startsWith(saying));
    if (!phrase) return null;
    found.push(phrase[1]);
    rest = rest.slice(phrase[0].length);
  }
  return prefer(found);
}

/**
 * Next integer gear strictly above `value`, or `value` when none remains.
 * Gears are the integers 1 through the ceiling.
 */
export function gearAbove(value, ceiling) {
  const top = Math.floor(ceiling);
  for (let gear = 1; gear <= top; gear += 1) {
    if (gear > value) return gear;
  }
  return value;
}

/** Previous integer gear strictly below `value`, or `value` when none remains. */
export function gearBelow(value, ceiling) {
  const top = Math.floor(ceiling);
  let previous = null;
  for (let gear = 1; gear <= top; gear += 1) {
    if (gear >= value) break;
    previous = gear;
  }
  return previous ?? value;
}

/**
 * Speed cap to apply when a saved cap was left off.
 * An already enabled cap is kept, including its number.
 * @returns {{ enabled: true, maxUnitsPerSecond: number }|null}
 */
export function startupSpeedUpdate(speedCap) {
  if (speedCap?.enabled) return null;
  const ceiling = Number.isFinite(speedCap?.ceiling) ? speedCap.ceiling : 10;
  return { enabled: true, maxUnitsPerSecond: Math.min(5, ceiling) };
}
