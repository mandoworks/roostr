'use strict';
// Standard orchestrator onboarding bundle, no human in the loop:
// PioRelay seat + default project, webhook registration (admin-gated, Standard
// Webhooks), agent card, board announcement, and MuseSight project bank +
// canonical knowledge pages + smoke retain/recall round-trip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ORCHESTRATOR_ROLES = new Set(['head-honcho', 'orchestrator']);

const CANONICAL_PAGES = [
  {
    name: 'Core concepts',
    tag: 'knowledge:concept',
    question: 'What are the core concepts, domain abstractions, and key entities in this project, the vocabulary a developer must understand?',
  },
  {
    name: 'Component map',
    tag: 'knowledge:component',
    question: 'What are the main components/modules/subsystems, what is each responsible for, and how do they relate or depend on one another?',
  },
  {
    name: 'Conventions and patterns',
    tag: 'knowledge:convention',
    question: 'What conventions, idioms, and recurring patterns does this project follow: testing, error handling, naming, structure, how changes are typically made?',
  },
  {
    name: 'Key decisions and rationale',
    tag: 'knowledge:decision',
    question: 'What are the significant technical decisions in this project and the rationale behind them, the durable "why we do it this way"?',
  },
  {
    name: 'Initiatives and enhancements',
    tag: 'knowledge:feature-work',
    question: 'What major initiatives, features, and enhancements has the project worked on, summarized as themes over time?',
  },
];

function isOrchestratorRole(role) {
  return typeof role === 'string' && ORCHESTRATOR_ROLES.has(role.trim().toLowerCase());
}

function sanitizeSlug(raw, fallback = 'crew') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return SLUG_RE.test(s) ? s : fallback;
}

function validateSlug(raw, label = 'slug') {
  if (typeof raw !== 'string' || !SLUG_RE.test(raw)) {
    throw new Error(`invalid ${label}: ${String(raw)}`);
  }
  return raw;
}

function bankIdForProject(project) {
  return `coding-agent::${validateSlug(project, 'project')}`;
}

function pageSourceQuery(page, project) {
  return `${page.question} Scope this page to ${project} ITSELF: the bank also holds facts about external tools, libraries and services that ${project} merely uses, configures, deploys or discusses, and those belong to somebody else's codebase. Include something only when its subject is ${project}'s own code, configuration or process; when it is about a dependency, leave it out however well-evidenced it looks, including any commit SHA or identifier that belongs to that dependency's repository rather than this one.`;
}

function canonicalPageSpecs(project) {
  const proj = validateSlug(project, 'project');
  return CANONICAL_PAGES.map((p) => ({
    name: p.name,
    tags: [p.tag],
    source_query: pageSourceQuery(p, proj),
  }));
}

function charterMemoryBlock(project) {
  const bankId = bankIdForProject(project);
  return [
    '## Memory discipline (MuseSight)',
    '',
    `- Project bank: \`${bankId}\` (one bank per project, never per agent).`,
    '- Recall lean before project work (`budget: "low"`, `max_tokens: 1000`, `prefer_observations: true`).',
    '- Retain decisions and conventions as they happen with tags `project:<project>,host:<host>,agent:<name>`.',
    '- Workers return retain-ready paragraphs; the orchestrator is the single writer to the bank.',
    '- Every deliverable ends with a `Memory:` line carrying the retain result (`facts before->after`).',
    '- Never retain secrets, tokens, keys, or `.env` contents.',
  ].join('\n');
}

function checkSkillInstalled(opts = {}) {
  const home = opts.home || os.homedir();
  const candidates = Array.isArray(opts.skillDirs) && opts.skillDirs.length > 0
    ? opts.skillDirs
    : [
        path.join(home, '.config', 'opencode', 'skills', 'musesight', 'SKILL.md'),
        path.join(home, '.gemini', 'config', 'skills', 'musesight', 'SKILL.md'),
        path.join(home, '.claude', 'skills', 'musesight', 'SKILL.md'),
      ];
  const found = candidates.filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  return { installed: found.length > 0, paths: found };
}

function readTokenFile(filePath) {
  if (!filePath) return null;
  try {
    const val = fs.readFileSync(filePath, 'utf8').trim();
    return val || null;
  } catch {
    return null;
  }
}

function writeSecretFile(filePath, secret) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(secret).trim() + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

async function httpJson(fetchFn, url, { method = 'GET', headers = {}, body = null } = {}) {
  const reqHeaders = { Accept: 'application/json', ...headers };
  let payload;
  if (body !== null && body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetchFn(url, { method, headers: reqHeaders, body: payload });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ok: res.ok, status: res.status, data };
}

function shouldAutoOnboard(opts = {}, env = process.env) {
  if (!isOrchestratorRole(opts.role)) return false;
  if (opts.onboard === true) return true;
  if (env.ROOSTR_AUTO_ONBOARD === '0') return false;
  return Boolean(env.ROOSTR_RELAY_URL || env.ROOSTR_MUSESIGHT_URL);
}

async function runOnboard(opts = {}, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const env = deps.env || process.env;
  const nowFn = deps.now || Date.now;

  const agent = validateSlug(opts.agent, 'agent');
  const project = validateSlug(opts.project || sanitizeSlug(path.basename(opts.cwd || process.cwd())), 'project');
  const host = String(opts.host || os.hostname() || 'unknown').trim() || 'unknown';
  const displayName = opts.displayName || agent;
  const role = opts.role || 'orchestrator';
  const capabilities = Array.isArray(opts.capabilities) && opts.capabilities.length > 0
    ? opts.capabilities
    : ['orchestrate', 'build'];

  const relayBase = (opts.relayUrl || env.ROOSTR_RELAY_URL || '').replace(/\/+$/, '');
  const musesightBase = (opts.musesightUrl || env.ROOSTR_MUSESIGHT_URL || '').replace(/\/+$/, '');
  const statusUrl = opts.statusUrl || env.ROOSTR_STATUS_URL || '';
  const webhookUrl = opts.webhookUrl || env.ROOSTR_WEBHOOK_URL || '';
  const announceTo = validateSlug(opts.announceTo || env.ROOSTR_ANNOUNCE_TO || 'roman', 'announceTo');

  const adminToken = opts.adminToken
    || env.ROOSTR_RELAY_ADMIN_TOKEN
    || readTokenFile(opts.adminTokenFile || env.ROOSTR_RELAY_ADMIN_TOKEN_FILE);

  const bankId = bankIdForProject(project);
  const skill = checkSkillInstalled({ home: opts.home, skillDirs: opts.skillDirs });

  const plan = {
    agent,
    project,
    host,
    displayName,
    role,
    capabilities,
    bankId,
    skillInstalled: skill.installed,
    skillPaths: skill.paths,
    relayConfigured: Boolean(relayBase),
    webhookConfigured: Boolean(webhookUrl),
    musesightConfigured: Boolean(musesightBase),
    statusConfigured: Boolean(statusUrl),
    dryRun: Boolean(opts.dryRun),
  };

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      plan,
      charterBlock: charterMemoryBlock(project),
      steps: {
        seat: relayBase ? 'planned' : 'skipped',
        webhook: relayBase && webhookUrl ? 'planned' : 'skipped',
        card: relayBase && adminToken ? 'planned' : 'skipped',
        announce: relayBase ? 'planned' : 'skipped',
        musesight: musesightBase ? 'planned' : 'skipped',
      },
    };
  }

  if (typeof fetchFn !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const steps = {};
  const errors = [];

  if (relayBase) {
    // 1. PioRelay seat + default project
    const seatRes = await httpJson(fetchFn, `${relayBase}/agents/${encodeURIComponent(agent)}/default`, {
      method: 'PUT',
      body: { project },
    });
    steps.seat = { ok: seatRes.ok, status: seatRes.status };
    if (!seatRes.ok) errors.push(`seat failed (${seatRes.status})`);

    // 2. Webhook registration (standard, admin-gated, Standard Webhooks)
    if (webhookUrl) {
      if (!adminToken) {
        steps.webhook = { ok: false, status: 0, error: 'missing admin token' };
        errors.push('webhook registration skipped: missing admin token');
      } else {
        const whBody = { url: webhookUrl };
        if (opts.webhookSecret) whBody.secret = opts.webhookSecret;
        const whRes = await httpJson(fetchFn, `${relayBase}/agents/${encodeURIComponent(agent)}/webhook`, {
          method: 'PUT',
          headers: { 'X-PioRelay-Admin': adminToken },
          body: whBody,
        });
        if (whRes.ok && whRes.data && whRes.data.generated_secret && whRes.data.secret && opts.webhookSecretOut) {
          writeSecretFile(opts.webhookSecretOut, whRes.data.secret);
        }
        steps.webhook = {
          ok: whRes.ok,
          status: whRes.status,
          secretSaved: Boolean(whRes.ok && whRes.data && whRes.data.generated_secret && opts.webhookSecretOut),
        };
        if (!whRes.ok) errors.push(`webhook registration failed (${whRes.status})`);
      }
    } else {
      steps.webhook = { ok: true, skipped: true, reason: 'resident or no webhook url' };
    }

    // 3. Agent card (admin-gated)
    if (adminToken) {
      const cardRes = await httpJson(fetchFn, `${relayBase}/agents/${encodeURIComponent(agent)}/card`, {
        method: 'PUT',
        headers: { 'X-PioRelay-Admin': adminToken },
        body: {
          display_name: displayName,
          role,
          capabilities,
          host,
        },
      });
      steps.card = { ok: cardRes.ok, status: cardRes.status };
      if (!cardRes.ok) errors.push(`agent card failed (${cardRes.status})`);
    } else {
      steps.card = { ok: false, skipped: true, reason: 'missing admin token' };
      errors.push('agent card skipped: missing admin token');
    }

    // 4. Board announcement
    const clientMsgId = `${agent}-onboard-${project}-${Math.floor(nowFn() / 60000)}`;
    const msgRes = await httpJson(fetchFn, `${relayBase}/agent-messages`, {
      method: 'POST',
      body: {
        from: agent,
        to: announceTo,
        subject: `${displayName} onboarded for ${project}`,
        body: `Agent ${agent} onboarded on ${host} for project ${project} (role: ${role}, bank: ${bankId}).`,
        kind: 'note',
        project,
        client_msg_id: clientMsgId,
      },
    });
    steps.announce = { ok: msgRes.ok, status: msgRes.status };
    if (!msgRes.ok) errors.push(`relay announce failed (${msgRes.status})`);
  } else {
    steps.seat = { skipped: true };
    steps.webhook = { skipped: true };
    steps.card = { skipped: true };
    steps.announce = { skipped: true };
  }

  if (statusUrl) {
    const stRes = await httpJson(fetchFn, statusUrl, {
      method: 'POST',
      body: {
        agent,
        state: 'idle',
        label: role,
        source: 'roostr-onboard',
      },
    });
    steps.status = { ok: stRes.ok, status: stRes.status };
    if (!stRes.ok) errors.push(`agent-status announce failed (${stRes.status})`);
  } else {
    steps.status = { skipped: true };
  }

  // 5. MuseSight project bank + 5 canonical knowledge pages + smoke proof
  if (musesightBase) {
    const encodedBank = encodeURIComponent(bankId);
    const bankRes = await httpJson(fetchFn, `${musesightBase}/v1/default/banks/${encodedBank}`, {
      method: 'PUT',
      body: {
        name: project,
        mission: `Long-term engineering memory for ${project}.`,
      },
    });

    const pageSpecs = canonicalPageSpecs(project);
    const pagesCreated = [];
    let pagesOk = true;
    for (const page of pageSpecs) {
      const pRes = await httpJson(fetchFn, `${musesightBase}/v1/default/banks/${encodedBank}/knowledge-base/pages`, {
        method: 'POST',
        body: page,
      });
      // 409 means the canonical page already exists in this bank
      const ok = pRes.ok || pRes.status === 409;
      if (!ok) pagesOk = false;
      pagesCreated.push({ name: page.name, status: pRes.status, ok });
    }

    const smokeMarker = `onboard-smoke-${crypto.randomBytes(4).toString('hex')}`;
    const smokeContent = `Onboarding verification (${smokeMarker}) for project ${project}: ${agent} stood up on ${host} using bank ${bankId}.`;
    const retainRes = await httpJson(fetchFn, `${musesightBase}/v1/default/banks/${encodedBank}/memories`, {
      method: 'POST',
      body: {
        items: [
          {
            content: smokeContent,
            tags: [`project:${project}`, `host:${host}`, `agent:${agent}`],
          },
        ],
      },
    });

    const recallRes = await httpJson(fetchFn, `${musesightBase}/v1/default/banks/${encodedBank}/memories/recall`, {
      method: 'POST',
      body: {
        query: smokeMarker,
        budget: 'low',
        max_tokens: 1000,
        prefer_observations: true,
      },
    });

    const recallResults = recallRes.data && Array.isArray(recallRes.data.results)
      ? recallRes.data.results
      : (recallRes.data && Array.isArray(recallRes.data.memories) ? recallRes.data.memories : []);

    const roundTripOk = Boolean(retainRes.ok && recallRes.ok && recallResults.length > 0);
    steps.musesight = {
      ok: Boolean(bankRes.ok && pagesOk && roundTripOk),
      bankId,
      bankStatus: bankRes.status,
      pagesOk,
      pages: pagesCreated,
      retainStatus: retainRes.status,
      recallStatus: recallRes.status,
      recallCount: recallResults.length,
      roundTripOk,
      skillInstalled: skill.installed,
    };
    if (!steps.musesight.ok) {
      errors.push('musesight bank/pages/smoke verification failed');
    }
  } else {
    steps.musesight = { skipped: true, bankId, skillInstalled: skill.installed };
  }

  return {
    ok: errors.length === 0,
    plan,
    charterBlock: charterMemoryBlock(project),
    steps,
    errors,
  };
}

const USAGE = [
  'usage: roostr onboard --agent <slug> [--project <slug>] [--display-name <text>]',
  '  [--role <text>] [--host <name>] [--capabilities <a,b>]',
  '  [--webhook-url <url>] [--relay-url <url>] [--musesight-url <url>]',
  '  [--status-url <url>] [--announce-to <slug>] [--admin-token-file <path>]',
  '  [--webhook-secret-out <path>] [--dry-run] [--json]',
].join(' ');

function parseArgs(argv) {
  const out = { capabilities: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--json') { out.json = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }

    let v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (a.startsWith('--')) {
      v = argv[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      i++;
    } else {
      return { error: `unknown argument ${a}` };
    }

    if (a === '--agent') out.agent = v;
    else if (a === '--project') out.project = v;
    else if (a === '--display-name') out.displayName = v;
    else if (a === '--role') out.role = v;
    else if (a === '--host') out.host = v;
    else if (a === '--capabilities') {
      out.capabilities = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--webhook-url') out.webhookUrl = v;
    else if (a === '--relay-url') out.relayUrl = v;
    else if (a === '--musesight-url') out.musesightUrl = v;
    else if (a === '--status-url') out.statusUrl = v;
    else if (a === '--announce-to') out.announceTo = v;
    else if (a === '--admin-token-file') out.adminTokenFile = v;
    else if (a === '--webhook-secret-out') out.webhookSecretOut = v;
    else return { error: `unknown option ${a}` };
  }
  return out;
}

async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const parsed = parseArgs(argv || []);
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`roostr onboard: ${parsed.error}\n`);
    return 2;
  }
  if (!parsed.agent) {
    stderr.write('roostr onboard: --agent <slug> is required\n');
    return 2;
  }

  let res;
  try {
    res = await runOnboard(parsed, deps);
  } catch (err) {
    stderr.write(`roostr onboard: ${err.message}\n`);
    return 1;
  }

  if (parsed.json) {
    stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    stdout.write(`onboard: ${res.plan.agent} (${res.plan.project})\n`);
    stdout.write(`bank:    ${res.plan.bankId}\n`);
    stdout.write(`status:  ${res.ok ? 'ok' : 'incomplete'}\n`);
    if (Array.isArray(res.errors) && res.errors.length > 0) {
      for (const e of res.errors) stdout.write(`error:   ${e}\n`);
    }
  }
  return res.ok ? 0 : 1;
}

module.exports = {
  CANONICAL_PAGES,
  isOrchestratorRole,
  sanitizeSlug,
  validateSlug,
  bankIdForProject,
  canonicalPageSpecs,
  charterMemoryBlock,
  checkSkillInstalled,
  shouldAutoOnboard,
  runOnboard,
  parseArgs,
  main,
};
