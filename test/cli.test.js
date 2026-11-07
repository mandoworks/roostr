'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'crew-board');

test('help: the command list ends on the page, no truncation', () => {
  const r = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /crew-board sessions \[--json\]/);
  assert.match(r.stdout, /crew-board restore \[--workspace <id\|label\|here\|all>\] \[--yes\] \[--dry-run\]/);
  assert.match(r.stdout.trimEnd(), /-h, --help +this help$/);
});

test('version: --version and -v print the manifest version and exit 0', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'herdr-plugin.toml'), 'utf8');
  const m = /^version\s*=\s*"([^"]+)"/m.exec(manifest);
  assert.ok(m, 'manifest has a version');
  for (const args of [['--version'], ['-v'], ['board', '--version'], ['--version', 'extra']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, /^crew-board \d+\.\d+\.\d+\n$/);
    assert.equal(r.stdout.trim(), `crew-board ${m[1]}`);
  }
});

test('name: draws lowercase worker names and rejects a bad language', () => {
  const ok = spawnSync(process.execPath, [bin, 'name', '--language', 'en', '--count', '3'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  for (const n of lines) assert.match(n, /^[a-z]+(?:-\d+)?$/);
  const bad = spawnSync(process.execPath, [bin, 'name', '--language', 'de'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown language/);
});

test('spawn, outcome and summary dispatch to the ledger and the summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-cli-'));
  const env = {
    ...process.env,
    CREW_BOARD_LEDGER: path.join(dir, 'ledger.jsonl'),
    CREW_BOARD_SUMMARY: path.join(dir, 'summary.json'),
  };
  try {
    const s = spawnSync(process.execPath, [bin, 'spawn', '--pane', 'w1:p2', '--task', 'fix the login timeout'], { env, encoding: 'utf8' });
    assert.equal(s.status, 0, s.stderr);
    const run = /run:\s+([A-Za-z0-9-]+)/.exec(s.stdout);
    assert.ok(run, s.stdout);
    const o = spawnSync(process.execPath, [bin, 'outcome', '--run', run[1], '--result', 'pass'], { env, encoding: 'utf8' });
    assert.equal(o.status, 0, o.stderr);
    const sum = spawnSync(process.execPath, [bin, 'summary', '--json', '--no-write'], { env, encoding: 'utf8' });
    assert.equal(sum.status, 0, sum.stderr);
    const data = JSON.parse(sum.stdout);
    assert.equal(data.runs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
