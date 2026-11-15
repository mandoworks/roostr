'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const onboard = require('../src/onboard');

test('onboard: slug, bankId, canonical pages, and charter block', () => {
  assert.equal(onboard.isOrchestratorRole('head-honcho'), true);
  assert.equal(onboard.isOrchestratorRole('orchestrator'), true);
  assert.equal(onboard.isOrchestratorRole('worker'), false);
  assert.equal(onboard.bankIdForProject('roostr'), 'coding-agent::roostr');

  const pages = onboard.canonicalPageSpecs('roostr');
  assert.equal(pages.length, 5);
  assert.deepEqual(
    pages.map((p) => p.tags[0]),
    [
      'knowledge:concept',
      'knowledge:component',
      'knowledge:convention',
      'knowledge:decision',
      'knowledge:feature-work',
    ]
  );
  assert.match(pages[0].source_query, /Scope this page to roostr ITSELF/);

  const charter = onboard.charterMemoryBlock('roostr');
  assert.match(charter, /coding-agent::roostr/);
  assert.match(charter, /facts before->after/);
  assert.match(charter, /Never retain secrets/);
});

test('onboard: runOnboard executes seat, webhook, card, announce, status, and musesight proof', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-onboard-'));
  try {
    const skillPath = path.join(tmp, 'skills', 'musesight', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '# MuseSight');

    const adminFile = path.join(tmp, 'admin-token');
    fs.writeFileSync(adminFile, 'test-admin-tok\n', { mode: 0o600 });
    const secretOut = path.join(tmp, 'webhook-secret');

    const calls = [];
    const mockFetch = async (url, init = {}) => {
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      const headers = init.headers || {};
      calls.push({ url, method, headers, body });

      if (url.endsWith('/webhook')) {
        assert.equal(headers['X-PioRelay-Admin'], 'test-admin-tok');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ agent: 'roosty', url: body.url, generated_secret: true, secret: 'whsec_test_123' }),
        };
      }
      if (url.endsWith('/card')) {
        assert.equal(headers['X-PioRelay-Admin'], 'test-admin-tok');
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'roosty' }) };
      }
      if (url.endsWith('/memories/recall')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ results: [{ text: 'smoke verified' }] }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    };

    const res = await onboard.runOnboard({
      agent: 'roosty',
      project: 'roostr',
      displayName: 'Roosty Argon',
      role: 'head-honcho',
      host: 'ovh',
      capabilities: ['orchestrate', 'build'],
      relayUrl: 'http://relay.local/api/v1',
      musesightUrl: 'http://musesight.local',
      statusUrl: 'http://status.local/announce',
      webhookUrl: 'http://127.0.0.1:18789/hook',
      adminTokenFile: adminFile,
      webhookSecretOut: secretOut,
      skillDirs: [skillPath],
    }, { fetch: mockFetch, now: () => 1794780000000 });

    assert.equal(res.ok, true);
    assert.equal(res.steps.seat.ok, true);
    assert.equal(res.steps.webhook.ok, true);
    assert.equal(res.steps.webhook.secretSaved, true);
    assert.equal(res.steps.card.ok, true);
    assert.equal(res.steps.announce.ok, true);
    assert.equal(res.steps.status.ok, true);
    assert.equal(res.steps.musesight.ok, true);
    assert.equal(res.steps.musesight.pages.length, 5);
    assert.equal(res.steps.musesight.roundTripOk, true);
    assert.equal(res.steps.musesight.skillInstalled, true);

    // Webhook secret was persisted to 0600 file and never leaked in response
    assert.equal(fs.readFileSync(secretOut, 'utf8').trim(), 'whsec_test_123');
    assert.equal(fs.statSync(secretOut).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(res).includes('whsec_test_123'), false);
    assert.equal(JSON.stringify(res).includes('test-admin-tok'), false);

    // 1 default + 1 webhook + 1 card + 1 message + 1 status + 1 bank + 5 pages + 1 retain + 1 recall = 13 calls
    assert.equal(calls.length, 13);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('onboard: CLI --dry-run and missing --agent validation', async () => {
  let out = '';
  let err = '';
  const bad = await onboard.main([], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  assert.equal(bad, 2);
  assert.match(err, /--agent/);

  out = '';
  err = '';
  const code = await onboard.main(['--agent', 'roosty', '--project', 'roostr', '--dry-run', '--json'], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  assert.equal(code, 0);
  const doc = JSON.parse(out);
  assert.equal(doc.dryRun, true);
  assert.equal(doc.plan.bankId, 'coding-agent::roostr');
});
