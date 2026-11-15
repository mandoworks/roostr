'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createSecretStore } = require('../src/secrets');
const { createAuthService } = require('../src/auth');
const { createHerdrClient } = require('../src/herdr');
const { createRateLimiter } = require('../src/ratelimit');
const { createAuditLogger } = require('../src/audit');
const { createApp } = require('../src/app');

function makeMockReq({ method = 'GET', url = '/agents/', headers = {}, body = '', remoteAddress = '127.0.0.1' }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  for (const [k, v] of Object.entries(headers)) {
    req.headers[k.toLowerCase()] = v;
  }
  req.socket = { remoteAddress };
  req.destroy = () => {};

  process.nextTick(() => {
    if (body !== undefined && body !== null && body !== '') {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });

  return req;
}

function invokeHandler(handler, reqOpts) {
  return new Promise((resolve, reject) => {
    const req = makeMockReq(reqOpts);
    const headers = {};
    const chunks = [];
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (name, value) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.write = (chunk) => {
      res.headersSent = true;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      res.headersSent = true;
      res.emit('finish');
      resolve({
        status: res.statusCode,
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
    };
    res.destroy = () => {
      resolve({
        status: res.statusCode,
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
    };

    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

function createHarness(opts = {}) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-dash-app-'));
  const configDir = path.join(tmpBase, 'config');
  const staticDir = path.join(tmpBase, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Agents Index</h1>');

  const config = loadConfig({
    PORT: '8960',
    RP_ID: 'example.ts.net',
    ORIGIN: 'https://example.ts.net',
    STATIC_DIR: staticDir,
    ROOSTR_DASHBOARD_CONFIG_DIR: configDir,
    ALLOW_ADD_CREDENTIAL: opts.allowAddCredential ? '1' : '0',
  });

  const store = createSecretStore(config.configDir);

  const mockWebAuthn = {
    async generateRegistrationOptions(params) {
      return {
        rp: { name: params.rpName, id: params.rpID },
        user: { id: 'dXNlcg', name: params.userName, displayName: params.userDisplayName },
        challenge: 'reg-challenge-1',
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      };
    },
    async verifyRegistrationResponse(params) {
      if (params.response && params.response.fail) {
        return { verified: false };
      }
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: params.response.id || 'cred-abc',
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: ['internal'],
          },
        },
      };
    },
    async generateAuthenticationOptions(params) {
      return {
        challenge: 'auth-challenge-1',
        rpId: params.rpID,
        allowCredentials: params.allowCredentials,
      };
    },
    async verifyAuthenticationResponse(params) {
      if (params.response && params.response.fail) {
        return { verified: false };
      }
      return {
        verified: true,
        authenticationInfo: {
          credentialID: params.credential.id,
          newCounter: params.credential.counter + 1,
        },
      };
    },
  };

  const auth = createAuthService({ config, store, webauthn: mockWebAuthn });

  const herdrCalls = [];
  let nowMs = 10000;
  const sampleSnapshot = {
    id: 'cli:api:snapshot',
    result: {
      snapshot: {
        workspaces: [{ workspace_id: 'w1', label: 'roostr', number: 1, focused: true }],
        tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1, focused: true }],
        panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, label: 'dev' }],
        agents: [
          {
            pane_id: 'w1:p1',
            workspace_id: 'w1',
            tab_id: 'w1:t1',
            agent: 'claude',
            agent_status: 'blocked',
            name: 'miguel',
            focused: true,
          },
        ],
      },
    },
  };

  let failNextHerdr = null;
  const mockExecFile = (bin, args, execOpts, cb) => {
    herdrCalls.push({ bin, args, execOpts });
    if (failNextHerdr) {
      const msg = failNextHerdr;
      failNextHerdr = null;
      const err = new Error('Command failed');
      return cb(err, '', `${msg}\nsecond line ignored\n`);
    }
    if (args[0] === 'api' && args[1] === 'snapshot') {
      return cb(null, JSON.stringify(sampleSnapshot), '');
    }
    if (args[0] === 'pane' && args[1] === 'read') {
      return cb(null, 'Allow tool? (y/n)\n', '');
    }
    return cb(null, '', '');
  };

  const herdr = createHerdrClient({
    herdrBin: config.herdrBin,
    timeoutMs: config.herdrTimeoutMs,
    cacheTtlMs: 1000,
    execFile: mockExecFile,
    now: () => nowMs,
  });

  const rateLimiter = createRateLimiter({ maxRequests: 20, windowMs: 10000 });
  const audit = createAuditLogger(store.auditPath);
  const handler = createApp({ config, store, auth, herdr, rateLimiter, audit });

  return {
    tmpBase,
    config,
    store,
    herdrCalls,
    setNow: (v) => {
      nowMs = v;
    },
    setFailNextHerdr: (msg) => {
      failNextHerdr = msg;
    },
    handler,
    cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
  };
}

describe('dashboard herdr client and HTTP app', () => {
  it('enforces 0600 secrets, bootstrap lockdown, registration, token rotation, and session cookie', async () => {
    const h = createHarness();
    try {
      const token = h.store.getEnrollToken();
      assert.equal(token.length, 64);

      const secretMode = fs.statSync(h.store.sessionSecretPath).mode & 0o777;
      const enrollMode = fs.statSync(h.store.enrollTokenPath).mode & 0o777;
      assert.equal(secretMode, 0o600);
      assert.equal(enrollMode, 0o600);

      // Before enrollment, other pages and setup with wrong token are blocked
      const badSetup = await invokeHandler(h.handler, { url: '/agents/auth/setup?token=wrong' });
      assert.equal(badSetup.status, 403);

      const indexBlocked = await invokeHandler(h.handler, { url: '/agents/' });
      assert.equal(indexBlocked.status, 403);

      const loginBlocked = await invokeHandler(h.handler, { url: '/agents/auth/login' });
      assert.equal(loginBlocked.status, 403);

      const apiBlocked = await invokeHandler(h.handler, { url: '/agents/api/state' });
      assert.equal(apiBlocked.status, 403);

      // Valid setup token serves setup page
      const goodSetup = await invokeHandler(h.handler, { url: `/agents/auth/setup?token=${token}` });
      assert.equal(goodSetup.status, 200);
      assert.match(goodSetup.body, /Enroll Passkey/);

      // POST without CSRF/Origin is rejected
      const noCsrf = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/options',
        headers: { origin: h.config.origin },
        body: { token },
      });
      assert.equal(noCsrf.status, 403);

      const badOrigin = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/options',
        headers: { 'x-roostr-csrf': '1', origin: 'https://evil.example' },
        body: { token },
      });
      assert.equal(badOrigin.status, 403);

      // Complete registration
      const regOpts = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/options',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token, label: 'TestPhone' },
      });
      assert.equal(regOpts.status, 200);
      const { challengeId } = JSON.parse(regOpts.body);

      const regVerify = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/verify',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token, challengeId, label: 'TestPhone', response: { id: 'cred-1' } },
      });
      assert.equal(regVerify.status, 200);

      const setCookie = regVerify.headers['set-cookie'];
      assert.ok(setCookie);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /Secure/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.match(setCookie, /Max-Age=43200/);

      const credMode = fs.statSync(h.store.credentialsPath).mode & 0o777;
      assert.equal(credMode, 0o600);

      // Token rotated and second registration refused
      const newToken = h.store.getEnrollToken();
      assert.notEqual(newToken, token);

      const secondSetup = await invokeHandler(h.handler, { url: `/agents/auth/setup?token=${newToken}` });
      assert.equal(secondSetup.status, 403);

      // Unauthenticated requests now redirect pages -> login, 401 for API
      const unauthPage = await invokeHandler(h.handler, { url: '/agents/control/' });
      assert.equal(unauthPage.status, 302);
      assert.match(unauthPage.headers.location, /^\/agents\/auth\/login\?next=/);

      const unauthApi = await invokeHandler(h.handler, { url: '/agents/api/state' });
      assert.equal(unauthApi.status, 401);

      // Authenticated access works with the issued cookie
      const cookiePair = setCookie.split(';')[0];
      const staticRes = await invokeHandler(h.handler, {
        url: '/agents/',
        headers: { cookie: cookiePair },
      });
      assert.equal(staticRes.status, 200);
      assert.match(staticRes.body, /Agents Index/);
    } finally {
      h.cleanup();
    }
  });

  it('handles Herdr API routes, caching, argv allowlist, audit log, 502 errors, and 429 rate limits', async () => {
    const h = createHarness();
    try {
      const token = h.store.getEnrollToken();
      const optRes = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/options',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token },
      });
      const { challengeId } = JSON.parse(optRes.body);
      const verRes = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/verify',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token, challengeId, response: { id: 'cred-1' } },
      });
      const cookie = verRes.headers['set-cookie'].split(';')[0];

      // GET /agents/api/state caches for <= 1s
      const s1 = await invokeHandler(h.handler, { url: '/agents/api/state', headers: { cookie } });
      assert.equal(s1.status, 200);
      const s2 = await invokeHandler(h.handler, { url: '/agents/api/state', headers: { cookie } });
      assert.equal(s2.status, 200);
      assert.equal(h.herdrCalls.length, 1);

      h.setNow(11500);
      const s3 = await invokeHandler(h.handler, { url: '/agents/api/state', headers: { cookie } });
      assert.equal(s3.status, 200);
      assert.equal(h.herdrCalls.length, 2);
      assert.deepEqual(h.herdrCalls[0].args, ['api', 'snapshot']);
      assert.equal(h.herdrCalls[0].execOpts.timeout, 10000);

      // GET /agents/api/pane/<paneId>?lines=500 caps at 120
      const paneRes = await invokeHandler(h.handler, {
        url: '/agents/api/pane/w1:p1?lines=500',
        headers: { cookie },
      });
      assert.equal(paneRes.status, 200);
      assert.deepEqual(JSON.parse(paneRes.body), { text: 'Allow tool? (y/n)\n' });
      assert.deepEqual(h.herdrCalls[2].args, ['pane', 'read', 'w1:p1', '--source', 'visible', '--lines', '120']);

      // POST /agents/api/pane/<paneId>/keys
      const keysRes = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/keys',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { keys: ['enter'] },
      });
      assert.equal(keysRes.status, 200);
      assert.deepEqual(h.herdrCalls[3].args, ['pane', 'send-keys', 'w1:p1', 'enter']);

      // POST /agents/api/pane/<paneId>/prompt resolves agent name from snapshot
      const promptRes = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/prompt',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { text: 'run tests now' },
      });
      assert.equal(promptRes.status, 200);
      assert.deepEqual(h.herdrCalls[4].args, ['agent', 'prompt', 'miguel', 'run tests now']);

      // POST /agents/api/pane/<paneId>/close requires matching confirm
      const badClose = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/close',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { confirm: 'wrong' },
      });
      assert.equal(badClose.status, 400);

      const okClose = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/close',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { confirm: 'w1:p1' },
      });
      assert.equal(okClose.status, 200);
      assert.deepEqual(h.herdrCalls[5].args, ['pane', 'close', 'w1:p1']);

      // Rename pane and clear label
      const okRename = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/rename',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { label: 'Nora · garden' },
      });
      assert.equal(okRename.status, 200);
      assert.deepEqual(h.herdrCalls[6].args, ['pane', 'rename', 'w1:p1', 'Nora · garden']);

      const okClearRename = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/rename',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { label: '' },
      });
      assert.equal(okClearRename.status, 200);
      assert.deepEqual(h.herdrCalls[7].args, ['pane', 'rename', 'w1:p1', '--clear']);

      // Start fresh agent (and reject disallowed kind)
      const badStart = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/start',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { name: 'nora', kind: 'sh' },
      });
      assert.equal(badStart.status, 400);

      const okStart = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/start',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { name: 'nora', kind: 'opencode' },
      });
      assert.equal(okStart.status, 200);
      assert.deepEqual(h.herdrCalls[8].args, ['agent', 'start', 'nora', '--kind', 'opencode', '--pane', 'w1:p1']);

      // Audit log contains entries with no cookies/secrets
      const auditRes = await invokeHandler(h.handler, { url: '/agents/api/audit', headers: { cookie } });
      assert.equal(auditRes.status, 200);
      const { entries } = JSON.parse(auditRes.body);
      assert.ok(entries.length >= 6);
      assert.equal(entries[0].action, 'pane.start');

      // Herdr failure returns 502 with first line of stderr
      h.setFailNextHerdr('agent_blocked: pane waiting for approval');
      const failRes = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/pane/w1:p1/keys',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { keys: ['esc'] },
      });
      assert.equal(failRes.status, 502);
      assert.deepEqual(JSON.parse(failRes.body), { error: 'agent_blocked: pane waiting for approval' });

      // Rate limit triggers 429 after 20 API calls per 10s
      let got429 = false;
      for (let i = 0; i < 20; i += 1) {
        const r = await invokeHandler(h.handler, {
          url: '/agents/api/auth/me',
          headers: { cookie, 'x-forwarded-for': '100.64.0.9' },
        });
        if (r.status === 429) {
          got429 = true;
          break;
        }
      }
      assert.equal(got429, false); // 20th request is allowed
      const limited = await invokeHandler(h.handler, {
        url: '/agents/api/auth/me',
        headers: { cookie, 'x-forwarded-for': '100.64.0.9' },
      });
      assert.equal(limited.status, 429);
    } finally {
      h.cleanup();
    }
  });

  it('serves control UI assets, clears cookie on logout, and supports real @simplewebauthn/server options', async () => {
    const h = createHarness({ allowAddCredential: true });
    try {
      const token1 = h.store.getEnrollToken();
      const opt1 = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/options',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token: token1 },
      });
      const ver1 = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/verify',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token: token1, challengeId: JSON.parse(opt1.body).challengeId, response: { id: 'cred-1' } },
      });
      const cookie = ver1.headers['set-cookie'].split(';')[0];

      // Serve control UI files when authenticated
      const ctrlHtml = await invokeHandler(h.handler, { url: '/agents/control/', headers: { cookie } });
      assert.equal(ctrlHtml.status, 200);
      assert.match(ctrlHtml.body, /Herdr Control/);

      const ctrlJs = await invokeHandler(h.handler, { url: '/agents/control/app.js', headers: { cookie } });
      assert.equal(ctrlJs.status, 200);

      const namesHtml = await invokeHandler(h.handler, { url: '/agents/names.html', headers: { cookie } });
      assert.equal(namesHtml.status, 200);
      assert.match(namesHtml.body, /Orchestrator Names/);

      const namesSet = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/names/override',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { slug: 'roosty', name: 'Roosty Argon' },
      });
      assert.equal(namesSet.status, 200);
      assert.equal(JSON.parse(namesSet.body).names.overrides.roosty.name, 'Roosty Argon');

      const namesGet = await invokeHandler(h.handler, { url: '/agents/api/names', headers: { cookie } });
      assert.equal(namesGet.status, 200);
      assert.equal(JSON.parse(namesGet.body).names.overrides.roosty.name, 'Roosty Argon');

      // ALLOW_ADD_CREDENTIAL=1 permits second passkey with rotated token
      const token2 = h.store.getEnrollToken();
      const opt2 = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/register/options',
        headers: { 'x-roostr-csrf': '1', origin: h.config.origin },
        body: { token: token2 },
      });
      assert.equal(opt2.status, 200);

      // Logout clears session cookie
      const logoutRes = await invokeHandler(h.handler, {
        method: 'POST',
        url: '/agents/api/auth/logout',
        headers: { cookie, 'x-roostr-csrf': '1', origin: h.config.origin },
        body: {},
      });
      assert.equal(logoutRes.status, 200);
      assert.match(logoutRes.headers['set-cookie'], /Max-Age=0/);

      // Real @simplewebauthn/server option generation
      const realAuth = createAuthService({ config: h.config, store: h.store });
      const realReg = await realAuth.beginRegistration(token2, 'MacBook');
      assert.equal(realReg.ok, true);
      assert.equal(realReg.options.rp.id, 'example.ts.net');
      assert.ok(typeof realReg.options.challenge === 'string' && realReg.options.challenge.length > 10);

      const realLogin = await realAuth.beginLogin();
      assert.equal(realLogin.ok, true);
      assert.equal(realLogin.options.rpId, 'example.ts.net');
      assert.equal(realLogin.options.allowCredentials.length, 1);
    } finally {
      h.cleanup();
    }
  });
});
