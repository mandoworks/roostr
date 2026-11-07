'use strict';
// Grilling: the pre-plan interview (Items G1-G4).
//
// Structured interview before any code is written or workers spawned.
// The output is docs/orchestration-plan.md, not code.
//
// G1: 7 questions with recommendations, zero dependencies.
// G2: Approval gate, plan derives from answers, secretary spawns nothing until human approves.
// G3: Optional page/skill runner with GRILL_HERDR_TARGET.
// G4: Install-time choice in crew file (recommended, custom, none).

const fs = require('fs');
const path = require('path');

const GRILL_QUESTIONS = [
  {
    id: 'problem',
    number: 1,
    title: 'The problem, in one sentence',
    prompt: 'What problem are we solving, in one sentence?',
    recommendation: 'State the core issue or desired outcome directly without implementation details.',
  },
  {
    id: 'done',
    number: 2,
    title: 'What done looks like and how we check it',
    prompt: 'What does done look like, and how will we check it?',
    recommendation: 'Name the specific behaviors, passing outputs, or verified states that demonstrate completion.',
  },
  {
    id: 'scope',
    number: 3,
    title: 'Scope (in, and explicitly out)',
    prompt: 'What is in scope, and what is explicitly out?',
    recommendation: 'Keep in-scope items bounded to this round; explicitly list tempting adjacent tasks as out of scope.',
  },
  {
    id: 'files',
    number: 4,
    title: 'File boundaries',
    prompt: 'Which files or directories may change, and which are off limits?',
    recommendation: 'List allowed paths strictly; mark infrastructure, root configs, or adjacent packages off limits.',
  },
  {
    id: 'verify',
    number: 5,
    title: 'Verification command',
    prompt: 'What is the exact verification command, and what must be green?',
    recommendation: 'Provide the single authoritative command (e.g. ./verify.sh) with all tests and syntax checks passing.',
  },
  {
    id: 'budget',
    number: 6,
    title: 'Budget or token ceiling',
    prompt: 'What is the budget or token ceiling?',
    recommendation: 'Set a dollar or token ceiling for the crew run (e.g. $5 total or 12 wakes).',
  },
  {
    id: 'recovery',
    number: 7,
    title: 'Failure recovery',
    prompt: 'What happens on failure, and who decides the next move?',
    recommendation: 'Stop after 2 consecutive test failures or 3 identical command errors and escalate to human.',
  },
];

const DEFAULT_PLAN_PATH = path.join('docs', 'orchestration-plan.md');

function generatePlanMarkdown(answers = {}) {
  // Constraints trace 1:1 to answers given; no invented constraints.
  const problem = String(answers.problem || '').trim();
  const done = String(answers.done || '').trim();
  const scopeIn = String(answers.scopeIn || answers.scope || '').trim();
  const scopeOut = String(answers.scopeOut || '').trim();
  const allowed = Array.isArray(answers.allowedFiles)
    ? answers.allowedFiles.join(', ')
    : String(answers.allowedFiles || answers.files || '').trim();
  const forbidden = Array.isArray(answers.forbiddenFiles)
    ? answers.forbiddenFiles.join(', ')
    : String(answers.forbiddenFiles || '').trim();
  const verify = String(answers.verifyCommand || answers.verify || '').trim();
  const budget = String(answers.budget || '').trim();
  const recovery = String(answers.failureRecovery || answers.recovery || '').trim();
  const status = answers.approved === true ? 'Approved' : 'Pending Human Approval';

  const lines = [
    '# Orchestration Plan',
    '',
    `Status: ${status}`,
    `Approved: ${answers.approved === true ? 'true' : 'false'}`,
    '',
    '## 1. Problem',
    problem || '(none provided)',
    '',
    '## 2. Done Criteria and Verification',
    `Outcome: ${done || '(none provided)'}`,
    `Command: ${verify || '(none provided)'}`,
    '',
    '## 3. Scope Boundaries',
    `In Scope: ${scopeIn || '(none provided)'}`,
    `Explicitly Out of Scope: ${scopeOut || '(none provided)'}`,
    '',
    '## 4. File Boundaries',
    `Allowed paths: ${allowed || '(none provided)'}`,
    `Forbidden paths: ${forbidden || '(none provided)'}`,
    '',
    '## 5. Budget and Ceilings',
    budget || '(none provided)',
    '',
    '## 6. Failure Recovery Policy',
    recovery || '(none provided)',
    '',
  ];

  return lines.join('\n');
}

function parsePlan(markdownText) {
  const text = String(markdownText || '');
  const isApproved = /Status:\s*Approved/i.test(text) || /Approved:\s*true/i.test(text);

  const getSection = (title) => {
    const re = new RegExp(`##\\s*\\d*\\.?\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
    const m = re.exec(text);
    return m ? m[1].trim() : '';
  };

  const constraints = {
    problem: getSection('Problem'),
    done: getSection('Done Criteria and Verification'),
    scope: getSection('Scope Boundaries'),
    files: getSection('File Boundaries'),
    budget: getSection('Budget and Ceilings'),
    recovery: getSection('Failure Recovery Policy'),
  };

  return {
    approved: isApproved,
    status: isApproved ? 'approved' : 'pending_approval',
    constraints,
  };
}

function isPlanApproved(plan) {
  if (!plan) return false;
  if (typeof plan === 'string') {
    return parsePlan(plan).approved;
  }
  return plan.approved === true;
}

function invokeGrillRunner({
  runner = 'none',
  skill = null,
  command = null,
  targetPaneId = null,
  isCallable = null,
  execFn = null,
} = {}) {
  // G4 Calling contract:
  // - none: template-only interview (G1), always available, zero dependencies.
  // - recommended: grill-with-ui (jasonku09/grill-with-ui).
  // - custom: user-named grilling skill and invocation.
  // A runner that cannot be called is a setup error surfaced to the user,
  // never a silent fallback mid-interview.

  if (runner === 'none') {
    return {
      type: 'template',
      runner: 'none',
      questions: GRILL_QUESTIONS,
    };
  }

  const env = {};
  if (targetPaneId) {
    env.GRILL_HERDR_TARGET = targetPaneId;
  }

  if (runner === 'recommended') {
    const callable = typeof isCallable === 'function'
      ? isCallable('grill-with-ui')
      : true;

    if (!callable) {
      throw new Error('grill runner "recommended" (grill-with-ui) is not installed or not callable; check setup');
    }

    if (typeof execFn === 'function') {
      execFn('grill-with-ui', { env, questions: GRILL_QUESTIONS });
    }

    return {
      type: 'skill',
      runner: 'recommended',
      skill: 'grill-with-ui',
      env,
      questions: GRILL_QUESTIONS,
    };
  }

  if (runner === 'custom') {
    const target = command || skill;
    if (!target) {
      throw new Error('grill runner "custom" requires a configured skill or command; check setup');
    }

    const callable = typeof isCallable === 'function'
      ? isCallable(target)
      : true;

    if (!callable) {
      throw new Error(`grill runner "custom" (${target}) is not callable; check setup`);
    }

    if (typeof execFn === 'function') {
      execFn(target, { env, questions: GRILL_QUESTIONS });
    }

    return {
      type: 'custom',
      runner: 'custom',
      target,
      env,
      questions: GRILL_QUESTIONS,
    };
  }

  throw new Error(`unknown grill runner: "${runner}"`);
}

module.exports = {
  GRILL_QUESTIONS,
  DEFAULT_PLAN_PATH,
  generatePlanMarkdown,
  parsePlan,
  isPlanApproved,
  invokeGrillRunner,
};
