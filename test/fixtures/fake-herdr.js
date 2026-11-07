#!/usr/bin/env node
'use strict';
// A tiny stand in for the Herdr CLI. It answers only the read calls the board
// makes while it builds a frame or prints JSON, so test/headless.test.js can
// run on a machine with no Herdr installed.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0] || '';
const sub = args[1] || '';

function out(value) {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
}

function snapshot() {
  const file = path.join(__dirname, 'headless-snapshot.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cwd = process.env.CREW_BOARD_FAKE_CWD;
  if (cwd) {
    for (const p of data.panes) if (p && typeof p.cwd === 'string') p.cwd = cwd;
    for (const a of data.agents) if (a && typeof a.cwd === 'string') a.cwd = cwd;
  }
  return data;
}

const footer = [
  'Example session output',
  '─'.repeat(32),
  '$1.25 | ctx:37% | in:1000 out:234',
  '',
].join('\n');

if (command === 'api' && sub === 'snapshot') {
  out({ result: { snapshot: snapshot() } });
} else if (command === 'pane' && sub === 'read') {
  out(footer);
} else if (command === 'pane' && sub === 'process-info') {
  out({ result: { process_info: { shell_pid: process.pid } } });
} else if (command === 'pane' && sub === 'list') {
  out({ result: { panes: [] } });
} else if (command === 'pane' && sub === 'report-metadata') {
  out({ result: {} });
} else if (command === 'agent' && sub === 'list') {
  out({ result: { agents: [] } });
} else if (command === 'plugin' && sub === 'list') {
  out({ result: { plugins: [] } });
} else {
  out({});
}

process.exitCode = 0;
