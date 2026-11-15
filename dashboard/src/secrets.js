'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensureConfigDir(configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(configDir, 0o700);
  } catch {
    // Ignore if filesystem does not support chmod
  }
}

function writeAtomic0600(filePath, content) {
  const dir = path.dirname(filePath);
  ensureConfigDir(dir);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o600, encoding: 'utf8' });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

function generateTokenHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function loadOrCreateSecret(filePath) {
  ensureConfigDir(path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (raw.length > 0) {
      return raw;
    }
  }
  const secret = generateTokenHex(32);
  writeAtomic0600(filePath, `${secret}\n`);
  return secret;
}

function rotateSecret(filePath) {
  const secret = generateTokenHex(32);
  writeAtomic0600(filePath, `${secret}\n`);
  return secret;
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return false;
  }
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createSecretStore(configDir) {
  const sessionSecretPath = path.join(configDir, 'session-secret');
  const enrollTokenPath = path.join(configDir, 'enroll-token');
  const credentialsPath = path.join(configDir, 'credentials.json');
  const auditPath = path.join(configDir, 'audit.jsonl');

  ensureConfigDir(configDir);
  const sessionSecret = loadOrCreateSecret(sessionSecretPath);
  loadOrCreateSecret(enrollTokenPath);

  function getSessionSecret() {
    return sessionSecret;
  }

  function getEnrollToken() {
    return loadOrCreateSecret(enrollTokenPath);
  }

  function verifyEnrollToken(candidate) {
    const expected = getEnrollToken();
    return constantTimeEquals(candidate, expected);
  }

  function rotateEnrollToken() {
    return rotateSecret(enrollTokenPath);
  }

  function loadCredentials() {
    if (!fs.existsSync(credentialsPath)) {
      return [];
    }
    const raw = fs.readFileSync(credentialsPath, 'utf8').trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.credentials)) {
      throw new Error('credentials.json has invalid structure');
    }
    return parsed.credentials;
  }

  function saveCredentials(credentials) {
    const payload = JSON.stringify({ credentials }, null, 2) + '\n';
    writeAtomic0600(credentialsPath, payload);
  }

  return {
    configDir,
    sessionSecretPath,
    enrollTokenPath,
    credentialsPath,
    auditPath,
    getSessionSecret,
    getEnrollToken,
    verifyEnrollToken,
    rotateEnrollToken,
    loadCredentials,
    saveCredentials,
  };
}

module.exports = {
  ensureConfigDir,
  writeAtomic0600,
  loadOrCreateSecret,
  rotateSecret,
  constantTimeEquals,
  createSecretStore,
};
