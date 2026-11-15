'use strict';

const fs = require('fs');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SINGLE_LINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;
const MAX_NAME_LENGTH = 64;
const MAX_HISTORY = 200;
const STALE_WORKER_SECONDS = 90;

const HOST_DISPLAY_MAP = {
  'vps-43beb0ce': 'ovh',
  muse: 'muse',
};

function displayHostName(host) {
  if (typeof host !== 'string' || !host.trim()) return 'unknown';
  const key = host.trim();
  return HOST_DISPLAY_MAP[key] || key;
}

function validateSlug(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'slug must be a string' };
  }
  const slug = raw.trim();
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: 'invalid slug' };
  }
  return { ok: true, value: slug };
}

function validateDisplayName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'name must be a string' };
  }
  if (SINGLE_LINE_CONTROL_RE.test(raw)) {
    return { ok: false, error: 'name contains disallowed control characters' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  return { ok: true, value: trimmed };
}

function emptyNamesDoc() {
  return {
    schema: 1,
    updated_at: null,
    updated_epoch: 0,
    orchestrators: [],
    overrides: {},
    history: [],
  };
}

function normalizeNamesDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyNamesDoc();
  }
  const orchestrators = Array.isArray(raw.orchestrators)
    ? [...new Set(raw.orchestrators.filter((s) => typeof s === 'string' && SLUG_RE.test(s)))].sort()
    : [];
  const overrides = {};
  if (raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
    for (const [slug, rec] of Object.entries(raw.overrides)) {
      if (!SLUG_RE.test(slug) || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
      if (typeof rec.name !== 'string' || SINGLE_LINE_CONTROL_RE.test(rec.name) || !rec.name.trim()) continue;
      overrides[slug] = {
        name: rec.name.trim().slice(0, MAX_NAME_LENGTH),
        updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : null,
        retired_at: typeof rec.retired_at === 'string' ? rec.retired_at : null,
      };
    }
  }
  const history = Array.isArray(raw.history)
    ? raw.history.filter((h) => h && typeof h === 'object' && !Array.isArray(h)).slice(0, MAX_HISTORY)
    : [];
  return {
    schema: 1,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    updated_epoch: Number.isFinite(raw.updated_epoch) ? raw.updated_epoch : 0,
    orchestrators,
    overrides,
    history,
  };
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, doc) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const body = JSON.stringify(doc, null, 2) + '\n';
  try {
    fs.writeFileSync(tmpPath, body, { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(tmpPath, 0o644);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function readWorkerHosts(staticDir, nowMs = Date.now()) {
  const workersDir = path.join(staticDir, 'workers');
  if (!fs.existsSync(workersDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(workersDir);
  } catch {
    return [];
  }

  const nowSec = Math.floor(nowMs / 1000);
  const hosts = [];
  for (const name of entries.sort()) {
    if (!/^workers\.[a-z0-9][a-z0-9.-]*\.json$/i.test(name)) continue;
    const doc = readJsonSafe(path.join(workersDir, name));
    if (!doc || typeof doc !== 'object') continue;
    const rawHost = (typeof doc.host === 'string' && doc.host.trim())
      ? doc.host.trim()
      : name.replace(/^workers\.|\.json$/gi, '');
    const genEpoch = Number.isFinite(doc.generated_epoch) ? doc.generated_epoch : 0;
    const ageSec = genEpoch > 0 ? Math.max(0, nowSec - genEpoch) : null;
    const stale = ageSec === null || ageSec > STALE_WORKER_SECONDS;
    hosts.push({
      file: name,
      rawHost,
      host: displayHostName(rawHost),
      generatedAt: doc.generated_at || null,
      ageSec,
      stale,
      workers: Array.isArray(doc.workers)
        ? doc.workers.filter((w) => w && typeof w === 'object' && !Array.isArray(w))
        : [],
    });
  }
  return hosts;
}

function collectEligibleSlugs({ namesDoc, staticDir, statusPath }) {
  const map = new Map();
  function upsert(slug, source, sourceName) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return;
    const prev = map.get(slug) || { slug, sources: [], sourceName: null };
    if (!prev.sources.includes(source)) prev.sources.push(source);
    if (!prev.sourceName && typeof sourceName === 'string' && sourceName.trim()) {
      prev.sourceName = sourceName.trim();
    }
    map.set(slug, prev);
  }

  const dataDoc = readJsonSafe(path.join(staticDir, 'data.json'));
  if (dataDoc && Array.isArray(dataDoc.tier1)) {
    for (const a of dataDoc.tier1) {
      if (!a || typeof a !== 'object') continue;
      upsert(a.id || a.slug || a.agent, 'roster', a.name);
    }
  }

  const statusDoc = readJsonSafe(statusPath);
  if (statusDoc && statusDoc.agents && typeof statusDoc.agents === 'object' && !Array.isArray(statusDoc.agents)) {
    for (const [slug, ev] of Object.entries(statusDoc.agents)) {
      upsert(slug, 'announce', ev && (ev.name || ev.label));
    }
  }

  const roostrDoc = readJsonSafe(path.join(staticDir, 'roostr.json'));
  if (roostrDoc && Array.isArray(roostrDoc.panes)) {
    for (const p of roostrDoc.panes) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.agentName === 'string') upsert(p.agentName, 'roostr', p.name);
    }
  }

  for (const slug of namesDoc.orchestrators) upsert(slug, 'orchestrator', null);
  for (const slug of Object.keys(namesDoc.overrides)) {
    upsert(slug, 'override', null);
  }

  return [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function createNamesStore({ namesPath, staticDir, statusPath, now = () => Date.now() }) {
  function load() {
    return normalizeNamesDoc(readJsonSafe(namesPath));
  }

  function save(doc, nowMs) {
    doc.updated_at = new Date(nowMs).toISOString();
    doc.updated_epoch = Math.floor(nowMs / 1000);
    writeJsonAtomic(namesPath, doc);
    return doc;
  }

  function snapshot() {
    const nowMs = now();
    const doc = load();
    const eligible = collectEligibleSlugs({ namesDoc: doc, staticDir, statusPath });
    const drift = [];
    for (const item of eligible) {
      const ov = doc.overrides[item.slug];
      if (ov && item.sourceName && ov.name !== item.sourceName) {
        drift.push({ slug: item.slug, overrideName: ov.name, sourceName: item.sourceName });
      }
    }
    const hosts = readWorkerHosts(staticDir, nowMs);
    return { names: doc, eligible, drift, hosts };
  }

  function setOverride(rawSlug, rawName, by = 'pio') {
    const sv = validateSlug(rawSlug);
    if (!sv.ok) return { ok: false, status: 400, error: sv.error };
    const nv = validateDisplayName(rawName);
    if (!nv.ok) return { ok: false, status: 400, error: nv.error };

    const nowMs = now();
    const iso = new Date(nowMs).toISOString();
    const doc = load();
    const prev = doc.overrides[sv.value] ? doc.overrides[sv.value].name : null;

    if (!nv.value) {
      delete doc.overrides[sv.value];
    } else {
      doc.overrides[sv.value] = {
        name: nv.value,
        updated_at: iso,
        retired_at: null,
      };
    }

    doc.history.unshift({
      id: `h_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      ts: iso,
      slug: sv.value,
      action: nv.value ? 'override.set' : 'override.clear',
      prev_name: prev,
      next_name: nv.value || null,
      by,
    });
    doc.history = doc.history.slice(0, MAX_HISTORY);

    save(doc, nowMs);
    return { ok: true, names: doc };
  }

  function setOrchestrator(rawSlug, enabled, by = 'pio') {
    const sv = validateSlug(rawSlug);
    if (!sv.ok) return { ok: false, status: 400, error: sv.error };

    const nowMs = now();
    const iso = new Date(nowMs).toISOString();
    const doc = load();
    const set = new Set(doc.orchestrators);
    if (enabled) set.add(sv.value);
    else set.delete(sv.value);
    doc.orchestrators = [...set].sort();

    doc.history.unshift({
      id: `h_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      ts: iso,
      slug: sv.value,
      action: enabled ? 'orchestrator.add' : 'orchestrator.remove',
      prev_name: null,
      next_name: null,
      by,
    });
    doc.history = doc.history.slice(0, MAX_HISTORY);

    save(doc, nowMs);
    return { ok: true, names: doc };
  }

  function revertHistory(historyId, by = 'pio') {
    const doc = load();
    const revertedIds = new Set(
      doc.history
        .filter((h) => h && h.action === 'override.revert' && typeof h.reverted_id === 'string')
        .map((h) => h.reverted_id)
    );
    const isRevertable = (h) => h && (h.action === 'override.set' || h.action === 'override.clear');
    const target = historyId
      ? doc.history.find((h) => h.id === historyId && isRevertable(h))
      : doc.history.find((h) => isRevertable(h) && !revertedIds.has(h.id));

    if (!target) {
      return { ok: false, status: 404, error: 'no override history entry to revert' };
    }
    if (historyId && revertedIds.has(target.id)) {
      return { ok: false, status: 409, error: 'history entry already reverted' };
    }
    if (typeof target.slug !== 'string' || !SLUG_RE.test(target.slug)) {
      return { ok: false, status: 400, error: 'invalid slug in history entry' };
    }

    const nowMs = now();
    const iso = new Date(nowMs).toISOString();
    const current = doc.overrides[target.slug] ? doc.overrides[target.slug].name : null;
    const prevName = (typeof target.prev_name === 'string' && !SINGLE_LINE_CONTROL_RE.test(target.prev_name))
      ? target.prev_name.trim().slice(0, MAX_NAME_LENGTH)
      : '';

    if (prevName) {
      doc.overrides[target.slug] = {
        name: prevName,
        updated_at: iso,
        retired_at: null,
      };
    } else {
      delete doc.overrides[target.slug];
    }

    doc.history.unshift({
      id: `h_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      ts: iso,
      slug: target.slug,
      action: 'override.revert',
      prev_name: current,
      next_name: prevName || null,
      reverted_id: target.id,
      by,
    });
    doc.history = doc.history.slice(0, MAX_HISTORY);

    save(doc, nowMs);
    return { ok: true, names: doc, reverted: target };
  }

  return {
    load,
    snapshot,
    setOverride,
    setOrchestrator,
    revertHistory,
  };
}

module.exports = {
  HOST_DISPLAY_MAP,
  STALE_WORKER_SECONDS,
  displayHostName,
  validateSlug,
  validateDisplayName,
  normalizeNamesDoc,
  readWorkerHosts,
  createNamesStore,
};
