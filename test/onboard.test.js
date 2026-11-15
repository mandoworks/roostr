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

    const announceCall = calls.find((c) => c.url.endsWith('/agent-messages'));
    assert.ok(announceCall);
    assert.equal(announceCall.method, 'POST');
    assert.equal(announceCall.body.kind, 'report');
    assert.equal(announceCall.body.to, 'roman');
    assert.equal(announceCall.body.project, 'roostr');
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
  const code = await onboard.main([
    '--agent', 'roosty',
    '--project', 'roostr',
    '--capabilities', 'orchestrate, review',
    '--capabilities', 'ship',
    '--host', 'ovh',
    '--dry-run',
    '--json',
  ], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    env: { ROOSTR_STATUS_URL: 'http://status.local/announce' },
  });
  assert.equal(code, 0);
  const doc = JSON.parse(out);
  assert.equal(doc.dryRun, true);
  assert.equal(doc.plan.bankId, 'coding-agent::roostr');
  assert.equal(doc.plan.host, 'ovh');
  assert.deepEqual(doc.plan.capabilities, ['orchestrate', 'review', 'ship']);
  assert.equal(doc.steps.status, 'planned');
});

test('onboard: httpJson and runOnboard wrap network errors with method, url, and cause without leaking secrets', async () => {
  const secretToken = 'super-secret-admin-tok-xyz';
  const causeErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
  const fetchErr = new TypeError('fetch failed', { cause: causeErr });

  await assert.rejects(
    () => onboard.httpJson(
      async () => { throw fetchErr; },
      'http://relay.local/api/v1/agents/roosty/card',
      { method: 'PUT', headers: { 'X-PioRelay-Admin': secretToken }, body: { secret: 'whsec_hidden' } }
    ),
    (err) => {
      assert.match(err.message, /PUT http:\/\/relay\.local\/api\/v1\/agents\/roosty\/card/);
      assert.match(err.message, /fetch failed/);
      assert.match(err.message, /ECONNREFUSED/);
      assert.equal(err.message.includes(secretToken), false);
      assert.equal(err.message.includes('whsec_hidden'), false);
      assert.equal(err.message.includes('X-PioRelay-Admin'), false);
      assert.equal(err.cause, fetchErr);
      return true;
    }
  );

  // Also test cause.message when cause.code is absent, and res.text() failure
  const msgOnlyFetchErr = new TypeError('fetch failed', { cause: new Error('socket hang up') });
  await assert.rejects(
    () => onboard.httpJson(
      async () => ({ ok: true, status: 200, text: async () => { throw msgOnlyFetchErr; } }),
      'http://status.local/announce',
      { method: 'POST', body: { agent: 'roosty' } }
    ),
    (err) => {
      assert.match(err.message, /POST http:\/\/status\.local\/announce/);
      assert.match(err.message, /socket hang up/);
      return true;
    }
  );

  // runOnboard propagates wrapped error with URL + cause and no secret leaks
  await assert.rejects(
    () => onboard.runOnboard({
      agent: 'roosty',
      project: 'roostr',
      relayUrl: 'http://relay.local/api/v1',
      webhookUrl: 'http://127.0.0.1:18789/hook',
      adminToken: secretToken,
    }, {
      fetch: async (url) => {
        if (url.endsWith('/webhook')) {
          throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
        }
        return { ok: true, status: 200, text: async () => '{}' };
      },
    }),
    (err) => {
      assert.match(err.message, /PUT http:\/\/relay\.local\/api\/v1\/agents\/roosty\/webhook/);
      assert.match(err.message, /ETIMEDOUT/);
      assert.equal(err.message.includes(secretToken), false);
      return true;
    }
  );
});

test('onboard: partial failure handling continues across steps and aggregates errors', async () => {
  let pageIdx = 0;
  const mockFetch = async (url) => {
    if (url.endsWith('/default')) {
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'db down' }) };
    }
    if (url.endsWith('/agent-messages')) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'bad request' }) };
    }
    if (url.endsWith('/knowledge-base/pages')) {
      pageIdx += 1;
      if (pageIdx === 1) return { ok: false, status: 409, text: async () => '{}' };
      if (pageIdx === 2) return { ok: false, status: 502, text: async () => '{}' };
      return { ok: true, status: 201, text: async () => '{}' };
    }
    if (url.endsWith('/memories/recall')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  const res = await onboard.runOnboard({
    agent: 'roosty',
    project: 'roostr',
    host: '   ',
    capabilities: '  ',
    relayUrl: 'http://relay.local/api/v1',
    webhookUrl: 'http://127.0.0.1:18789/hook',
    musesightUrl: 'http://musesight.local',
    statusUrl: 'http://status.local/announce',
  }, { fetch: mockFetch, now: () => 1794780000000 });

  assert.equal(res.ok, false);
  assert.equal(res.plan.host, os.hostname() || 'unknown');
  assert.deepEqual(res.plan.capabilities, ['orchestrate', 'build']);
  assert.equal(res.steps.seat.ok, false);
  assert.equal(res.steps.seat.status, 500);
  assert.equal(res.steps.webhook.ok, false);
  assert.equal(res.steps.card.ok, false);
  assert.equal(res.steps.announce.ok, false);
  assert.equal(res.steps.status.ok, true);
  assert.equal(res.steps.musesight.pages[0].ok, true);
  assert.equal(res.steps.musesight.pages[1].ok, false);
  assert.equal(res.steps.musesight.pagesOk, false);
  assert.equal(res.steps.musesight.roundTripOk, false);
  assert.equal(res.steps.musesight.ok, false);
  assert.ok(res.errors.includes('seat failed (500)'));
  assert.ok(res.errors.includes('webhook registration skipped: missing admin token'));
  assert.ok(res.errors.includes('agent card skipped: missing admin token'));
  assert.ok(res.errors.includes('relay announce failed (400)'));
  assert.ok(res.errors.includes('musesight bank/pages/smoke verification failed'));
});

test('onboard: shouldAutoOnboard edge cases and CLI error exit code', async () => {
  assert.equal(onboard.shouldAutoOnboard({ role: 'worker', onboard: true }, { ROOSTR_RELAY_URL: 'http://x' }), false);
  assert.equal(onboard.shouldAutoOnboard({ role: 'orchestrator', onboard: false }, { ROOSTR_RELAY_URL: 'http://x' }), false);
  assert.equal(onboard.shouldAutoOnboard({ role: 'head-honcho', onboard: true }, { ROOSTR_AUTO_ONBOARD: '0' }), true);
  assert.equal(onboard.shouldAutoOnboard({ role: 'orchestrator' }, { ROOSTR_AUTO_ONBOARD: '0', ROOSTR_RELAY_URL: 'http://x' }), false);
  assert.equal(onboard.shouldAutoOnboard({ role: 'orchestrator' }, { ROOSTR_RELAY_URL: '   ', ROOSTR_MUSESIGHT_URL: '' }), false);
  assert.equal(onboard.shouldAutoOnboard({ role: 'orchestrator' }, { ROOSTR_MUSESIGHT_URL: 'http://muse' }), true);

  let out = '';
  let err = '';
  const code = await onboard.main(['--agent', 'roosty', '--project', 'roostr', '--relay-url', 'http://relay.local'], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    fetch: async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    },
  });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /PUT http:\/\/relay\.local\/agents\/roosty\/default.*ECONNREFUSED/);
});
