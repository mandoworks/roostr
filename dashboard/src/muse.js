'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELAY_TIMEOUT_MS = 5000;
const AGENT_SLUG_RE = /^[a-z0-9-]{1,32}$/;

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readNamesDoc(namesStore) {
  if (!namesStore) {
    return { overrides: {}, orchestrators: [] };
  }
  try {
    if (typeof namesStore.load === 'function') {
      const doc = namesStore.load();
      if (doc && typeof doc === 'object') return doc;
    }
    if (typeof namesStore.snapshot === 'function') {
      const snap = namesStore.snapshot();
      if (snap && snap.names && typeof snap.names === 'object') return snap.names;
    }
  } catch {
    // ignore
  }
  return { overrides: {}, orchestrators: [] };
}

function normalizeMuseState(statusRec, workerRec, tier1Rec) {
  if (statusRec && typeof statusRec.state === 'string' && statusRec.state.trim()) {
    return statusRec.state.trim();
  }
  if (workerRec && typeof workerRec.state === 'string' && workerRec.state.trim()) {
    return workerRec.state.trim();
  }
  if (tier1Rec) {
    if (typeof tier1Rec.cls === 'string' && tier1Rec.cls.trim()) {
      return tier1Rec.cls.trim();
    }
    if (typeof tier1Rec.status === 'string' && tier1Rec.status.trim()) {
      return tier1Rec.status.trim();
    }
  }
  return 'idle';
}

function normalizeAgent({
  slug,
  sourceName,
  emoji,
  role,
  tier1Rec,
  workerRec,
  statusRec,
  romanDesk,
  namesDoc,
}) {
  const overrides = (namesDoc && namesDoc.overrides) || {};
  const orchestrators = new Set(
    Array.isArray(namesDoc && namesDoc.orchestrators) ? namesDoc.orchestrators : []
  );
  const overrideRec = overrides[slug];
  const overrideName = overrideRec && typeof overrideRec.name === 'string' && overrideRec.name.trim()
    ? overrideRec.name.trim()
    : null;
  const resolvedSourceName = sourceName || slug;
  const name = overrideName || resolvedSourceName;
  const isOrchestrator = slug === 'roman' || orchestrators.has(slug);

  let tokensToday = null;
  if (tier1Rec && Number.isFinite(tier1Rec.tokens_today)) {
    tokensToday = tier1Rec.tokens_today;
  } else if (workerRec && Number.isFinite(workerRec.tokens)) {
    tokensToday = workerRec.tokens;
  } else if (romanDesk && (Number.isFinite(romanDesk.tokens_in_today) || Number.isFinite(romanDesk.tokens_out_today))) {
    tokensToday = (romanDesk.tokens_in_today || 0) + (romanDesk.tokens_out_today || 0);
  }

  const lastActivityAst = (statusRec && typeof statusRec.at_ast === 'string' && statusRec.at_ast)
    || (tier1Rec && typeof tier1Rec.last_activity_ast === 'string' && tier1Rec.last_activity_ast)
    || (tier1Rec && typeof tier1Rec.last_update === 'string' && tier1Rec.last_update)
    || (romanDesk && typeof romanDesk.last_activity_ast === 'string' && romanDesk.last_activity_ast)
    || null;

  return {
    slug,
    name,
    sourceName: resolvedSourceName,
    overrideName,
    isOrchestrator,
    emoji: emoji || (tier1Rec && tier1Rec.emoji) || null,
    role: role || (tier1Rec && tier1Rec.role) || null,
    state: normalizeMuseState(statusRec, workerRec, tier1Rec),
    currentTask: (statusRec && typeof statusRec.label === 'string' && statusRec.label)
      || (workerRec && typeof workerRec.task === 'string' && workerRec.task)
      || (tier1Rec && typeof tier1Rec.current_task === 'string' && tier1Rec.current_task)
      || (romanDesk && typeof romanDesk.report_line === 'string' && romanDesk.report_line)
      || null,
    nextTask: (tier1Rec && typeof tier1Rec.next_task === 'string' && tier1Rec.next_task) || null,
    blocker: (tier1Rec && typeof tier1Rec.blocker === 'string' && tier1Rec.blocker) || null,
    session: (workerRec && typeof workerRec.session === 'string' && workerRec.session)
      || (romanDesk && typeof romanDesk.chat_id === 'string' && romanDesk.chat_id)
      || null,
    model: (workerRec && typeof workerRec.model === 'string' && workerRec.model) || null,
    tokensToday,
    lastActivityAst,
    tasks: tier1Rec && Array.isArray(tier1Rec.tasks) ? tier1Rec.tasks : [],
    docs: tier1Rec && Array.isArray(tier1Rec.docs) ? tier1Rec.docs : [],
    bank: (tier1Rec && typeof tier1Rec.bank === 'string' && tier1Rec.bank) || null,
  };
}

function getMuseSnapshot({ staticDir, statusPath, namesStore } = {}) {
  const dataDoc = staticDir ? readJsonSafe(path.join(staticDir, 'data.json')) : null;
  const workersDoc = staticDir ? readJsonSafe(path.join(staticDir, 'workers', 'workers.muse.json')) : null;
  const statusDoc = statusPath ? readJsonSafe(statusPath) : null;
  const namesDoc = readNamesDoc(namesStore);

  const romanDesk = (dataDoc && dataDoc.roman_desk && typeof dataDoc.roman_desk === 'object')
    ? dataDoc.roman_desk
    : null;
  const tier1 = dataDoc && Array.isArray(dataDoc.tier1) ? dataDoc.tier1 : [];
  const tier2 = dataDoc && Array.isArray(dataDoc.tier2) ? dataDoc.tier2 : [];

  const workersList = workersDoc && Array.isArray(workersDoc.workers) ? workersDoc.workers : [];
  const workerBySlug = new Map();
  for (const w of workersList) {
    if (!w || typeof w !== 'object') continue;
    const slug = typeof w.agent === 'string' ? w.agent.trim() : '';
    if (slug) workerBySlug.set(slug, w);
  }

  const statusAgents = (statusDoc && statusDoc.agents && typeof statusDoc.agents === 'object')
    ? statusDoc.agents
    : {};

  const agents = [];
  const seen = new Set();

  if (romanDesk || workerBySlug.has('roman') || statusAgents.roman) {
    seen.add('roman');
    const workerRec = workerBySlug.get('roman') || null;
    agents.push(normalizeAgent({
      slug: 'roman',
      sourceName: (workerRec && workerRec.name) || 'Roman',
      emoji: null,
      role: (romanDesk && romanDesk.chat_title) || 'Orchestrator',
      tier1Rec: null,
      workerRec,
      statusRec: statusAgents.roman || null,
      romanDesk,
      namesDoc,
    }));
  }

  for (const rec of tier1) {
    if (!rec || typeof rec !== 'object') continue;
    const slug = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    agents.push(normalizeAgent({
      slug,
      sourceName: typeof rec.name === 'string' ? rec.name.trim() : slug,
      emoji: rec.emoji || null,
      role: rec.role || null,
      tier1Rec: rec,
      workerRec: workerBySlug.get(slug) || null,
      statusRec: statusAgents[slug] || null,
      romanDesk: null,
      namesDoc,
    }));
  }

  for (const [slug, workerRec] of workerBySlug.entries()) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    agents.push(normalizeAgent({
      slug,
      sourceName: (workerRec && typeof workerRec.name === 'string' && workerRec.name.trim()) || slug,
      emoji: null,
      role: null,
      tier1Rec: null,
      workerRec,
      statusRec: statusAgents[slug] || null,
      romanDesk: null,
      namesDoc,
    }));
  }

  const generatedEpoch = (dataDoc && Number.isFinite(dataDoc.generated_epoch) && dataDoc.generated_epoch)
    || (statusDoc && Number.isFinite(statusDoc.generated_epoch) && statusDoc.generated_epoch)
    || (workersDoc && Number.isFinite(workersDoc.generated_epoch) && workersDoc.generated_epoch)
    || null;

  const stampAst = (dataDoc && typeof dataDoc.stamp_ast === 'string' && dataDoc.stamp_ast)
    || (statusDoc && typeof statusDoc.stamp_ast === 'string' && statusDoc.stamp_ast)
    || null;

  return {
    romanDesk,
    agents,
    tier2,
    generatedEpoch,
    stampAst,
  };
}

async function sendPioRelayMessage({
  piorelayBase = 'http://100.97.196.10:3016/api/v1',
  from = 'pio',
  to,
  subject,
  body,
  project = 'muse',
  threadId = null,
  fetchImpl = null,
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, status: 502, error: 'fetch unavailable' };
  }

  const base = String(piorelayBase || '').replace(/\/+$/, '');
  const url = `${base}/agent-messages`;
  const clientMsgId = crypto.randomUUID();

  const payload = {
    from_agent: from,
    to_agent: to,
    subject,
    body,
    thread_id: threadId || null,
    client_msg_id: clientMsgId,
    project: project || 'muse',
    kind: 'task',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!response.ok) {
      const errMsg = (parsed && parsed.error) || `piorelay returned HTTP ${response.status}`;
      return { ok: false, status: 502, error: errMsg };
    }

    return { ok: true, result: parsed || { ok: true, client_msg_id: clientMsgId } };
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? 'piorelay request timed out'
      : ((err && err.message) || 'piorelay request failed');
    return { ok: false, status: 502, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRelayMessage(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    id: m.id ?? m.msg_id ?? m.client_msg_id ?? null,
    from: m.from ?? m.from_agent ?? null,
    to: m.to ?? m.to_agent ?? null,
    subject: typeof m.subject === 'string' ? m.subject : '',
    body: typeof m.body === 'string' ? m.body : (typeof m.text === 'string' ? m.text : ''),
    project: m.project ?? null,
    threadId: m.threadId ?? m.thread_id ?? null,
    createdAt: m.createdAt ?? m.created_at ?? m.timestamp ?? null,
    read: Boolean(m.read ?? m.is_read ?? m.read_at),
  };
}

async function fetchPioRelayMessages({
  piorelayBase = 'http://100.97.196.10:3016/api/v1',
  agent = null,
  project = null,
  limit = 20,
  fetchImpl = null,
} = {}) {
  let agentSlug = null;
  if (agent !== undefined && agent !== null && agent !== '') {
    if (typeof agent !== 'string' || !AGENT_SLUG_RE.test(agent)) {
      return { ok: false, status: 400, error: 'invalid agent' };
    }
    agentSlug = agent;
  }

  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, status: 502, error: 'fetch unavailable' };
  }

  const parsedLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(50, Math.trunc(Number(limit))))
    : 20;

  const base = String(piorelayBase || '').replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (agentSlug) {
    params.set('agent', agentSlug);
  }
  params.set('limit', String(parsedLimit));
  if (typeof project === 'string' && project.trim()) {
    params.set('project', project.trim());
  }
  const url = `${base}/agent-messages?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const errMsg = (parsed && parsed.error) || `piorelay returned HTTP ${response.status}`;
      return { ok: false, status: 502, error: errMsg };
    }

    let rawList = [];
    if (Array.isArray(parsed)) {
      rawList = parsed;
    } else if (parsed && Array.isArray(parsed.messages)) {
      rawList = parsed.messages;
    } else if (parsed && Array.isArray(parsed.items)) {
      rawList = parsed.items;
    }

    const messages = rawList.map(normalizeRelayMessage).filter(Boolean);
    return {
      ok: true,
      agent: agentSlug,
      messages,
    };
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? 'piorelay request timed out'
      : ((err && err.message) || 'piorelay request failed');
    return { ok: false, status: 502, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  RELAY_TIMEOUT_MS,
  getMuseSnapshot,
  sendPioRelayMessage,
  fetchPioRelayMessages,
};
