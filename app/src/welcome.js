(() => {
  const bridge = window.limpet;
  if (!bridge) return;
  const seenKey = 'limpet.welcome.v1';
  const help = document.createElement('button');
  help.id = 'limpet-help';
  help.textContent = '?';
  help.title = 'Getting started and setup checks';
  help.setAttribute('aria-label', help.title);
  document.getElementById('tabbar').appendChild(help);
  const dialog = document.createElement('dialog');
  dialog.id = 'limpet-welcome';
  dialog.setAttribute('aria-labelledby', 'welcome-title');
  // Static application text only; all diagnostic values below use textContent.
  dialog.innerHTML = `<h2 id="welcome-title">Welcome to Limpet</h2>
    <p>Your terminal is ready. Start with a local command, or connect using <code>xssh user@host</code> (replace user and host with your SSH login).</p>
    <p><strong>Keep remote work alive:</strong> xssh reconnects when the network drops. Your remote host needs <code>tmux</code> to preserve the running shell and programs. Without it, reconnection starts a fresh shell.</p>
    <p>Inside xssh, try <code>peek image.png</code> or <code>download report.txt</code>. Dragged files go to the remote directory after the transfer preview.</p>
    <p>Use <strong>Accounts</strong> to select a coding agent. Install its CLI separately, then sign in once per account. Moving to another provider sends future requests to that provider.</p>
    <h3>Setup checks</h3><p id="welcome-checks" role="status">Checking local tools…</p><ul class="welcome-tools"></ul>
    <p>These checks look for executable files on the app's PATH. A tool installed only through your shell profile can still work in the terminal. No software is installed and no credentials are read.</p>
    <p id="welcome-shortcuts"></p><div class="welcome-foot"><button type="button" id="welcome-docs">Read the guide</button><button type="button" id="welcome-close">Back to terminal</button></div>`;
  document.body.appendChild(dialog);
  dialog.querySelector('#welcome-shortcuts').textContent = bridge.platform === 'darwin'
    ? 'Default shortcuts: ⌘T new tab · ⌘, settings. Shortcuts can be changed in Settings.'
    : 'Default shortcuts: Ctrl+Shift+T new tab · Ctrl+, settings. Shortcuts can be changed in Settings.';
  let previousFocus;
  let card;
  const dismiss = () => { if (card) card.remove(); try { localStorage.setItem(seenKey, '1'); } catch (_) { /* restricted storage */ } };
  const open = async () => {
    previousFocus = document.activeElement;
    dismiss();
    if (!dialog.open) dialog.showModal();
    const list = dialog.querySelector('.welcome-tools');
    list.replaceChildren();
    const status = dialog.querySelector('#welcome-checks');
    status.textContent = 'Checking local tools…';
    try {
      const result = await bridge.setupInfo();
      for (const tool of result.tools) {
        const row = document.createElement('li');
        row.textContent = `${tool.name}: ${tool.present ? 'available on PATH' : 'not found on the app PATH'}${tool.name === 'ssh' || tool.name === 'scp' ? '' : ' (optional coding agent)'}`;
        list.appendChild(row);
      }
      status.textContent = 'Local checks complete.';
    } catch (_) { status.textContent = 'Setup checks are unavailable. You can still use the terminal and read the guide.'; }
  };
  help.addEventListener('click', open);
  dialog.querySelector('#welcome-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (previousFocus && previousFocus.isConnected) previousFocus.focus(); else help.focus(); });
  dialog.querySelector('#welcome-docs').addEventListener('click', () => bridge.openExternal('https://github.com/samuelwbarber/limpet#install'));
  let seen = false;
  try { seen = localStorage.getItem(seenKey) === '1'; } catch (_) { /* show help once per window */ }
  if (!seen) {
    card = document.createElement('aside');
    card.id = 'limpet-start';
    card.setAttribute('aria-label', 'Getting started');
    card.innerHTML = '<strong>Welcome to Limpet</strong><p>Connect a host, check your setup, or start working in the terminal.</p><button type="button">Getting started</button><button type="button">Dismiss</button>';
    const buttons = card.querySelectorAll('button');
    buttons[0].addEventListener('click', open);
    buttons[1].addEventListener('click', dismiss);
    document.body.appendChild(card);
  }
})();
