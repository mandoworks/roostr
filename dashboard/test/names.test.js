'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STALE_WORKER_SECONDS,
  displayHostName,
  validateSlug,
  validateDisplayName,
  normalizeNamesDoc,
  readWorkerHosts,
  createNamesStore,
} = require('../src/names');

describe('dashboard names store', () => {
  it('maps known hostnames cleanly', () => {
    assert.equal(displayHostName('vps-43beb0ce'), 'ovh');
    assert.equal(displayHostName('muse'), 'muse');
    assert.equal(displayHostName('laptop'), 'laptop');
  });

  it('validates slugs and display names', () => {
    assert.deepEqual(validateSlug('roosty'), { ok: true, value: 'roosty' });
    assert.equal(validateSlug('Bad Slug').ok, false);
    assert.deepEqual(validateDisplayName('  Roosty Argon  '), { ok: true, value: 'Roosty Argon' });
    assert.equal(validateDisplayName('bad\nname').ok, false);
  });

  it('persists overrides, orchestrators, drift, host snapshots, and reverts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-names-'));
    try {
      const staticDir = path.join(tmp, 'agents');
      const workersDir = path.join(staticDir, 'workers');
      fs.mkdirSync(workersDir, { recursive: true });

      fs.writeFileSync(
        path.join(staticDir, 'data.json'),
        JSON.stringify({ tier1: [{ id: 'la-guardiana', name: 'Guardiana' }] })
      );
      const statusPath = path.join(tmp, 'status.json');
      fs.writeFileSync(
        statusPath,
        JSON.stringify({ agents: { roosty: { label: 'Building' } } })
      );
      const nowMs = 1794780000000;
      const epoch = Math.floor(nowMs / 1000);
      fs.writeFileSync(
        path.join(workersDir, 'workers.vps-43beb0ce.json'),
        JSON.stringify({
          schema: 1,
          host: 'vps-43beb0ce',
          generated_epoch: epoch - 10,
          generated_at: new Date(nowMs - 10000).toISOString(),
          workers: [{ pane_id: 'w2:p1', name: 'doma', state: 'idle', task: 'migrate' }],
        })
      );
      fs.writeFileSync(
        path.join(workersDir, 'workers.muse.json'),
        JSON.stringify({
          schema: 1,
          host: 'muse',
          generated_epoch: epoch - 120,
          generated_at: new Date(nowMs - 120000).toISOString(),
          workers: [{ pane_id: 'muse:engy', name: 'Engy', state: 'working', task: 'posts' }],
        })
      );

      const store = createNamesStore({
        namesPath: path.join(staticDir, 'names.json'),
        staticDir,
        statusPath,
        now: () => nowMs,
      });

      const r1 = store.setOverride('la-guardiana', 'La Guardiana', 'pio');
      assert.equal(r1.ok, true);
      const r2 = store.setOrchestrator('la-guardiana', true, 'pio');
      assert.equal(r2.ok, true);

      const snap = store.snapshot();
      assert.equal(snap.names.overrides['la-guardiana'].name, 'La Guardiana');
      assert.deepEqual(snap.names.orchestrators, ['la-guardiana']);
      assert.equal(snap.drift.length, 1);
      assert.equal(snap.drift[0].sourceName, 'Guardiana');

      assert.equal(snap.hosts.length, 2);
      const ovh = snap.hosts.find((h) => h.host === 'ovh');
      const muse = snap.hosts.find((h) => h.host === 'muse');
      assert.equal(ovh.stale, false);
      assert.equal(muse.stale, true);

      const rev = store.revertHistory(null, 'pio');
      assert.equal(rev.ok, true);
      assert.equal(rev.names.overrides['la-guardiana'], undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('recovers cleanly from corrupt names.json and cleans up atomic temp files on write error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-names-corrupt-'));
    try {
      const staticDir = path.join(tmp, 'agents');
      fs.mkdirSync(staticDir, { recursive: true });
      const namesPath = path.join(staticDir, 'names.json');

      // Corrupt JSON
      fs.writeFileSync(namesPath, '{not valid json');
      const store = createNamesStore({
        namesPath,
        staticDir,
        statusPath: path.join(tmp, 'missing-status.json'),
        now: () => 1794780000000,
      });
      assert.deepEqual(store.load().overrides, {});
      assert.deepEqual(store.load().orchestrators, []);

      // Wrong JSON root types and malformed fields
      assert.deepEqual(normalizeNamesDoc([]).overrides, {});
      assert.deepEqual(normalizeNamesDoc('bad').history, []);
      const partial = normalizeNamesDoc({
        orchestrators: ['roosty', 'INVALID SLUG', 'roosty'],
        overrides: {
          roosty: { name: '  Roosty  ' },
          badctrl: { name: 'evil\nname' },
          empty: { name: '   ' },
          arr: ['nope'],
        },
        history: [null, ['bad'], { id: 'h1', action: 'override.set' }],
      });
      assert.deepEqual(partial.orchestrators, ['roosty']);
      assert.equal(partial.overrides.roosty.name, 'Roosty');
      assert.equal(partial.overrides.badctrl, undefined);
      assert.equal(partial.overrides.empty, undefined);
      assert.equal(partial.overrides.arr, undefined);
      assert.equal(partial.history.length, 1);

      // Recovery on write
      const saved = store.setOverride('roosty', 'Roosty Argon', 'pio');
      assert.equal(saved.ok, true);
      assert.equal(JSON.parse(fs.readFileSync(namesPath, 'utf8')).overrides.roosty.name, 'Roosty Argon');

      // Atomic temp file cleanup when rename fails (target path is a directory)
      const dirTarget = path.join(tmp, 'dir-as-file');
      fs.mkdirSync(dirTarget, { recursive: true });
      const badStore = createNamesStore({
        namesPath: dirTarget,
        staticDir,
        statusPath: '',
        now: () => 1794780000000,
      });
      assert.throws(() => badStore.setOverride('roosty', 'Roosty', 'pio'));
      const leftoverTemps = fs.readdirSync(tmp).filter((f) => f.includes('.tmp'));
      assert.deepEqual(leftoverTemps, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('enforces STALE_WORKER_SECONDS boundary (>90s stale, <=90s fresh, missing epoch stale)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-names-stale-'));
    try {
      const workersDir = path.join(tmp, 'workers');
      fs.mkdirSync(workersDir, { recursive: true });
      const nowMs = 1794780000000;
      const nowSec = Math.floor(nowMs / 1000);

      fs.writeFileSync(
        path.join(workersDir, 'workers.boundary-ok.json'),
        JSON.stringify({
          host: 'boundary-ok',
          generated_epoch: nowSec - STALE_WORKER_SECONDS,
          workers: [{ pane_id: 'w1:p1', name: 'a' }, null],
        })
      );
      fs.writeFileSync(
        path.join(workersDir, 'workers.boundary-stale.json'),
        JSON.stringify({
          host: 'boundary-stale',
          generated_epoch: nowSec - (STALE_WORKER_SECONDS + 1),
          workers: [],
        })
      );
      fs.writeFileSync(
        path.join(workersDir, 'workers.no-epoch.json'),
        JSON.stringify({ host: '', workers: [] })
      );
      fs.writeFileSync(path.join(workersDir, 'workers.corrupt.json'), '{bad');

      const hosts = readWorkerHosts(tmp, nowMs);
      assert.equal(hosts.length, 3);

      const okHost = hosts.find((h) => h.host === 'boundary-ok');
      assert.equal(okHost.ageSec, STALE_WORKER_SECONDS);
      assert.equal(okHost.stale, false);
      assert.equal(okHost.workers.length, 1);

      const staleHost = hosts.find((h) => h.host === 'boundary-stale');
      assert.equal(staleHost.ageSec, STALE_WORKER_SECONDS + 1);
      assert.equal(staleHost.stale, true);

      const noEpoch = hosts.find((h) => h.host === 'no-epoch');
      assert.equal(noEpoch.ageSec, null);
      assert.equal(noEpoch.stale, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles empty/whitespace override clearing, revert chain, history cap, and sourceName precedence', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-names-hist-'));
    try {
      const staticDir = path.join(tmp, 'agents');
      fs.mkdirSync(staticDir, { recursive: true });
      const statusPath = path.join(tmp, 'status.json');
      const namesPath = path.join(staticDir, 'names.json');

      fs.writeFileSync(
        path.join(staticDir, 'data.json'),
        JSON.stringify({
          tier1: [
            { id: 'both-slug', name: 'Roster Name' },
            { id: 'empty-name', name: '' },
          ],
        })
      );
      fs.writeFileSync(
        statusPath,
        JSON.stringify({
          agents: {
            'both-slug': { name: 'Status Name', label: 'working' },
            'empty-name': { name: 'Status Fallback' },
            'status-only': { label: 'Status Label' },
          },
        })
      );
      fs.writeFileSync(
        path.join(staticDir, 'roostr.json'),
        JSON.stringify({
          panes: [{ agentName: 'both-slug', name: 'Roostr Pane Name' }],
        })
      );

      let tick = 1794780000000;
      const store = createNamesStore({
        namesPath,
        staticDir,
        statusPath,
        now: () => (tick += 1000),
      });

      // sourceName precedence: data.json > status.json > roostr.json, and override-only has null sourceName
      assert.equal(store.setOverride('both-slug', 'Override Both', 'pio').ok, true);
      assert.equal(store.setOverride('override-only', 'Only Override', 'pio').ok, true);

      const snap1 = store.snapshot();
      const bySlug = new Map(snap1.eligible.map((e) => [e.slug, e]));
      assert.equal(bySlug.get('both-slug').sourceName, 'Roster Name');
      assert.equal(bySlug.get('empty-name').sourceName, 'Status Fallback');
      assert.equal(bySlug.get('status-only').sourceName, 'Status Label');
      assert.equal(bySlug.get('override-only').sourceName, null);
      assert.equal(snap1.drift.length, 1);
      assert.deepEqual(snap1.drift[0], {
        slug: 'both-slug',
        overrideName: 'Override Both',
        sourceName: 'Roster Name',
      });

      // Whitespace clears override and records override.clear
      const cleared = store.setOverride('both-slug', '   ', 'pio');
      assert.equal(cleared.ok, true);
      assert.equal(cleared.names.overrides['both-slug'], undefined);
      assert.equal(cleared.names.history[0].action, 'override.clear');
      assert.equal(cleared.names.history[0].prev_name, 'Override Both');
      const clearId = cleared.names.history[0].id;

      // Consecutive reverts walk back without getting stuck on already-reverted entries
      const rev1 = store.revertHistory(null, 'pio');
      assert.equal(rev1.ok, true);
      assert.equal(rev1.reverted.id, clearId);
      assert.equal(rev1.names.overrides['both-slug'].name, 'Override Both');

      // Explicit revert of already-reverted id returns 409
      const dupRev = store.revertHistory(clearId, 'pio');
      assert.equal(dupRev.ok, false);
      assert.equal(dupRev.status, 409);

      const rev2 = store.revertHistory(null, 'pio');
      assert.equal(rev2.ok, true);
      assert.equal(rev2.names.overrides['override-only'], undefined);

      const rev3 = store.revertHistory(null, 'pio');
      assert.equal(rev3.ok, true);
      assert.equal(rev3.names.overrides['both-slug'], undefined);

      const revEmpty = store.revertHistory(null, 'pio');
      assert.equal(revEmpty.ok, false);
      assert.equal(revEmpty.status, 404);

      // History cap at 200 entries
      for (let i = 0; i < 205; i += 1) {
        const r = store.setOverride('roosty', `Name ${i}`, 'pio');
        assert.equal(r.ok, true);
      }
      assert.equal(store.load().history.length, 200);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
