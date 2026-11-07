'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const load = () => import(path.join(__dirname, '..', 'integrations', 'opencode', 'crew-board.mjs'));
const fresh = () => ({ session: null, task: null, model: null, tokens: 0, costs: {}, last: null });

test('opencode plugin: session title is the task, replies give model, context tokens, and cost', async () => {
  const step = (await load()).default.step;
  const s = fresh();
  assert.equal(step(s, { type: 'session.updated', properties: { info: { id: 's1', title: 'New session - 2026-10-22T18:00:00Z' } } }), null);
  assert.deepEqual(step(s, { type: 'session.updated', properties: { info: { id: 's1', title: 'Fix the login bug' } } }), ['--task', 'Fix the login bug', '--task-source', 'agent', '--session', 's1']);
  // A reply still streaming is skipped; a finished one reports.
  assert.equal(step(s, { type: 'message.updated', properties: { info: { id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 1 } } } }), null);
  const done = (id, cost) => ({
    type: 'message.updated',
    properties: { info: { id, sessionID: 's1', role: 'assistant', time: { created: 1, completed: 2 }, modelID: 'example-model', cost, tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 0 } } } },
  });
  assert.deepEqual(step(s, done('m1', 0.5)), ['--task', 'Fix the login bug', '--task-source', 'agent', '--session', 's1', '--model', 'example-model', '--tokens', '6200', '--cost', '0.5']);
  assert.deepEqual(step(s, done('m2', 0.25)), ['--task', 'Fix the login bug', '--task-source', 'agent', '--session', 's1', '--model', 'example-model', '--tokens', '6200', '--cost', '0.75']);
  // The same message again changes nothing, so nothing is sent.
  assert.equal(step(s, done('m2', 0.25)), null);
  // Subagent sessions and other sessions do not move the pane's task.
  assert.equal(step(s, { type: 'session.updated', properties: { info: { id: 's2', parentID: 's1', title: 'Explore the repo' } } }), null);
  assert.equal(step(s, { type: 'message.updated', properties: { info: { id: 'x', sessionID: 's9', role: 'assistant', time: { completed: 2 } } } }), null);
  assert.equal(step(s, { type: 'file.edited', properties: {} }), null);
});

test('opencode plugin: the file exports only the plugin (opencode runs every export)', async () => {
  const mod = await load();
  assert.deepEqual(Object.keys(mod), ['default']);
});

test('opencode plugin: does nothing outside Herdr', async () => {
  const CrewBoardPlugin = (await load()).default;
  const saved = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;
  try {
    assert.deepEqual(await CrewBoardPlugin(), {});
  } finally {
    if (saved !== undefined) process.env.HERDR_PANE_ID = saved;
  }
});
