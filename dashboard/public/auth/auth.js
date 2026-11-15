'use strict';

(function () {
  function b64uToUint8Array(b64u) {
    const padLen = (4 - (b64u.length % 4)) % 4;
    const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  function bufferToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function showStatus(msg, kind) {
    const el = document.getElementById('status-banner');
    if (!el) return;
    el.textContent = msg;
    el.className = `banner ${kind}`;
    el.hidden = false;
  }

  async function apiPost(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Roostr-CSRF': '1',
      },
      body: JSON.stringify(payload || {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('slow down');
      }
      const msg = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function decodeCreationOptions(opts) {
    const publicKey = Object.assign({}, opts);
    publicKey.challenge = b64uToUint8Array(opts.challenge);
    publicKey.user = Object.assign({}, opts.user, {
      id: b64uToUint8Array(opts.user.id),
    });
    if (Array.isArray(opts.excludeCredentials)) {
      publicKey.excludeCredentials = opts.excludeCredentials.map((c) =>
        Object.assign({}, c, { id: b64uToUint8Array(c.id) })
      );
    }
    return publicKey;
  }

  function decodeRequestOptions(opts) {
    const publicKey = Object.assign({}, opts);
    publicKey.challenge = b64uToUint8Array(opts.challenge);
    if (Array.isArray(opts.allowCredentials)) {
      publicKey.allowCredentials = opts.allowCredentials.map((c) =>
        Object.assign({}, c, { id: b64uToUint8Array(c.id) })
      );
    }
    return publicKey;
  }

  function serializeRegistration(cred) {
    const resp = cred.response;
    const transports = typeof resp.getTransports === 'function' ? resp.getTransports() : undefined;
    return {
      id: cred.id,
      rawId: bufferToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToB64u(resp.clientDataJSON),
        attestationObject: bufferToB64u(resp.attestationObject),
        transports,
      },
    };
  }

  function serializeAuthentication(cred) {
    const resp = cred.response;
    return {
      id: cred.id,
      rawId: bufferToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToB64u(resp.clientDataJSON),
        authenticatorData: bufferToB64u(resp.authenticatorData),
        signature: bufferToB64u(resp.signature),
        userHandle: resp.userHandle ? bufferToB64u(resp.userHandle) : undefined,
      },
    };
  }

  function safeNextTarget() {
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    if (next && next.startsWith('/agents/') && !next.startsWith('//')) {
      return next;
    }
    return '/agents/control/';
  }

  async function handleSetup(btn) {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const labelInput = document.getElementById('passkey-label');
    const label = labelInput ? labelInput.value : '';

    btn.disabled = true;
    try {
      const start = await apiPost('/agents/api/auth/register/options', { token, label });
      const cred = await navigator.credentials.create({
        publicKey: decodeCreationOptions(start.options),
      });
      if (!cred) {
        throw new Error('Passkey creation cancelled');
      }
      const result = await apiPost('/agents/api/auth/register/verify', {
        token,
        label,
        challengeId: start.challengeId,
        response: serializeRegistration(cred),
      });
      showStatus('Passkey enrolled. Redirecting...', 'ok');
      window.location.assign(result.redirect || '/agents/control/');
    } catch (err) {
      showStatus(err.message || 'Passkey enrollment failed', 'error');
      btn.disabled = false;
    }
  }

  async function handleLogin(btn) {
    btn.disabled = true;
    try {
      const start = await apiPost('/agents/api/auth/login/options', {});
      const cred = await navigator.credentials.get({
        publicKey: decodeRequestOptions(start.options),
      });
      if (!cred) {
        throw new Error('Passkey sign-in cancelled');
      }
      await apiPost('/agents/api/auth/login/verify', {
        challengeId: start.challengeId,
        response: serializeAuthentication(cred),
      });
      showStatus('Signed in. Redirecting...', 'ok');
      window.location.assign(safeNextTarget());
    } catch (err) {
      showStatus(err.message || 'Passkey sign-in failed', 'error');
      btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const mode = document.body.getAttribute('data-mode');
    const btn = document.getElementById('auth-action');
    if (!btn) return;

    if (!window.PublicKeyCredential || !navigator.credentials) {
      btn.disabled = true;
      showStatus('WebAuthn passkeys are not supported in this browser or context (HTTPS required).', 'error');
      return;
    }

    btn.addEventListener('click', () => {
      if (mode === 'setup') {
        handleSetup(btn);
      } else {
        handleLogin(btn);
      }
    });
  });
})();
