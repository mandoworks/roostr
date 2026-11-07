'use strict';
// Experiential Labs (explabs) usage limits.
// Queries the Experiential Labs gateway for tier and rate limits when the
// integration is enabled by EXPLABS_ENABLED or by a trusted crew file. The key
// and cookie come only from EXPLABS_API_KEY and EXPLABS_COOKIE. There is no
// home directory file discovery. When disabled nothing is read or requested.
// Caches to disk (~/.crew-board/state/explabs.json) so the board reads instantly
// on start, and refreshes in the background every 60 seconds without blocking
// rendering.

const fs = require('fs');
const path = require('path');
const state = require('./state');

const EVERY_MS = 60 * 1000;
const TIMEOUT_MS = 10000;

let cache = null;
let running = false;
let activeKeyId = null;

function loadKey() {
  if (process.env.EXPLABS_API_KEY) return process.env.EXPLABS_API_KEY.trim() || null;
  return null;
}

function loadCookie() {
  if (process.env.EXPLABS_COOKIE) return process.env.EXPLABS_COOKIE.trim() || null;
  return null;
}

// Off unless the caller opts in or EXPLABS_ENABLED is 1, true or yes.
function enabled(opts = {}) {
  if (opts && opts.enabled === true) return true;
  const v = String(process.env.EXPLABS_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function stateFile() {
  return path.join(state.stateDir(), 'explabs.json');
}

function loadDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (data && data.limits) return data;
  } catch (_) {}
  return null;
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatTier(t) {
  if (!t) return 'tier ?';
  return String(t).replace(/_/g, ' ');
}

// Background refresh: queries credits from web session and rate limits from API key.
async function refresh(apiKey, cookie) {
  try {
    let creditInfo = null;
    if (cookie) {
      try {
        const orgsRes = await fetch('https://platform.experientiallabs.ai/api/orgs', {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (orgsRes.ok) {
          const data = await orgsRes.json();
          const org = data && data.orgs && data.orgs[0];
          if (org) {
            const balance = Number(org.credit_balance_usd) || 0;
            const granted = Number(org.credit_granted_usd) || 0;
            const spend = Number(org.billable_spend_usd) || 0;
            const pct = granted > 0 ? Math.min(100, Math.round((spend / granted) * 100)) : 0;
            creditInfo = {
              orgName: org.name || 'explabs',
              balance: `$${balance.toFixed(2)}`,
              granted: `$${granted.toFixed(2)}`,
              spendPct: pct,
            };
          }
        }
      } catch (_) {}
    }

    let lim = null;
    let keyName = creditInfo ? creditInfo.orgName : 'Full Experiential';

    if (apiKey) {
      let keyId = activeKeyId;
      if (!keyId) {
        const keysRes = await fetch('https://api.experientiallabs.ai/api/keys', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (keysRes.ok) {
          const keys = await keysRes.json();
          if (Array.isArray(keys) && keys.length) {
            const active = keys.find((k) => k.name === 'Full Experiential' && !k.revoked_at)
              || keys.find((k) => !k.revoked_at)
              || keys[0];
            keyId = active.id;
            if (!creditInfo && active.name) keyName = active.name;
            activeKeyId = keyId;
          }
        }
      }

      if (keyId) {
        const limRes = await fetch(`https://api.experientiallabs.ai/api/gateway/keys/${keyId}/limits`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (limRes.ok) lim = await limRes.json();
      }
    }

    const now = Date.now();
    const nextHour = Math.ceil(now / (3600 * 1000)) * 3600;
    const nextDay = Math.ceil(now / (86400 * 1000)) * 86400;

    const windows = [];
    if (creditInfo) {
      windows.push({
        name: 'credit',
        used: creditInfo.spendPct,
        cap: `${creditInfo.balance} left of ${creditInfo.granted}`,
        resets: null,
      });
    } else {
      if (lim && lim.tokens_per_hour) {
        windows.push({
          name: '1h',
          used: null,
          resets: nextHour,
          cap: `${fmtNum(lim.tokens_per_hour)}`,
        });
      }
      if (lim && lim.tokens_per_day) {
        windows.push({
          name: '24h',
          used: null,
          resets: nextDay,
          cap: `${fmtNum(lim.tokens_per_day)}`,
        });
      }
    }

    if (!windows.length) return;

    const report = {
      at: now,
      limits: [
        {
          source: `explabs ${keyName}`,
          windows,
        },
      ],
    };

    cache = report;
    state.writeJson(stateFile(), report);
  } catch (_) {
    // Network errors do not crash the board
  } finally {
    running = false;
  }
}

// Returns the cached report and triggers a background refresh when stale.
// Disabled: returns null without reading the disk cache.
function limits(now = Date.now(), opts = {}) {
  if (!enabled(opts)) return null;

  if (cache === null) {
    cache = loadDisk() || { at: -Infinity, limits: [] };
  }

  const apiKey = loadKey();
  const cookie = loadCookie();
  if ((apiKey || cookie) && !running && now - cache.at >= EVERY_MS) {
    running = true;
    refresh(apiKey, cookie);
  }

  return cache.limits && cache.limits.length ? cache : null;
}

module.exports = {
  limits,
  enabled,
  fmtNum,
  formatTier,
};
