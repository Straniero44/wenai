/**
 * Guards the "runs without the reference checkouts" requirement.
 *
 * companion must not read anything outside its own directory: the answer
 * library is vendored under vendor/ayvajs, and the UDP/TCode output is
 * implemented here rather than loaded from MultiFunPlayer.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { Ayva, TempestStroke } from '../vendor/ayvajs/index.js';
import { STROKE_NAMES } from '../src/parameters.js';

const companionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function jsFiles(dir) {
  return walk(dir).filter((file) => file.endsWith('.js'));
}

/** Every `from '...'` and `import('...')` specifier in a source file. */
function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isLocal(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

describe('vendored ayvajs', () => {
  test('loads from companion and still exposes the 42 strokes', () => {
    assert.deepEqual(Object.keys(TempestStroke.library), [...STROKE_NAMES]);
    assert.equal(typeof Ayva.tempestMotion, 'function');
    assert.equal(typeof TempestStroke, 'function');
  });

  test('runs a stroke through an injected timer and output', async () => {
    const lines = [];
    const ayva = new Ayva().defaultConfiguration();
    ayva.setTimer({
      now: () => performance.now() / 1000,
      sleep: (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)),
    });
    ayva.addOutput({ write: (line) => lines.push(line) });

    const stroke = new TempestStroke('orbit-grind', 60);
    stroke.bind(ayva);
    const running = ayva.do(stroke);
    await new Promise((done) => setTimeout(done, 120));
    ayva.stop();
    await running;

    assert.ok(lines.length > 0, 'the stroke wrote TCode lines');
    assert.ok(
      lines.some((line) => /^L0\d{4} .*R2\d{4}/.test(line)),
      `no six-axis stroke line among: ${JSON.stringify(lines.slice(0, 3))}`,
    );
  });

  test('is a plain directory that stays inside companion', () => {
    const vendorDir = join(companionDir, 'vendor', 'ayvajs');
    assert.equal(statSync(vendorDir).isDirectory(), true);
    const files = walk(vendorDir);
    assert.ok(files.some((file) => file.endsWith(`${sep}index.js`)));
    assert.ok(files.some((file) => file.endsWith(`${sep}LICENSE`)));
    assert.ok(files.length > 10, 'the full src tree is present, not two hand-picked files');
  });
});

describe('no reference-checkout dependency', () => {
  test('relative imports never leave companion', () => {
    const offenders = [];
    for (const file of jsFiles(companionDir)) {
      if (file.includes(`${sep}vendor${sep}`)) continue;
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!isLocal(specifier)) continue;
        const target = resolve(dirname(file), specifier);
        const inside = relative(companionDir, target);
        if (inside.startsWith('..') || inside.startsWith(sep)) {
          offenders.push(`${relative(companionDir, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('vendored sources import only vendored files', () => {
    const vendorDir = join(companionDir, 'vendor', 'ayvajs');
    for (const file of jsFiles(vendorDir)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!isLocal(specifier)) continue;
        const target = resolve(dirname(file), specifier);
        const inside = relative(vendorDir, target);
        assert.equal(
          inside.startsWith('..'),
          false,
          `${relative(vendorDir, file)} -> ${specifier}`,
        );
      }
    }
  });

  test('no source contains an absolute path to a checkout', () => {
    // Sibling checkouts of the reference repos are optional, so nothing may point at them.
    // Built from parts so this file does not trip its own scan.
    const needles = [['', 'home', 'syaoran'].join('/'), ['', 'data', 'Projects'].join('/')];
    const offenders = [];
    for (const file of jsFiles(companionDir)) {
      const source = readFileSync(file, 'utf8');
      for (const needle of needles) {
        if (source.includes(needle)) offenders.push(`${relative(companionDir, file)}: ${needle}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
