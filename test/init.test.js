'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const init = require('../src/init');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-init-'));
process.env.ROOSTR_STATE_DIR = path.join(tmpRoot, 'state');
process.env.ROOSTR_CONFIG = path.join(tmpRoot, 'config.json');

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function capture(fn) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    const code = fn();
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

function makeDir(name) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, name));
  return dir;
}

test('init: detectCheck prefers an executable verify.sh', () => {
  const dir = makeDir('check-verify-');
  fs.writeFileSync(path.join(dir, 'verify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(init.detectCheck(dir), './verify.sh');
});

test('init: detectCheck falls back to npm test for a package.json', () => {
  const dir = makeDir('check-npm-');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.equal(init.detectCheck(dir), 'npm test');
});

test('init: detectCheck returns null when there is no check', () => {
  assert.equal(init.detectCheck(makeDir('check-none-')), null);
});

test('init: starterToml carries the name, budget, tags and optional check', () => {
  const toml = init.starterToml('/tmp/my-project', './verify.sh');
  assert.match(toml, /name = "my-project"/);
  assert.match(toml, /budget = 20/);
  assert.match(toml, /tags = "label"/);
  assert.match(toml, /\[\[check\]\]/);
  assert.match(toml, /run = "\.\/verify\.sh"/);
  assert.ok(!init.starterToml('/tmp/my-project', null).includes('[[check]]'));
});

test('init: runInit writes, trusts and configures a fresh project', () => {
  const dir = makeDir('fresh-');
  fs.writeFileSync(path.join(dir, 'verify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const { code, out } = capture(() => init.runInit(['--dir', dir, '--json']));
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.crewCreated, true);
  assert.equal(result.trusted, true);
  assert.equal(result.checks[0].run, './verify.sh');
  assert.equal(result.checks[0].name, 'verify');

  const toml = fs.readFileSync(path.join(dir, '.roostr.toml'), 'utf8');
  assert.match(toml, new RegExp(`name = "${path.basename(dir)}"`));
  assert.match(toml, /budget = 20/);
  assert.match(toml, /\[\[check\]\]/);

  const trust = JSON.parse(fs.readFileSync(path.join(process.env.ROOSTR_STATE_DIR, 'trust.json'), 'utf8'));
  assert.ok(trust[path.join(dir, '.roostr.toml')]);

  assert.equal(result.config.created, true);
  assert.ok(fs.existsSync(process.env.ROOSTR_CONFIG));
  assert.ok(Array.isArray(result.config.tools));

  // A second run keeps the existing crew file.
  const second = capture(() => init.runInit(['--dir', dir, '--json']));
  assert.equal(JSON.parse(second.out).crewCreated, false);
});

test('init: runInit omits the check when none is detectable', () => {
  const dir = makeDir('nocheck-');
  const { code, out } = capture(() => init.runInit(['--dir', dir, '--json']));
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.checks.length, 0);
  const toml = fs.readFileSync(path.join(dir, '.roostr.toml'), 'utf8');
  assert.ok(!toml.includes('[[check]]'));
});

test('init: runInit rejects a missing directory', () => {
  const missing = path.join(tmpRoot, 'does-not-exist');
  const { code } = capture(() => init.runInit(['--dir', missing]));
  assert.equal(code, 1);
});
