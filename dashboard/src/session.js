'use strict';

const crypto = require('crypto');

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'roostr_session';

function signSession(claims, secret, opts = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('session secret is required');
  }
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_SESSION_TTL_MS;
  const payload = {
    sub: claims.sub || 'pio',
    credId: claims.credId || '',
    label: claims.label || 'Passkey',
    iat: nowMs,
    exp: nowMs + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64, 'utf8')
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySession(token, secret, opts = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) {
    return null;
  }
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64, 'utf8')
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return null;
  }

  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  if (nowMs >= payload.exp) {
    return null;
  }
  if (payload.iat > nowMs + 60000) {
    return null;
  }

  return payload;
}

function parseCookies(cookieHeader) {
  const result = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    return result;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name && !(name in result)) {
      result[name] = val;
    }
  }
  return result;
}

function formatSessionCookie(token, maxAgeSeconds = 43200, name = COOKIE_NAME) {
  return `${name}=${token}; Path=/agents; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function formatClearSessionCookie(name = COOKIE_NAME) {
  return `${name}=; Path=/agents; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_SESSION_TTL_MS,
  signSession,
  verifySession,
  parseCookies,
  formatSessionCookie,
  formatClearSessionCookie,
};
