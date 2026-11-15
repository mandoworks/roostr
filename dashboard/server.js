'use strict';

const http = require('http');
const { loadConfig } = require('./src/config');
const { createSecretStore } = require('./src/secrets');
const { createAuthService } = require('./src/auth');
const { createHerdrClient } = require('./src/herdr');
const { createRateLimiter } = require('./src/ratelimit');
const { createAuditLogger } = require('./src/audit');
const { createNamesStore } = require('./src/names');
const { createApp } = require('./src/app');

function startServer(env = process.env) {
  const config = loadConfig(env);
  const store = createSecretStore(config.configDir);
  const auth = createAuthService({ config, store });
  const herdr = createHerdrClient({
    herdrBin: config.herdrBin,
    timeoutMs: config.herdrTimeoutMs,
    cacheTtlMs: config.snapshotCacheTtlMs,
  });
  const rateLimiter = createRateLimiter({
    maxRequests: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });
  const audit = createAuditLogger(store.auditPath);
  const names = createNamesStore({
    namesPath: config.namesPath,
    staticDir: config.staticDir,
    statusPath: config.statusPath,
  });

  const handler = createApp({ config, store, auth, herdr, rateLimiter, audit, names });
  const server = http.createServer(handler);

  server.listen(config.port, config.host, () => {
    const enrolled = auth.hasCredentials();
    process.stdout.write(
      `roostr-dashboard listening on http://${config.host}:${config.port}/agents/ (enrolled=${enrolled})\n`
    );
    if (!enrolled) {
      process.stdout.write(
        `enrollment URL: ${config.origin}/agents/auth/setup?token=<see ${store.enrollTokenPath}>\n`
      );
    }
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
