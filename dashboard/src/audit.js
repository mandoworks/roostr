'use strict';

const fs = require('fs');
const path = require('path');
const { ensureConfigDir } = require('./secrets');

function summarizeText(text, max = 80) {
  if (typeof text !== 'string') return '';
  const single = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 3) + '...';
}

function createAuditLogger(auditPath) {
  function log(entry) {
    try {
      ensureConfigDir(path.dirname(auditPath));
      const record = {
        ts: new Date().toISOString(),
        ip: String(entry.ip || 'unknown'),
        action: String(entry.action || 'unknown'),
        paneId: entry.paneId ? String(entry.paneId) : null,
        summary: summarizeText(entry.summary || '', 120),
        ok: entry.ok !== false,
      };
      const line = JSON.stringify(record) + '\n';
      const exists = fs.existsSync(auditPath);
      fs.appendFileSync(auditPath, line, { encoding: 'utf8', mode: 0o600 });
      if (!exists) {
        try {
          fs.chmodSync(auditPath, 0o600);
        } catch {
          // Ignore chmod errors
        }
      }
    } catch {
      // Audit logging must not crash the request handler
    }
  }

  function readRecent(limit = 20) {
    if (!fs.existsSync(auditPath)) {
      return [];
    }
    const raw = fs.readFileSync(auditPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const slice = lines.slice(-Math.max(1, limit));
    const entries = [];
    for (let i = slice.length - 1; i >= 0; i -= 1) {
      try {
        entries.push(JSON.parse(slice[i]));
      } catch {
        // Skip corrupt lines
      }
    }
    return entries;
  }

  return { log, readRecent };
}

module.exports = { createAuditLogger, summarizeText };
