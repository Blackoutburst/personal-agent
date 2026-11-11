// The Studio tab (#65): an app grid (APPS) whose tiles open the Studio mailbox (#63/#64, read-only correspondence) or the
// shared Studio calendar (src/studio-calendar.mjs, through public/calendar-ui.mjs). Routes: #studio, #studio/<app id>.
import { createCalendarUI } from './calendar-ui.mjs';
import { createOpsUI } from './ops-ui.mjs';

// One entry per app; a new Studio app adds its tile here, an access flag in /api/studio "access" and a view below.
export const APPS = Object.freeze([
  Object.freeze({ id: 'mail', name: 'Boîte mail', line: 'Contacts et échanges du Studio, en lecture.', icon: '✉' }),
  Object.freeze({ id: 'calendar', name: 'Calendrier', line: 'Rendez-vous et échéances partagés par les membres et leurs compagnons.', icon: '▦' }),
  Object.freeze({ id: 'ops', name: 'Ops', line: 'Les agents de C-chan : en cours, tickets, décisions et consommation.', icon: '◉' })
]);
const CALENDAR_LABELS = { calendar: 'Calendrier', previous: 'Mois précédent', next: 'Mois suivant', today: 'Aujourd’hui', addEvent: 'Ajouter un événement',
  weekdays: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'], holiday: 'Férié', allDay: 'Toute la journée', todaySuffix: ', aujourd’hui', open: ', ouvrir',
  more: (count, day) => `${count} de plus le ${day}`, nothing: 'Rien de prévu.', addOnDay: 'Ajouter un événement ce jour-là', edit: 'Modifier',
  editNamed: title => `Modifier ${title}`, newEvent: 'Nouvel événement', editEvent: 'Modifier l’événement', title: 'Titre', allDayCheck: ' Toute la journée',
  date: 'Date', time: 'Heure', ends: 'Fin (facultatif)', endTime: 'Heure de fin', location: 'Lieu', notes: 'Notes', save: 'Enregistrer', add: 'Ajouter',
  cancel: 'Annuler', delete: 'Supprimer', confirmDelete: title => `Supprimer « ${title} » pour tous les membres du Studio ?`,
  confirmDeleteAll: title => `Supprimer « ${title} » pour tous les membres du Studio ?`, endBeforeStart: 'La fin est avant le début.',
  deleted: 'Événement supprimé.', saved: 'Événement enregistré.', added: 'Événement ajouté.', unavailable: 'Le calendrier du Studio n’est pas disponible pour le moment.',
  saveFailed: 'Le calendrier n’a pas pu enregistrer. Réessayez.', upcoming: 'À venir', noUpcoming: 'Aucun événement à venir.' };
const who = person => person ? person.name + (person.kind === 'companion' ? ' (compagnon)' : '') : null;
export function bylineFor(event) {
  const created = who(event?.createdBy), updated = who(event?.updatedBy);
  if (!created) return null;
  return 'Ajouté par ' + created + (updated && updated !== created ? ' · modifié par ' + updated : '');
}

const FOLLOW = { opted_out: 'Opposition enregistrée', uncertain: 'Envoi à vérifier', replied: 'Réponse reçue',
  not_contacted: 'Sans premier contact envoyé', used: 'Relance déjà utilisée', waiting: 'Relance en attente', daily_limit: 'Limite du jour atteinte', eligible: 'Relance possible via C-chan' };
const STATE = { sent: 'Envoyé', pending: 'Envoi incertain : ne pas renvoyer', failed: 'Envoi refusé', received: 'Reçu' };
const date = value => new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
// navigate(appId | null): go to #studio/<app> or back to the grid (the host app routes it back to show).
export function createStudioUI({ document, fetchImpl = fetch, onDenied = () => {}, navigate = null, requestId }) {
  const home = document.getElementById('studio-home'), nav = document.getElementById('nav-studio');
  if (!home) return { show: async () => {}, probe: async () => {}, clear() {}, hide() {} };
  const node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let epoch = 0, request = 0, detailRequest = 0, openRequest = 0, data = null, selected = null, messages = [], nextOffset = null;
  let apps = null, current = null;
  const go = app => { if (navigate) navigate(app); else void show(app); };
  // The grid and the bar above an open app.
  const grid = node('div', { className: 'studio-apps' }); grid.setAttribute('role', 'list');
  const appBar = node('div', { className: 'studio-app-bar', hidden: true });
  const back = node('button', { type: 'button', className: 'button studio-apps-back', textContent: '‹ Applications' });
  back.setAttribute('aria-label', 'Retour aux applications du Studio');
  const appTitle = node('h2', { className: 'studio-app-title', tabIndex: -1 });
  appBar.append(back, appTitle);
  back.addEventListener('click', () => go(null));
  const gridNote = node('p', { className: 'note', role: 'status' });
  const mailView = node('section', { className: 'studio-app studio-mail', hidden: true });
  mailView.setAttribute('aria-label', 'Suivi des contacts');
  const calendarView = node('section', { className: 'studio-app studio-calendar', hidden: true });
  calendarView.setAttribute('aria-label', 'Calendrier du Studio');
  const calendarIntro = node('p', { className: 'intro', textContent: 'Partagé par les membres du Studio et leurs compagnons. Chacun le voit à son heure locale.' });
  const calendarHome = node('section', { className: 'calendar-block' });
  calendarView.append(calendarIntro, calendarHome);
  const calendarUI = createCalendarUI({ document, fetchImpl, home: calendarHome, endpoint: 'api/studio', labels: CALENDAR_LABELS, locale: 'fr-FR',
    features: { holidays: false, repeat: false, reminders: false }, notesMax: 2000, byline: bylineFor, agenda: true,
    fields: [{ key: 'company', label: 'Entreprise (facultatif)', max: 200 }, { key: 'contact', label: 'Contact (facultatif)', max: 254 }],
    visible: () => current === 'calendar', ...(requestId ? { requestId } : {}) });
  const opsView = node('section', { className: 'studio-app studio-ops', hidden: true });
  opsView.setAttribute('aria-label', 'Ops : les agents de C-chan');
  const opsUI = createOpsUI({ document, fetchImpl, home: opsView, visible: () => current === 'ops', onDenied });
  const note = node('p', { className: 'note', role: 'status' });
  const refresh = node('button', { type: 'button', className: 'button', textContent: 'Actualiser' });
  const search = node('input', { type: 'search', placeholder: 'Chercher une entreprise ou un contact' });
  search.setAttribute('aria-label', 'Chercher une entreprise ou un contact');
  const controls = node('div', { className: 'studio-controls' }); controls.append(search, refresh);
  const layout = node('div', { className: 'studio-layout' });
  const list = node('div', { className: 'studio-contacts' }), detail = node('section', { className: 'studio-detail' });
  detail.setAttribute('aria-label', 'Échanges du contact');
  const provenance = node('p', { className: 'studio-provenance' });
  layout.append(list, detail);
  mailView.append(node('p', { className: 'intro', textContent: 'Contacts et échanges. C-chan reste votre interlocutrice pour les envois.' }), controls, note, layout, provenance);
  home.replaceChildren(gridNote, grid, appBar, mailView, calendarView, opsView);
  function renderGrid() {
    grid.replaceChildren();
    for (const app of APPS) {
      if (!apps?.[app.id]) continue;
      const tile = node('button', { type: 'button', className: 'studio-app-tile' });
      tile.setAttribute('role', 'listitem'); tile.dataset.app = app.id;
      const icon = node('span', { className: 'studio-app-icon', textContent: app.icon }); icon.setAttribute('aria-hidden', 'true');
      tile.append(icon, node('strong', { textContent: app.name }), node('span', { textContent: app.line }));
      const owner = epoch;
      tile.addEventListener('click', () => { if (owner === epoch) go(app.id); });
      grid.append(tile);
    }
  }
  function layoutFor(app) {
    if (app !== 'ops') opsUI.hide();
    current = app;
    grid.hidden = app !== null; appBar.hidden = app === null; gridNote.hidden = app !== null;
    mailView.hidden = app !== 'mail'; calendarView.hidden = app !== 'calendar'; opsView.hidden = app !== 'ops';
    appTitle.textContent = APPS.find(item => item.id === app)?.name ?? '';
  }
  // The grid, or one app (opening it refreshes it). An app this member may not open shows the grid with a note.
  async function show(app = null) {
    const owner = epoch, token = ++openRequest;
    if (!apps) {
      gridNote.textContent = 'Chargement…';
      try {
        const result = await api({ action: 'access' });
        if (owner !== epoch || token !== openRequest) return;
        apps = { mail: true, calendar: false, ops: false, ...(result.apps ?? {}) }; if (nav) nav.hidden = false;
      } catch (error) {
        if (owner !== epoch || token !== openRequest) return;
        if (error.status === 401 || error.status === 403) failed(error); else gridNote.textContent = 'Le Studio n’est pas disponible. Réessayez dans un instant.';
        return;
      }
    }
    const wanted = app && APPS.some(item => item.id === app) && apps[app] ? app : null;
    gridNote.textContent = app && !wanted ? 'Cette application n’est pas disponible pour vous.' : '';
    renderGrid(); layoutFor(wanted);
    if (wanted) appTitle.focus?.();
    if (wanted === 'mail') await showMail();
    else if (wanted === 'calendar') await calendarUI.show();
    else if (wanted === 'ops') await opsUI.show();
  }
  async function api(body) {
    const response = await fetchImpl('api/studio', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.code ?? 'STUDIO_UNAVAILABLE'); error.status = response.status; throw error; }
    return result;
  }
  function failed(error) {
    if (error.status === 401) { clear(); onDenied(error.message); return; }
    if (error.status === 403) { clear(); gridNote.textContent = note.textContent = 'Cette vue est réservée aux membres autorisés du Studio.'; return; }
    note.textContent = 'Les échanges ne sont pas disponibles. Réessayez avec Actualiser.';
  }
  async function probe() {
    const owner = epoch;
    try {
      const result = await api({ action: 'access' });
      if (owner === epoch) { apps = { mail: true, calendar: false, ops: false, ...(result.apps ?? {}) }; if (nav) nav.hidden = false; }
    }
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
  async function showMail() {
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
    openRequest++; apps = null; grid.replaceChildren(); gridNote.textContent = ''; layoutFor(null); calendarUI.clear(); opsUI.clear();
  }
  search.addEventListener('input', renderList); refresh.addEventListener('click', () => { void showMail(); });
  return { show, probe, clear, hide: () => opsUI.hide() };
}
