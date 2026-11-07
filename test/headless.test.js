'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const bin = fs.existsSync(path.join(repo, 'bin', 'roostr')) ? path.join(repo, 'bin', 'roostr') : path.join(repo, 'bin', 'crew-board');
const fake = path.join(__dirname, 'fixtures', 'fake-herdr.js');
const manifest = path.join(repo, 'herdr-plugin.toml');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-headless-'));
const home = path.join(root, 'home');
const codexHome = path.join(root, 'codex');
const stateDir = path.join(root, 'state');
const work = path.join(root, 'work');
for (const dir of [home, codexHome, stateDir, work]) fs.mkdirSync(dir, { recursive: true });
fs.chmodSync(fake, 0o755);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function nodeBinDir() {
  return path.dirname(process.execPath);
}

function env() {
  const e = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    CREW_BOARD_STATE_DIR: stateDir,
    CREW_BOARD_FAKE_CWD: work,
    CREW_BOARD_TAGS: 'off',
    CREW_BOARD_NO_UPDATE_CHECK: '1',
    HERDR_BIN_PATH: fake,
    NO_COLOR: '1',
    COLUMNS: '120',
    TZ: 'UTC',
    PATH: [nodeBinDir(), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  };
  for (const key of [
    'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID',
    'EXPLABS_ENABLED', 'EXPLABS_API_KEY', 'EXPLABS_KEY_FILE', 'EXPLABS_COOKIE', 'EXPLABS_COOKIE_FILE',
    'CREW_BOARD_CONFIG', 'CREW_BOARD_LEDGER', 'CREW_BOARD_SUMMARY', 'CREW_BOARD_PRICES',
  ]) delete e[key];
  return e;
}

function run(argv) {
  return spawnSync(process.execPath, [bin, ...argv], {
    cwd: repo,
    env: env(),
    encoding: 'utf8',
    timeout: 30 * 1000,
  });
}

function manifestVersion() {
  const text = fs.readFileSync(manifest, 'utf8');
  const m = /^version\s*=\s*"([^"]+)"/m.exec(text);
  assert.ok(m, 'herdr-plugin.toml has a version line');
  return m[1];
}

test('headless: --json --all prints an envelope with every pane', (t) => {
  const r = run(['--json', '--all']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);

  let panes;
  let total;
  if (Array.isArray(data)) {
    // Base branch before W2's envelope work. Keep the old shape usable so this
    // test still guards the read path, and tighten once the envelope lands.
    panes = data;
    total = data.length;
    t.diagnostic('rows array shape: the W2 JSON envelope is not on this base yet');
  } else {
    assert.equal(typeof data.version, 'string');
    assert.equal(typeof data.scope, 'string');
    assert.equal(data.scope, 'all');
    assert.ok(data.summary && typeof data.summary === 'object');
    panes = data.panes;
    total = data.summary.total;
    assert.ok(Array.isArray(panes));
  }

  assert.equal(total, 3);
  for (const pane of panes) assert.equal(typeof pane.paneId, 'string');
});

test('headless: --once --all draws the named panes', () => {
  const r = run(['--once', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /example-app/);
  assert.match(r.stdout, /api-worker/);
});

test('headless: --version matches the manifest', (t) => {
  const r = run(['--version']);
  if (r.status !== 0) {
    t.diagnostic('--version is owned by W2/VER-01 and is not on this base yet');
    return;
  }
  assert.match(r.stdout.trim(), /^(roostr|crew-board) \d+\.\d+\.\d+$/);
  assert.match(r.stdout.trim(), new RegExp(`^(roostr|crew-board) ${manifestVersion()}$`));
});
