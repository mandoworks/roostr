'use strict';
// `crew-board template <role> [--name <name>] [--plan <path>] [--package <text>]`
//
// Reads one plain Markdown role template from templates/agents/<role>.md and
// fills the four placeholders. No shell, no path from the caller, no pane data.

const fs = require('fs');
const path = require('path');

const ROLES = ['head-honcho', 'worker', 'reviewer'];
const DEFAULTS = {
  role: (role) => role,
  name: (role) => role,
  plan: () => 'docs/orchestration-plan.md',
  package: () => '(unassigned)',
};

function templateFile(role) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`);
  return path.join(__dirname, '..', 'templates', 'agents', `${role}.md`);
}

function load(role) {
  return fs.readFileSync(templateFile(role), 'utf8');
}

function valueFor(key, role, values) {
  const v = values && values[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return DEFAULTS[key](role);
}

function render(role, values = {}) {
  let text = load(role);
  const filled = {
    ROLE: valueFor('role', role, values),
    NAME: valueFor('name', role, values),
    PLAN: valueFor('plan', role, values),
    PACKAGE: valueFor('package', role, values),
  };
  for (const [key, v] of Object.entries(filled)) text = text.split(`{{${key}}}`).join(v);
  return text;
}

const USAGE = 'usage: roostr template <head-honcho|worker|reviewer> [--name <name>] [--plan <path>] [--package <text>]';

function parseArgs(argv) {
  let role = null;
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--name' || a === '--plan' || a === '--package') {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      values[a.slice(2)] = v;
      continue;
    }
    if (a.startsWith('-')) return { error: `unknown option ${a}` };
    if (role) return { error: `unexpected argument ${a}` };
    role = a;
  }
  if (!role) return { error: 'missing role' };
  if (!ROLES.includes(role)) return { error: `role must be one of: ${ROLES.join(', ')}` };
  return { role, values };
}

function main(argv) {
  const p = parseArgs(argv);
  if (p.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (p.error) {
    process.stderr.write(`roostr template: ${p.error}\n${USAGE}\n`);
    return 2;
  }
  try {
    process.stdout.write(render(p.role, p.values));
    return 0;
  } catch (e) {
    process.stderr.write(`roostr template: ${e.message}\n`);
    return 1;
  }
}

module.exports = { ROLES, USAGE, templateFile, load, render, parseArgs, main };
