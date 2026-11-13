// Renderer: the "hit its limit, move this chat?" banner (see failover.js).
// Loaded after renderer.js and uses its `tabs` and `activeId`. The banner sits
// in the bottom-right of its tab's pane, so it shows only with that tab, and
// does not take focus when it appears. Its actions remain keyboard accessible. Move is the tab menu's move; Not now, or Esc,
// hides it until the next limit event.
/* global tabs, activeId, showAgentSwitchResult */

const failoverBanners = new Map(); // session id -> banner element

function closeFailoverBanner(id) {
  const el = failoverBanners.get(id);
  if (el) el.remove();
  failoverBanners.delete(id);
}

function failoverButton(label, className, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

window.limpet.onFailoverOffer(({ id, text, to, clear }) => {
  closeFailoverBanner(id);
  const t = tabs.get(id);
  if (clear || !t) return;
  const el = document.createElement('div');
  el.className = 'failover-banner';
  el.setAttribute('role', 'status');
  const msg = document.createElement('div');
  msg.className = 'text';
  msg.textContent = text;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const later = failoverButton('Not now', 'later', () => { closeFailoverBanner(id); t.term.focus(); });
  actions.append(later);
  if (to) {
    const move = failoverButton('Move', 'move', async () => {
      if (el.classList.contains('busy')) return;
      el.classList.add('busy');
      msg.textContent = `Moving this chat to ${to}…`;
      try {
        const result = await window.limpet.claudeSwitch(id, to);
        showAgentSwitchResult(id, to, result);
      } catch (error) {
        showAgentSwitchResult(id, to, { ok: false, reason: error.message || String(error) });
      } finally {
        closeFailoverBanner(id);
        const tab = tabs.get(id);
        if (tab) tab.term.focus();
      }
    });
    actions.append(move);
  }
  el.append(msg, actions);
  t.pane.appendChild(el);
  failoverBanners.set(id, el);
});

// Esc hides the front tab's banner. It still reaches the terminal too: the
// banner isn't what has the keyboard.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !failoverBanners.has(activeId) || failoverBanners.get(activeId).classList.contains('busy')) return;
  // Consumed here: an ESC byte reaching the shell would make zsh read the next
  // key as a Meta chord.
  e.preventDefault();
  e.stopPropagation();
  closeFailoverBanner(activeId);
}, true);
