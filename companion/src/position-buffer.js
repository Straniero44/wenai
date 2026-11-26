const AXIS_PATTERN = 'L0|L1|L2|R0|R1|R2';

export const AXES = Object.freeze(['L0', 'L1', 'L2', 'R0', 'R1', 'R2']);

function parseLine(line) {
  const tokens = [];
  const expression = new RegExp(`(?:^|[^A-Za-z0-9])(${AXIS_PATTERN})(\\d{4})(?!\\d)`, 'g');
  const remainder = line.replace(expression, (_match, axis, digits) => {
    tokens.push([axis, Number(digits) / 9999]);
    return ' ';
  });
  return { tokens, remainder };
}

/**
 * Ayva `{ write }` target. Valid tokens update in-memory positions.
 * The UDP loop, not this buffer, owns pacing, I-intervals, and speed clamp.
 */
export class PositionBuffer {
  #positions = new Map(AXES.map((axis) => [axis, null]));
  #log;

  constructor(options = {}) {
    this.#log = options.log ?? ((message) => {
      console.warn(message);
    });
  }

  write(line) {
    if (line == null) return;
    const text = String(line);
    const { tokens, remainder } = parseLine(text);
    for (const [axis, position] of tokens) {
      this.#positions.set(axis, position);
    }
    if (/\S/.test(remainder)) {
      this.#log(`discarded position text: ${remainder.trim()}`);
    }
  }

  get(axis) {
    return this.#positions.has(axis) ? this.#positions.get(axis) : null;
  }
}
