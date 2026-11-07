'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-herdr-'));
const fake = path.join(dir, 'herdr');
const payload = {
  result: {
    snapshot: {
      agents: [
        { pane_id: 'w1:p1', workspace_id: 'w1', agent: 5, cwd: 7, terminal_id: 9 },
        null,
        { pane_id: 9 },
        { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', cwd: '/tmp', terminal_id: 4 },
      ],
      panes: [
        { pane_id: 'w1:p1', cwd: false, label: 3 },
        { pane_id: 3 },
        'not a pane',
      ],
      workspaces: [
        { workspace_id: 'w1', label: 'app' },
        { label: 'no id' },
      ],
    },
  },
};
fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
fs.chmodSync(fake, 0o700);

const herdr = require('../src/herdr');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('snapshot: drops malformed entries and coerces unsafe fields', async () => {
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = fake;
  try {
    const s = await herdr.snapshot();
    assert.deepEqual(s.agents, [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: '', cwd: null, terminal_id: null },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', cwd: '/tmp', terminal_id: null },
    ]);
    assert.deepEqual(s.panes, [{ pane_id: 'w1:p1', cwd: null, label: null, terminal_id: null }]);
    assert.deepEqual(s.workspaces, [{ workspace_id: 'w1', label: 'app' }]);
  } finally {
    if (saved === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = saved;
  }
});

test('run: a missing herdr binary names the real problem', async () => {
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = path.join(dir, 'missing-herdr');
  try {
    await assert.rejects(herdr.snapshot(), /herdr not found on PATH \(crew-board runs inside Herdr\)/);
  } finally {
    if (saved === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = saved;
  }
});

test('renameAgent and startAgent pass their argv as separate entries', async () => {
  const record = path.join(dir, 'record.json');
  const recorder = path.join(dir, 'recorder');
  fs.writeFileSync(recorder, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('{"result":{}}');\n`);
  fs.chmodSync(recorder, 0o700);
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = recorder;
  try {
    await herdr.renameAgent('w1:p1', 'la-jefa-x');
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), ['agent', 'rename', 'w1:p1', 'la-jefa-x']);
    await herdr.startAgent('la-jefa-x', 'opencode', 'w1:p1', ['--verbose', '--model', 'fast-x']);
    const argv = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.deepEqual(argv, ['agent', 'start', 'la-jefa-x', '--kind', 'opencode', '--pane', 'w1:p1', '--', '--verbose', '--model', 'fast-x']);
    assert.ok(!argv.includes('--variant'));
  } finally {
    if (saved === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = saved;
  }
});
