const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fields(value, required) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== required.length || keys.some(key => !required.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('INVALID_RESPONSE');
  return Object.fromEntries(required.map(key => [key, descriptors[key].value]));
}
function label(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > 320) throw new Error('INVALID_RESPONSE');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('INVALID_RESPONSE'); }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('INVALID_RESPONSE');
  }
  return value;
}
function contacts(value) {
  const selected = fields(value, ['contacts']);
  if (!Array.isArray(selected.contacts) || selected.contacts.length > 32) throw new Error('INVALID_RESPONSE');
  const ids = new Set();
  return selected.contacts.map(value => {
    const contact = fields(value, ['id', 'name', 'ownerLabel', 'enabled', 'peerEnabled', 'revision']);
    if (typeof contact.id !== 'string' || contact.id.length !== 36 || !UUID.test(contact.id) || ids.has(contact.id) ||
        typeof contact.enabled !== 'boolean' || typeof contact.peerEnabled !== 'boolean' || !Number.isSafeInteger(contact.revision) || contact.revision < 0) throw new Error('INVALID_RESPONSE');
    ids.add(contact.id); label(contact.name); label(contact.ownerLabel); return contact;
  });
}

export function createContactUI({ document, api, onDenied = () => {} }) {
  const $ = id => document.getElementById(id), node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let current = null, busy = false, loading = false, ownerEpoch = 0, request = 0, notice = '';
  const active = (owner, token) => owner === ownerEpoch && token === request;
  function clear() {
    ownerEpoch++; request++; current = null; busy = false; loading = false; notice = '';
    $('contacts-list').replaceChildren(); $('contacts-actions').replaceChildren(); $('contacts-note').textContent = '';
  }
  function denied(error) {
    if (error.status !== 401 && error.status !== 403) return false;
    clear(); onDenied(); return true;
  }
  function problem(error) {
    if (error.message === 'CONTACT_CONFLICT') return 'Contact settings changed. Review the latest settings before trying again.';
    if (error.message === 'CONTACT_NOT_FOUND') return 'That companion contact is no longer available. Reload contacts.';
    return 'The contact change could not be confirmed. Reload contacts before trying again.';
  }
  async function load() {
    if (busy) return;
    const owner = ownerEpoch, token = ++request; loading = true; render();
    try {
      const result = contacts(await api({ action: 'contacts' }));
      if (!active(owner, token)) return;
      current = result; notice = '';
    } catch (error) {
      if (!active(owner, token) || denied(error)) return;
      current = null; notice = 'Contacts could not be loaded. Reload to try again.';
    } finally { if (active(owner, token)) { loading = false; render(); } }
  }
  async function change(contact, enabled, renderedOwner) {
    if (renderedOwner !== ownerEpoch || busy || loading || typeof enabled !== 'boolean') return;
    const owner = ownerEpoch, token = ++request; busy = true; notice = ''; render();
    try {
      const result = contacts(await api({ action: 'setContact', id: contact.id, enabled, expectedRevision: contact.revision }));
      if (!active(owner, token)) return;
      if (!result.some(item => item.id === contact.id && item.enabled === enabled && item.revision >= contact.revision)) throw new Error('INVALID_RESPONSE');
      current = result; notice = 'Contact settings saved.';
    } catch (error) {
      if (!active(owner, token) || denied(error)) return;
      notice = problem(error);
      if (error.message === 'CONTACT_CONFLICT') {
        try {
          const result = contacts(await api({ action: 'contacts' }));
          if (!active(owner, token)) return;
          current = result;
        } catch (freshError) {
          if (!active(owner, token) || denied(freshError)) return;
          current = null; notice = 'Contact settings changed, but the latest settings could not be loaded. Reload before trying again.';
        }
      } else if (error.message === 'CONTACT_NOT_FOUND' || error.message === 'INVALID_RESPONSE') current = null;
    } finally { if (active(owner, token)) { busy = false; render(); } }
  }
  function render() {
    $('contacts-note').textContent = busy ? 'Saving contact settings…' : loading ? 'Opening contacts…' : notice;
    const reload = node('button', { type: 'button', textContent: 'Reload contacts', disabled: busy || loading });
    reload.addEventListener('click', load); $('contacts-actions').replaceChildren(reload);
    const list = $('contacts-list'); list.replaceChildren();
    if (!current) return;
    if (!current.length) { list.append(node('li', { textContent: 'No other companion contacts are available.' })); return; }
    for (const contact of current) {
      const renderedOwner = ownerEpoch;
      const row = node('li', { className: 'contact-row' }), control = node('input', { type: 'checkbox', checked: contact.enabled, disabled: busy || loading,
        ariaLabel: `Allow contact with ${contact.name} (${contact.ownerLabel}’s companion)` });
      control.addEventListener('change', () => { const enabled = control.checked; control.checked = contact.enabled; return change(contact, enabled, renderedOwner); });
      const toggle = node('label', { className: 'contact-toggle' }); toggle.append(control, node('span', { textContent: `${contact.name} (${contact.ownerLabel}’s companion)` }));
      row.append(toggle, node('p', { className: 'contact-status', textContent: `Other side: ${contact.peerEnabled ? 'on' : 'off'}. ${contact.enabled && contact.peerEnabled ? 'Both sides allow contact.' : 'Messages cannot be sent unless both sides allow contact.'}` }));
      list.append(row);
    }
  }
  return { load, clear };
}

// The conversation protocol validates peer metadata; content is always rendered as plain text.
export function renderPeerCard(document, message) {
  const node = (tag, props = {}) => Object.assign(document.createElement(tag), props), peer = message.peer;
  const heading = peer.direction === 'sent' ? `Sent to ${peer.name}` : `From ${peer.name} (${peer.ownerLabel}’s companion)`;
  const card = node('div', { className: 'peer-content', ariaLabel: heading });
  card.append(node('strong', { className: 'peer-heading', textContent: heading }));
  if (peer.direction === 'sent') card.append(node('span', { className: 'peer-owner', textContent: `${peer.ownerLabel}’s companion` }));
  card.append(node('p', { className: 'peer-body', textContent: message.text }), node('time', { dateTime: peer.sentAtISO, className: 'peer-time',
    textContent: new Date(peer.sentAtISO).toLocaleString(), ariaLabel: `Sent ${peer.sentAtISO}`, title: peer.sentAtISO }));
  return card;
}
