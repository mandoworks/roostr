'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-update-'));
process.env.CREW_BOARD_STATE_DIR = dir;
delete process.env.CREW_BOARD_NO_UPDATE_CHECK;
const update = require('../src/update');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('newer and latestTag: plain vX.Y.Z tags only, compared as numbers', () => {
  assert.ok(update.newer('0.1.10', '0.1.9'));
  assert.ok(update.newer('1.0.0', '0.9.9'));
  assert.ok(!update.newer('0.1.0', '0.1.0'));
  assert.ok(!update.newer('junk', '0.1.0'));
  const out = [
    'aaa\trefs/tags/v0.1.0',
    'bbb\trefs/tags/v0.1.10',
    'ccc\trefs/tags/v0.1.9',
    'ddd\trefs/tags/v0.2.0-beta',
    'eee\trefs/tags/nightly',
  ].join('\n');
  assert.equal(update.latestTag(out), '0.1.10');
  assert.equal(update.latestTag(''), null);
});

test('installed: the version in the manifest', () => {
  assert.match(update.installed(), /^\d+\.\d+\.\d+$/);
  const f = path.join(dir, 'm.toml');
  fs.writeFileSync(f, 'id = "x"\nversion = "1.2.3"\n');
  assert.equal(update.installed(f), '1.2.3');
  assert.equal(update.installed(path.join(dir, 'missing.toml')), null);
});

test('check: once a day between boards, offers only a newer release, never prompts git', () => {
  const manifest = path.join(dir, 'm.toml');
  fs.writeFileSync(manifest, 'version = "0.1.0"\n');
  const calls = [];
  const run = (cmd, argv, opts, cb) => {
    calls.push({ cmd, argv, opts, cb });
    return null;
  };
  const day = 24 * 60 * 60 * 1000;
  assert.equal(update.check(1000, { manifest }, run), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.ok(calls[0].argv[3] === 'https://github.com/mandoworks/roostr' || calls[0].argv[3] === 'https://github.com/mandoworks/crew-board');
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0');
  calls[0].cb(null, 'aaa\trefs/tags/v0.1.0\nbbb\trefs/tags/v0.1.1\n');
  assert.equal(update.check(2000, { manifest }, run), '0.1.1');
  assert.equal(calls.length, 1, 'not due for a day');
  fs.writeFileSync(manifest, 'version = "0.1.1"\n');
  assert.equal(update.check(3000, { manifest }, run), null, 'installed now, nothing to offer');
  update.check(1000 + day, { manifest }, run);
  assert.equal(calls.length, 2);
  calls[1].cb(new Error('offline'), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'update.json'), 'utf8')).latest, '0.1.1', 'a failed check keeps the last answer');
  assert.equal(update.check(5000 + day, { manifest, noUpdateCheck: true }, run), null);
  process.env.CREW_BOARD_NO_UPDATE_CHECK = '1';
  fs.writeFileSync(manifest, 'version = "0.1.0"\n');
  assert.equal(update.check(6000 + day, { manifest }, run), null, 'the variable turns it off');
  delete process.env.CREW_BOARD_NO_UPDATE_CHECK;
});
