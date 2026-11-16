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
  resolveStaticPath,
};
