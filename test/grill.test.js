'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const grill = require('../src/grill');
const daemon = require('../src/daemon');
const crewfile = require('../src/crewfile');
const templates = require('../src/templates');

test('G1: template interview has exact seven questions with recommendations and zero dependencies', () => {
  assert.equal(grill.GRILL_QUESTIONS.length, 7);

  const ids = grill.GRILL_QUESTIONS.map((q) => q.id);
  assert.deepEqual(ids, ['problem', 'done', 'scope', 'files', 'verify', 'budget', 'recovery']);

  for (const q of grill.GRILL_QUESTIONS) {
    assert.ok(q.title && q.title.length > 5);
    assert.ok(q.prompt && q.prompt.length > 10);
    assert.ok(q.recommendation && q.recommendation.length > 10);
  }

  // Check Head Honcho role template carries the seven questions
  const rendered = templates.render('head-honcho');
  assert.match(rendered, /The problem, in one sentence/);
  assert.match(rendered, /What done looks like and how we check it/);
  assert.match(rendered, /Scope/);
  assert.match(rendered, /File boundaries/);
  assert.match(rendered, /Verification/);
  assert.match(rendered, /Budget/);
  assert.match(rendered, /Failure recovery/);
  assert.match(rendered, /Every constraint must trace 1:1 to the answers given/);
});

test('G2: plan constraints trace 1:1 to answers given with zero invented constraints', () => {
  const humanAnswers = {
    problem: 'Add cost ledger and rotation retention policy',
    done: 'All unit tests green and verify.sh passes with 0 failures',
    scopeIn: 'Rotation retention in src/rotate.js and crew file setting',
    scopeOut: 'No board UI redesign and no external packages',
    allowedFiles: ['src/rotate.js', 'src/crewfile.js', 'test/rotate.test.js'],
    forbiddenFiles: ['package.json', 'node_modules', 'bin/*'],
    verifyCommand: './verify.sh',
    budget: '$5 ceiling and max 12 wakes per day',
    failureRecovery: 'Stop after 2 test failures and escalate to human',
    approved: true,
  };

  const planMarkdown = grill.generatePlanMarkdown(humanAnswers);

  // Traceability 1:1
  assert.ok(planMarkdown.includes(humanAnswers.problem));
  assert.ok(planMarkdown.includes(humanAnswers.done));
  assert.ok(planMarkdown.includes(humanAnswers.scopeIn));
  assert.ok(planMarkdown.includes(humanAnswers.scopeOut));
  assert.ok(planMarkdown.includes('src/rotate.js, src/crewfile.js, test/rotate.test.js'));
  assert.ok(planMarkdown.includes('package.json, node_modules, bin/*'));
  assert.ok(planMarkdown.includes(humanAnswers.verifyCommand));
  assert.ok(planMarkdown.includes(humanAnswers.budget));
  assert.ok(planMarkdown.includes(humanAnswers.failureRecovery));

  // Parse plan and verify constraints match
  const parsed = grill.parsePlan(planMarkdown);
  assert.equal(parsed.approved, true);
  assert.equal(parsed.status, 'approved');
  assert.equal(parsed.constraints.problem, humanAnswers.problem);
  assert.ok(parsed.constraints.done.includes(humanAnswers.done));
  assert.ok(parsed.constraints.scope.includes(humanAnswers.scopeIn));
  assert.ok(parsed.constraints.files.includes('src/rotate.js'));
});

test('G2: spawn attempt before approval is refused', async () => {
  const unapprovedPlan = {
    approved: false,
    tasks: [{ id: 'pkg-1', title: 'Task 1', tier: 'fast' }],
  };

  const crewConfig = {
    tiers: { fast: { model: 'gemini-3.8-flash', effort: 'low' } },
  };

  const res = await daemon.executePlan(unapprovedPlan, crewConfig, { recordLedger: false });
  assert.equal(res.refused, true);
  assert.equal(res.dispatches.length, 0);
  assert.equal(res.escalations.length, 1);
  assert.equal(res.escalations[0].type, 'plan_unapproved');
});

test('G3: optional runner sets GRILL_HERDR_TARGET for event-woken delivery', () => {
  let captured = null;
  const runner = grill.invokeGrillRunner({
    runner: 'recommended',
    targetPaneId: 'w1Z:pH',
    isCallable: () => true,
    execFn: (name, opts) => {
      captured = { name, opts };
    },
  });

  assert.equal(runner.type, 'skill');
  assert.equal(runner.skill, 'grill-with-ui');
  assert.equal(runner.env.GRILL_HERDR_TARGET, 'w1Z:pH');
  assert.equal(captured.name, 'grill-with-ui');
  assert.equal(captured.opts.env.GRILL_HERDR_TARGET, 'w1Z:pH');
});

test('G4: install-time skill choices in crew file: recommended, custom, and none', () => {
  // 1. None (template-only default)
  const tomlNone = `
[grill]
runner = "none"
`;
  const crewNone = crewfile.toCrew(crewfile.parseToml(tomlNone), '/tmp/test-none/.crew-board.toml');
  assert.equal(crewNone.errors.length, 0);
  assert.equal(crewNone.grill.runner, 'none');

  const resNone = grill.invokeGrillRunner({ runner: crewNone.grill.runner });
  assert.equal(resNone.type, 'template');
  assert.equal(resNone.questions.length, 7);

  // 2. Recommended (grill-with-ui)
  const tomlRec = `
[grill]
runner = "recommended"
`;
  const crewRec = crewfile.toCrew(crewfile.parseToml(tomlRec), '/tmp/test-rec/.crew-board.toml');
  assert.equal(crewRec.errors.length, 0);
  assert.equal(crewRec.grill.runner, 'recommended');

  // 3. Custom runner
  const tomlCustom = `
[grill]
runner = "custom"
skill = "my-custom-grill"
command = "grill-cli --mode interactive"
`;
  const crewCustom = crewfile.toCrew(crewfile.parseToml(tomlCustom), '/tmp/test-custom/.crew-board.toml');
  assert.equal(crewCustom.errors.length, 0);
  assert.equal(crewCustom.grill.runner, 'custom');
  assert.equal(crewCustom.grill.skill, 'my-custom-grill');
  assert.equal(crewCustom.grill.command, 'grill-cli --mode interactive');

  // Invalid runner option reports error
  const tomlInvalid = `
[grill]
runner = "unknown-runner"
`;
  const crewInvalid = crewfile.toCrew(crewfile.parseToml(tomlInvalid), '/tmp/test-invalid/.crew-board.toml');
  assert.ok(crewInvalid.errors.some((e) => e.includes('[grill] runner must be')));
});

test('G4: uncallable runner surfaces setup error and never silently falls back mid-interview', () => {
  // Recommended runner unavailable
  assert.throws(
    () => {
      grill.invokeGrillRunner({
        runner: 'recommended',
        isCallable: () => false,
      });
    },
    /is not installed or not callable/
  );

  // Custom runner without command/skill
  assert.throws(
    () => {
      grill.invokeGrillRunner({
        runner: 'custom',
      });
    },
    /requires a configured skill or command/
  );

  // Custom runner uncallable
  assert.throws(
    () => {
      grill.invokeGrillRunner({
        runner: 'custom',
        skill: 'broken-grill',
        isCallable: () => false,
      });
    },
    /is not callable/
  );
});
