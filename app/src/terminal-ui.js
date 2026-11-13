/* global tabs, activeId, activate, showAccountMenu, closeAccountMenu, SearchAddon */
(() => {
  const strip = document.getElementById('tabstrip');
  const accounts = document.getElementById('accounts-button');
  const status = document.createElement('div');
  status.id = 'terminal-status'; status.setAttribute('role', 'status');
  const connection = document.createElement('span'); connection.id = 'terminal-connection';
  const notice = document.createElement('span');
  status.append(connection, notice); document.body.append(status);
  window.LimpetTerminalUI = { announce: (message) => { notice.textContent = message; } };
  let statusBusy = false;
  async function updateStatus() {
    if (statusBusy || !window.limpet.getSessionStatus || activeId == null) return;
    statusBusy = true; const id = activeId;
    try {
      const state = await window.limpet.getSessionStatus(id);
      if (id !== activeId || !state) return;
      const remote = state.remote;
      connection.textContent = state.exited ? 'Session exited' : remote ? `SSH destination: ${typeof remote === 'string' ? remote : remote.host || remote.hostname || 'remote'}${state.remoteCwd ? ` - ${state.remoteCwd}` : ''}` : 'Local shell';
      connection.title = remote ? 'Reported SSH destination; this is not a connection heartbeat or a guarantee of session protection.' : 'Shell running on this computer';
    } catch { if (id === activeId) connection.textContent = 'Session status unavailable'; }
    finally { statusBusy = false; }
  }
  setInterval(updateStatus, 3000);
  document.getElementById('settings-button').onclick = () => window.LimpetSettings.open();
  accounts.onclick = () => { if (tabs.has(activeId)) showAccountMenu(activeId, accounts); };

  // Keep semantic state in sync even when sessions are detached or restored.
  const syncTabs = () => {
    updateStatus();
    for (const [id, tab] of tabs) {
      const selected = id === activeId;
      tab.tabEl.setAttribute('role', 'tab');
      tab.tabEl.setAttribute('aria-selected', String(selected));
      tab.tabEl.tabIndex = selected ? 0 : -1;
      tab.tabEl.id = `session-tab-${id}`;
      tab.pane.id = `session-panel-${id}`;
      tab.tabEl.setAttribute('aria-controls', tab.pane.id);
      tab.pane.setAttribute('role', 'tabpanel');
      tab.pane.setAttribute('aria-labelledby', tab.tabEl.id);
      tab.tabEl.querySelector('.close')?.setAttribute('aria-label', `Close ${tab.titleEl.textContent}`);
      if (selected) tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  new MutationObserver(syncTabs).observe(strip, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true });
  strip.addEventListener('keydown', (event) => {
    if (event.target.closest('button')) return;
    const ids = [...tabs.keys()];
    if (!ids.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    const i = ids.indexOf(activeId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : event.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length : event.key === 'ArrowRight' ? (i + 1) % ids.length : i;
    activate(ids[next]);
    if (event.key.startsWith('Arrow') || ['Home', 'End'].includes(event.key)) requestAnimationFrame(() => tabs.get(ids[next])?.tabEl.focus());
  });

  const bar = document.createElement('form');
  bar.id = 'terminal-search'; bar.hidden = true; bar.setAttribute('role', 'search');
  bar.innerHTML = '<input type="search" aria-label="Find in terminal output" placeholder="Find in output"><span class="result" role="status"></span><button type="button" class="previous" aria-label="Previous match">Previous</button><button type="submit" aria-label="Next match">Next</button><button type="button" class="bottom">Bottom</button><button type="button" class="dismiss" aria-label="Close search">Close</button>';
  document.getElementById('terms').append(bar);
  const input = bar.querySelector('input');
  const result = bar.querySelector('.result');
  const addons = new WeakMap();
  function search(back = false) {
    const tab = tabs.get(activeId);
    if (!tab) return;
    if (!input.value) { result.textContent = ''; return; }
    let addon = addons.get(tab.term);
    if (!addon) { addon = new SearchAddon.SearchAddon(); tab.term.loadAddon(addon); addons.set(tab.term, addon); }
    const found = back ? addon.findPrevious(input.value) : addon.findNext(input.value);
    result.textContent = found ? 'Match found' : 'No matches';
  }
  function openSearch() { closeAccountMenu(); bar.hidden = false; input.focus(); input.select(); }
  function dismiss() { bar.hidden = true; tabs.get(activeId)?.term.focus(); }
  bar.onsubmit = (e) => { e.preventDefault(); search(); };
  bar.querySelector('.previous').onclick = () => search(true);
  bar.querySelector('.dismiss').onclick = dismiss;
  bar.querySelector('.bottom').onclick = () => { tabs.get(activeId)?.term.scrollToBottom(); dismiss(); };
  input.addEventListener('input', () => search());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); search(true); } });
  document.getElementById('find-output').onclick = openSearch;
  document.addEventListener('keydown', (e) => {
    if (window.LimpetSettings.isOpen()) return;
    if ((e.ctrlKey && e.shiftKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); openSearch(); }
    else if (e.key === 'Escape' && !bar.hidden) { e.preventDefault(); e.stopPropagation(); dismiss(); }
    else if (e.key === 'Escape' && document.querySelector('.account-menu')) requestAnimationFrame(() => accounts.focus());
  }, true);
  new MutationObserver(() => accounts.setAttribute('aria-expanded', String(!!document.querySelector('.account-menu')))).observe(document.body, { childList: true });
  syncTabs();
})();
