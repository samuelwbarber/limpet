// Predictive local echo for laggy links (the Mosh trick, limpet-flavoured).
//
// On a slow ssh link the terminal feels awful because every keystroke has to
// round-trip to the server before it's echoed back. This draws the characters
// you type IMMEDIATELY, in red, as a DOM overlay ON TOP of xterm -- and removes
// each one the instant the server's real echo advances the cursor past it. The
// red glyphs then give way to the terminal's own (normal-coloured) text.
//
// Design guarantees:
//   * We never write predicted bytes into xterm's buffer. Predictions live in a
//     separate overlay layer, so a wrong guess is just a cleared overlay -- the
//     buffer (fed only by the server) is always the source of truth and can
//     never be corrupted by a misprediction.
//   * Adaptive: a prediction is only *revealed* if it's still unconfirmed after
//     a short delay, so on a fast link the echo beats the reveal and you never
//     see red -- it looks exactly like today.
//   * Self-gating: predictions only become visible once we've observed that the
//     current context actually echoes what you type. A password prompt (no echo)
//     never confirms, so it never shows what you typed. Enter forgets that
//     observation, so a `sudo` password prompt right after a command stays dark.
//   * Conservative: only single printable characters are predicted. Enter, Tab,
//     arrows, Ctrl-keys, escape sequences and pastes clear predictions instead.
(function () {
  const PRINTABLE = (code) => code >= 0x20 && code <= 0x7e;
  const REVEAL_MS = 55;                 // unconfirmed longer than this -> show red
  const MIN_EXPIRE = 800, MAX_EXPIRE = 4000;
  const RED = '#f38ba8';                // matches the terminal's catppuccin theme

  function create(term, screenEl) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5;';
    overlay.style.fontFamily = term.options.fontFamily;
    overlay.style.fontSize = term.options.fontSize + 'px';
    screenEl.appendChild(overlay);

    const st = {
      q: [],            // outstanding predictions, in type order
      predRow: 0, predCol: 0,
      echoOn: false,    // confirmed the current context echoes typed chars?
      srtt: 0,          // smoothed round-trip estimate (ms), for expiry tuning
      tick: null,
    };

    // Cell geometry in CSS px. Prefer xterm's own render dimensions; fall back to
    // dividing the screen element (which is exactly cols x rows cells wide/tall).
    function cell() {
      try {
        const d = term._core._renderService.dimensions.css.cell;
        if (d && d.width > 0 && d.height > 0) return d;
      } catch (e) { /* internal shape changed -> fall through */ }
      const w = screenEl.clientWidth / term.cols, h = screenEl.clientHeight / term.rows;
      return (w > 0 && h > 0) ? { width: w, height: h } : null;
    }

    function startTick() { if (!st.tick) st.tick = setInterval(expire, 120); }
    function stopTick() { if (st.tick && !st.q.length) { clearInterval(st.tick); st.tick = null; } }

    // Oldest prediction unconfirmed for too long => this context isn't echoing
    // (password prompt) or the link stalled. Drop all and stop showing red until
    // we re-observe an echo.
    function expire() {
      const limit = Math.min(MAX_EXPIRE, Math.max(MIN_EXPIRE, st.srtt * 3 || MIN_EXPIRE));
      if (st.q.length && performance.now() - st.q[0].sentAt > limit) { st.echoOn = false; flush(); }
      stopTick();
    }

    function place(el, row, col, c) {
      el.style.left = (col * c.width) + 'px';
      el.style.top = (row * c.height) + 'px';
      el.style.width = c.width + 'px';
      el.style.height = c.height + 'px';
      el.style.lineHeight = c.height + 'px';
    }

    function flush() {
      for (const p of st.q) { clearTimeout(p.revealTimer); p.el.remove(); }
      st.q = [];
      stopTick();
    }

    // A key was typed. Predict it (printable) or clear predictions (everything
    // else). Called before the byte is sent to the pty.
    function onKey(d) {
      if (d.length === 1 && PRINTABLE(d.charCodeAt(0))) {
        const c = cell();
        if (!c) return;                         // can't position overlay yet -> skip
        if (!st.q.length) { const b = term.buffer.active; st.predRow = b.cursorY; st.predCol = b.cursorX; }
        if (st.predCol >= term.cols) { st.predCol = 0; st.predRow++; }
        if (st.predRow >= term.rows) { flush(); return; }  // ran off the screen
        const el = document.createElement('span');
        el.textContent = d;
        el.style.cssText = `position:absolute;color:${RED};white-space:pre;`;
        el.style.visibility = 'hidden';           // revealed later, only if still unconfirmed
        place(el, st.predRow, st.predCol, c);
        overlay.appendChild(el);
        const p = { el, row: st.predRow, col: st.predCol, sentAt: performance.now(), revealTimer: null };
        st.predCol++;
        st.q.push(p);
        p.revealTimer = setTimeout(() => { if (st.echoOn) el.style.visibility = 'visible'; }, REVEAL_MS);
        startTick();
      } else {
        if (d === '\r' || d === '\n') st.echoOn = false;  // context may stop echoing
        flush();
      }
    }

    // The server sent output and xterm repainted. Confirm any predictions the
    // real cursor has now advanced past, and bail out if the echo diverged from
    // what we guessed. Called from term.onRender (fires after the buffer updates).
    function reconcile() {
      if (!st.q.length) return;
      const b = term.buffer.active, rr = b.cursorY, rc = b.cursorX;
      let confirmed = false;
      while (st.q.length) {
        const p = st.q[0];
        if (!(p.row < rr || (p.row === rr && p.col < rc))) break;  // server hasn't reached it yet
        clearTimeout(p.revealTimer); p.el.remove(); st.q.shift();
        const rtt = performance.now() - p.sentAt;
        st.srtt = st.srtt ? st.srtt * 0.8 + rtt * 0.2 : rtt;
        st.echoOn = true; confirmed = true;
      }
      if (confirmed) for (const p of st.q) p.el.style.visibility = 'visible';  // trusted context now
      // The next unconfirmed glyph must sit exactly at the server's cursor; if it
      // doesn't, the echo went somewhere we didn't predict -> drop everything.
      if (st.q.length) { const n = st.q[0]; if (!(n.row === rr && n.col === rc)) flush(); }
      stopTick();
    }

    function dispose() {
      flush();
      if (st.tick) { clearInterval(st.tick); st.tick = null; }
      overlay.remove();
    }

    return { onKey, reconcile, flush, dispose };
  }

  window.Predict = { create };
})();
