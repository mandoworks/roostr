'use strict';

(function () {
  const state = {
    data: null,
    filter: '',
  };

  function showError(msg, kind) {
    const banner = document.getElementById('error-banner');
    const text = document.getElementById('error-text');
    if (!banner || !text) return;
    text.textContent = msg;
    banner.className = `banner ${kind || 'error'}`;
    banner.hidden = false;
  }

  function clearError() {
    const banner = document.getElementById('error-banner');
    if (banner) banner.hidden = true;
  }

  async function apiFetch(url, opts) {
    const options = Object.assign({ credentials: 'same-origin' }, opts || {});
    if (options.method === 'POST') {
      options.headers = Object.assign(
        {
          'Content-Type': 'application/json',
          'X-Roostr-CSRF': '1',
        },
        options.headers || {}
      );
    }
    const res = await fetch(url, options);
    if (res.status === 401) {
      window.location.assign('/agents/auth/login?next=' + encodeURIComponent(window.location.pathname));
      throw new Error('unauthorized');
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = (body && body.error) || `Request failed (${res.status})`;
      showError(msg, 'error');
      throw new Error(msg);
    }
    clearError();
    return body;
  }

  function renderSlugs() {
    const list = document.getElementById('slug-list');
    const driftBox = document.getElementById('drift-box');
    const driftMsg = document.getElementById('drift-msg');
    if (!list || !state.data) return;

    const { names, eligible, drift } = state.data;
    if (driftBox && driftMsg) {
      if (Array.isArray(drift) && drift.length > 0) {
        driftMsg.textContent = 'Drift detected: ' + drift.map((d) => `${d.slug} (${d.overrideName} vs ${d.sourceName})`).join(', ');
        driftBox.hidden = false;
      } else {
        driftBox.hidden = true;
      }
    }

    list.textContent = '';
    const filter = state.filter.trim().toLowerCase();
    const orchSet = new Set((names && names.orchestrators) || []);
    const overrides = (names && names.overrides) || {};

    const items = (eligible || []).filter((item) => {
      if (!filter) return true;
      const ov = overrides[item.slug] ? overrides[item.slug].name : '';
      return item.slug.includes(filter) || (item.sourceName || '').toLowerCase().includes(filter) || ov.toLowerCase().includes(filter);
    });

    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No matching slugs.';
      list.appendChild(p);
      return;
    }

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'pane-item';

      const top = document.createElement('div');
      top.className = 'pane-row-top';
      const slugEl = document.createElement('span');
      slugEl.className = 'pane-name';
      slugEl.textContent = item.slug;

      const metaEl = document.createElement('span');
      metaEl.className = 'pane-id';
      metaEl.textContent = item.sources.join(', ');
      top.appendChild(slugEl);
      top.appendChild(metaEl);
      card.appendChild(top);

      if (item.sourceName) {
        const src = document.createElement('div');
        src.className = 'pane-task';
        src.textContent = `source: ${item.sourceName}`;
        card.appendChild(src);
      }

      const form = document.createElement('form');
      form.className = 'inline-form';

      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 64;
      input.placeholder = 'Canonical display name (empty clears)';
      input.value = (overrides[item.slug] && overrides[item.slug].name) || '';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'small primary';
      saveBtn.textContent = 'Save';

      const orchBtn = document.createElement('button');
      orchBtn.type = 'button';
      const isOrch = orchSet.has(item.slug);
      orchBtn.className = isOrch ? 'small approve' : 'small';
      orchBtn.textContent = isOrch ? 'Orchestrator' : 'Mark orch';

      orchBtn.addEventListener('click', async () => {
        await apiFetch('/agents/api/names/orchestrator', {
          method: 'POST',
          body: JSON.stringify({ slug: item.slug, enabled: !isOrch }),
        });
        await refresh();
      });

      form.addEventListener('submit', async (evt) => {
        evt.preventDefault();
        await apiFetch('/agents/api/names/override', {
          method: 'POST',
          body: JSON.stringify({ slug: item.slug, name: input.value }),
        });
        await refresh();
      });

      form.appendChild(input);
      form.appendChild(saveBtn);
      form.appendChild(orchBtn);
      card.appendChild(form);
      list.appendChild(card);
    }
  }

  function renderHosts() {
    const hostsEl = document.getElementById('hosts-list');
    const summaryEl = document.getElementById('hosts-summary');
    if (!hostsEl || !state.data) return;
    const hosts = Array.isArray(state.data.hosts) ? state.data.hosts : [];
    if (summaryEl) summaryEl.textContent = `${hosts.length} host(s)`;
    hostsEl.textContent = '';

    for (const h of hosts) {
      const box = document.createElement('div');
      box.className = 'ws-group';
      const title = document.createElement('h3');
      title.className = 'ws-title';
      const age = h.ageSec === null ? 'unknown age' : `${h.ageSec}s ago`;
      title.textContent = `${h.host} (${h.workers.length} workers, ${age}${h.stale ? ', STALE' : ''})`;
      box.appendChild(title);

      for (const w of h.workers) {
        const row = document.createElement('div');
        row.className = 'audit-row';
        const label = w.name || w.agent || w.pane_id;
        row.textContent = `${w.pane_id} | ${label} | ${w.state || 'unknown'} | ${w.task || ''}`;
        box.appendChild(row);
      }
      hostsEl.appendChild(box);
    }
  }

  function renderHistory() {
    const el = document.getElementById('history-list');
    if (!el || !state.data) return;
    el.textContent = '';
    const history = (state.data.names && state.data.names.history) || [];
    if (history.length === 0) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = 'No changes recorded yet.';
      el.appendChild(span);
      return;
    }
    for (const h of history.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'audit-row';
      row.textContent = `${h.ts} | ${h.slug} | ${h.action} | ${h.prev_name || '-'} -> ${h.next_name || '-'}`;
      el.appendChild(row);
    }
  }

  async function refresh() {
    state.data = await apiFetch('/agents/api/names');
    renderSlugs();
    renderHosts();
    renderHistory();
  }

  async function loadUser() {
    const me = await apiFetch('/agents/api/auth/me');
    const el = document.getElementById('user-info');
    if (el) el.textContent = `${me.user} (${me.label || 'Passkey'})`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const dismiss = document.getElementById('error-dismiss');
    if (dismiss) dismiss.addEventListener('click', clearError);

    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', async () => {
        try {
          await apiFetch('/agents/api/auth/logout', { method: 'POST', body: '{}' });
        } catch {}
        window.location.assign('/agents/auth/login');
      });
    }

    const filterInput = document.getElementById('slug-filter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        state.filter = filterInput.value;
        renderSlugs();
      });
    }

    const revertBtn = document.getElementById('revert-btn');
    if (revertBtn) {
      revertBtn.addEventListener('click', async () => {
        await apiFetch('/agents/api/names/revert', { method: 'POST', body: '{}' });
        await refresh();
      });
    }

    loadUser().catch(() => {});
    refresh().catch(() => {});
  });
})();
