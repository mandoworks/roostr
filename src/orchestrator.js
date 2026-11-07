'use strict';
// Shared helpers for starting the Head Honcho, and for the agent start args
// every role uses. Pure functions here; the board owns the live picker.

const path = require('path');
const config = require('./config');
const templates = require('./templates');

const TASK = 'grilling the crew plan';
const ROLE = 'head-honcho';
const SECRETARY_ROLE = 'secretary';
const SECRETARY_TASK = 'monitoring the crew';
const SECRETARY_ABOUT = 'Runs monitor passes and records outcomes';
const DEFAULT_HEAD_NAME = 'la-jefa';
const PLAN = 'docs/orchestration-plan.md';

function projectSlug(project) {
  const base = path.basename(String(project || '').replace(/\\/g, '/')) || 'crew';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug || 'crew';
}

// The agent name is the chosen head name plus the project, then -2, -3 on a
// collision. The pane label uses the same name so the row, label and task line
// all agree.
function nextName(agents, headName, project) {
  const head = typeof headName === 'string' && headName.trim() ? headName.trim() : DEFAULT_HEAD_NAME;
  const slug = projectSlug(project);
  const base = `${head}-${slug}`;
  const used = new Set((agents || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const name = `${base}-${n}`;
    if (!used.has(name)) return name;
  }
  return `${base}-999`;
}

// Panes in the home workspace that are not live agents.
function shellPanes(snapshot, agents, home) {
  if (!home || !snapshot || !Array.isArray(snapshot.panes)) return [];
  const live = new Set((agents || []).map((a) => a && a.pane_id).filter(Boolean));
  return snapshot.panes
    .filter((p) => p && p.pane_id && p.workspace_id === home && !live.has(p.pane_id))
    .map((p) => ({ paneId: p.pane_id, label: p.label || null, cwd: p.cwd || null }));
}

function projectName(snapshot, home, fallback) {
  const pane = snapshot && Array.isArray(snapshot.panes)
    ? snapshot.panes.find((p) => p && p.workspace_id === home && p.cwd)
    : null;
  return projectSlug(pane && pane.cwd ? pane.cwd : fallback);
}

function prompt(name) {
  return templates.render(ROLE, { name, plan: PLAN });
}

function secretaryPrompt(name) {
  return templates.render(SECRETARY_ROLE, { name, plan: PLAN });
}

// The secretary is workspace scoped so two open workspaces do not share a
// Herdr agent name and the pane itself says which crew it belongs to.
function secretaryName(workspaceLabel) {
  const label = String(workspaceLabel || 'crew').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'crew';
  const slug = projectSlug(label).slice(0, 21).replace(/-+$/, '') || 'crew';
  return { agent: `secretary-${slug}`.slice(0, 32), display: `Secretary - ${label}` };
}

function resolveRole(cfg = null, roleKey = ROLE) {
  const c = cfg || config.loadConfig().config;
  const role = c.roles && c.roles[roleKey] ? c.roles[roleKey] : {};
  const fallbackEffort = roleKey === ROLE ? 'high' : 'medium';
  return {
    tool: role.tool || c.defaultTool || 'claude',
    model: role.model || '',
    effort: role.effort || fallbackEffort,
    args: Array.isArray(role.args) ? role.args.slice() : [],
  };
}

// Opencode accepts --model but not --variant. Any --variant the user put in
// the config is dropped here, because the TUI versions tested reject it. The
// effort is still recorded in the report, never claimed as an internal variant.
function roleArgs(role, kind) {
  const args = Array.isArray(role && role.args) ? role.args.slice() : [];
  if (kind !== 'opencode') return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--variant') {
      i++;
      continue;
    }
    if (String(args[i]).startsWith('--variant=')) continue;
    out.push(args[i]);
  }
  if (role && role.model && !out.includes('--model')) out.push('--model', role.model);
  return out;
}

module.exports = {
  TASK, ROLE, SECRETARY_ROLE, SECRETARY_TASK, SECRETARY_ABOUT, DEFAULT_HEAD_NAME, PLAN,
  projectSlug, nextName, shellPanes, projectName, prompt, secretaryPrompt, secretaryName, resolveRole, roleArgs,
};
