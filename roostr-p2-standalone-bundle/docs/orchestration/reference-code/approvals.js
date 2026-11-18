'use strict';
// Reference implementation for src/approvals.js (Zero external dependencies, Node >= 22)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const stateDir = require('../../state-dir');
const state = require('../../state');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_RISK_CLASSES = new Set(['routine', 'big-decision']);
const approvalBus = new EventEmitter();
approvalBus.setMaxListeners(100);

function approvalsFile() {
  return process.env.ROOSTR_APPROVALS_FILE || path.join(stateDir.resolveStateDir(), 'approvals.json');
}

function decisionsFile() {
  return process.env.ROOSTR_DECISIONS_FILE || path.join(stateDir.resolveStateDir(), 'decisions.jsonl');
}

function loadApprovals() {
  const data = state.readJson(approvalsFile());
  return (data && Array.isArray(data.approvals)) ? data.approvals : [];
}

function saveApprovals(approvals) {
  state.writeJson(approvalsFile(), { schema: 1, updatedAt: new Date().toISOString(), approvals });
}

function appendDecisionLog(entry) {
  const file = decisionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

function expireStaleApprovals(now = Date.now()) {
  const list = loadApprovals();
  let changed = false;
  for (const item of list) {
    if (item.status === 'pending' && now >= Date.parse(item.expiresAt)) {
      item.status = 'denied-timeout';
      item.decidedAt = new Date(now).toISOString();
      item.decidedBy = 'system:ttl';
      item.decisionNote = 'Expired after TTL without approval';
      changed = true;
      appendDecisionLog({ event: 'decision', ...item });
      approvalBus.emit(`decided:${item.id}`, item);
    }
  }
  if (changed) saveApprovals(list);
  return list;
}

function createApproval(input, now = Date.now()) {
  const riskClass = input.riskClass || 'routine';
  if (!VALID_RISK_CLASSES.has(riskClass)) {
    throw new Error(`Invalid riskClass: ${riskClass} (expected routine or big-decision)`);
  }
  if (!input.agentId || !input.action) {
    throw new Error('agentId and action are required');
  }
  const ttlMs = Number(input.ttlMs) > 0 ? Number(input.ttlMs) : DEFAULT_TTL_MS;
  const item = {
    id: `apr_${now}_${crypto.randomBytes(3).toString('hex')}`,
    agentId: String(input.agentId),
    owner: String(input.owner || 'orchestrator'),
    host: String(input.host || 'ovh').toLowerCase(),
    action: String(input.action),
    command: Array.isArray(input.command) ? input.command.map(String) : [String(input.command || '')].filter(Boolean),
    cwd: String(input.cwd || process.cwd()),
    riskClass,
    context: input.context && typeof input.context === 'object' ? input.context : { summary: String(input.context || '') },
    status: 'pending',
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    grillSessionId: null
  };
  const list = expireStaleApprovals(now);
  list.push(item);
  saveApprovals(list);
  approvalBus.emit('created', item);
  return item;
}

function decideApproval({ id, decision, actor, authType, note, now = Date.now() }) {
  if (decision !== 'approved' && decision !== 'denied') {
    throw new Error('decision must be approved or denied');
  }
  const list = expireStaleApprovals(now);
  const item = list.find((a) => a.id === id);
  if (!item) {
    const err = new Error(`Approval not found: ${id}`);
    err.statusCode = 404;
    throw err;
  }
  if (item.status !== 'pending') {
    const err = new Error(`Approval ${id} is already ${item.status}`);
    err.statusCode = 409;
    throw err;
  }
  if (item.riskClass === 'big-decision' && authType !== 'passkey') {
    const err = new Error('big-decision approvals require human passkey authentication');
    err.statusCode = 403;
    throw err;
  }
  if (item.riskClass === 'routine' && authType !== 'passkey') {
    const normalizedActor = String(actor || '').toLowerCase();
    if (item.host !== 'ovh' || normalizedActor !== 'hermita') {
      const err = new Error('Token routine approval is restricted to hermita on host=ovh');
      err.statusCode = 403;
      throw err;
    }
  }
  item.status = decision;
  item.decidedAt = new Date(now).toISOString();
  item.decidedBy = String(actor || (authType === 'passkey' ? 'operator-passkey' : 'unknown'));
  item.decisionNote = note ? String(note) : null;
  saveApprovals(list);
  appendDecisionLog({ event: 'decision', ...item });
  approvalBus.emit(`decided:${item.id}`, item);
  return item;
}

function waitForApproval(id, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const list = expireStaleApprovals();
    const existing = list.find((a) => a.id === id);
    if (!existing || existing.status !== 'pending') {
      return resolve(existing || null);
    }
    const timer = setTimeout(() => {
      approvalBus.removeListener(`decided:${id}`, onDecide);
      resolve(expireStaleApprovals().find((a) => a.id === id) || existing);
    }, timeoutMs);
    function onDecide(updated) {
      clearTimeout(timer);
      resolve(updated);
    }
    approvalBus.once(`decided:${id}`, onDecide);
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  approvalBus,
  approvalsFile,
  decisionsFile,
  loadApprovals,
  saveApprovals,
  expireStaleApprovals,
  createApproval,
  decideApproval,
  waitForApproval
};
