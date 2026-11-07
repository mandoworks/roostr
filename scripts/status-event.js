#!/usr/bin/env node
'use strict';
// Herdr runs this on every pane.agent_status_changed event (see
// herdr-plugin.toml) with the event in HERDR_PLUGIN_EVENT_JSON. It records when
// the pane entered its status, so the board can show an exact time in status
// even for changes that happened while no board was open. Prints nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validPaneId, eventFile, writeJson } = require('../src/state');
const rotate = require('../src/rotate');
const daemon = require('../src/daemon');

function transitionsPath() {
  return process.env.CREW_BOARD_TRANSITIONS || path.join(os.homedir(), '.crew-board', 'transitions.jsonl');
}

function readTransitions(file = transitionsPath(), options = {}) {
  const files = [file];
  if (options && options.includeArchive) {
    const archive = file + (options.suffix || rotate.DEFAULT_ARCHIVE_SUFFIX);
    if (fs.existsSync(archive)) files.unshift(archive);
  }
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry);
      } catch {
        // Tolerant reader: skips malformed lines.
      }
    }
  }
  return out;
}

function appendTransition(entry, file = transitionsPath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Backends without POSIX modes are fine.
  }
  rotate.maybeRotate(file);
  return entry;
}

function parseEvent(raw) {
  let d;
  try {
    d = JSON.parse(raw).data;
  } catch (e) {
    return null;
  }
  if (!d || !validPaneId(d.pane_id) || typeof d.agent_status !== 'string') return null;
  const status = d.agent_status.toLowerCase();
  if (!/^[a-z_]{1,16}$/.test(status)) return null;
  return { pane: d.pane_id, status };
}

function main(env = process.env, now = Date.now(), options = {}) {
  const e = parseEvent(env.HERDR_PLUGIN_EVENT_JSON || '');
  if (!e) return null;
  try {
    appendTransition({
      at: new Date(now).toISOString(),
      pane: e.pane,
      status: e.status,
    }, options.transitionsFile || transitionsPath());
  } catch {
    // Failure isolation: hook still cannot throw.
  }
  const rec = { ...e, at: now };
  writeJson(options.eventFile || eventFile(e.pane), rec);

  // D1 live event feed wiring: update daemon tracked state
  try {
    const dFile = options.daemonStateFile || daemon.daemonStateFile();
    const dState = daemon.loadDaemonState(dFile, now);
    const processed = daemon.processEvent(dState, {
      pane: e.pane,
      status: e.status,
      at: now,
    });
    if (processed.changed) {
      daemon.saveDaemonState(processed.state, dFile);
    }
  } catch {
    // Failure isolation: daemon hook error must not fail Herdr's dispatch
  }

  return rec;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // a status time is a nicety; never fail Herdr's event dispatch
  }
}

module.exports = { parseEvent, main, transitionsPath, readTransitions, appendTransition };
