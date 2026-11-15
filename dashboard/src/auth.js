'use strict';

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 100;

function sanitizeLabel(raw) {
  if (typeof raw !== 'string') return 'Passkey';
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  return cleaned || 'Passkey';
}

function createAuthService(opts) {
  const { config, store, webauthn } = opts;
  const rpId = config.rpId;
  const origin = config.origin;
  const allowAddCredential = Boolean(config.allowAddCredential);

  const api = webauthn || {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
  };

  const challenges = new Map();

  function pruneChallenges(nowMs = Date.now()) {
    for (const [id, entry] of challenges.entries()) {
      if (nowMs >= entry.expiresAt) {
        challenges.delete(id);
      }
    }
    while (challenges.size >= MAX_CHALLENGES) {
      const oldestKey = challenges.keys().next().value;
      if (!oldestKey) break;
      challenges.delete(oldestKey);
    }
  }

  function issueChallenge(type, challenge, extra = {}) {
    const nowMs = Date.now();
    pruneChallenges(nowMs);
    const challengeId = crypto.randomBytes(24).toString('base64url');
    challenges.set(challengeId, {
      type,
      challenge,
      expiresAt: nowMs + CHALLENGE_TTL_MS,
      ...extra,
    });
    return challengeId;
  }

  function consumeChallenge(challengeId, expectedType) {
    if (typeof challengeId !== 'string' || !challengeId) {
      return null;
    }
    const entry = challenges.get(challengeId);
    challenges.delete(challengeId);
    if (!entry || entry.type !== expectedType) {
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      return null;
    }
    return entry;
  }

  function hasCredentials() {
    return store.loadCredentials().length > 0;
  }

  function canRegister(token) {
    if (!store.verifyEnrollToken(token)) {
      return { ok: false, status: 403, error: 'invalid enrollment token' };
    }
    const creds = store.loadCredentials();
    if (creds.length > 0 && !allowAddCredential) {
      return { ok: false, status: 403, error: 'registration is closed' };
    }
    return { ok: true, creds };
  }

  async function beginRegistration(token, labelRaw) {
    const gate = canRegister(token);
    if (!gate.ok) {
      return gate;
    }
    const label = sanitizeLabel(labelRaw);
    const options = await api.generateRegistrationOptions({
      rpName: 'Roostr Agents',
      rpID: rpId,
      userName: 'pio',
      userDisplayName: 'Pio',
      attestationType: 'none',
      excludeCredentials: gate.creds.map((c) => ({
        id: c.id,
        transports: Array.isArray(c.transports) ? c.transports : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    const challengeId = issueChallenge('register', options.challenge, { label });
    return { ok: true, challengeId, options };
  }

  async function finishRegistration(token, challengeId, response, labelRaw) {
    const gate = canRegister(token);
    if (!gate.ok) {
      return gate;
    }
    const pending = consumeChallenge(challengeId, 'register');
    if (!pending) {
      return { ok: false, status: 400, error: 'invalid or expired challenge' };
    }
    if (!response || typeof response !== 'object') {
      return { ok: false, status: 400, error: 'missing registration response' };
    }

    let verification;
    try {
      verification = await api.verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      });
    } catch (err) {
      return { ok: false, status: 400, error: err.message || 'registration verification failed' };
    }

    if (!verification || !verification.verified || !verification.registrationInfo) {
      return { ok: false, status: 400, error: 'registration not verified' };
    }

    const { credential } = verification.registrationInfo;
    const creds = store.loadCredentials();
    if (creds.length > 0 && !allowAddCredential) {
      return { ok: false, status: 403, error: 'registration is closed' };
    }
    if (creds.some((c) => c.id === credential.id)) {
      return { ok: false, status: 409, error: 'credential already registered' };
    }

    const label = labelRaw !== undefined ? sanitizeLabel(labelRaw) : pending.label;
    const saved = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: Array.isArray(credential.transports) ? credential.transports : [],
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };

    creds.push(saved);
    store.saveCredentials(creds);
    store.rotateEnrollToken();

    return { ok: true, credential: saved };
  }

  async function beginLogin() {
    const creds = store.loadCredentials();
    if (creds.length === 0) {
      return { ok: false, status: 403, error: 'no passkey enrolled' };
    }
    const options = await api.generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: c.id,
        transports: Array.isArray(c.transports) ? c.transports : undefined,
      })),
    });
    const challengeId = issueChallenge('login', options.challenge);
    return { ok: true, challengeId, options };
  }

  async function finishLogin(challengeId, response) {
    const creds = store.loadCredentials();
    if (creds.length === 0) {
      return { ok: false, status: 403, error: 'no passkey enrolled' };
    }
    const pending = consumeChallenge(challengeId, 'login');
    if (!pending) {
      return { ok: false, status: 400, error: 'invalid or expired challenge' };
    }
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
      return { ok: false, status: 400, error: 'missing authentication response' };
    }

    const idx = creds.findIndex((c) => c.id === response.id);
    if (idx < 0) {
      return { ok: false, status: 401, error: 'unknown credential' };
    }
    const cred = creds[idx];

    let verification;
    try {
      verification = await api.verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: Array.isArray(cred.transports) ? cred.transports : undefined,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      return { ok: false, status: 401, error: err.message || 'authentication failed' };
    }

    if (!verification || !verification.verified || !verification.authenticationInfo) {
      return { ok: false, status: 401, error: 'authentication not verified' };
    }

    creds[idx] = {
      ...cred,
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date().toISOString(),
    };
    store.saveCredentials(creds);

    return { ok: true, credential: creds[idx] };
  }

  return {
    hasCredentials,
    canRegister,
    beginRegistration,
    finishRegistration,
    beginLogin,
    finishLogin,
  };
}

module.exports = { createAuthService, sanitizeLabel };
