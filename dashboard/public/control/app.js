'use strict';

(function () {
  const STATE_POLL_MS = 5000;
  const PANE_POLL_MS = 1500;

  const state = {
    selectedPaneId: null,
    snapshot: null,
    snapshotTimer: null,
    paneTimer: null,
    lastUpdatedAt: 0,
    lastScreenText: '',
    wrapScreen: false,
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
    if (res.status === 429) {
      showError('slow down', 'warn');
      throw new Error('slow down');
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      showError(msg, 'error');
      throw new Error(msg);
    }

    clearError();
    return data;
  }

  function unwrapSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return {};
    if (raw.result && raw.result.snapshot) return raw.result.snapshot;
    if (raw.snapshot) return raw.snapshot;
    return raw;
  }

  function badge(text, cls) {
    const span = document.createElement('span');
    span.className = cls ? `badge ${cls}` : 'badge';
    span.textContent = text;
    return span;
  }

  function shortCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return '';
    const cleaned = cwd.replace(/\s*\(deleted\)\s*$/i, '').trim();
    if (!cleaned) return '';
    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length === 0) return '/';
    if (parts.length <= 2 && cleaned.startsWith('/home/')) return '~';
    return parts[parts.length - 1];
  }

  function paneDisplayName(pane, agent) {
    return (agent && agent.name)
      || (agent && agent.tokens && agent.tokens.name)
      || (pane && pane.label)
      || shortCwd(pane && (pane.foreground_cwd || pane.cwd))
      || 'shell';
  }

  function deriveAgentSlug(pane, agent) {
    const raw = (agent && agent.name)
      || (pane && pane.label)
      || shortCwd(pane && (pane.foreground_cwd || pane.cwd))
      || 'agent';
    const cleaned = String(raw)
      .split(' · ')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '')
      .slice(0, 32);
    return cleaned || 'agent';
  }

  function buildPaneButton(pane, agent) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    const isSelected = pane.pane_id === state.selectedPaneId;
    btn.className = 'pane-item' + (isSelected ? ' selected' : '');
    if (isSelected) btn.setAttribute('aria-current', 'true');
    btn.setAttribute('data-pane-id', pane.pane_id);

    const top = document.createElement('div');
    top.className = 'pane-row-top';

    const nameEl = document.createElement('span');
    nameEl.className = 'pane-name';
    const agentName = paneDisplayName(pane, agent);
    const agentKind = agent && agent.agent ? ` (${agent.agent})` : '';
    nameEl.textContent = `${agentName}${agentKind}`;

    const idEl = document.createElement('span');
    idEl.className = 'pane-id';
    idEl.textContent = pane.pane_id;

    top.appendChild(nameEl);
    top.appendChild(idEl);
    btn.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'pane-meta';

    let status = 'shell';
    let statusCls = 'status-shell';
    if (pane.restore_error) {
      status = 'restore error';
      statusCls = 'status-error';
    } else if (agent && agent.agent_status) {
      status = agent.agent_status;
      statusCls = `status-${status}`;
    } else if (pane.agent_status && pane.agent_status !== 'unknown') {
      status = pane.agent_status;
      statusCls = `status-${status}`;
    }
    meta.appendChild(badge(status, statusCls));

    if (pane.focused || (agent && agent.focused)) {
      meta.appendChild(badge('focused', 'focused'));
    }
    btn.appendChild(meta);

    const cwdHint = shortCwd(pane.foreground_cwd || pane.cwd);
    const taskText = (agent && agent.tokens && agent.tokens.task)
      || pane.restore_error
      || (agent && agent.terminal_title_stripped)
      || (pane.label ? (pane.terminal_title_stripped || cwdHint) : pane.terminal_title_stripped)
      || '';
    if (taskText && taskText !== agentName) {
      const taskEl = document.createElement('div');
      taskEl.className = 'pane-task';
      taskEl.textContent = taskText;
      btn.appendChild(taskEl);
    }

    if (agent && !pane.restore_error) {
      const quick = document.createElement('div');
      quick.className = 'pane-quick-actions';

      const appBtn = document.createElement('button');
      appBtn.type = 'button';
      appBtn.className = 'small approve';
      appBtn.textContent = 'Approve';
      appBtn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        sendKeyToPane(pane.pane_id, 'enter');
      });

      const denBtn = document.createElement('button');
      denBtn.type = 'button';
      denBtn.className = 'small deny';
      denBtn.textContent = 'Deny';
      denBtn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        sendKeyToPane(pane.pane_id, 'esc');
      });

      quick.appendChild(appBtn);
      quick.appendChild(denBtn);
      btn.appendChild(quick);
    }

    btn.addEventListener('click', () => selectPane(pane.pane_id));
    btn.addEventListener('keydown', (evt) => {
      if (evt.target !== btn) return;
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        selectPane(pane.pane_id);
      }
    });
    return btn;
  }

  function renderPaneList(snap) {
    const container = document.getElementById('pane-list');
    if (!container) return;
    container.textContent = '';

    const workspaces = Array.isArray(snap.workspaces) ? snap.workspaces.slice() : [];
    const tabs = Array.isArray(snap.tabs) ? snap.tabs.slice() : [];
    const panes = Array.isArray(snap.panes) ? snap.panes : [];
    const agents = Array.isArray(snap.agents) ? snap.agents : [];

    const agentByPane = new Map();
    for (const a of agents) {
      if (a && a.pane_id) agentByPane.set(a.pane_id, a);
    }

    // Ensure any agent without a pane record still shows up.
    const seenPaneIds = new Set(panes.map((p) => p && p.pane_id).filter(Boolean));
    const allPanes = panes.slice();
    for (const a of agents) {
      if (a && a.pane_id && !seenPaneIds.has(a.pane_id)) {
        allPanes.push({
          pane_id: a.pane_id,
          workspace_id: a.workspace_id,
          tab_id: a.tab_id,
          focused: a.focused,
          label: a.name || '',
        });
      }
    }

    if (allPanes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No panes reported by Herdr.';
      container.appendChild(empty);
      return;
    }

    workspaces.sort((a, b) => (a.number || 0) - (b.number || 0));
    tabs.sort((a, b) => (a.number || 0) - (b.number || 0));

    const wsMap = new Map(workspaces.map((w) => [w.workspace_id, w]));
    const tabMap = new Map(tabs.map((t) => [t.tab_id, t]));

    const grouped = new Map();
    for (const p of allPanes) {
      if (!p || !p.pane_id) continue;
      const wsId = p.workspace_id || 'unknown';
      const tabId = p.tab_id || 'unknown';
      if (!grouped.has(wsId)) grouped.set(wsId, new Map());
      const tabGroups = grouped.get(wsId);
      if (!tabGroups.has(tabId)) tabGroups.set(tabId, []);
      tabGroups.get(tabId).push(p);
    }

    const orderedWsIds = [
      ...workspaces.map((w) => w.workspace_id).filter((id) => grouped.has(id)),
      ...[...grouped.keys()].filter((id) => !wsMap.has(id)),
    ];

    for (const wsId of orderedWsIds) {
      const ws = wsMap.get(wsId);
      const wsBox = document.createElement('div');
      wsBox.className = 'ws-group';

      const wsTitle = document.createElement('h3');
      wsTitle.className = 'ws-title';
      wsTitle.textContent = (ws && ws.label ? `${ws.label} (${wsId})` : wsId) + (ws && ws.focused ? ' *' : '');
      wsBox.appendChild(wsTitle);

      const tabGroups = grouped.get(wsId);
      const orderedTabIds = [
        ...tabs.map((t) => t.tab_id).filter((id) => tabGroups.has(id)),
        ...[...tabGroups.keys()].filter((id) => !tabMap.has(id)),
      ];

      for (const tabId of orderedTabIds) {
        const tab = tabMap.get(tabId);
        const tabBox = document.createElement('div');
        tabBox.className = 'tab-group';

        const tabTitle = document.createElement('div');
        tabTitle.className = 'tab-title';
        const tabName = tab && tab.label ? `Tab ${tab.label}` : tabId;
        tabTitle.textContent = tabName + (tab && tab.focused ? ' (active)' : '');
        tabBox.appendChild(tabTitle);

        for (const p of tabGroups.get(tabId)) {
          tabBox.appendChild(buildPaneButton(p, agentByPane.get(p.pane_id)));
        }

        wsBox.appendChild(tabBox);
      }

      container.appendChild(wsBox);
    }
  }

  function findSelectedContext() {
    const snap = state.snapshot || {};
    const panes = Array.isArray(snap.panes) ? snap.panes : [];
    const agents = Array.isArray(snap.agents) ? snap.agents : [];
    const workspaces = Array.isArray(snap.workspaces) ? snap.workspaces : [];
    const tabs = Array.isArray(snap.tabs) ? snap.tabs : [];

    const pane = panes.find((p) => p && p.pane_id === state.selectedPaneId) || null;
    const agent = agents.find((a) => a && a.pane_id === state.selectedPaneId) || null;
    const wsId = (pane && pane.workspace_id) || (agent && agent.workspace_id) || null;
    const tabId = (pane && pane.tab_id) || (agent && agent.tab_id) || null;
    const ws = workspaces.find((w) => w && w.workspace_id === wsId) || null;
    const tab = tabs.find((t) => t && t.tab_id === tabId) || null;
    return { pane, agent, ws, tab };
  }

  function updateRecoveryPanel(screenText) {
    const panel = document.getElementById('recovery-panel');
    const msgEl = document.getElementById('recovery-msg');
    const startForm = document.getElementById('start-agent-form');
    const nameInput = document.getElementById('start-agent-name');
    const closeBtn = document.getElementById('recovery-close-btn');
    if (!panel || !msgEl || !startForm || !closeBtn) return;

    if (!state.selectedPaneId) {
      panel.hidden = true;
      return;
    }

    const { pane, agent } = findSelectedContext();
    const restoreErr = pane && pane.restore_error;
    const missingSession = /Error:\s*Session not found/i.test(screenText || '');

    if (restoreErr) {
      msgEl.textContent = `Restore failed: ${restoreErr}`;
      startForm.hidden = true;
      closeBtn.hidden = false;
      panel.hidden = false;
      return;
    }

    if (missingSession || (!agent && pane)) {
      msgEl.textContent = missingSession
        ? 'Dead session on screen (Session not found). Start a fresh agent in this pane:'
        : 'Shell pane has no active agent. Start an agent session here if needed:';
      startForm.hidden = false;
      closeBtn.hidden = true;
      if (nameInput && document.activeElement !== nameInput && !nameInput.dataset.dirty) {
        nameInput.value = deriveAgentSlug(pane, agent);
      }
      panel.hidden = false;
      return;
    }

    panel.hidden = true;
  }

  function updateDetailHeader() {
    const titleEl = document.getElementById('detail-title');
    const metaEl = document.getElementById('detail-meta');
    const toolsEl = document.getElementById('detail-tools');
    if (!titleEl || !metaEl) return;

    if (!state.selectedPaneId) {
      titleEl.textContent = 'Select a pane';
      metaEl.textContent = '';
      if (toolsEl) toolsEl.hidden = true;
      return;
    }

    const { pane, agent, ws, tab } = findSelectedContext();
    const name = paneDisplayName(pane, agent);
    titleEl.textContent = `${name} (${state.selectedPaneId})`;

    const parts = [];
    const wsLabel = (ws && ws.label) || (pane && pane.workspace_id) || (agent && agent.workspace_id);
    const tabLabel = (tab && tab.label) || (pane && pane.tab_id) || (agent && agent.tab_id);
    if (wsLabel) parts.push(tabLabel ? `${wsLabel} / ${tabLabel}` : wsLabel);

    if (pane && pane.restore_error) {
      parts.push('restore error');
    } else if (agent) {
      parts.push(`${agent.agent || 'agent'} | ${agent.agent_status || 'unknown'}`);
    } else {
      parts.push('shell');
    }

    const dir = shortCwd(pane && (pane.foreground_cwd || pane.cwd));
    if (dir) parts.push(dir);
    metaEl.textContent = parts.join(' | ');
    if (toolsEl) toolsEl.hidden = false;
    updateRecoveryPanel(state.lastScreenText);
  }

  async function refreshPaneScreen() {
    const paneId = state.selectedPaneId;
    if (!paneId) return;
    try {
      const data = await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}?lines=40`);
      if (state.selectedPaneId !== paneId) return;
      state.lastScreenText = data.text || '';
      const pre = document.getElementById('pane-screen');
      if (pre) {
        const atBottom = pre.scrollHeight - pre.clientHeight - pre.scrollTop < 32;
        pre.textContent = state.lastScreenText;
        if (atBottom) {
          pre.scrollTop = pre.scrollHeight;
        }
      }
      updateRecoveryPanel(state.lastScreenText);
    } catch {
      // Error banner already updated
    }
  }

  function selectPane(paneId) {
    state.selectedPaneId = paneId;
    state.lastScreenText = '';
    const emptyEl = document.getElementById('detail-empty');
    const bodyEl = document.getElementById('detail-body');
    const renameForm = document.getElementById('rename-form');
    const startName = document.getElementById('start-agent-name');
    if (emptyEl) emptyEl.hidden = !paneId ? false : true;
    if (bodyEl) bodyEl.hidden = !paneId;
    if (renameForm) renameForm.hidden = true;
    if (startName) delete startName.dataset.dirty;

    updateDetailHeader();
    if (state.snapshot) {
      renderPaneList(state.snapshot);
    }

    if (state.paneTimer) {
      clearInterval(state.paneTimer);
      state.paneTimer = null;
    }
    if (paneId) {
      refreshPaneScreen();
      state.paneTimer = setInterval(refreshPaneScreen, PANE_POLL_MS);
    }
  }

  async function refreshState() {
    try {
      const raw = await apiFetch('/agents/api/state');
      const snap = unwrapSnapshot(raw);
      state.snapshot = snap;
      state.lastUpdatedAt = Date.now();
      const ageEl = document.getElementById('snapshot-age');
      if (ageEl) ageEl.textContent = new Date().toLocaleTimeString();

      if (state.selectedPaneId) {
        const panes = Array.isArray(snap.panes) ? snap.panes : [];
        const agents = Array.isArray(snap.agents) ? snap.agents : [];
        const exists = panes.some((p) => p && p.pane_id === state.selectedPaneId)
          || agents.some((a) => a && a.pane_id === state.selectedPaneId);
        if (!exists) {
          selectPane(null);
        } else {
          updateDetailHeader();
        }
      }
      renderPaneList(snap);
    } catch {
      // Error banner handled in apiFetch
    }
  }

  async function refreshAuditIfOpen() {
    const details = document.getElementById('audit-details');
    if (!details || !details.open) return;
    const list = document.getElementById('audit-list');
    if (!list) return;
    try {
      const data = await apiFetch('/agents/api/audit');
      list.textContent = '';
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (entries.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'muted';
        empty.textContent = 'No audit entries yet.';
        list.appendChild(empty);
        return;
      }
      for (const e of entries) {
        const row = document.createElement('div');
        row.className = 'audit-row';
        const status = e.ok ? 'ok' : 'err';
        const panePart = e.paneId ? ` [${e.paneId}]` : '';
        row.textContent = `${e.ts} | ${e.ip} | ${e.action}${panePart} | ${status} | ${e.summary || ''}`;
        list.appendChild(row);
      }
    } catch {
      // Error banner handled
    }
  }

  async function sendKeyToPane(paneId, key) {
    if (!paneId) return;
    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/keys`, {
        method: 'POST',
        body: JSON.stringify({ keys: [key] }),
      });
      if (state.selectedPaneId === paneId) {
        setTimeout(refreshPaneScreen, 200);
      }
      refreshState();
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    }
  }

  async function sendKey(key) {
    return sendKeyToPane(state.selectedPaneId, key);
  }

  async function sendPrompt(evt) {
    evt.preventDefault();
    const paneId = state.selectedPaneId;
    const input = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('prompt-send');
    if (!paneId || !input) return;

    const text = input.value;
    if (!text.trim()) {
      showError('Prompt cannot be empty', 'warn');
      return;
    }

    if (sendBtn) sendBtn.disabled = true;
    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      input.value = '';
      setTimeout(refreshPaneScreen, 300);
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function openCloseDialog() {
    const paneId = state.selectedPaneId;
    const dialog = document.getElementById('close-dialog');
    const msg = document.getElementById('close-dialog-msg');
    const input = document.getElementById('close-confirm-input');
    const submit = document.getElementById('close-submit');
    if (!paneId || !dialog || !msg || !input || !submit) return;

    msg.textContent = `Type "${paneId}" to permanently close this pane.`;
    input.value = '';
    submit.disabled = true;
    dialog.showModal();
    input.focus();
  }

  async function confirmClosePane() {
    const paneId = state.selectedPaneId;
    const dialog = document.getElementById('close-dialog');
    const input = document.getElementById('close-confirm-input');
    if (!paneId || !input || input.value !== paneId) return;

    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/close`, {
        method: 'POST',
        body: JSON.stringify({ confirm: paneId }),
      });
      if (dialog && dialog.open) dialog.close();
      selectPane(null);
      refreshState();
      refreshAuditIfOpen();
    } catch {
      if (dialog && dialog.open) dialog.close();
    }
  }

  async function loadUser() {
    try {
      const me = await apiFetch('/agents/api/auth/me');
      const el = document.getElementById('user-info');
      if (el) {
        el.textContent = `${me.user} (${me.label || 'Passkey'})`;
      }
    } catch {
      // Handled by apiFetch
    }
  }

  async function savePaneRename(evt) {
    evt.preventDefault();
    const paneId = state.selectedPaneId;
    const input = document.getElementById('rename-input');
    const form = document.getElementById('rename-form');
    if (!paneId || !input) return;

    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ label: input.value }),
      });
      if (form) form.hidden = true;
      await refreshState();
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    }
  }

  async function startFreshAgent(evt) {
    evt.preventDefault();
    const paneId = state.selectedPaneId;
    const nameInput = document.getElementById('start-agent-name');
    const kindSelect = document.getElementById('start-agent-kind');
    const btn = document.getElementById('start-agent-btn');
    if (!paneId || !nameInput || !kindSelect) return;

    const name = nameInput.value.trim();
    const kind = kindSelect.value;
    if (!name) {
      showError('Agent slug is required', 'warn');
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/start`, {
        method: 'POST',
        body: JSON.stringify({ name, kind }),
      });
      delete nameInput.dataset.dirty;
      await refreshState();
      setTimeout(refreshPaneScreen, 300);
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function signOut() {
    try {
      await apiFetch('/agents/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      // Redirect regardless
    }
    window.location.assign('/agents/auth/login');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const dismiss = document.getElementById('error-dismiss');
    if (dismiss) dismiss.addEventListener('click', clearError);

    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) signOutBtn.addEventListener('click', signOut);

    document.querySelectorAll('[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        if (key) sendKey(key);
      });
    });

    const promptForm = document.getElementById('prompt-form');
    if (promptForm) promptForm.addEventListener('submit', sendPrompt);

    const closeBtn = document.getElementById('close-pane-btn');
    if (closeBtn) closeBtn.addEventListener('click', openCloseDialog);

    const recoveryCloseBtn = document.getElementById('recovery-close-btn');
    if (recoveryCloseBtn) recoveryCloseBtn.addEventListener('click', openCloseDialog);

    const renameToggle = document.getElementById('rename-toggle-btn');
    const renameForm = document.getElementById('rename-form');
    const renameInput = document.getElementById('rename-input');
    const renameCancel = document.getElementById('rename-cancel');
    if (renameToggle && renameForm && renameInput) {
      renameToggle.addEventListener('click', () => {
        const { pane } = findSelectedContext();
        renameInput.value = (pane && pane.label) || '';
        renameForm.hidden = !renameForm.hidden;
        if (!renameForm.hidden) renameInput.focus();
      });
      renameForm.addEventListener('submit', savePaneRename);
    }
    if (renameCancel && renameForm) {
      renameCancel.addEventListener('click', () => {
        renameForm.hidden = true;
      });
    }

    const wrapToggle = document.getElementById('wrap-toggle-btn');
    const paneScreen = document.getElementById('pane-screen');
    if (wrapToggle && paneScreen) {
      wrapToggle.addEventListener('click', () => {
        state.wrapScreen = !state.wrapScreen;
        paneScreen.classList.toggle('wrap', state.wrapScreen);
        wrapToggle.textContent = state.wrapScreen ? 'Wrap: On' : 'Wrap: Off';
        wrapToggle.setAttribute('aria-pressed', state.wrapScreen ? 'true' : 'false');
      });
    }

    const startForm = document.getElementById('start-agent-form');
    const startName = document.getElementById('start-agent-name');
    if (startName) {
      startName.addEventListener('input', () => {
        startName.dataset.dirty = '1';
      });
    }
    if (startForm) startForm.addEventListener('submit', startFreshAgent);

    const closeInput = document.getElementById('close-confirm-input');
    const closeSubmit = document.getElementById('close-submit');
    if (closeInput && closeSubmit) {
      closeInput.addEventListener('input', () => {
        closeSubmit.disabled = closeInput.value !== state.selectedPaneId;
      });
      closeSubmit.addEventListener('click', confirmClosePane);
    }

    const closeCancel = document.getElementById('close-cancel');
    const closeDialog = document.getElementById('close-dialog');
    if (closeCancel && closeDialog) {
      closeCancel.addEventListener('click', () => closeDialog.close());
    }

    const auditDetails = document.getElementById('audit-details');
    if (auditDetails) {
      auditDetails.addEventListener('toggle', () => {
        if (auditDetails.open) refreshAuditIfOpen();
      });
    }

    loadUser();
    refreshState();
    state.snapshotTimer = setInterval(refreshState, STATE_POLL_MS);
  });
})();
