'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const skillFile = fs.existsSync(path.join(root, 'skills', 'roostr', 'SKILL.md'))
  ? path.join(root, 'skills', 'roostr', 'SKILL.md')
  : path.join(root, 'skills', 'crew-board', 'SKILL.md');
const text = fs.readFileSync(skillFile, 'utf8');

// Every `--flag` that follows `marker` on the same code span or line.
function flagsAfter(marker) {
  const out = new Set();
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) break;
    let rest = text.slice(at + marker.length);
    const stop = rest.search(/[`\n]/);
    if (stop !== -1) rest = rest.slice(0, stop);
    for (const m of rest.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)) out.add(m[1]);
    from = at + marker.length;
  }
  return out;
}

// `roostr` or `crew-board` on its own, not subcommands.
const boardFlags = new Set();
for (const m of text.matchAll(/(?:roostr|crew-board)(?![\w-])/g)) {
  const after = text.slice(m.index + m[0].length);
  if (/^\s+[a-z][a-z0-9-]*\b/.test(after)) continue;
  let rest = after;
  const stop = rest.search(/[`\n]/);
  if (stop !== -1) rest = rest.slice(0, stop);
  for (const f of rest.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)) boardFlags.add(f[1]);
}

function reportFlags() {
  const src = fs.readFileSync(path.join(root, 'src', 'report.js'), 'utf8');
  const block = /const FIELDS = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'FIELDS block in src/report.js');
  const flags = new Set([...block[1].matchAll(/'(--[a-z]+)':/g)].map((m) => m[1]));
  for (const f of ['--pane', '--from', '-h', '--help']) flags.add(f);
  return flags;
}

test('the skill has front matter with a name and a description', () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, 'front matter');
  assert.match(fm[1], /^name:\s*(roostr|crew-board)\s*$/m);
  const desc = /^description:\s*(.+)$/m.exec(fm[1]);
  assert.ok(desc, 'description');
  assert.ok(desc[1].trim().length > 20, 'description says when to use it');
});

test('every report flag in the skill is a real report flag', () => {
  const used = new Set([...flagsAfter('roostr report'), ...flagsAfter('crew-board report')]);
  assert.ok(used.size > 0, 'the skill shows report commands');
  const allowed = reportFlags();
  for (const flag of used) assert.ok(allowed.has(flag), `unknown report flag ${flag}`);
  for (const flag of ['--pane', '--task']) assert.ok(used.has(flag), `the skill uses ${flag}`);
});

test('every board flag in the skill is in --help', () => {
  const bin = fs.existsSync(path.join(root, 'bin', 'roostr'))
    ? path.join(root, 'bin', 'roostr')
    : path.join(root, 'bin', 'crew-board');
  const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  const known = new Set([...help.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
  assert.ok(boardFlags.size > 0, 'the skill shows a board command');
  for (const flag of boardFlags) assert.ok(known.has(flag), `unknown board flag ${flag}`);
  for (const flag of ['--json', '--all']) assert.ok(boardFlags.has(flag), `the skill uses ${flag}`);
});
