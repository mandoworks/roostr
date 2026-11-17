'use strict';

const fs = require('fs');
const path = require('path');
const {
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
} = require('./validate');
const {
  COOKIE_NAME,
  signSession,
  verifySession,
  parseCookies,
  formatSessionCookie,
  formatClearSessionCookie,
} = require('./session');
const { HerdrError, resolveAgentTargetFromSnapshot } = require('./herdr');
const { createNamesStore } = require('./names');
const { getRecoverySnapshot, captureBackups, restoreWorkspace } = require('./sessions-bridge');
const { getMuseSnapshot, sendPioRelayMessage, fetchPioRelayMessages } = require('./muse');

const MAX_JSON_BYTES = 64 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function getClientIp(req) {
  const remote = (req.socket && req.socket.remoteAddress) || 'unknown';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (isLoopback) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
    }
  }
  return remote;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  setSecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(body);
}

function sendRawJson(res, statusCode, jsonString) {
  res.statusCode = statusCode;
  setSecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(jsonString);
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  setSecurityHeaders(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendRedirect(res, location) {
  res.statusCode = 302;
  setSecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', location);
  res.end();
}

function sendFile(res, filePath, isHead = false) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  res.statusCode = 200;
  setSecurityHeaders(res);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', ext === '.html' ? 'private, no-cache' : 'private, max-age=300');
  if (isHead) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendText(res, 500, 'read error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        settled = true;
        const err = new Error('request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        return resolve({});
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object');
          err.statusCode = 400;
          return reject(err);
        }
        resolve(parsed);
      } catch {
        const err = new Error('invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function safeNextPath(rawNext) {
  if (typeof rawNext !== 'string') return '/agents/control/';
  if (!rawNext.startsWith('/agents/') || rawNext.startsWith('//') || /[\r\n\\]/.test(rawNext)) {
    return '/agents/control/';
  }
  return rawNext;
}

function decodeSubpath(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function createApp({ config, store, auth, herdr, rateLimiter, audit, names, fetch: fetchImpl, execFile: execFileImpl }) {
  const authPublicDir = path.join(config.publicDir, 'auth');
  const controlPublicDir = path.join(config.publicDir, 'control');
  const namesPublicDir = path.join(config.publicDir, 'names');
  const namesStore = names || createNamesStore({
    namesPath: config.namesPath || path.join(config.staticDir, 'names.json'),
    staticDir: config.staticDir,
    statusPath: config.statusPath || '',
  });

  function getSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.cookieName || COOKIE_NAME];
    if (!token) return null;
    return verifySession(token, store.getSessionSecret());
  }

  function issueSessionHeader(credential) {
    const token = signSession(
      {
        sub: 'pio',
        credId: credential.id,
        label: credential.label || 'Passkey',
      },
      store.getSessionSecret(),
      { ttlMs: config.sessionTtlMs }
    );
    return formatSessionCookie(token, Math.floor(config.sessionTtlMs / 1000), config.cookieName);
  }

  async function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendText(res, 400, 'bad request');
    }

    const pathname = url.pathname;
    if (pathname !== '/agents' && !pathname.startsWith('/agents/')) {
      return sendText(res, 404, 'not found');
    }

    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      return sendText(res, 405, 'method not allowed');
    }

    const isHead = method === 'HEAD';
    const isApi = pathname.startsWith('/agents/api/');
    const clientIp = getClientIp(req);

    if (isApi) {
      const rl = rateLimiter.check(clientIp);
      if (!rl.allowed) {
        return sendJson(
          res,
          429,
          { error: 'rate limit exceeded' },
          { 'Retry-After': String(rl.retryAfterSec) }
        );
      }
    }

    if (method === 'POST') {
      if (req.headers['x-roostr-csrf'] !== '1' || req.headers['origin'] !== config.origin) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
    }

    const enrolled = auth.hasCredentials();

    // Static assets for auth UI (CSS/JS only, never HTML pages).
    if ((method === 'GET' || isHead) && (pathname === '/agents/auth/auth.css' || pathname === '/agents/auth/auth.js')) {
      const file = resolveStaticPath(authPublicDir, pathname.slice('/agents/auth/'.length));
      if (!file) return sendText(res, 404, 'not found');
      return sendFile(res, file, isHead);
    }

    // Bootstrap / Registration endpoints
    if (pathname === '/agents/auth/setup' && (method === 'GET' || isHead)) {
      const token = url.searchParams.get('token') || '';
      const gate = auth.canRegister(token);
      if (!gate.ok) {
        return sendText(res, gate.status, gate.error);
      }
      const file = resolveStaticPath(authPublicDir, 'setup.html');
      if (!file) return sendText(res, 404, 'setup page missing');
      return sendFile(res, file, isHead);
    }

    if (pathname === '/agents/api/auth/register/options' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const result = await auth.beginRegistration(body.token || '', body.label);
      if (!result.ok) {
        audit.log({ ip: clientIp, action: 'auth.enroll_denied', summary: result.error, ok: false });
        return sendJson(res, result.status, { error: result.error });
      }
      return sendJson(res, 200, { challengeId: result.challengeId, options: result.options });
    }

    if (pathname === '/agents/api/auth/register/verify' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const result = await auth.finishRegistration(
        body.token || '',
        body.challengeId,
        body.response,
        body.label
      );
      if (!result.ok) {
        audit.log({ ip: clientIp, action: 'auth.enroll_failed', summary: result.error, ok: false });
        return sendJson(res, result.status, { error: result.error });
      }
      audit.log({
        ip: clientIp,
        action: 'auth.enroll',
        summary: `label=${result.credential.label}`,
        ok: true,
      });
      res.setHeader('Set-Cookie', issueSessionHeader(result.credential));
      return sendJson(res, 200, { ok: true, redirect: '/agents/control/' });
    }

    // If no credentials exist yet, no other page or endpoint is reachable.
    if (!enrolled) {
      if (isApi) {
        return sendJson(res, 403, { error: 'enrollment required' });
      }
      return sendText(res, 403, 'Enrollment required. Open /agents/auth/setup?token=...');
    }

    // Login & Logout routes (when enrolled)
    if (pathname === '/agents/auth/login' && (method === 'GET' || isHead)) {
      const existing = getSession(req);
      if (existing) {
        return sendRedirect(res, safeNextPath(url.searchParams.get('next')));
      }
      const file = resolveStaticPath(authPublicDir, 'login.html');
      if (!file) return sendText(res, 404, 'login page missing');
      return sendFile(res, file, isHead);
    }

    if (pathname === '/agents/api/auth/login/options' && method === 'POST') {
      const result = await auth.beginLogin();
      if (!result.ok) {
        return sendJson(res, result.status, { error: result.error });
      }
      return sendJson(res, 200, { challengeId: result.challengeId, options: result.options });
    }

    if (pathname === '/agents/api/auth/login/verify' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const result = await auth.finishLogin(body.challengeId, body.response);
      if (!result.ok) {
        audit.log({ ip: clientIp, action: 'auth.login_failed', summary: result.error, ok: false });
        return sendJson(res, result.status, { error: result.error });
      }
      audit.log({
        ip: clientIp,
        action: 'auth.login',
        summary: `label=${result.credential.label}`,
        ok: true,
      });
      res.setHeader('Set-Cookie', issueSessionHeader(result.credential));
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/agents/api/auth/logout' && method === 'POST') {
      const session = getSession(req);
      if (session) {
        audit.log({ ip: clientIp, action: 'auth.logout', summary: `sub=${session.sub}`, ok: true });
      }
      res.setHeader('Set-Cookie', formatClearSessionCookie(config.cookieName));
      return sendJson(res, 200, { ok: true });
    }

    // All remaining routes require a valid session cookie.
    const session = getSession(req);
    if (!session) {
      if (isApi) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const next = encodeURIComponent(safeNextPath(pathname + url.search));
      return sendRedirect(res, `/agents/auth/login?next=${next}`);
    }

    // Authenticated API routes
    if (pathname === '/agents/api/auth/me' && method === 'GET') {
      return sendJson(res, 200, {
        authenticated: true,
        user: session.sub,
        label: session.label,
        credId: session.credId,
        expiresAt: new Date(session.exp).toISOString(),
      });
    }

    if (pathname === '/agents/api/state' && method === 'GET') {
      try {
        const raw = await herdr.snapshotRaw();
        return sendRawJson(res, 200, raw);
      } catch (err) {
        return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
      }
    }

    if (pathname === '/agents/api/audit' && method === 'GET') {
      return sendJson(res, 200, { entries: audit.readRecent(20) });
    }

    if (pathname === '/agents/api/sessions' && method === 'GET') {
      return sendJson(res, 200, getRecoverySnapshot({
        roostrStateDir: config.roostrStateDir,
        roostrRepoDir: config.roostrRepoDir,
      }));
    }

    if (pathname === '/agents/api/backups/capture' && method === 'POST') {
      const capRes = await captureBackups({
        roostrRepoDir: config.roostrRepoDir,
        roostrStateDir: config.roostrStateDir,
        execFileImpl,
      });
      if (!capRes.ok) {
        audit.log({
          ip: clientIp,
          action: 'backups.capture',
          summary: `err=${capRes.error}`,
          ok: false,
        });
        return sendJson(res, capRes.status || 502, { error: capRes.error });
      }
      audit.log({
        ip: clientIp,
        action: 'backups.capture',
        summary: 'captured',
        ok: true,
      });
      return sendJson(res, 200, { ok: true, captured: capRes.captured });
    }

    if (pathname === '/agents/api/sessions/restore' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const restRes = await restoreWorkspace({
        roostrRepoDir: config.roostrRepoDir,
        roostrStateDir: config.roostrStateDir,
        workspace: body.workspace,
        mode: body.mode,
        version: body.version,
        layout: body.layout,
        execFileImpl,
      });
      if (!restRes.ok) {
        if ((restRes.status || 502) !== 400) {
          audit.log({
            ip: clientIp,
            action: 'sessions.restore',
            summary: `workspace=${String(body.workspace || '')} mode=${String(body.mode || 'sessions')} err=${restRes.error}`,
            ok: false,
          });
        }
        return sendJson(res, restRes.status || 502, { error: restRes.error });
      }
      audit.log({
        ip: clientIp,
        action: 'sessions.restore',
        summary: `workspace=${String(body.workspace).trim()} mode=${restRes.mode}`,
        ok: true,
      });
      return sendJson(res, 200, restRes);
    }

    if (pathname === '/agents/api/muse' && method === 'GET') {
      return sendJson(res, 200, getMuseSnapshot({
        staticDir: config.staticDir,
        statusPath: config.statusPath,
        namesStore,
      }));
    }

    if (pathname === '/agents/api/muse/message' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const mv = validateMuseMessage(body);
      if (!mv.ok) {
        return sendJson(res, 400, { error: mv.error });
      }
      const relayRes = await sendPioRelayMessage({
        piorelayBase: config.piorelayBase,
        from: session.label || session.sub || 'pio',
        to: mv.value.to,
        subject: mv.value.subject,
        body: mv.value.body,
        project: mv.value.project,
        threadId: mv.value.threadId,
        fetchImpl,
      });
      if (!relayRes.ok) {
        audit.log({
          ip: clientIp,
          action: 'muse.message',
          summary: `to=${mv.value.to} err=${relayRes.error}`,
          ok: false,
        });
        return sendJson(res, relayRes.status || 502, { error: relayRes.error });
      }
      audit.log({
        ip: clientIp,
        action: 'muse.message',
        summary: `to=${mv.value.to} subject=${mv.value.subject.slice(0, 40)}`,
        ok: true,
      });
      return sendJson(res, 200, { ok: true, relay: relayRes.result });
    }

    if (pathname === '/agents/api/muse/messages' && method === 'GET') {
      const agentParam = url.searchParams.get('agent') || '';
      if (!/^[a-z0-9-]{1,32}$/.test(agentParam)) {
        return sendJson(res, 400, { error: 'invalid agent' });
      }
      let limitVal = 20;
      if (url.searchParams.has('limit') && url.searchParams.get('limit') !== '') {
        const rawLimit = url.searchParams.get('limit');
        if (!/^\d+$/.test(rawLimit)) {
          return sendJson(res, 400, { error: 'limit must be between 1 and 50' });
        }
        limitVal = Number.parseInt(rawLimit, 10);
        if (limitVal < 1 || limitVal > 50) {
          return sendJson(res, 400, { error: 'limit must be between 1 and 50' });
        }
      }
      let projectVal = null;
      if (url.searchParams.has('project')) {
        const rawProject = url.searchParams.get('project') || '';
        if (/[\x00-\x1f\x7f-\x9f]/.test(rawProject) || rawProject.length > 64) {
          return sendJson(res, 400, { error: 'invalid project' });
        }
        projectVal = rawProject.trim() || null;
      }
      const relayRes = await fetchPioRelayMessages({
        piorelayBase: config.piorelayBase,
        agent: agentParam,
        project: projectVal,
        limit: limitVal,
        fetchImpl,
      });
      if (!relayRes.ok) {
        return sendJson(res, relayRes.status || 502, { error: relayRes.error });
      }
      return sendJson(res, 200, {
        ok: true,
        agent: relayRes.agent,
        messages: relayRes.messages,
      });
    }

    if (pathname === '/agents/api/names' && method === 'GET') {
      return sendJson(res, 200, namesStore.snapshot());
    }

    if (pathname === '/agents/api/names/override' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const resMap = namesStore.setOverride(body.slug, body.name, session.label || session.sub);
      if (!resMap.ok) {
        return sendJson(res, resMap.status, { error: resMap.error });
      }
      const cleared = !String(body.name || '').trim();
      audit.log({
        ip: clientIp,
        action: 'names.override',
        summary: `slug=${body.slug} name=${cleared ? '(cleared)' : String(body.name).trim()}`,
        ok: true,
      });
      return sendJson(res, 200, resMap);
    }

    if (pathname === '/agents/api/names/orchestrator' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      if (typeof body.enabled !== 'boolean') {
        return sendJson(res, 400, { error: 'enabled must be a boolean' });
      }
      const resMap = namesStore.setOrchestrator(body.slug, body.enabled, session.label || session.sub);
      if (!resMap.ok) {
        return sendJson(res, resMap.status, { error: resMap.error });
      }
      audit.log({
        ip: clientIp,
        action: 'names.orchestrator',
        summary: `slug=${body.slug} enabled=${body.enabled}`,
        ok: true,
      });
      return sendJson(res, 200, resMap);
    }

    if (pathname === '/agents/api/names/revert' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
      const resMap = namesStore.revertHistory(body.historyId || null, session.label || session.sub);
      if (!resMap.ok) {
        return sendJson(res, resMap.status, { error: resMap.error });
      }
      audit.log({
        ip: clientIp,
        action: 'names.revert',
        summary: `slug=${resMap.reverted.slug}`,
        ok: true,
      });
      return sendJson(res, 200, resMap);
    }

    if (pathname.startsWith('/agents/api/pane/')) {
      const rest = pathname.slice('/agents/api/pane/'.length);
      const parts = rest.split('/');
      const decodedPaneId = decodeSubpath(parts[0] || '');
      const pv = validatePaneId(decodedPaneId);
      if (!pv.ok) {
        return sendJson(res, 400, { error: pv.error });
      }
      const paneId = pv.value;

      if (parts.length === 1 && method === 'GET') {
        const lv = validateLines(url.searchParams.get('lines'));
        if (!lv.ok) {
          return sendJson(res, 400, { error: lv.error });
        }
        try {
          const text = await herdr.readPane(paneId, lv.value);
          return sendJson(res, 200, { text });
        } catch (err) {
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      if (parts.length === 2 && parts[1] === 'keys' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { error: err.message });
        }
        const kv = validateKeys(body.keys);
        if (!kv.ok) {
          return sendJson(res, 400, { error: kv.error });
        }
        try {
          await herdr.sendKeys(paneId, kv.value);
          audit.log({
            ip: clientIp,
            action: 'pane.keys',
            paneId,
            summary: `keys=${kv.value.join(',')}`,
            ok: true,
          });
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          audit.log({
            ip: clientIp,
            action: 'pane.keys',
            paneId,
            summary: `keys=${kv.value.join(',')} err=${err.message}`,
            ok: false,
          });
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      if (parts.length === 2 && parts[1] === 'prompt' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { error: err.message });
        }
        const tv = validatePrompt(body.text);
        if (!tv.ok) {
          return sendJson(res, 400, { error: tv.error });
        }
        try {
          const snap = await herdr.getSnapshotObject();
          const targetName = resolveAgentTargetFromSnapshot(snap, paneId);
          if (!targetName) {
            return sendJson(res, 404, { error: 'pane has no active agent in snapshot' });
          }
          await herdr.promptAgent(targetName, tv.value);
          audit.log({
            ip: clientIp,
            action: 'pane.prompt',
            paneId,
            summary: `target=${targetName} len=${tv.value.length}`,
            ok: true,
          });
          return sendJson(res, 200, { ok: true, name: targetName });
        } catch (err) {
          audit.log({
            ip: clientIp,
            action: 'pane.prompt',
            paneId,
            summary: `len=${tv.value.length} err=${err.message}`,
            ok: false,
          });
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      if (parts.length === 2 && parts[1] === 'rename' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { error: err.message });
        }
        const lv = validatePaneLabel(body.label);
        if (!lv.ok) {
          return sendJson(res, 400, { error: lv.error });
        }
        try {
          await herdr.renamePane(paneId, lv.value);
          audit.log({
            ip: clientIp,
            action: 'pane.rename',
            paneId,
            summary: lv.value ? `label=${lv.value}` : 'cleared',
            ok: true,
          });
          return sendJson(res, 200, { ok: true, label: lv.value });
        } catch (err) {
          audit.log({
            ip: clientIp,
            action: 'pane.rename',
            paneId,
            summary: `err=${err.message}`,
            ok: false,
          });
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      if (parts.length === 2 && parts[1] === 'start' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { error: err.message });
        }
        const nv = validateAgentName(body.name);
        if (!nv.ok) {
          return sendJson(res, 400, { error: nv.error });
        }
        const kv = validateAgentKind(body.kind);
        if (!kv.ok) {
          return sendJson(res, 400, { error: kv.error });
        }
        const mv = validateOptionalModel(body.model);
        if (!mv.ok) {
          return sendJson(res, 400, { error: mv.error });
        }
        const ev = validateOptionalEffort(body.effort);
        if (!ev.ok) {
          return sendJson(res, 400, { error: ev.error });
        }
        const sv = validateOptionalSessionId(body.session);
        if (!sv.ok) {
          return sendJson(res, 400, { error: sv.error });
        }
        const startOpts = {
          model: mv.value,
          effort: ev.value,
          session: sv.value,
        };
        try {
          await herdr.startAgent(paneId, nv.value, kv.value, startOpts);
          audit.log({
            ip: clientIp,
            action: 'pane.start',
            paneId,
            summary: `name=${nv.value} kind=${kv.value}${mv.value ? ` model=${mv.value}` : ''}${ev.value ? ` effort=${ev.value}` : ''}${sv.value ? ` session=${sv.value}` : ''}`,
            ok: true,
          });
          return sendJson(res, 200, {
            ok: true,
            name: nv.value,
            kind: kv.value,
            model: mv.value,
            effort: ev.value,
            session: sv.value,
          });
        } catch (err) {
          audit.log({
            ip: clientIp,
            action: 'pane.start',
            paneId,
            summary: `name=${nv.value} kind=${kv.value} err=${err.message}`,
            ok: false,
          });
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      if (parts.length === 2 && parts[1] === 'split' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { error: err.message });
        }
        const dv = validateSplitDirection(body.direction);
        if (!dv.ok) {
          return sendJson(res, 400, { error: dv.error });
        }

        let cwdVal = null;
        if (body.cwd !== undefined && body.cwd !== null && body.cwd !== '') {
          if (typeof body.cwd !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(body.cwd)) {
            return sendJson(res, 400, { error: 'invalid cwd' });
          }
          const trimmedCwd = body.cwd.trim();
          if (trimmedCwd.startsWith('-')) {
            return sendJson(res, 400, { error: 'invalid cwd' });
          }
          if (trimmedCwd) {
            cwdVal = trimmedCwd;
          }
        }

        let startCfg = null;
        if (body.startAgent !== undefined && body.startAgent !== null) {
          if (typeof body.startAgent !== 'object' || Array.isArray(body.startAgent)) {
            return sendJson(res, 400, { error: 'startAgent must be an object' });
          }
          const sa = body.startAgent;
          const nv = validateAgentName(sa.name);
          if (!nv.ok) return sendJson(res, 400, { error: nv.error });
          const kv = validateAgentKind(sa.kind);
          if (!kv.ok) return sendJson(res, 400, { error: kv.error });
          const mv = validateOptionalModel(sa.model);
          if (!mv.ok) return sendJson(res, 400, { error: mv.error });
          const ev = validateOptionalEffort(sa.effort);
          if (!ev.ok) return sendJson(res, 400, { error: ev.error });
          const sv = validateOptionalSessionId(sa.session);
          if (!sv.ok) return sendJson(res, 400, { error: sv.error });
          startCfg = {
            name: nv.value,
            kind: kv.value,
            opts: { model: mv.value, effort: ev.value, session: sv.value },
          };
        }

        try {
          const splitResult = await herdr.splitPane(paneId, dv.value, cwdVal);
          const newPaneId = typeof splitResult === 'string'
            ? splitResult
            : (splitResult && splitResult.paneId) || null;
          if (startCfg && newPaneId) {
            await herdr.startAgent(newPaneId, startCfg.name, startCfg.kind, startCfg.opts);
          }
          audit.log({
            ip: clientIp,
            action: 'pane.split',
            paneId,
            summary: `direction=${dv.value}${newPaneId ? ` newPane=${newPaneId}` : ''}${startCfg ? ` start=${startCfg.name}:${startCfg.kind}` : ''}`,
            ok: true,
          });
          return sendJson(res, 200, { ok: true, paneId: newPaneId });
        } catch (err) {
          audit.log({
            ip: clientIp,
            action: 'pane.split',
            paneId,
            summary: `direction=${dv.value} err=${err.message}`,
            ok: false,
          });
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      if (parts.length === 2 && parts[1] === 'close' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { error: err.message });
        }
        if (body.confirm !== paneId) {
          return sendJson(res, 400, { error: 'confirm must match pane id' });
        }
        try {
          await herdr.closePane(paneId);
          audit.log({
            ip: clientIp,
            action: 'pane.close',
            paneId,
            summary: 'closed',
            ok: true,
          });
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          audit.log({
            ip: clientIp,
            action: 'pane.close',
            paneId,
            summary: `err=${err.message}`,
            ok: false,
          });
          return sendJson(res, err instanceof HerdrError ? 502 : 500, { error: err.message });
        }
      }

      return sendJson(res, 404, { error: 'not found' });
    }

    if (isApi) {
      return sendJson(res, 404, { error: 'not found' });
    }

    // Only GET/HEAD reach static serving
    if (method !== 'GET' && !isHead) {
      return sendText(res, 405, 'method not allowed');
    }

    if (pathname === '/agents') {
      return sendRedirect(res, '/agents/');
    }

    if (pathname === '/agents/control') {
      return sendRedirect(res, '/agents/control/');
    }

    if (pathname === '/agents/names.html') {
      const file = resolveStaticPath(namesPublicDir, 'index.html');
      if (!file) return sendText(res, 404, 'not found');
      return sendFile(res, file, isHead);
    }

    if (pathname.startsWith('/agents/names/')) {
      const decoded = decodeSubpath(pathname.slice('/agents/names/'.length));
      if (decoded === null) return sendText(res, 400, 'bad path');
      const file = resolveStaticPath(namesPublicDir, decoded);
      if (!file) return sendText(res, 404, 'not found');
      return sendFile(res, file, isHead);
    }

    if (pathname.startsWith('/agents/control/')) {
      const decoded = decodeSubpath(pathname.slice('/agents/control/'.length));
      if (decoded === null) return sendText(res, 400, 'bad path');
      const file = resolveStaticPath(controlPublicDir, decoded);
      if (!file) return sendText(res, 404, 'not found');
      return sendFile(res, file, isHead);
    }

    const decoded = decodeSubpath(pathname.slice('/agents/'.length));
    if (decoded === null) return sendText(res, 400, 'bad path');
    const staticFile = resolveStaticPath(config.staticDir, decoded);
    if (!staticFile) return sendText(res, 404, 'not found');
    return sendFile(res, staticFile, isHead);
  }

  return function requestListener(req, res) {
    Promise.resolve(handleRequest(req, res)).catch(() => {
      if (!res.headersSent) {
        sendText(res, 500, 'internal server error');
      } else {
        res.destroy();
      }
    });
  };
}

module.exports = { createApp, getClientIp, safeNextPath };
