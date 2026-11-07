'use strict';
// Update notice. Herdr has no `plugin update`, so once a day a live board asks
// GitHub for the plugin's release tags (`git ls-remote`, nothing is sent but
// the request) and offers the newest one when it is newer than the installed
// version. Installing is never automatic: an update is new code that runs as
// you, so it waits for the `u` key. CREW_BOARD_NO_UPDATE_CHECK=1 or
// --no-update-check turns the check off.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const state = require('./state');

const REPO = process.env.ROOSTR_REPO || process.env.CREW_BOARD_REPO || 'mandoworks/roostr';
const URL = `https://github.com/${REPO}`;
const EVERY_MS = 24 * 60 * 60 * 1000;
const MANIFEST = path.join(__dirname, '..', 'herdr-plugin.toml');

let running = false;

function updateFile() {
  return path.join(state.stateDir(), 'update.json');
}

function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True when version `a` is newer than `b` ("0.1.1" > "0.1.0").
function newer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The installed version, read from the manifest each time: an update replaces
// the files in place, so this moves as soon as one lands.
function installed(file = MANIFEST) {
  try {
    const m = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(file, 'utf8'));
    return m && parseVersion(m[1]) ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// `git ls-remote --tags --refs` output -> the newest release version
// ("0.1.1"), or null. Only plain vX.Y.Z tags count, so pre-releases and other
// tags are never offered.
function latestTag(text) {
  let best = null;
  for (const line of String(text).split('\n')) {
    const m = /\trefs\/tags\/(v\d+\.\d+\.\d+)$/.exec(line.trim());
    if (!m) continue;
    const v = m[1].slice(1);
    if (!best || newer(v, best)) best = v;
  }
  return best;
}

function disabled(opts) {
  return Boolean(opts && opts.noUpdateCheck) || ['1', 'true', 'yes'].includes(String(process.env.CREW_BOARD_NO_UPDATE_CHECK || '').toLowerCase());
}

// The version to offer, or null. Reads the shared state file (so several
// boards check once a day between them) and starts a background check when
// one is due. `run` is execFile (tests swap it).
function check(now = Date.now(), opts = {}, run = execFile) {
  if (disabled(opts)) return null;
  const current = installed(opts.manifest);
  if (!current) return null;
  const file = updateFile();
  const saved = state.readJson(file) || {};
  if (!running && !(now - saved.checkedAt < EVERY_MS)) {
    running = true;
    // A private or missing repo must fail, not ask for a password.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const child = run('git', ['ls-remote', '--tags', '--refs', URL], { timeout: 15000, env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      running = false;
      try {
        state.writeJson(file, { checkedAt: now, latest: err ? saved.latest || null : latestTag(stdout) });
      } catch (e) {
        // a read only state dir only costs the notice
      }
    });
    if (child && child.unref) child.unref();
  }
  return saved.latest && newer(saved.latest, current) ? saved.latest : null;
}

module.exports = { REPO, newer, installed, latestTag, check };
