'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const templates = require('../src/templates');

const bin = path.join(__dirname, '..', 'bin', 'crew-board');

test('templates: every role renders with its placeholders filled', () => {
  for (const role of templates.ROLES) {
    const out = templates.render(role, { name: 'api', plan: 'docs/plan.md', package: 'api' });
    assert.match(out, new RegExp(`Role: ${role}`));
    assert.match(out, /Agent name: api/);
    assert.match(out, /Plan file: docs\/plan\.md/);
    assert.match(out, /Work package: api/);
    assert.doesNotMatch(out, /\{\{[A-Z]+\}\}/, `${role} has an unfilled placeholder`);
  }
});

test('templates: missing values keep the template defaults', () => {
  const out = templates.render('worker');
  assert.match(out, /Role: worker/);
  assert.match(out, /Agent name: worker/);
  assert.match(out, /Plan file: docs\/orchestration-plan\.md/);
  assert.match(out, /Work package: \(unassigned\)/);
});

test('templates: an unknown role or a traversal role is rejected', () => {
  assert.throws(() => templates.render('nope'), /role must be one of/);
  assert.throws(() => templates.render('../head-honcho'), /role must be one of/);
  const p = templates.parseArgs(['nope']);
  assert.ok(p.error);
  assert.equal(templates.main(['nope']), 2);
});

test('templates: no template carries a private path, host or secret', () => {
  const forbidden = new RegExp(['arman' + 'do', 'punto' + 'pio', 'conta' + 'bo', 'tail' + 'net', '\\.sec' + 'rets/', '/Us' + 'ers/', '/ho' + 'me/[a-z]+/'].join('|'), 'i');
  for (const role of templates.ROLES) {
    assert.doesNotMatch(templates.load(role), forbidden, role);
  }
});

test('templates: the command prints a role and fails on a bad one', () => {
  const ok = spawnSync(process.execPath, [bin, 'template', 'head-honcho', '--name', 'lead-1', '--plan', 'docs/plan.md'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Agent name: lead-1/);
  assert.match(ok.stdout, /docs\/plan\.md/);
  const bad = spawnSync(process.execPath, [bin, 'template', 'ghost'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /role must be one of/);
});
