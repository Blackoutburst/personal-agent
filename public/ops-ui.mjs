// The Studio "Ops" app (#75, docs/OPS.md): a read-only view of C-chan's agents. It shows the live agents, the ticket
// pipeline, C-chan's decision log, the usage of the runs and, per ticket, the Board message history. It refreshes by
// itself every few seconds while it is open, and has an "Actualiser" button. All text comes from the Board or the
// runner and is shown as plain text only.
const COLUMNS = [['todo', 'À faire'], ['in_progress', 'En cours'], ['review', 'En revue'], ['blocked', 'Bloqué'], ['done', 'Terminé']];
const STATES = { queued: 'En attente', preparing: 'Préparation', running: 'En cours', stopping: 'Arrêt', succeeded: 'Livré', blocked: 'Bloqué',
  failed: 'Échec', timeout: 'Délai dépassé', stopped: 'Arrêté', cancelled: 'Annulé', interrupted: 'Interrompu' };
const KINDS = { launch: 'Lancement', escalate: 'Escalade', return: 'Retour', result: 'Résultat', review: 'Revue', accept: 'Acceptation',
  blocked: 'Blocage', ready: 'Prêt', needs_you: 'Vous attend' };
export const REFRESH_MS = 10_000;

export const duration = seconds => seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min`
  : `${Math.round(seconds / 360) / 10} h`;
const when = value => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';

export function createOpsUI({ document, fetchImpl = fetch, home, visible = () => true, onDenied = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  const node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let epoch = 0, request = 0, timer = null, historyRequest = 0, openTicket = null;
  const note = node('p', { className: 'note', role: 'status' });
  const refresh = node('button', { type: 'button', className: 'button', textContent: 'Actualiser' });
  const stamp = node('span', { className: 'note' });
  const bar = node('div', { className: 'studio-controls' }); bar.append(refresh, stamp);
  const body = node('div', { className: 'ops-body' });
  const history = node('section', { className: 'ops-history' }); history.setAttribute('aria-label', 'Messages du ticket');
  home.append(node('p', { className: 'intro', textContent: 'Les agents de C-chan, en lecture seule. La vue se met à jour toute seule.' }), bar, note, body, history);

  async function api(payload) {
    const response = await fetchImpl('api/studio', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.code ?? 'OPS_UNAVAILABLE'); error.status = response.status; throw error; }
    return result;
  }
  const section = (title, ...children) => { const el = node('section', { className: 'ops-section' }); el.append(node('h3', { textContent: title }), ...children); return el; };
  const empty = text => node('p', { className: 'note', textContent: text });

  function agents(rows) {
    const list = node('ul', { className: 'ops-agents' });
    for (const row of rows) {
      const item = node('li', { className: row.live ? 'ops-agent live' : 'ops-agent' });
      const ticket = row.ticketNumber ? `#${row.ticketNumber} ${row.ticketTitle}` : 'aucun ticket';
      const beat = row.live && row.heartbeatAgeSeconds !== null ? ` · battement il y a ${duration(row.heartbeatAgeSeconds)}` : row.endedAt ? ` · fini ${when(row.endedAt)}` : '';
      item.append(node('strong', { textContent: row.name }), node('span', { textContent: ` (${row.role}) · ${row.model} · ${STATES[row.state] ?? row.state}` }),
        node('div', { textContent: `${ticket} · ${row.turns}${row.maxTurns ? '/' + row.maxTurns : ''} tours${beat}` }));
      if (row.error) item.append(node('div', { className: 'note', textContent: row.error }));
      list.append(item);
    }
    return list.children.length ? list : empty('Aucun agent pour le moment.');
  }

  function pipeline(data) {
    if (!data) return empty('Le Board n’est pas joignable pour le moment.');
    const wrap = node('div', { className: 'ops-pipeline' });
    for (const [key, label] of COLUMNS) {
      const column = node('div', { className: 'ops-column' }); column.dataset.status = key;
      column.append(node('h4', { textContent: `${label} (${data[key]?.length ?? 0})` }));
      for (const ticket of (data[key] ?? []).slice(0, 30)) {
        const button = node('button', { type: 'button', className: 'ops-ticket', textContent: `#${ticket.number ?? '?'} ${ticket.title}` });
        button.setAttribute('aria-label', `Historique de #${ticket.number}`);
        const owner = epoch;
        button.addEventListener('click', () => { if (owner === epoch) void showHistory(ticket); });
        column.append(button);
      }
      wrap.append(column);
    }
    return wrap;
  }

  function decisions(rows) {
    const list = node('ul', { className: 'ops-decisions' });
    for (const row of rows) list.append(node('li', { textContent: `${when(row.at)} · ${KINDS[row.kind] ?? row.kind} · ${row.text}` }));
    return list.children.length ? list : empty('Aucune décision enregistrée pour le moment.');
  }

  function usage(data) {
    const wrap = node('div', { className: 'ops-usage' });
    for (const [key, label] of [['last24h', '24 dernières heures'], ['last7d', '7 derniers jours']]) {
      const window = data?.windows?.[key]; if (!window) continue;
      const line = node('div'); line.append(node('strong', { textContent: label + ' : ' }),
        node('span', { textContent: `${window.total.runs} lancements, ${window.total.turns} tours, ${duration(window.total.seconds)}` }));
      wrap.append(line);
      for (const [model, row] of Object.entries(window.models)) wrap.append(node('div', { className: 'note', textContent: `${model} : ${row.runs} lancements, ${row.turns} tours, ${duration(row.seconds)}` }));
    }
    if (data?.limitHits) wrap.append(node('div', { textContent: `Limite du plan atteinte ${data.limitHits} fois cette semaine.` }));
    if (data?.note) wrap.append(node('div', { className: 'note', textContent: 'Plan Max : tours et durée par modèle ; les jetons ne sont pas remontés.' }));
    return wrap;
  }

  function render(data) {
    body.replaceChildren(section('Agents', agents(data.agents ?? [])), section('Pipeline', pipeline(data.pipeline)),
      section('Décisions de C-chan', decisions(data.decisions ?? [])), section('Consommation', usage(data.usage)));
    stamp.textContent = ` Mis à jour ${when(data.at)}`;
  }

  async function load() {
    const owner = epoch, token = ++request;
    try {
      const data = await api({ action: 'ops' });
      if (owner !== epoch || token !== request) return;
      note.textContent = ''; render(data);
    } catch (error) {
      if (owner !== epoch || token !== request) return;
      if (error.status === 401) { clear(); onDenied(error.message); return; }
      note.textContent = error.status === 403 ? 'Cette vue est réservée aux membres du Studio.' : 'Ops n’est pas disponible pour le moment. Réessayez avec Actualiser.';
    }
  }

  async function showHistory(ticket) {
    const owner = epoch, token = ++historyRequest; openTicket = ticket;
    history.replaceChildren(node('p', { className: 'note', textContent: 'Chargement…' }));
    try {
      const result = await api({ action: 'opsMessages', ticketId: ticket.id });
      if (owner !== epoch || token !== historyRequest) return;
      const list = node('ul', { className: 'ops-messages' });
      for (const message of result.messages ?? []) list.append(node('li', { textContent: `${when(message.at)} · ${message.author || 'inconnu'} : ${message.text}` }));
      const close = node('button', { type: 'button', className: 'button', textContent: 'Fermer' });
      close.addEventListener('click', () => { if (owner === epoch) { openTicket = null; history.replaceChildren(); } });
      history.replaceChildren(node('h3', { textContent: `Messages du Board : #${result.ticketNumber ?? ticket.number} ${result.title ?? ''}` }),
        list.children.length ? list : empty('Aucun message sur ce ticket.'), close);
    } catch (error) {
      if (owner !== epoch || token !== historyRequest) return;
      history.replaceChildren(node('p', { className: 'note', textContent: 'L’historique n’est pas disponible pour le moment.' }));
    }
  }

  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }
  // Opening the app loads it and starts the periodic refresh; leaving it (hide) stops the polling.
  async function show() {
    stop();
    timer = setTimer(() => { if (visible()) void load(); }, REFRESH_MS);
    timer?.unref?.();
    await load();
  }
  function hide() { stop(); }
  function clear() { epoch += 1; stop(); body.replaceChildren(); history.replaceChildren(); note.textContent = ''; stamp.textContent = ''; openTicket = null; }
  refresh.addEventListener('click', () => { void load(); if (openTicket) void showHistory(openTicket); });
  return { show, hide, clear, load };
}
