'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { signSession, verifySession, parseCookies } = require('../src/session');

describe('session cookie signing', () => {
  const secret = 'a'.repeat(64);
  const now = 1_700_000_000_000;

  it('signs and verifies a valid session token', () => {
    const token = signSession(
      { sub: 'pio', credId: 'cred-1', label: 'Phone' },
      secret,
      { now, ttlMs: 12 * 60 * 60 * 1000 }
    );
    const claims = verifySession(token, secret, { now: now + 1000 });
    assert.ok(claims);
    assert.equal(claims.sub, 'pio');
    assert.equal(claims.credId, 'cred-1');
    assert.equal(claims.label, 'Phone');
  });

  it('rejects tampered payload, tampered signature, wrong secret, and malformed tokens', () => {
    const token = signSession({ sub: 'pio', credId: 'cred-1' }, secret, { now });
    const [payloadB64, sig] = token.split('.');

    // Tamper payload
    const fakePayload = Buffer.from(
      JSON.stringify({ sub: 'admin', credId: 'cred-1', iat: now, exp: now + 999999 })
    ).toString('base64url');
    assert.equal(verifySession(`${fakePayload}.${sig}`, secret, { now }), null);

    // Tamper signature
    const flippedSig = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    assert.equal(verifySession(`${payloadB64}.${flippedSig}`, secret, { now }), null);

    // Wrong secret
    assert.equal(verifySession(token, 'b'.repeat(64), { now }), null);

    // Malformed
    assert.equal(verifySession('', secret, { now }), null);
    assert.equal(verifySession('nodot', secret, { now }), null);
    assert.equal(verifySession(`${payloadB64}.${sig}.extra`, secret, { now }), null);
    assert.equal(verifySession(null, secret, { now }), null);
  });

  it('rejects expired tokens', () => {
    const ttlMs = 1000;
    const token = signSession({ sub: 'pio' }, secret, { now, ttlMs });
    assert.ok(verifySession(token, secret, { now: now + 999 }));
    assert.equal(verifySession(token, secret, { now: now + 1000 }), null);
    assert.equal(verifySession(token, secret, { now: now + 5000 }), null);
  });

  it('parses cookie headers cleanly', () => {
    const cookies = parseCookies('foo=bar; roostr_session=abc.def; theme=dark');
    assert.deepEqual(cookies, {
      foo: 'bar',
      roostr_session: 'abc.def',
      theme: 'dark',
    });
  });
});
