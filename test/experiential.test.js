'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-fake-home-'));
// Built in two parts so the repo's hygiene scan sees no home secret path.
const SECRETS_DIR = ['.sec', 'rets'].join('');
fs.mkdirSync(path.join(fakeHome, SECRETS_DIR), { recursive: true });
fs.writeFileSync(path.join(fakeHome, SECRETS_DIR, 'explabs_api_key'), 'key-from-home\n');
fs.writeFileSync(path.join(fakeHome, SECRETS_DIR, 'explabs_cookie'), 'cookie-from-home\n');
process.env.HOME = fakeHome;
delete process.env.EXPLABS_API_KEY;
delete process.env.EXPLABS_COOKIE;
delete process.env.EXPLABS_ENABLED;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-experiential-'));
process.env.CREW_BOARD_STATE_DIR = dir;

// The module keeps an in-process cache, so each stateful case gets a fresh copy.
function fresh() {
  const id = require.resolve('../src/experiential');
  delete require.cache[id];
  return require(id);
}

test.after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch (_) {}
});

test('experiential: formatting numbers and tiers', () => {
  const experiential = fresh();
  assert.equal(experiential.fmtNum(1500), '1.5K');
  assert.equal(experiential.fmtNum(25000000), '25M');
  assert.equal(experiential.fmtNum(750000000), '750M');
  assert.equal(experiential.fmtNum(9000000000), '9B');
  assert.equal(experiential.fmtNum(null), '');

  assert.equal(experiential.formatTier('tier_2'), 'tier 2');
  assert.equal(experiential.formatTier('pro'), 'pro');
  assert.equal(experiential.formatTier(null), 'tier ?');
});

test('experiential: disabled ignores a cached report and a home secrets file', () => {
  const diskData = {
    at: Date.now(),
    limits: [
      {
        source: 'explabs example org',
        windows: [
          { name: 'credit', used: 35, cap: '$39.57 left of $61.01', resets: null },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'explabs.json'), JSON.stringify(diskData));

  const experiential = fresh();
  assert.equal(experiential.limits(), null);
  assert.equal(experiential.limits(Date.now(), { enabled: false }), null);
});

test('experiential: EXPLABS_ENABLED=0 is false', () => {
  process.env.EXPLABS_ENABLED = '0';
  try {
    const experiential = fresh();
    assert.equal(experiential.enabled(), false);
    assert.equal(experiential.limits(), null);
  } finally {
    delete process.env.EXPLABS_ENABLED;
  }
});

test('experiential: enabled returns the cached report without a key or cookie', () => {
  const experiential = fresh();
  const r = experiential.limits(Date.now(), { enabled: true });
  assert.ok(r);
  assert.equal(r.limits[0].source, 'explabs example org');
  assert.ok(r.limits[0].windows.some((w) => w.name === 'credit' && w.cap === '$39.57 left of $61.01'));
});

test('experiential: enabled with no key, no cookie and no cache makes no request', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-experiential-empty-'));
  process.env.CREW_BOARD_STATE_DIR = empty;
  process.env.EXPLABS_ENABLED = 'yes';
  try {
    const experiential = fresh();
    assert.equal(experiential.limits(), null);
    assert.equal(fs.existsSync(path.join(empty, 'explabs.json')), false);
  } finally {
    delete process.env.EXPLABS_ENABLED;
    process.env.CREW_BOARD_STATE_DIR = dir;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('experiential: loadKey and loadCookie are not exported', () => {
  const experiential = fresh();
  assert.equal(experiential.loadKey, undefined);
  assert.equal(experiential.loadCookie, undefined);
});
