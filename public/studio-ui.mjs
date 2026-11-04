const FOLLOW = { opted_out: 'Opposition enregistrée', uncertain: 'Envoi à vérifier', replied: 'Réponse reçue',
  not_contacted: 'Sans premier contact envoyé', used: 'Relance déjà utilisée', waiting: 'Relance en attente', daily_limit: 'Limite du jour atteinte', eligible: 'Relance possible via C-chan' };
const STATE = { sent: 'Envoyé', pending: 'Envoi incertain : ne pas renvoyer', failed: 'Envoi refusé', received: 'Reçu' };
const date = value => new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
export function createStudioUI({ document, fetchImpl = fetch, onDenied = () => {} }) {
  const home = document.getElementById('studio-home'), nav = document.getElementById('nav-studio');
  if (!home) return { show: async () => {}, probe: async () => {}, clear() {} };
  const node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let epoch = 0, request = 0, detailRequest = 0, data = null, selected = null, messages = [], nextOffset = null;
  const note = node('p', { className: 'note', role: 'status' });
  const refresh = node('button', { type: 'button', className: 'button', textContent: 'Actualiser' });
  const search = node('input', { type: 'search', placeholder: 'Chercher une entreprise ou un contact' });
  search.setAttribute('aria-label', 'Chercher une entreprise ou un contact');
  const controls = node('div', { className: 'studio-controls' }); controls.append(search, refresh);
  const layout = node('div', { className: 'studio-layout' });
  const list = node('div', { className: 'studio-contacts' }), detail = node('section', { className: 'studio-detail' });
  detail.setAttribute('aria-label', 'Échanges du contact');
  const provenance = node('p', { className: 'studio-provenance' });
  layout.append(list, detail); home.replaceChildren(controls, note, layout, provenance);
  async function api(body) {
    const response = await fetchImpl('api/studio', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.code ?? 'STUDIO_UNAVAILABLE'); error.status = response.status; throw error; }
    return result;
  }
  function failed(error) {
    if (error.status === 401) { clear(); onDenied(error.message); return; }
    if (error.status === 403) { clear(); note.textContent = 'Cette vue est réservée aux membres autorisés du Studio.'; return; }
    note.textContent = 'Les échanges ne sont pas disponibles. Réessayez avec Actualiser.';
  }
  async function probe() {
    const owner = epoch;
    try { await api({ action: 'access' }); if (owner === epoch && nav) nav.hidden = false; }
    catch (error) { if (owner === epoch && error.status === 401) failed(error); }
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase('fr');
    const contacts = (data?.contacts ?? []).filter(item => [item.company, ...item.addresses.map(a => a.address)].join(' ').toLocaleLowerCase('fr').includes(query));
    list.replaceChildren();
    if (!contacts.length) list.append(node('p', { textContent: data?.contacts.length ? 'Aucun contact ne correspond à cette recherche.' : 'Aucun contact enregistré. Les échanges apparaîtront ici après leur traitement par C-chan.' }));
    for (const item of contacts) {
      const owner = epoch;
      const button = node('button', { type: 'button', className: 'studio-contact' });
      button.setAttribute('aria-pressed', String(selected === item.company));
      button.append(node('strong', { textContent: item.company }), node('span', { textContent: item.addresses.map(a => a.address).join(', ') }),
        node('span', { className: item.optedOut ? 'studio-opposition' : '', textContent: FOLLOW[item.followUp] }),
        node('time', { dateTime: item.lastAt, textContent: date(item.lastAt) }));
      button.addEventListener('click', () => { if (owner === epoch) void loadDetail(item.company); }); list.append(button);
    }
  }
  function renderDetail() {
    detail.replaceChildren(); layout.dataset.detail = selected ? 'true' : 'false';
    if (!selected) { detail.append(node('p', { textContent: 'Choisissez un contact pour lire les échanges.' })); return; }
    const back = node('button', { type: 'button', className: 'text-button studio-back', textContent: 'Retour aux contacts' });
    const owner = epoch, company = selected, token = detailRequest;
    const current = () => owner === epoch && company === selected && token === detailRequest;
    back.addEventListener('click', () => { if (!current()) return; selected = null; detailRequest++; renderDetail(); renderList(); search.focus(); });
    const title = node('h2', { textContent: selected, tabIndex: -1 });
    detail.append(back, title);
    const item = data?.contacts.find(contact => contact.company === selected);
    if (item) detail.append(node('p', { className: 'studio-status', textContent: FOLLOW[item.followUp] + (item.eligibleAt ? ' · ' + date(item.eligibleAt) : '') }));
    if (nextOffset !== null) {
      const older = node('button', { type: 'button', className: 'button', textContent: 'Échanges plus anciens' });
      const offset = nextOffset;
      older.addEventListener('click', () => { if (!current()) return; older.disabled = true; void loadDetail(company, offset); }); detail.append(older);
    }
    const timeline = node('ol', { className: 'studio-timeline' });
    for (const message of messages) {
      const entry = node('li', { className: 'studio-message ' + message.direction });
      const header = node('p', { className: 'studio-message-meta', textContent: STATE[message.state] + ' · ' + date(message.at) });
      entry.append(header, node('p', { textContent: (message.direction === 'sent' ? 'À : ' : 'De : ') + message.address }),
        node('h3', { textContent: message.subject }));
      if (message.automatic) entry.append(node('p', { textContent: 'Message automatique' }));
      if (message.optedOut) entry.append(node('p', { className: 'studio-opposition', textContent: 'Demande d’opposition' }));
      entry.append(node('pre', { className: 'studio-message-text', textContent: message.text ?? 'Corps non conservé pour cet ancien échange. Seules les métadonnées sont disponibles.' }));
      timeline.append(entry);
    }
    detail.append(timeline); if (!messages.length) detail.append(node('p', { textContent: 'Chargement des échanges…' }));
  }
  async function loadDetail(company, offset = 0) {
    const owner = epoch, token = ++detailRequest;
    if (!offset) { selected = company; messages = []; nextOffset = null; renderList(); renderDetail(); }
    try {
      const result = await api({ action: 'detail', company, offset });
      if (owner !== epoch || token !== detailRequest) return;
      const byId = new Map((offset ? [...result.messages, ...messages] : result.messages).map(m => [m.direction + ':' + m.id, m]));
      messages = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)); nextOffset = result.nextOffset;
      note.textContent = ''; renderDetail();
      if (!offset) detail.querySelector('h2')?.focus();
    } catch (error) { if (owner === epoch && token === detailRequest) { failed(error); renderDetail(); } }
  }
  async function show() {
    const owner = epoch, token = ++request; detailRequest++; selected = null; messages = []; nextOffset = null;
    note.textContent = 'Chargement des contacts…'; refresh.disabled = true; renderDetail();
    try {
      const result = await api({ action: 'list' }); if (owner !== epoch || token !== request) return;
      data = result; if (nav) nav.hidden = false; note.textContent = result.limited ? 'Les 200 contacts les plus récents sont affichés.' : '';
      provenance.textContent = result.provenance.text + (result.provenance.missingSent ? ` ${result.provenance.missingSent} ancien(s) envoi(s) sans corps conservé.` : '')
        + (result.provenance.missingReceived ? ` ${result.provenance.missingReceived} réponse(s) ancienne(s) en attente d’archivage ou dont le fichier n’est plus disponible.` : '');
      renderList();
    } catch (error) { if (owner === epoch && token === request) failed(error); }
    finally { if (owner === epoch && token === request) refresh.disabled = false; }
  }
  function clear() {
    epoch++; request++; detailRequest++; data = null; selected = null; messages = []; nextOffset = null; search.value = '';
    list.replaceChildren(); detail.replaceChildren(); provenance.textContent = ''; note.textContent = ''; refresh.disabled = false;
    layout.dataset.detail = 'false'; if (nav) nav.hidden = true;
  }
  search.addEventListener('input', renderList); refresh.addEventListener('click', () => { void show(); });
  return { show, probe, clear };
}
