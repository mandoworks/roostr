'use strict';

const fs = require('fs');
const path = require('path');

const PANE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}:[A-Za-z0-9_-]{1,32}$/;

const ALLOWLIST_KEYS = new Set([
  'enter',
  'esc',
  'tab',
  'space',
  'up',
  'down',
  'left',
  'right',
  'backspace',
  'y',
  'n',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'ctrl-c',
]);

const MAX_KEYS_PER_REQUEST = 8;
const MAX_PROMPT_LENGTH = 4000;
const MAX_PANE_LINES = 120;
const DEFAULT_PANE_LINES = 40;
const MAX_PANE_LABEL = 80;

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ALLOWLIST_AGENT_KINDS = new Set([
  'claude',
  'opencode',
  'kilo',
  'agy',
  'codex',
  'gemini',
]);

const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
const MAX_MODEL_LENGTH = 80;
const ALLOWLIST_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const SESSION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const ALLOWLIST_SPLIT_DIRECTIONS = new Set(['right', 'down']);
const MUSE_SLUG_RE = /^[a-z0-9-]{1,32}$/;
const MAX_MUSE_SUBJECT_LENGTH = 140;
const MAX_MUSE_BODY_LENGTH = 16000;
const MAX_MUSE_THREAD_ID_LENGTH = 80;

// Reject C0 controls except \t, \n, \r, plus DEL and C1 controls.
const DISALLOWED_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const SINGLE_LINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

function validatePaneId(paneId) {
  if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) {
    return { ok: false, error: 'invalid pane id' };
  }
  return { ok: true, value: paneId };
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return { ok: false, error: 'keys must be a non-empty array' };
  }
  if (keys.length > MAX_KEYS_PER_REQUEST) {
    return { ok: false, error: `too many keys (max ${MAX_KEYS_PER_REQUEST})` };
  }
  const validated = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !ALLOWLIST_KEYS.has(k)) {
      return { ok: false, error: `disallowed key: ${typeof k === 'string' ? k : typeof k}` };
    }
    validated.push(k);
  }
  return { ok: true, value: validated };
}

function validatePrompt(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'prompt text must be a string' };
  }
  if (DISALLOWED_CONTROL_RE.test(text)) {
    return { ok: false, error: 'prompt contains disallowed control characters' };
  }
  if (text.trim().length === 0) {
    return { ok: false, error: 'prompt text cannot be empty' };
  }
  if (text.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters` };
  }
  return { ok: true, value: text };
}

function validateLines(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: DEFAULT_PANE_LINES };
  }
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) {
    return { ok: false, error: 'lines must be a positive integer' };
  }
  const n = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, error: 'lines must be at least 1' };
  }
  return { ok: true, value: Math.min(n, MAX_PANE_LINES) };
}

function validatePaneLabel(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'label must be a string' };
  }
  if (SINGLE_LINE_CONTROL_RE.test(raw)) {
    return { ok: false, error: 'label contains disallowed control characters' };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('-')) {
    return { ok: false, error: 'label cannot start with -' };
  }
  if (trimmed.length > MAX_PANE_LABEL) {
    return { ok: false, error: `label exceeds ${MAX_PANE_LABEL} characters` };
  }
  return { ok: true, value: trimmed };
}

function validateAgentName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'agent name must be a string' };
  }
  const trimmed = raw.trim();
  if (!AGENT_NAME_RE.test(trimmed)) {
    return { ok: false, error: 'invalid agent name' };
  }
  return { ok: true, value: trimmed };
}

function validateAgentKind(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'agent kind must be a string' };
  }
  const trimmed = raw.trim();
  if (!ALLOWLIST_AGENT_KINDS.has(trimmed)) {
    return { ok: false, error: `disallowed agent kind: ${trimmed}` };
  }
  return { ok: true, value: trimmed };
}

function validateOptionalModel(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'model must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (trimmed.length > MAX_MODEL_LENGTH) {
    return { ok: false, error: `model exceeds ${MAX_MODEL_LENGTH} characters` };
  }
  if (trimmed.startsWith('-') || !MODEL_RE.test(trimmed)) {
    return { ok: false, error: 'invalid model' };
  }
  return { ok: true, value: trimmed };
}

function validateOptionalEffort(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'effort must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (!ALLOWLIST_EFFORTS.has(trimmed)) {
    return { ok: false, error: `disallowed effort: ${trimmed}` };
  }
  return { ok: true, value: trimmed };
}

function validateOptionalSessionId(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'session id must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (trimmed.startsWith('-') || !SESSION_ID_RE.test(trimmed)) {
    return { ok: false, error: 'invalid session id' };
  }
  return { ok: true, value: trimmed };
}

function validateSplitDirection(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: 'right' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'direction must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: 'right' };
  }
  if (!ALLOWLIST_SPLIT_DIRECTIONS.has(trimmed)) {
    return { ok: false, error: `disallowed split direction: ${trimmed}` };
  }
  return { ok: true, value: trimmed };
}

function validateMuseMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'message body must be an object' };
  }
  if (typeof body.to !== 'string' || !MUSE_SLUG_RE.test(body.to.trim())) {
    return { ok: false, error: 'invalid recipient slug' };
  }
  const to = body.to.trim();

  if (typeof body.subject !== 'string') {
    return { ok: false, error: 'subject must be a string' };
  }
  if (SINGLE_LINE_CONTROL_RE.test(body.subject)) {
    return { ok: false, error: 'subject contains disallowed control characters' };
  }
  const subject = body.subject.trim();
  if (subject.length === 0 || subject.length > MAX_MUSE_SUBJECT_LENGTH) {
    return { ok: false, error: `subject must be 1..${MAX_MUSE_SUBJECT_LENGTH} characters` };
  }

  if (typeof body.body !== 'string') {
    return { ok: false, error: 'body must be a string' };
  }
  if (DISALLOWED_CONTROL_RE.test(body.body)) {
    return { ok: false, error: 'body contains disallowed control characters' };
  }
  const msgBody = body.body.trim();
  if (msgBody.length === 0 || msgBody.length > MAX_MUSE_BODY_LENGTH) {
    return { ok: false, error: `body must be 1..${MAX_MUSE_BODY_LENGTH} characters` };
  }

  let project = 'muse';
  if (body.project !== undefined && body.project !== null && body.project !== '') {
    if (typeof body.project !== 'string' || !MUSE_SLUG_RE.test(body.project.trim())) {
      return { ok: false, error: 'invalid project slug' };
    }
    project = body.project.trim();
  }

  let threadId = null;
  if (body.threadId !== undefined && body.threadId !== null && body.threadId !== '') {
    if (typeof body.threadId !== 'string') {
      return { ok: false, error: 'threadId must be a string' };
    }
    if (SINGLE_LINE_CONTROL_RE.test(body.threadId)) {
      return { ok: false, error: 'threadId contains disallowed control characters' };
    }
    const trimmedThread = body.threadId.trim();
    if (trimmedThread.length > MAX_MUSE_THREAD_ID_LENGTH) {
      return { ok: false, error: `threadId exceeds ${MAX_MUSE_THREAD_ID_LENGTH} characters` };
    }
    if (trimmedThread) {
      threadId = trimmedThread;
    }
  }

  return {
    ok: true,
    value: { to, subject, body: msgBody, project, threadId },
  };
}

function resolveStaticPath(rootDir, subpath) {
  if (typeof rootDir !== 'string' || !rootDir) return null;
  if (typeof subpath !== 'string') return null;
  if (subpath.includes('\0') || subpath.includes('\\')) return null;
  if (path.isAbsolute(subpath) || subpath.startsWith('/')) return null;

  const trimmed = subpath === '' || subpath.endsWith('/')
    ? `${subpath}index.html`
    : subpath;

  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return null;
    }
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch {
    return null;
  }

  const candidate = path.resolve(rootReal, ...segments);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) {
    return null;
  }

  let target = candidate;
  try {
    const lstat = fs.lstatSync(target);
    if (lstat.isDirectory()) {
      target = path.join(target, 'index.html');
    }
    const realTarget = fs.realpathSync(target);
    if (realTarget !== rootReal && !realTarget.startsWith(rootReal + path.sep)) {
      return null;
    }
    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) {
      return null;
    }
    return realTarget;
  } catch {
    return null;
  }
}

module.exports = {
  PANE_ID_RE,
  ALLOWLIST_KEYS,
  ALLOWLIST_AGENT_KINDS,
  MAX_KEYS_PER_REQUEST,
  MAX_PROMPT_LENGTH,
  MAX_PANE_LINES,
  DEFAULT_PANE_LINES,
  MAX_PANE_LABEL,
  validatePaneId,
  validateKeys,
  validatePrompt,
  validateLines,
  validatePaneLabel,
  validateAgentName,
  validateAgentKind,
  validateOptionalModel,
  validateOptionalEffort,
  validateOptionalSessionId,
  validateSplitDirection,
  validateMuseMessage,
  resolveStaticPath,
};
