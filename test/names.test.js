'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-names-'));
const saved = process.env.CREW_BOARD_CONFIG;
const savedNames = process.env.CREW_BOARD_NAMES;
process.env.CREW_BOARD_CONFIG = path.join(dir, 'config.json');
process.env.CREW_BOARD_NAMES = path.join(dir, 'names.json');

const names = require('../src/names');
const config = require('../src/config');
const bin = path.join(__dirname, '..', 'bin', 'crew-board');

test.after(() => {
  if (saved === undefined) delete process.env.CREW_BOARD_CONFIG;
  else process.env.CREW_BOARD_CONFIG = saved;
  if (savedNames === undefined) delete process.env.CREW_BOARD_NAMES;
  else process.env.CREW_BOARD_NAMES = savedNames;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('names: every language pool has 30 or more lowercase names and no sofia', () => {
  for (const lang of names.LANGUAGES) {
    const pool = names.pool(lang);
    assert.ok(pool.length >= 30, `${lang} has ${pool.length}`);
    assert.equal(new Set(pool).size, pool.length, `${lang} has no duplicates`);
    for (const n of pool) {
      assert.match(n, /^[a-z]+$/, `${lang}: ${n} is a lowercase word`);
      assert.notEqual(n, 'sofia');
    }
  }
  assert.deepEqual(names.LANGUAGES, ['en', 'es', 'pt', 'fr']);
});

test('names: the Spanish pool returns Spanish names', () => {
  const esPool = new Set(names.pool('es'));
  const drawn = names.draw({ language: 'es', count: 10 });
  assert.equal(drawn.length, 10);
  for (const n of drawn) assert.ok(esPool.has(n), `${n} is in the es pool`);
  assert.match(names.capitalize(drawn[0]), /^[A-Z]/);
});

test('names: exclusion and live crew names are never drawn', () => {
  const drawn = names.draw({ language: 'en', count: 5, exclude: ['james', 'oliver', 'sofia'] });
  assert.ok(!drawn.includes('james'));
  assert.ok(!drawn.includes('oliver'));
  assert.ok(!drawn.includes('sofia'));
  const second = names.draw({ language: 'en', count: 5, exclude: drawn });
  for (const n of second) assert.ok(!drawn.includes(n), `${n} avoids the first draw`);
});

test('names: an exhausted pool appends -2, -3', () => {
  const pool = names.pool('en');
  const exclude = pool.slice(0, -1);
  const drawn = names.draw({ language: 'en', count: 3, exclude });
  assert.equal(drawn[0], pool[pool.length - 1]);
  assert.match(drawn[1], /-2$/);
  assert.match(drawn[2], /-3$/);
  assert.equal(new Set(drawn).size, 3);
});

test('names: an unknown language throws', () => {
  assert.throws(() => names.draw({ language: 'de', count: 1 }), /unknown language/);
});

test('names: config headLanguage defaults, validates and saves', () => {
  assert.equal(config.loadConfig().config.headLanguage, 'en');
  const next = config.defaultConfig();
  next.headLanguage = 'fr';
  config.saveConfig(next);
  assert.equal(config.loadConfig().config.headLanguage, 'fr');
  const bad = config.normalize({ headLanguage: 'zz' });
  assert.equal(bad.config.headLanguage, 'en');
  assert.ok(bad.warnings.some((w) => /headLanguage/.test(w)));
});

test('names: the CLI prints lowercase names and rejects bad input', () => {
  const ok = spawnSync(process.execPath, [bin, 'name', '--language', 'es', '--count', '3', '--exclude', 'diego,sofia'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  for (const n of lines) {
    assert.match(n, /^[a-z]+(?:-\d+)?$/);
    assert.notEqual(n, 'diego');
    assert.notEqual(n, 'sofia');
  }
  const badLang = spawnSync(process.execPath, [bin, 'name', '--language', 'de'], { encoding: 'utf8' });
  assert.equal(badLang.status, 2);
  assert.match(badLang.stderr, /unknown language/);
  const badCount = spawnSync(process.execPath, [bin, 'name', '--language', 'en', '--count', '0'], { encoding: 'utf8' });
  assert.equal(badCount.status, 2);
  assert.match(badCount.stderr, /--count/);
});

test('names: drawFor keeps recent names out of the next draw and records history', () => {
  const file = path.join(dir, 'history.json');
  const first = names.drawFor({ language: 'en', count: 5, file });
  assert.equal(first.length, 5);
  assert.ok(fs.existsSync(file));
  const second = names.drawFor({ language: 'en', count: 5, file });
  for (const n of second) assert.ok(!first.includes(n), `${n} avoids the last draw`);
  const history = names.readHistory(file);
  assert.equal(history.length, 10);
  assert.ok(history.every((e) => e.language === 'en' && e.role === 'worker'));
});

test('names: a draw with remember false leaves history alone', () => {
  const file = path.join(dir, 'history-none.json');
  names.drawFor({ language: 'es', count: 3, file, remember: false });
  assert.equal(names.readHistory(file).length, 0);
});

test('names: --history prints the recent name list', () => {
  const file = path.join(dir, 'history-cli.json');
  names.record(['valeria'], { language: 'es', role: 'secretary', file });
  const old = process.env.CREW_BOARD_NAMES;
  process.env.CREW_BOARD_NAMES = file;
  try {
    const saved = process.stdout.write;
    const out = [];
    process.stdout.write = (m) => { out.push(String(m)); return true; };
    try {
      assert.equal(names.main(['--history']), 0);
    } finally {
      process.stdout.write = saved;
    }
    assert.match(out.join(''), /valeria\tes\tsecretary/);
  } finally {
    if (old === undefined) delete process.env.CREW_BOARD_NAMES;
    else process.env.CREW_BOARD_NAMES = old;
  }
});

test('names: boss titles rotate from the head pool and record history', () => {
  const file = path.join(dir, 'titles.json');
  const first = names.pickTitle({ file });
  assert.ok(config.HEAD_NAMES.some((h) => h.name === first));
  const second = names.pickTitle({ file });
  assert.ok(config.HEAD_NAMES.some((h) => h.name === second));
  assert.notEqual(first, second);
  const history = names.readHistory(file);
  assert.equal(history.length, 2);
  assert.ok(history.every((e) => e.language === 'titles' && e.role === 'head-honcho'));
});
