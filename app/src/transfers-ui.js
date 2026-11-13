// Transfers stay visible outside terminal output, without taking typing focus.
(() => {
  const panel = document.createElement('section');
  panel.id = 'transfers';
  panel.setAttribute('aria-label', 'File transfers');
  document.body.appendChild(panel);
  const cards = new Map();
  window.addEventListener('limpet:session-removed', (event) => {
    for (const [id, card] of cards) if (card.dataset.sessionId === String(event.detail)) { card.remove(); cards.delete(id); }
  });
  window.limpet.onTransfer((job) => {
    let card = cards.get(job.id);
    if (!card) {
      card = document.createElement('article');
      card.className = 'transfer-card';
      card.dataset.sessionId = String(job.sessionId);
      cards.set(job.id, card);
      panel.appendChild(card);
    }
    card.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = `${job.state === 'running' ? 'Sending' : job.state === 'done' ? 'Sent' : job.state === 'cancelled' ? 'Cancelled' : 'Transfer failed'}: ${job.names.join(', ')}`;
    const destination = document.createElement('div');
    destination.textContent = job.destination;
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = job.message;
    const actions = document.createElement('div');
    const button = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = async () => {
        b.disabled = true;
        try { await fn(); } catch (e) { status.textContent = e.message; }
        finally { b.disabled = false; }
      };
      actions.appendChild(b);
    };
    if (job.state === 'running') button('Cancel', () => window.limpet.cancelTransfer(job.sessionId, job.id));
    else {
      if (job.state !== 'done') button('Retry…', () => window.limpet.retryTransfer(job.sessionId, job.id));
      button('Dismiss', () => { card.remove(); cards.delete(job.id); });
    }
    card.append(heading, destination, status, actions);
  });
})();
