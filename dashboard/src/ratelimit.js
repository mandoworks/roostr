'use strict';

function createRateLimiter(opts = {}) {
  const maxRequests = opts.maxRequests || 20;
  const windowMs = opts.windowMs || 10000;
  const hits = new Map();
  let lastSweep = 0;

  function sweep(nowMs) {
    if (nowMs - lastSweep < windowMs) return;
    lastSweep = nowMs;
    const cutoff = nowMs - windowMs;
    for (const [key, list] of hits.entries()) {
      const fresh = list.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, fresh);
      }
    }
  }

  function check(key, nowMs = Date.now()) {
    sweep(nowMs);
    const k = String(key || 'unknown');
    const cutoff = nowMs - windowMs;
    const existing = hits.get(k) || [];
    const fresh = existing.filter((ts) => ts > cutoff);
    if (fresh.length >= maxRequests) {
      hits.set(k, fresh);
      const oldest = fresh[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    fresh.push(nowMs);
    hits.set(k, fresh);
    return { allowed: true, remaining: maxRequests - fresh.length, retryAfterSec: 0 };
  }

  return { check };
}

module.exports = { createRateLimiter };
