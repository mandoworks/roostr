'use strict';

(function () {
  const STATE_POLL_MS = 5000;
  const PANE_POLL_MS = 1500;
  const COLLAPSED_STORAGE_KEY = 'roostr_collapsed_ws';

  function loadCollapsedState() {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCollapsedState(map) {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(map));
    } catch {
      // Ignore storage quota or private mode errors
    }
  }

  function parseInitialSelect() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const sel = params.get('select');
      if (!sel) return { paneId: null, museSlug: null };
      if (sel.startsWith('muse:')) {
        return { paneId: null, museSlug: sel.slice(5) || null };
      }
      return { paneId: sel, museSlug: null };
    } catch {
      return { paneId: null, museSlug: null };
    }
  }

  const initialSelect = parseInitialSelect();

  const state = {
    selectedPaneId: null,
    selectedMuseSlug: null,
    pendingSelectPaneId: initialSelect.paneId,
    pendingSelectMuseSlug: initialSelect.museSlug,
    snapshot: null,
    sessionsData: null,
    museData: null,
    snapshotTimer: null,
    paneTimer: null,
    lastUpdatedAt: 0,
    lastScreenText: '',
    wrapScreen: false,
    forceRecoveryOpen: false,
    sidebarCollapsed: false,
    viewMode: 'all',
    filterText: '',
    statusFilter: 'all',
    collapsed: loadCollapsedState(),
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
      window.location.assign(
        '/agents/auth/login?next=' + encodeURIComponent(window.location.pathname + (window.location.search || ''))
      );
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

  async function optionalGet(url) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.status === 401) {
        window.location.assign(
          '/agents/auth/login?next=' + encodeURIComponent(window.location.pathname + (window.location.search || ''))
        );
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
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

  function getPaneStatus(pane, agent) {
    if (pane && pane.restore_error) return 'restore error';
    if (agent && agent.agent_status) return agent.agent_status;
    if (pane && pane.agent_status && pane.agent_status !== 'unknown') return pane.agent_status;
    return 'shell';
  }

  function matchesFilter(textFields, statusValue) {
    if (state.statusFilter !== 'all' && statusValue !== state.statusFilter) {
      return false;
    }
    const q = state.filterText.trim().toLowerCase();
    if (!q) return true;
    return textFields.some((val) => val && String(val).toLowerCase().includes(q));
  }

  function matchesPaneFilter(pane, agent) {
    const status = getPaneStatus(pane, agent);
    const name = paneDisplayName(pane, agent);
    const task = (agent && agent.tokens && agent.tokens.task) || '';
    const cwd = (pane && (pane.foreground_cwd || pane.cwd)) || '';
    const title = (agent && agent.terminal_title_stripped) || (pane && pane.terminal_title_stripped) || '';
    return matchesFilter([name, pane.pane_id, task, cwd, title, pane.restore_error], status);
  }

  function buildCollapseHeader(key, labelText, activeCount, blockedCount, totalCount, opts) {
    const isCollapsed = Boolean(state.collapsed[key]);
    const isTab = Boolean(opts && opts.isTab);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'collapse-toggle';
    btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

    const left = document.createElement('span');
    left.className = 'collapse-toggle-left';

    const chev = document.createElement('span');
    chev.className = 'collapse-chevron';
    chev.textContent = isCollapsed ? '\u25B8' : '\u25BE';

    const lbl = document.createElement('span');
    lbl.className = 'collapse-label' + (isTab ? ' tab-title' : '');
    lbl.textContent = labelText;

    left.appendChild(chev);
    left.appendChild(lbl);
    btn.appendChild(left);

    const counts = document.createElement('span');
    counts.className = 'collapse-counts';
    if (blockedCount > 0) {
      counts.appendChild(badge(`${blockedCount} blocked`, 'status-blocked'));
    }
    if (activeCount > 0) {
      counts.appendChild(badge(`${activeCount} active`, 'status-working'));
    }
    if (isTab) {
      counts.appendChild(badge(`${totalCount} ${totalCount === 1 ? 'pane' : 'panes'}`, 'tab-count-badge'));
    } else if (blockedCount === 0 && activeCount === 0) {
      counts.appendChild(badge(`${totalCount}`, ''));
    }
    btn.appendChild(counts);

    btn.addEventListener('click', () => {
      if (state.collapsed[key]) {
        delete state.collapsed[key];
      } else {
        state.collapsed[key] = true;
      }
      saveCollapsedState(state.collapsed);
      renderSidebar();
    });
    return btn;
  }

  function buildPaneButton(pane, agent) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    const isSelected = pane.pane_id === state.selectedPaneId && !state.selectedMuseSlug;
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

    const status = getPaneStatus(pane, agent);
    let statusCls = 'status-shell';
    if (status === 'restore error') statusCls = 'status-error';
    else if (status !== 'shell') statusCls = `status-${status}`;
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

  function getAllPanesFromSnapshot(snap) {
    const panes = Array.isArray(snap && snap.panes) ? snap.panes : [];
    const agents = Array.isArray(snap && snap.agents) ? snap.agents : [];
    const agentByPane = new Map();
    for (const a of agents) {
      if (a && a.pane_id) agentByPane.set(a.pane_id, a);
    }
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
    return { allPanes, agentByPane };
  }

  function renderPaneList(snap) {
    const container = document.getElementById('pane-list');
    if (!container) return;
    container.textContent = '';

    if (state.viewMode === 'muse') {
      container.hidden = true;
      return;
    }
    container.hidden = false;

    if (!snap) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = 'Loading panes...';
      container.appendChild(loading);
      return;
    }

    const workspaces = Array.isArray(snap.workspaces) ? snap.workspaces.slice() : [];
    const tabs = Array.isArray(snap.tabs) ? snap.tabs.slice() : [];
    const { allPanes, agentByPane } = getAllPanesFromSnapshot(snap);

    const filteredPanes = allPanes.filter((p) => p && p.pane_id && matchesPaneFilter(p, agentByPane.get(p.pane_id)));

    if (filteredPanes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = allPanes.length === 0 ? 'No panes reported by Herdr.' : 'No panes match current filter.';
      container.appendChild(empty);
      return;
    }

    workspaces.sort((a, b) => (a.number || 0) - (b.number || 0));
    tabs.sort((a, b) => (a.number || 0) - (b.number || 0));

    const wsMap = new Map(workspaces.map((w) => [w.workspace_id, w]));
    const tabMap = new Map(tabs.map((t) => [t.tab_id, t]));

    const grouped = new Map();
    for (const p of filteredPanes) {
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
      const wsKey = `ws:${wsId}`;
      const wsBox = document.createElement('div');
      wsBox.className = 'ws-group' + (state.collapsed[wsKey] ? ' collapsed' : '');

      const tabGroups = grouped.get(wsId);
      let wsActive = 0;
      let wsBlocked = 0;
      let wsTotal = 0;
      for (const paneArr of tabGroups.values()) {
        for (const p of paneArr) {
          wsTotal += 1;
          const st = getPaneStatus(p, agentByPane.get(p.pane_id));
          if (st === 'working') wsActive += 1;
          if (st === 'blocked' || st === 'restore error') wsBlocked += 1;
        }
      }

      const wsLabel = (ws && ws.label ? `${ws.label} (${wsId})` : wsId) + (ws && ws.focused ? ' *' : '');
      wsBox.appendChild(buildCollapseHeader(wsKey, wsLabel, wsActive, wsBlocked, wsTotal));

      const wsChildren = document.createElement('div');
      wsChildren.className = 'ws-children';

      const orderedTabIds = [
        ...tabs.map((t) => t.tab_id).filter((id) => tabGroups.has(id)),
        ...[...tabGroups.keys()].filter((id) => !tabMap.has(id)),
      ];

      for (const tabId of orderedTabIds) {
        const tab = tabMap.get(tabId);
        const tabKey = `tab:${wsId}:${tabId}`;
        const tabPanes = tabGroups.get(tabId);
        let tabActive = 0;
        let tabBlocked = 0;
        for (const p of tabPanes) {
          const st = getPaneStatus(p, agentByPane.get(p.pane_id));
          if (st === 'working') tabActive += 1;
          if (st === 'blocked' || st === 'restore error') tabBlocked += 1;
        }

        const tabBox = document.createElement('div');
        tabBox.className = 'tab-group' + (state.collapsed[tabKey] ? ' collapsed' : '');
        let tabTitle = tabId;
        if (tab) {
          const hasNum = tab.number !== undefined && tab.number !== null && tab.number !== '';
          const rawLabel = (tab.label || '').trim();
          if (hasNum && rawLabel && rawLabel !== String(tab.number) && rawLabel !== `Tab ${tab.number}`) {
            tabTitle = `Tab ${tab.number} \u00B7 ${rawLabel}`;
          } else if (hasNum) {
            tabTitle = `Tab ${tab.number}`;
          } else if (rawLabel) {
            tabTitle = rawLabel.startsWith('Tab ') ? rawLabel : `Tab ${rawLabel}`;
          }
          if (tab.focused) {
            tabTitle += ' (active)';
          }
        }
        tabBox.appendChild(buildCollapseHeader(tabKey, tabTitle, tabActive, tabBlocked, tabPanes.length, { isTab: true }));

        const tabChildren = document.createElement('div');
        tabChildren.className = 'tab-children';
        for (const p of tabPanes) {
          tabChildren.appendChild(buildPaneButton(p, agentByPane.get(p.pane_id)));
        }
        tabBox.appendChild(tabChildren);
        wsChildren.appendChild(tabBox);
      }

      wsBox.appendChild(wsChildren);
      container.appendChild(wsBox);
    }
  }

  function getNormalizedMuseAgents() {
    if (!state.museData) return [];
    const list = [];
    const seen = new Set();
    const pushAgent = (a) => {
      if (!a || !a.slug || seen.has(a.slug)) return;
      seen.add(a.slug);
      list.push(a);
    };
    if (state.museData.romanDesk) pushAgent(state.museData.romanDesk);
    if (Array.isArray(state.museData.agents)) {
      for (const a of state.museData.agents) pushAgent(a);
    }
    return list;
  }

  function renderMuseList() {
    const container = document.getElementById('muse-list');
    if (!container) return;
    container.textContent = '';

    if (state.viewMode === 'panes') {
      container.hidden = true;
      return;
    }
    container.hidden = false;

    const allMuse = getNormalizedMuseAgents();
    if (allMuse.length === 0) return;

    const filtered = allMuse.filter((a) => {
      const st = a.state || 'idle';
      return matchesFilter([a.name, a.overrideName, a.sourceName, a.slug, a.role, a.currentTask, a.nextTask], st);
    });

    if (filtered.length === 0 && state.viewMode !== 'muse') return;

    const groupKey = 'muse';
    const wsBox = document.createElement('div');
    wsBox.className = 'ws-group' + (state.collapsed[groupKey] ? ' collapsed' : '');

    let activeCount = 0;
    let blockedCount = 0;
    for (const a of filtered) {
      if (a.state === 'working') activeCount += 1;
      if (a.state === 'blocked') blockedCount += 1;
    }

    wsBox.appendChild(buildCollapseHeader(groupKey, 'Muse Agents (Roman & Desks)', activeCount, blockedCount, filtered.length));

    const children = document.createElement('div');
    children.className = 'ws-children';

    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No Muse agents match current filter.';
      children.appendChild(empty);
    } else {
      for (const a of filtered) {
        const btn = document.createElement('div');
        btn.setAttribute('role', 'button');
        btn.tabIndex = 0;
        const isSelected = state.selectedMuseSlug === a.slug;
        btn.className = 'pane-item' + (isSelected ? ' selected' : '');
        if (isSelected) btn.setAttribute('aria-current', 'true');
        btn.setAttribute('data-muse-slug', a.slug);

        const top = document.createElement('div');
        top.className = 'pane-row-top';

        const nameEl = document.createElement('span');
        nameEl.className = 'pane-name';
        const displayName = a.overrideName || a.name || a.slug;
        nameEl.textContent = `${a.emoji ? a.emoji + ' ' : ''}${displayName}`;

        const idEl = document.createElement('span');
        idEl.className = 'pane-id';
        idEl.textContent = a.slug;

        top.appendChild(nameEl);
        top.appendChild(idEl);
        btn.appendChild(top);

        const meta = document.createElement('div');
        meta.className = 'pane-meta';
        const st = a.state || 'idle';
        meta.appendChild(badge(st, `status-${st}`));
        if (a.isOrchestrator) meta.appendChild(badge('orch', 'focused'));
        if (a.model) meta.appendChild(badge(a.model, ''));
        btn.appendChild(meta);

        if (a.currentTask) {
          const taskEl = document.createElement('div');
          taskEl.className = 'pane-task';
          taskEl.textContent = a.currentTask;
          btn.appendChild(taskEl);
        }

        btn.addEventListener('click', () => selectMuseAgent(a.slug));
        btn.addEventListener('keydown', (evt) => {
          if (evt.target !== btn) return;
          if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            selectMuseAgent(a.slug);
          }
        });
        children.appendChild(btn);
      }
    }

    wsBox.appendChild(children);
    container.appendChild(wsBox);
  }

  function renderSidebar() {
    renderPaneList(state.snapshot);
    renderMuseList();
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

  function getSavedSessionsList() {
    return (state.sessionsData && Array.isArray(state.sessionsData.sessions)) ? state.sessionsData.sessions : [];
  }

  function populateSessionPicker(pane) {
    const sel = document.getElementById('start-agent-session');
    if (!sel) return;
    const prevVal = sel.value;
    sel.textContent = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Fresh session (no resume)';
    sel.appendChild(defaultOpt);

    const sessions = getSavedSessionsList();
    if (sessions.length === 0) return;

    const paneCwd = pane && (pane.foreground_cwd || pane.cwd) || '';
    const sorted = sessions.slice().sort((a, b) => {
      const aMatch = paneCwd && a.cwd && paneCwd.startsWith(a.cwd) ? 1 : 0;
      const bMatch = paneCwd && b.cwd && paneCwd.startsWith(b.cwd) ? 1 : 0;
      return bMatch - aMatch;
    });

    for (const s of sorted) {
      const sid = s.sessionId || s.session || s.id;
      if (!sid) continue;
      const opt = document.createElement('option');
      opt.value = sid;
      const labelName = s.name || s.slug || s.kind || s.agent || 'session';
      const dir = shortCwd(s.cwd);
      opt.textContent = `${labelName} (${s.kind || s.agent || 'agent'})${dir ? ' @ ' + dir : ''} [${String(sid).slice(0, 12)}]`;
      sel.appendChild(opt);
    }

    if (prevVal && [...sel.options].some((o) => o.value === prevVal)) {
      sel.value = prevVal;
    }
    updateStartButtonLabel();
  }

  function updateStartButtonLabel() {
    const sel = document.getElementById('start-agent-session');
    const btn = document.getElementById('start-agent-btn');
    if (!sel || !btn) return;
    btn.textContent = sel.value ? 'Resume Saved Session' : 'Start Agent';
  }

  function updateRecoveryPanel(screenText) {
    const panel = document.getElementById('recovery-panel');
    const details = document.getElementById('recovery-details');
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
    populateSessionPicker(pane);

    const restoreErr = pane && pane.restore_error;
    const missingSession = /Error:\s*Session not found/i.test(screenText || '');

    if (restoreErr) {
      msgEl.textContent = `Restore failed: ${restoreErr}`;
      startForm.hidden = true;
      closeBtn.hidden = false;
      panel.hidden = false;
      if (details) details.open = true;
      return;
    }

    if (missingSession || (!agent && pane) || state.forceRecoveryOpen) {
      if (missingSession) {
        msgEl.textContent = 'Dead session on screen (Session not found). Start or resume an agent in this pane:';
      } else if (!agent && pane) {
        msgEl.textContent = 'Shell pane has no active agent. Start, resume a saved session, or split:';
      } else {
        msgEl.textContent = 'Start a new session, resume a saved session, or split this pane:';
      }
      startForm.hidden = false;
      closeBtn.hidden = true;
      if (nameInput && document.activeElement !== nameInput && !nameInput.dataset.dirty) {
        nameInput.value = deriveAgentSlug(pane, agent);
      }
      panel.hidden = false;
      if (details) details.open = true;
      return;
    }

    panel.hidden = true;
  }

  function updateDetailHeader() {
    const titleEl = document.getElementById('detail-title');
    const metaEl = document.getElementById('detail-meta');
    const toolsEl = document.getElementById('detail-tools');
    if (!titleEl || !metaEl) return;

    if (state.selectedMuseSlug) {
      const agent = getNormalizedMuseAgents().find((a) => a.slug === state.selectedMuseSlug);
      if (toolsEl) toolsEl.hidden = true;
      if (!agent) {
        titleEl.textContent = state.selectedMuseSlug;
        metaEl.textContent = 'Muse agent';
        return;
      }
      const displayName = agent.overrideName || agent.name || agent.slug;
      titleEl.textContent = `${agent.emoji ? agent.emoji + ' ' : ''}${displayName} (${agent.slug})`;
      const parts = [agent.role || 'Muse agent', agent.state || 'idle'];
      if (agent.model) parts.push(agent.model);
      metaEl.textContent = parts.join(' | ');
      return;
    }

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
    state.selectedMuseSlug = null;
    state.lastScreenText = '';
    state.forceRecoveryOpen = false;

    const sessionBtn = document.getElementById('session-panel-toggle-btn');
    if (sessionBtn) sessionBtn.setAttribute('aria-pressed', 'false');

    const emptyEl = document.getElementById('detail-empty');
    const bodyEl = document.getElementById('detail-body');
    const museBody = document.getElementById('muse-detail-body');
    const renameForm = document.getElementById('rename-form');
    const startName = document.getElementById('start-agent-name');

    if (museBody) museBody.hidden = true;
    if (emptyEl) emptyEl.hidden = Boolean(paneId);
    if (bodyEl) bodyEl.hidden = !paneId;
    if (renameForm) renameForm.hidden = true;
    if (startName) delete startName.dataset.dirty;

    updateDetailHeader();
    renderSidebar();

    if (state.paneTimer) {
      clearInterval(state.paneTimer);
      state.paneTimer = null;
    }
    if (paneId) {
      refreshPaneScreen();
      state.paneTimer = setInterval(refreshPaneScreen, PANE_POLL_MS);
    }
  }

  function renderMuseDetail(agent) {
    const header = document.getElementById('muse-detail-header');
    const overrideInput = document.getElementById('muse-override-input');
    const orchBtn = document.getElementById('muse-orch-toggle');
    const summaryCard = document.getElementById('muse-summary-card');
    const tasksList = document.getElementById('muse-tasks-list');
    const docsContainer = document.getElementById('muse-docs-container');

    if (header) {
      header.textContent = '';
      const top = document.createElement('div');
      top.className = 'muse-header-top';

      const title = document.createElement('strong');
      const displayName = agent.overrideName || agent.name || agent.slug;
      title.textContent = `${agent.emoji ? agent.emoji + ' ' : ''}${displayName} (@${agent.slug})`;

      const badges = document.createElement('div');
      badges.className = 'pane-meta';
      const st = agent.state || 'idle';
      badges.appendChild(badge(st, `status-${st}`));
      if (agent.isOrchestrator) badges.appendChild(badge('orchestrator', 'focused'));

      top.appendChild(title);
      top.appendChild(badges);
      header.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'muse-meta-grid';
      const items = [
        ['Model', agent.model || '-'],
        ['Session', agent.session || '-'],
        ['Last Activity', agent.lastActivityAst || '-'],
        ['Bank', agent.bank || '-'],
      ];
      for (const [k, v] of items) {
        const span = document.createElement('span');
        span.textContent = `${k}: ${v}`;
        meta.appendChild(span);
      }
      header.appendChild(meta);
    }

    if (overrideInput) {
      overrideInput.value = agent.overrideName || '';
    }
    if (orchBtn) {
      orchBtn.className = agent.isOrchestrator ? 'small approve' : 'small';
      orchBtn.textContent = agent.isOrchestrator ? 'Orchestrator' : 'Mark Orchestrator';
    }

    if (summaryCard) {
      summaryCard.textContent = '';
      const rows = [
        ['Current Task', agent.currentTask || 'None'],
        ['Next Task', agent.nextTask || 'None'],
        ['Blocker', agent.blocker || 'None'],
      ];
      for (const [label, val] of rows) {
        const div = document.createElement('div');
        div.className = 'muse-task-row';
        const strong = document.createElement('strong');
        strong.textContent = label + ':';
        const text = document.createElement('span');
        text.textContent = val;
        div.appendChild(strong);
        div.appendChild(text);
        summaryCard.appendChild(div);
      }
    }

    if (tasksList) {
      tasksList.textContent = '';
      const tasks = Array.isArray(agent.tasks) ? agent.tasks : [];
      if (tasks.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'muted';
        empty.textContent = 'No tasks listed.';
        tasksList.appendChild(empty);
      } else {
        for (const t of tasks) {
          const row = document.createElement('div');
          row.className = 'muse-task-row';
          const text = document.createElement('span');
          text.textContent = typeof t === 'string' ? t : (t.title || t.text || t.id || JSON.stringify(t));
          const tStatus = (t && t.status) || 'pending';
          const cls = tStatus === 'done' ? 'status-done'
            : tStatus === 'blocked' ? 'status-blocked'
              : (tStatus === 'in-progress' || tStatus === 'working') ? 'status-working'
                : 'status-idle';
          row.appendChild(text);
          row.appendChild(badge(tStatus, cls));
          tasksList.appendChild(row);
        }
      }
    }

    if (docsContainer) {
      docsContainer.textContent = '';
      const docs = agent.docs || {};
      const docEntries = [
        ['SOUL.md', docs['SOUL.md'] || docs.soul || ''],
        ['AGENT.md', docs['AGENT.md'] || docs.agent || ''],
        ['STATE.md', docs['STATE.md'] || docs.state || ''],
      ];
      let anyDoc = false;
      for (const [fname, content] of docEntries) {
        if (!content) continue;
        anyDoc = true;
        const det = document.createElement('details');
        det.className = 'muse-doc-item';
        const sum = document.createElement('summary');
        sum.textContent = fname;
        const pre = document.createElement('pre');
        pre.className = 'muse-doc-pre';
        pre.textContent = content;
        det.appendChild(sum);
        det.appendChild(pre);
        docsContainer.appendChild(det);
      }
      if (!anyDoc) {
        const empty = document.createElement('span');
        empty.className = 'muted';
        empty.textContent = 'No agent docs available.';
        docsContainer.appendChild(empty);
      }
    }
  }

  function renderMuseInboxStatus(text) {
    const list = document.getElementById('muse-inbox-list');
    if (!list) return;
    list.textContent = '';
    const msg = document.createElement('span');
    msg.className = 'muted';
    msg.textContent = text;
    list.appendChild(msg);
  }

  function renderMuseInboxMessages(messages) {
    const list = document.getElementById('muse-inbox-list');
    if (!list) return;
    list.textContent = '';

    if (!Array.isArray(messages) || messages.length === 0) {
      renderMuseInboxStatus('No recent PioRelay messages.');
      return;
    }

    for (const m of messages) {
      const item = document.createElement('div');
      item.className = 'muse-inbox-item';

      const head = document.createElement('div');
      head.className = 'muse-inbox-head';

      const badges = document.createElement('div');
      badges.className = 'muse-inbox-badges';
      const fromAgent = m.from_agent || m.from || '?';
      const toAgent = m.to_agent || m.to || '?';
      badges.appendChild(badge(`${fromAgent} -> ${toAgent}`, 'status-idle'));
      if (m.project) {
        badges.appendChild(badge(m.project, 'focused'));
      }

      const ts = document.createElement('span');
      ts.className = 'muted';
      ts.textContent = m.created_at || m.timestamp || m.ts || '';

      head.appendChild(badges);
      head.appendChild(ts);
      item.appendChild(head);

      const subj = document.createElement('div');
      subj.className = 'muse-inbox-subject';
      const strong = document.createElement('strong');
      strong.textContent = m.subject || '(no subject)';
      subj.appendChild(strong);
      item.appendChild(subj);

      const bodyText = m.body || m.message || m.text || '';
      if (bodyText) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'muse-inbox-body';
        bodyEl.textContent = bodyText;
        item.appendChild(bodyEl);
      }

      const actions = document.createElement('div');
      actions.className = 'muse-inbox-actions';
      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'small';
      replyBtn.textContent = 'Reply in Form';
      replyBtn.addEventListener('click', () => {
        const subjInput = document.getElementById('muse-msg-subject');
        const projInput = document.getElementById('muse-msg-project');
        const bodyInput = document.getElementById('muse-msg-body');
        const msgDetails = document.getElementById('muse-message-details');
        if (msgDetails) msgDetails.open = true;
        if (subjInput) {
          const rawSubj = (m.subject || '').trim();
          subjInput.value = /^re:/i.test(rawSubj) ? rawSubj : `Re: ${rawSubj}`;
        }
        if (projInput) {
          projInput.value = m.project || 'muse';
        }
        if (bodyInput) {
          bodyInput.focus();
          bodyInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      actions.appendChild(replyBtn);
      item.appendChild(actions);

      list.appendChild(item);
    }
  }

  async function loadMuseInbox(slug) {
    if (!slug) return;
    const refreshBtn = document.getElementById('muse-inbox-refresh-btn');
    const statusEl = document.getElementById('muse-inbox-status');
    if (refreshBtn) refreshBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Loading...';

    try {
      const res = await fetch(`/agents/api/muse/messages?agent=${encodeURIComponent(slug)}&limit=20`, {
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        window.location.assign(
          '/agents/auth/login?next=' + encodeURIComponent(window.location.pathname + (window.location.search || ''))
        );
        return;
      }
      if (state.selectedMuseSlug !== slug) return;
      if (res.status === 502) {
        renderMuseInboxStatus('PioRelay inbox unavailable (502).');
        if (statusEl) statusEl.textContent = 'Relay unavailable';
        return;
      }
      if (!res.ok) {
        renderMuseInboxStatus(`Could not load inbox (${res.status}).`);
        if (statusEl) statusEl.textContent = '';
        return;
      }
      const data = await res.json();
      if (state.selectedMuseSlug !== slug) return;
      const messages = Array.isArray(data) ? data : (Array.isArray(data && data.messages) ? data.messages : []);
      renderMuseInboxMessages(messages);
      if (statusEl) statusEl.textContent = `${messages.length} message${messages.length === 1 ? '' : 's'}`;
    } catch {
      if (state.selectedMuseSlug === slug) {
        renderMuseInboxStatus('PioRelay inbox unavailable.');
        if (statusEl) statusEl.textContent = '';
      }
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function selectMuseAgent(slug) {
    state.selectedMuseSlug = slug;
    state.selectedPaneId = null;
    if (state.paneTimer) {
      clearInterval(state.paneTimer);
      state.paneTimer = null;
    }

    const emptyEl = document.getElementById('detail-empty');
    const bodyEl = document.getElementById('detail-body');
    const museBody = document.getElementById('muse-detail-body');
    const renameForm = document.getElementById('rename-form');

    if (renameForm) renameForm.hidden = true;
    if (bodyEl) bodyEl.hidden = true;

    const agent = getNormalizedMuseAgents().find((a) => a.slug === slug);
    if (!agent) {
      if (museBody) museBody.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
    } else {
      if (emptyEl) emptyEl.hidden = true;
      if (museBody) museBody.hidden = false;
      renderMuseDetail(agent);
      loadMuseInbox(slug);
    }

    updateDetailHeader();
    renderSidebar();
  }

  function populateRestoreWorkspaceSelect() {
    const select = document.getElementById('restore-workspace-select');
    if (!select) return;
    const prev = select.value || 'all';
    const seen = new Map();

    const data = state.sessionsData;
    const backups = data && Array.isArray(data.backups) ? data.backups : [];
    for (const b of backups) {
      const wsId = b && (b.workspaceId || b.label);
      if (!wsId || wsId === 'all') continue;
      const label = b.label && b.workspaceId && b.label !== b.workspaceId
        ? `${b.label} (${b.workspaceId})`
        : String(wsId);
      if (!seen.has(String(wsId))) seen.set(String(wsId), label);
    }

    for (const s of getSavedSessionsList()) {
      const wsId = s && (s.workspaceId || s.workspace);
      if (!wsId || wsId === 'all') continue;
      if (!seen.has(String(wsId))) {
        const label = s.workspaceLabel && s.workspaceLabel !== wsId
          ? `${s.workspaceLabel} (${wsId})`
          : String(wsId);
        seen.set(String(wsId), label);
      }
    }

    select.textContent = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All workspaces (all)';
    select.appendChild(allOpt);

    for (const [wsId, label] of seen.entries()) {
      const opt = document.createElement('option');
      opt.value = wsId;
      opt.textContent = label;
      select.appendChild(opt);
    }

    if ([...select.options].some((o) => o.value === prev)) {
      select.value = prev;
    }
  }

  async function captureBackupNow() {
    const btn = document.getElementById('capture-backup-btn');
    const statusEl = document.getElementById('orchestration-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Capturing backup...';
    try {
      await apiFetch('/agents/api/backups/capture', {
        method: 'POST',
        body: '{}',
      });
      await refreshSessions();
      refreshAuditIfOpen();
      if (statusEl) statusEl.textContent = `Backup captured at ${new Date().toLocaleTimeString()}`;
    } catch {
      if (statusEl) statusEl.textContent = 'Backup capture failed.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function restoreWorkspace(workspace, mode, triggerBtn) {
    const targetWs = (workspace || '').trim() || 'all';
    const targetMode = mode === 'backup' ? 'backup' : 'sessions';
    const statusEl = document.getElementById('orchestration-status');
    if (triggerBtn) triggerBtn.disabled = true;
    if (statusEl) statusEl.textContent = `Restoring ${targetWs} (${targetMode})...`;
    try {
      await apiFetch('/agents/api/sessions/restore', {
        method: 'POST',
        body: JSON.stringify({ workspace: targetWs, mode: targetMode }),
      });
      await refreshState();
      await refreshSessions();
      refreshAuditIfOpen();
      if (statusEl) statusEl.textContent = `Restored ${targetWs} (${targetMode}) at ${new Date().toLocaleTimeString()}`;
    } catch {
      if (statusEl) statusEl.textContent = `Restore failed for ${targetWs}.`;
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  function renderOrchestrationDrawer() {
    populateRestoreWorkspaceSelect();
    const details = document.getElementById('orchestration-details');
    const content = document.getElementById('orchestration-content');
    if (!details || !details.open || !content) return;
    content.textContent = '';

    const data = state.sessionsData;
    if (!data) {
      const msg = document.createElement('span');
      msg.className = 'muted';
      msg.textContent = 'Session recovery & orchestration endpoint unavailable.';
      content.appendChild(msg);
      return;
    }

    // 1. Saved Sessions
    const sessTitle = document.createElement('div');
    sessTitle.className = 'orch-section-title';
    sessTitle.textContent = 'Saved Sessions (~/.roostr/sessions.json)';
    content.appendChild(sessTitle);

    const sessions = getSavedSessionsList();
    if (sessions.length === 0) {
      const none = document.createElement('span');
      none.className = 'muted';
      none.textContent = 'No saved sessions found.';
      content.appendChild(none);
    } else {
      for (const s of sessions) {
        const sid = s.sessionId || s.session || s.id || '';
        const row = document.createElement('div');
        row.className = 'orch-row';
        const info = document.createElement('div');
        info.className = 'orch-row-info';
        const label = s.name || s.slug || s.kind || s.agent || 'session';
        const parts = [label, s.kind || s.agent, s.model, shortCwd(s.cwd), sid ? sid.slice(0, 14) : ''].filter(Boolean);
        const textSpan = document.createElement('span');
        textSpan.textContent = parts.join(' | ');
        info.appendChild(textSpan);

        const tabVal = s.tab && s.tabId && s.tab !== s.tabId
          ? `${s.tab} (${s.tabId})`
          : (s.tab || s.tabId || '');
        if (tabVal) {
          info.appendChild(badge(`tab: ${tabVal}`, 'tab-count-badge'));
        }

        const actions = document.createElement('div');
        actions.className = 'orch-row-actions';

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'small';
        loadBtn.textContent = 'Load into Start Form';
        loadBtn.addEventListener('click', () => {
          loadSessionIntoForm(s);
        });

        const resumeBtn = document.createElement('button');
        resumeBtn.type = 'button';
        resumeBtn.className = 'small primary';
        resumeBtn.textContent = 'Resume in Selected Pane';
        resumeBtn.addEventListener('click', () => {
          resumeSessionInSelectedPane(s);
        });

        actions.appendChild(loadBtn);
        actions.appendChild(resumeBtn);
        row.appendChild(info);
        row.appendChild(actions);
        content.appendChild(row);
      }
    }

    // 2. Workspace Backups
    const bkpTitle = document.createElement('div');
    bkpTitle.className = 'orch-section-title';
    bkpTitle.textContent = 'Workspace Backups (~/.roostr/backups/)';
    content.appendChild(bkpTitle);

    const backupsList = document.createElement('div');
    backupsList.id = 'backups-list';
    backupsList.className = 'orch-list';
    const backups = Array.isArray(data.backups) ? data.backups : [];
    if (backups.length === 0) {
      const none = document.createElement('span');
      none.className = 'muted';
      none.textContent = 'No workspace backups found.';
      backupsList.appendChild(none);
    } else {
      for (const b of backups) {
        const row = document.createElement('div');
        row.className = 'orch-row';
        const info = document.createElement('div');
        const label = b.label || b.workspaceId || 'workspace';
        const ver = b.version !== undefined ? `v${b.version}` : '';
        const count = b.paneCount !== undefined ? `${b.paneCount} panes` : '';
        info.textContent = [label, ver, count, b.capturedAt || ''].filter(Boolean).join(' | ');

        const actions = document.createElement('div');
        actions.className = 'orch-row-actions';
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'small';
        restoreBtn.textContent = 'Restore Backup';
        restoreBtn.addEventListener('click', () => {
          restoreWorkspace(b.workspaceId || b.label, 'backup', restoreBtn);
        });
        actions.appendChild(restoreBtn);

        row.appendChild(info);
        row.appendChild(actions);
        backupsList.appendChild(row);
      }
    }
    content.appendChild(backupsList);

    // 3. Orchestration Tasks
    const orchTitle = document.createElement('div');
    orchTitle.className = 'orch-section-title';
    orchTitle.textContent = 'Orchestration Tasks (tasks.json)';
    content.appendChild(orchTitle);

    const orch = data.orchestration || {};
    const tasks = Array.isArray(orch.tasks) ? orch.tasks
      : (orch.tasks && Array.isArray(orch.tasks.tasks)) ? orch.tasks.tasks
        : [];
    if (tasks.length === 0) {
      const none = document.createElement('span');
      none.className = 'muted';
      none.textContent = 'No orchestration tasks found.';
      content.appendChild(none);
    } else {
      for (const t of tasks) {
        const row = document.createElement('div');
        row.className = 'orch-row';
        const left = document.createElement('div');
        left.textContent = `${t.id}: ${t.title || ''} (${[t.tool, t.model, t.effort].filter(Boolean).join(', ')})`;

        const right = document.createElement('div');
        right.className = 'orch-row-actions';
        const st = t.status || 'pending';
        const cls = st === 'done' ? 'status-done'
          : st === 'blocked' ? 'status-blocked'
            : (st === 'working' || st === 'in_progress') ? 'status-working'
              : 'status-idle';
        right.appendChild(badge(st, cls));
        if (t.report) {
          const rep = document.createElement('span');
          rep.className = 'muted';
          rep.textContent = t.report;
          right.appendChild(rep);
        }

        row.appendChild(left);
        row.appendChild(right);
        content.appendChild(row);
      }
    }
  }

  function applySessionFieldsToForm(s) {
    const nameInput = document.getElementById('start-agent-name');
    const kindSelect = document.getElementById('start-agent-kind');
    const modelInput = document.getElementById('start-agent-model');
    const effortSelect = document.getElementById('start-agent-effort');
    const sessionSelect = document.getElementById('start-agent-session');

    const sid = s.sessionId || s.session || s.id || '';
    if (nameInput && (s.name || s.slug)) {
      nameInput.value = s.name || s.slug;
      nameInput.dataset.dirty = '1';
    }
    if (kindSelect && (s.kind || s.agent)) {
      const k = s.kind || s.agent;
      if ([...kindSelect.options].some((o) => o.value === k)) kindSelect.value = k;
    }
    if (modelInput && s.model) modelInput.value = s.model;
    if (effortSelect && s.effort) {
      if ([...effortSelect.options].some((o) => o.value === s.effort)) effortSelect.value = s.effort;
    }
    if (sessionSelect && sid) {
      if ([...sessionSelect.options].some((o) => o.value === sid)) {
        sessionSelect.value = sid;
      }
    }
    updateStartButtonLabel();
  }

  function loadSessionIntoForm(s) {
    if (!state.selectedPaneId) {
      showError('Select a Herdr pane first to load a saved session into its start form.', 'warn');
      return;
    }
    state.forceRecoveryOpen = true;
    const sessionBtn = document.getElementById('session-panel-toggle-btn');
    if (sessionBtn) sessionBtn.setAttribute('aria-pressed', 'true');
    updateRecoveryPanel(state.lastScreenText);
    applySessionFieldsToForm(s);
    const panel = document.getElementById('recovery-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function resumeSessionInSelectedPane(s) {
    const paneId = state.selectedPaneId;
    if (!paneId) {
      showError('Select a Herdr pane first to resume a session.', 'warn');
      return;
    }
    const sid = s.sessionId || s.session || s.id;
    const name = s.name || s.slug || deriveAgentSlug(findSelectedContext().pane, null);
    const kind = s.kind || s.agent || 'opencode';
    const payload = { name, kind };
    if (s.model) payload.model = s.model;
    if (s.effort) payload.effort = s.effort;
    if (sid) payload.session = sid;

    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/start`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await refreshState();
      setTimeout(refreshPaneScreen, 300);
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    }
  }

  async function refreshSessions() {
    const data = await optionalGet('/agents/api/sessions');
    if (!data) return;
    state.sessionsData = data;
    if (state.selectedPaneId) {
      const { pane } = findSelectedContext();
      populateSessionPicker(pane);
    }
    renderOrchestrationDrawer();
  }

  async function refreshMuse() {
    const data = await optionalGet('/agents/api/muse');
    if (!data) return;
    state.museData = data;
    if (state.pendingSelectMuseSlug) {
      const target = state.pendingSelectMuseSlug;
      state.pendingSelectMuseSlug = null;
      selectMuseAgent(target);
      return;
    }
    if (state.selectedMuseSlug) {
      const agent = getNormalizedMuseAgents().find((a) => a.slug === state.selectedMuseSlug);
      if (agent) renderMuseDetail(agent);
      updateDetailHeader();
    }
    renderMuseList();
  }

  async function refreshState() {
    try {
      const raw = await apiFetch('/agents/api/state');
      const snap = unwrapSnapshot(raw);
      state.snapshot = snap;
      state.lastUpdatedAt = Date.now();
      const ageEl = document.getElementById('snapshot-age');
      if (ageEl) ageEl.textContent = new Date().toLocaleTimeString();

      if (state.pendingSelectPaneId) {
        const target = state.pendingSelectPaneId;
        state.pendingSelectPaneId = null;
        const { allPanes } = getAllPanesFromSnapshot(snap);
        if (allPanes.some((p) => p && p.pane_id === target)) {
          selectPane(target);
          return;
        }
      }

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
      renderSidebar();
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

  async function sendPromptText(text) {
    const paneId = state.selectedPaneId;
    if (!paneId || !text || !text.trim()) return;
    await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    setTimeout(refreshPaneScreen, 300);
    refreshAuditIfOpen();
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
      await sendPromptText(text);
      input.value = '';
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

  function findDeadShells() {
    if (!state.snapshot) return [];
    const { allPanes, agentByPane } = getAllPanesFromSnapshot(state.snapshot);
    return allPanes.filter((p) => {
      if (!p || !p.pane_id) return false;
      if (p.restore_error) return true;
      const agent = agentByPane.get(p.pane_id);
      const cwd = p.foreground_cwd || p.cwd || '';
      return !agent && /\(deleted\)\s*$/i.test(cwd);
    });
  }

  function openCleanShellsDialog() {
    const dead = findDeadShells();
    if (dead.length === 0) {
      showError('No dead shell panes found.', 'warn');
      return;
    }
    const dialog = document.getElementById('clean-shells-dialog');
    const msg = document.getElementById('clean-shells-msg');
    const list = document.getElementById('clean-shells-list');
    if (!dialog || !msg || !list) return;

    msg.textContent = `Close ${dead.length} dead shell pane(s)?`;
    list.textContent = '';
    for (const p of dead) {
      const row = document.createElement('div');
      row.className = 'audit-row';
      row.textContent = `${p.pane_id} | ${p.restore_error || p.foreground_cwd || p.cwd || 'dead shell'}`;
      list.appendChild(row);
    }
    dialog.showModal();
  }

  async function confirmCleanDeadShells() {
    const dead = findDeadShells();
    const dialog = document.getElementById('clean-shells-dialog');
    const btn = document.getElementById('clean-shells-confirm');
    if (btn) btn.disabled = true;
    try {
      for (const p of dead) {
        await apiFetch(`/agents/api/pane/${encodeURIComponent(p.pane_id)}/close`, {
          method: 'POST',
          body: JSON.stringify({ confirm: p.pane_id }),
        });
        if (state.selectedPaneId === p.pane_id) {
          selectPane(null);
        }
      }
      if (dialog && dialog.open) dialog.close();
      await refreshState();
      refreshAuditIfOpen();
    } catch {
      if (dialog && dialog.open) dialog.close();
    } finally {
      if (btn) btn.disabled = false;
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
    const modelInput = document.getElementById('start-agent-model');
    const effortSelect = document.getElementById('start-agent-effort');
    const sessionSelect = document.getElementById('start-agent-session');
    const btn = document.getElementById('start-agent-btn');
    if (!paneId || !nameInput || !kindSelect) return;

    const name = nameInput.value.trim();
    const kind = kindSelect.value;
    if (!name) {
      showError('Agent slug is required', 'warn');
      return;
    }

    const payload = { name, kind };
    const model = modelInput ? modelInput.value.trim() : '';
    const effort = effortSelect ? effortSelect.value.trim() : '';
    const session = sessionSelect ? sessionSelect.value.trim() : '';
    if (model) payload.model = model;
    if (effort) payload.effort = effort;
    if (session) payload.session = session;

    if (btn) btn.disabled = true;
    try {
      await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/start`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      delete nameInput.dataset.dirty;
      state.forceRecoveryOpen = false;
      const sessionBtn = document.getElementById('session-panel-toggle-btn');
      if (sessionBtn) sessionBtn.setAttribute('aria-pressed', 'false');
      await refreshState();
      setTimeout(refreshPaneScreen, 300);
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function splitCurrentPane(direction) {
    const paneId = state.selectedPaneId;
    if (!paneId) return;
    const { pane } = findSelectedContext();
    const cwd = pane && (pane.foreground_cwd || pane.cwd);
    const payload = { direction };
    if (cwd && !/\(deleted\)\s*$/i.test(cwd)) {
      payload.cwd = cwd.trim();
    }

    try {
      const res = await apiFetch(`/agents/api/pane/${encodeURIComponent(paneId)}/split`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await refreshState();
      if (res && res.paneId) {
        selectPane(res.paneId);
      }
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    }
  }

  async function saveMuseOverride(evt) {
    evt.preventDefault();
    const slug = state.selectedMuseSlug;
    const input = document.getElementById('muse-override-input');
    const btn = document.getElementById('muse-override-save');
    if (!slug || !input) return;
    if (btn) btn.disabled = true;
    try {
      await apiFetch('/agents/api/names/override', {
        method: 'POST',
        body: JSON.stringify({ slug, name: input.value }),
      });
      await refreshMuse();
    } catch {
      // Error banner handled
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function toggleMuseOrchestrator() {
    const slug = state.selectedMuseSlug;
    const agent = getNormalizedMuseAgents().find((a) => a.slug === slug);
    const btn = document.getElementById('muse-orch-toggle');
    if (!slug || !agent) return;
    if (btn) btn.disabled = true;
    try {
      await apiFetch('/agents/api/names/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ slug, enabled: !agent.isOrchestrator }),
      });
      await refreshMuse();
    } catch {
      // Error banner handled
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function sendMuseMessage(evt) {
    evt.preventDefault();
    const slug = state.selectedMuseSlug;
    const subjectEl = document.getElementById('muse-msg-subject');
    const projectEl = document.getElementById('muse-msg-project');
    const bodyEl = document.getElementById('muse-msg-body');
    const sendBtn = document.getElementById('muse-msg-send');
    const statusEl = document.getElementById('muse-msg-status');
    if (!slug || !subjectEl || !bodyEl) return;

    const subject = subjectEl.value.trim();
    const body = bodyEl.value.trim();
    const project = (projectEl && projectEl.value.trim()) || 'muse';
    if (!subject || !body) {
      showError('Subject and message body are required.', 'warn');
      return;
    }

    if (sendBtn) sendBtn.disabled = true;
    try {
      await apiFetch('/agents/api/muse/message', {
        method: 'POST',
        body: JSON.stringify({ to: slug, subject, body, project }),
      });
      subjectEl.value = '';
      bodyEl.value = '';
      if (statusEl) statusEl.textContent = `Sent to ${slug} at ${new Date().toLocaleTimeString()}`;
      loadMuseInbox(slug);
      refreshAuditIfOpen();
    } catch {
      // Error banner handled
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function collapseAllGroups() {
    const { allPanes } = getAllPanesFromSnapshot(state.snapshot || {});
    const next = { muse: true };
    for (const p of allPanes) {
      if (!p) continue;
      const wsId = p.workspace_id || 'unknown';
      const tabId = p.tab_id || 'unknown';
      next[`ws:${wsId}`] = true;
      next[`tab:${wsId}:${tabId}`] = true;
    }
    state.collapsed = next;
    saveCollapsedState(state.collapsed);
    renderSidebar();
  }

  function expandAllGroups() {
    state.collapsed = {};
    saveCollapsedState(state.collapsed);
    renderSidebar();
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

    const sidebarToggle = document.getElementById('sidebar-toggle-btn');
    const mainLayout = document.getElementById('main-layout');
    if (sidebarToggle && mainLayout) {
      sidebarToggle.addEventListener('click', () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        mainLayout.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
        sidebarToggle.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
      });
    }

    document.querySelectorAll('#view-tabs [data-view]').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        state.viewMode = tabBtn.getAttribute('data-view') || 'all';
        document.querySelectorAll('#view-tabs [data-view]').forEach((b) => {
          const active = b === tabBtn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        renderSidebar();
      });
    });

    const paneFilter = document.getElementById('pane-filter');
    if (paneFilter) {
      paneFilter.addEventListener('input', () => {
        state.filterText = paneFilter.value;
        renderSidebar();
      });
    }

    const statusFilter = document.getElementById('status-filter');
    if (statusFilter) {
      statusFilter.addEventListener('change', () => {
        state.statusFilter = statusFilter.value;
        renderSidebar();
      });
    }

    const collapseAllBtn = document.getElementById('collapse-all-btn');
    if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAllGroups);

    const expandAllBtn = document.getElementById('expand-all-btn');
    if (expandAllBtn) expandAllBtn.addEventListener('click', expandAllGroups);

    const cleanShellsBtn = document.getElementById('clean-dead-shells-btn');
    if (cleanShellsBtn) cleanShellsBtn.addEventListener('click', openCleanShellsDialog);

    const cleanShellsCancel = document.getElementById('clean-shells-cancel');
    const cleanShellsDialog = document.getElementById('clean-shells-dialog');
    if (cleanShellsCancel && cleanShellsDialog) {
      cleanShellsCancel.addEventListener('click', () => cleanShellsDialog.close());
    }
    const cleanShellsConfirm = document.getElementById('clean-shells-confirm');
    if (cleanShellsConfirm) cleanShellsConfirm.addEventListener('click', confirmCleanDeadShells);

    document.querySelectorAll('[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        if (key) sendKey(key);
      });
    });

    document.querySelectorAll('[data-prompt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-prompt');
        if (text) sendPromptText(text).catch(() => {});
      });
    });

    const promptForm = document.getElementById('prompt-form');
    if (promptForm) promptForm.addEventListener('submit', sendPrompt);

    const closeBtn = document.getElementById('close-pane-btn');
    if (closeBtn) closeBtn.addEventListener('click', openCloseDialog);

    const recoveryCloseBtn = document.getElementById('recovery-close-btn');
    if (recoveryCloseBtn) recoveryCloseBtn.addEventListener('click', openCloseDialog);

    const sessionToggleBtn = document.getElementById('session-panel-toggle-btn');
    if (sessionToggleBtn) {
      sessionToggleBtn.addEventListener('click', () => {
        state.forceRecoveryOpen = !state.forceRecoveryOpen;
        sessionToggleBtn.setAttribute('aria-pressed', state.forceRecoveryOpen ? 'true' : 'false');
        updateRecoveryPanel(state.lastScreenText);
      });
    }

    const sessionSelect = document.getElementById('start-agent-session');
    if (sessionSelect) {
      sessionSelect.addEventListener('change', () => {
        updateStartButtonLabel();
        const sid = sessionSelect.value;
        if (sid) {
          const found = getSavedSessionsList().find((s) => (s.sessionId || s.session || s.id) === sid);
          if (found) applySessionFieldsToForm(found);
        }
      });
    }

    const splitRightBtn = document.getElementById('split-right-btn');
    if (splitRightBtn) splitRightBtn.addEventListener('click', () => splitCurrentPane('right'));

    const splitDownBtn = document.getElementById('split-down-btn');
    if (splitDownBtn) splitDownBtn.addEventListener('click', () => splitCurrentPane('down'));

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

    const museOverrideForm = document.getElementById('muse-override-form');
    if (museOverrideForm) museOverrideForm.addEventListener('submit', saveMuseOverride);

    const museOrchToggle = document.getElementById('muse-orch-toggle');
    if (museOrchToggle) museOrchToggle.addEventListener('click', toggleMuseOrchestrator);

    const museMessageForm = document.getElementById('muse-message-form');
    if (museMessageForm) museMessageForm.addEventListener('submit', sendMuseMessage);

    const museInboxRefreshBtn = document.getElementById('muse-inbox-refresh-btn');
    if (museInboxRefreshBtn) {
      museInboxRefreshBtn.addEventListener('click', () => {
        if (state.selectedMuseSlug) loadMuseInbox(state.selectedMuseSlug);
      });
    }

    const captureBackupBtn = document.getElementById('capture-backup-btn');
    if (captureBackupBtn) {
      captureBackupBtn.addEventListener('click', captureBackupNow);
    }

    const restoreWorkspaceForm = document.getElementById('restore-workspace-form');
    if (restoreWorkspaceForm) {
      restoreWorkspaceForm.addEventListener('submit', (evt) => {
        evt.preventDefault();
        const wsSelect = document.getElementById('restore-workspace-select');
        const modeSelect = document.getElementById('restore-mode-select');
        const restoreBtn = document.getElementById('restore-workspace-btn');
        const ws = wsSelect ? wsSelect.value : 'all';
        const mode = modeSelect ? modeSelect.value : 'sessions';
        restoreWorkspace(ws, mode, restoreBtn);
      });
    }

    const orchDetails = document.getElementById('orchestration-details');
    if (orchDetails) {
      orchDetails.addEventListener('toggle', () => {
        if (orchDetails.open) renderOrchestrationDrawer();
      });
    }

    const auditDetails = document.getElementById('audit-details');
    if (auditDetails) {
      auditDetails.addEventListener('toggle', () => {
        if (auditDetails.open) refreshAuditIfOpen();
      });
    }

    loadUser();
    refreshState();
    refreshSessions();
    refreshMuse();
    state.snapshotTimer = setInterval(() => {
      refreshState();
      refreshSessions();
      refreshMuse();
    }, STATE_POLL_MS);
  });
})();
