// crew-board plugin for opencode and kilo (same plugin API).
//
// Inside a Herdr pane it reports the session title as the task line, plus the
// model, context tokens, and session cost, with `crew-board report`. Outside
// Herdr it does nothing. crew-board must be on PATH (or set CREW_BOARD_BIN).
//
//   opencode: "plugin": ["/path/to/crew-board/integrations/opencode/crew-board.mjs"]
//   kilo:     "plugin": ["file:///path/to/crew-board/integrations/opencode/crew-board.mjs"]

import { execFile } from 'node:child_process';

const MIN_GAP_MS = 2000;
// Titles opencode and kilo give a session before they name it.
const DEFAULT_TITLE = /^(new session|child session)\b/i;

// Pure: fold one event into the per pane state; returns the report flags to
// send, or null when nothing changed. Not exported on its own: opencode calls
// every exported function of a plugin file as a plugin.
function step(state, event) {
  const info = event && event.properties && event.properties.info;
  if (!info) return null;
  if (event.type === 'session.updated' || event.type === 'session.created') {
    if (info.parentID) return null; // a subagent's session, not the pane's task
    state.session = info.id;
    if (!info.title || DEFAULT_TITLE.test(info.title)) return null;
    state.task = info.title;
  } else if (event.type === 'message.updated') {
    if (info.role !== 'assistant' || !info.time || !info.time.completed) return null;
    if (state.session && info.sessionID !== state.session) return null;
    state.session = info.sessionID;
    const t = info.tokens || {};
    const cache = t.cache || {};
    state.costs[info.id] = Number(info.cost) || 0;
    state.model = info.modelID || state.model;
    // The prompt plus the reply is what the context holds after this turn.
    state.tokens = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (cache.read || 0) + (cache.write || 0);
  } else {
    return null;
  }
  const cost = Object.values(state.costs).reduce((a, b) => a + b, 0);
  const args = [];
  if (state.task) args.push('--task', state.task, '--task-source', 'agent');
  if (state.session) args.push('--session', state.session);
  if (state.model) args.push('--model', state.model);
  if (state.tokens) args.push('--tokens', String(state.tokens));
  if (Object.keys(state.costs).length) args.push('--cost', String(cost));
  const key = args.join('\u0000');
  if (!args.length || key === state.last) return null;
  state.last = key;
  return args;
}

const CrewBoardPlugin = async () => {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return {};
  const bin = process.env.CREW_BOARD_BIN || 'crew-board';
  const state = { session: null, task: null, model: null, tokens: 0, costs: {}, last: null };
  let pending = null;
  let timer = null;
  let lastSent = 0;
  const send = () => {
    timer = null;
    lastSent = Date.now();
    const args = pending;
    pending = null;
    execFile(bin, ['report', '--pane', pane, ...args], { timeout: 5000 }, () => {});
  };
  return {
    event: async ({ event } = {}) => {
      const args = step(state, event);
      if (!args) return;
      pending = args;
      if (!timer) timer = setTimeout(send, Math.max(0, MIN_GAP_MS - (Date.now() - lastSent)));
    },
  };
};

CrewBoardPlugin.step = step; // for tests
export default CrewBoardPlugin;
