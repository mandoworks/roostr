'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  displayHostName,
  validateSlug,
  validateDisplayName,
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
});
