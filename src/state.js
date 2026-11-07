'use strict';
// The small state dir crew-board keeps: exact usage reports per pane, and the
// board's own memory (colour tag per pane, when each status started).
// Default ~/.crew-board/state, override with CREW_BOARD_STATE_DIR.

const fs = require('fs');
const os = require('os');
const path = require('path');

function stateDir() {
  if (process.env.ROOSTR_STATE_DIR) return process.env.ROOSTR_STATE_DIR;
  if (process.env.CREW_BOARD_STATE_DIR) return process.env.CREW_BOARD_STATE_DIR;
  const roostr = path.join(os.homedir(), '.roostr', 'state');
  const legacy = path.join(os.homedir(), '.crew-board', 'state');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

// Pane ids look like "w11:p3". Require exactly one colon separating workspace and pane.
function validPaneId(id) {
  if (typeof id !== 'string' || id.length < 3 || id.length > 64) return false;
  const parts = id.split(':');
  if (parts.length !== 2) return false;
  return /^[A-Za-z0-9_-]+$/.test(parts[0]) && /^[A-Za-z0-9_-]+$/.test(parts[1]);
}

function paneFile(id) {
  const safe = String(id).replace(/_/g, '__').replace(/:/g, '_');
  return path.join(stateDir(), `${safe}.json`);
}

// When the pane entered its current status, written by the status event hook.
// Bad ids are rejected here too, so no caller can point it outside the state dir.
function eventFile(id) {
  if (!validPaneId(id)) throw new Error('bad pane id');
  return path.join(stateDir(), 'events', `${id.replace(/:/g, '_')}.json`);
}

function readJson(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    // Try backup if exists
    try {
      const bak = file + '.bak';
      if (fs.existsSync(bak)) {
        const data = fs.readFileSync(bak, 'utf8');
        return JSON.parse(data);
      }
    } catch (e2) {}
    return null;
  }
}

// Write to a temp file and rename, so a reader never sees half a file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Keep backup of existing good file
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + '.bak');
    }
  } catch (e) {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { stateDir, validPaneId, paneFile, eventFile, readJson, writeJson };
