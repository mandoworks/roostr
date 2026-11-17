'use strict';

const os = require('os');
const path = require('path');

function loadConfig(env = process.env) {
  const portRaw = env.PORT || '8960';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const homeDir = env.HOME || os.homedir();
  const configDir = env.ROOSTR_DASHBOARD_CONFIG_DIR
    || path.join(homeDir, '.config', 'roostr-dashboard');

  const staticDir = env.STATIC_DIR || '/home/ubuntu/service-directory/agents';
  const roostrStateDir = env.ROOSTR_STATE_DIR || path.join(homeDir, '.roostr');
  const roostrRepoDir = env.ROOSTR_REPO_DIR || path.resolve(__dirname, '..', '..');
  const piorelayBase = env.PIORELAY_BASE || 'http://100.123.63.122:3016/api/v1';

  return {
    host: '127.0.0.1',
    port,
    rpId: env.RP_ID || 'ovh.tail5f1fde.ts.net',
    origin: env.ORIGIN || 'https://ovh.tail5f1fde.ts.net',
    staticDir,
    roostrStateDir,
    roostrRepoDir,
    piorelayBase,
    namesPath: env.NAMES_PATH || path.join(staticDir, 'names.json'),
    statusPath: env.AGENT_STATUS_PATH || '/home/ubuntu/service-directory/agent-status/status.json',
    publicDir: path.join(__dirname, '..', 'public'),
    configDir,
    allowAddCredential: env.ALLOW_ADD_CREDENTIAL === '1',
    herdrBin: env.HERDR_BIN_PATH || 'herdr',
    herdrTimeoutMs: 10000,
    snapshotCacheTtlMs: 1000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    cookieName: 'roostr_session',
    rateLimitMax: 20,
    rateLimitWindowMs: 10000,
  };
}

module.exports = { loadConfig };
