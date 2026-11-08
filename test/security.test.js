'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crewfile = require('../src/crewfile');
const report = require('../src/report');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-security-'));

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('verifySafePath: allows normal files within workspace directory', () => {
  const ws = path.join(tmpRoot, 'safe-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const target = path.join(ws, '.herdr', 'crew.json');
  assert.equal(crewfile.verifySafePath(target, ws), true);
});

test('verifySafePath: rejects relative path escaping workspace directory', () => {
  const ws = path.join(tmpRoot, 'escape-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const target = path.join(ws, '..', 'escaped.json');
  assert.throws(() => {
    crewfile.verifySafePath(target, ws);
  }, /escapes base directory/);
});

test('verifySafePath: rejects symlink pointing outside workspace root', () => {
  const ws = path.join(tmpRoot, 'symlink-workspace');
  const outsideDir = path.join(tmpRoot, 'outside-target');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const linkDir = path.join(ws, '.herdr');
  fs.symlinkSync(outsideDir, linkDir, 'dir');

  const target = path.join(linkDir, 'crew.json');
  assert.throws(() => {
    crewfile.verifySafePath(target, ws);
  }, /escapes base directory/);
});

test('writeCrewJson: writes crew.json securely and rejects symlinked directory escape', () => {
  const ws = path.join(tmpRoot, 'write-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const written = crewfile.writeCrewJson(ws, { name: 'safe-crew' });
  assert.ok(fs.existsSync(written));
  const data = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(data.name, 'safe-crew');

  const escapeWs = path.join(tmpRoot, 'write-escape-ws');
  const evilDir = path.join(tmpRoot, 'evil-dir');
  fs.mkdirSync(escapeWs, { recursive: true });
  fs.mkdirSync(evilDir, { recursive: true });
  fs.symlinkSync(evilDir, path.join(escapeWs, '.herdr'), 'dir');

  assert.throws(() => {
    crewfile.writeCrewJson(escapeWs, { name: 'evil-crew' });
  }, /escapes base directory/);
});

test('verifyReportPath: permits paths in state directory and rejects outside escapes', () => {
  const stateDir = path.join(tmpRoot, 'state-dir');
  fs.mkdirSync(stateDir, { recursive: true });

  const safeFile = path.join(stateDir, 'w1_p1.json');
  assert.equal(report.verifyReportPath(safeFile, stateDir), true);

  const outsideFile = path.join(tmpRoot, 'other', 'w1_p1.json');
  assert.throws(() => {
    report.verifyReportPath(outsideFile, stateDir);
  }, /symlink or path escape outside allowed root/);

  const symlinkState = path.join(tmpRoot, 'sym-state-dir');
  const outsideEscape = path.join(tmpRoot, 'outside-escape');
  fs.mkdirSync(symlinkState, { recursive: true });
  fs.mkdirSync(outsideEscape, { recursive: true });
  const symlinkChild = path.join(symlinkState, 'sub');
  fs.symlinkSync(outsideEscape, symlinkChild, 'dir');

  assert.throws(() => {
    report.verifyReportPath(path.join(symlinkChild, 'pane.json'), symlinkState);
  }, /symlink or path escape outside allowed root/);
});
