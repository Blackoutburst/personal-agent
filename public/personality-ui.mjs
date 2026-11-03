const MAX_BYTES = 256 * 1024, REVISION = /^[a-f0-9]{64}$/;
const SOURCES = { settled_turn: 'After a reply', owner_edit: 'Owner edit', owner_restore: 'Owner restore', before_owner_change: 'Before an owner change' };
function contentValid(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const revisionValid = value => typeof value === 'string' && value.length === 64 && REVISION.test(value);
const dateValid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function checked(value, version = false, mutation = false) {
  const invalid = () => { throw new Error('INVALID_RESPONSE'); };
  if (!value || typeof value !== 'object' || !revisionValid(value.revision) || !contentValid(value.content) || !dateValid(value.modifiedAtISO)) invalid();
  if (version) {
    if (!dateValid(value.observedAtISO) || !Object.hasOwn(SOURCES, value.source)) invalid();
  } else {
    if (value.file !== 'SOUL.md' || value.historyLimit !== 20 || !Array.isArray(value.history) || value.history.length > 20 ||
        (mutation && typeof value.changed !== 'boolean')) invalid();
    const ids = new Set();
    for (const item of value.history) {
      if (!item || !revisionValid(item.revision) || ids.has(item.revision) || !dateValid(item.observedAtISO) ||
          !dateValid(item.modifiedAtISO) || !Object.hasOwn(SOURCES, item.source)) invalid();
      ids.add(item.revision);
    }
  }
  return value;
}

// Textareas normalize newlines. Keep unchanged separators, including mixed CRLF/CR/LF, around each edit.
function editedContent(previous, value) {
  if (previous.replace(/\r\n|\r/g, '\n') === value) return previous;
  const old = previous.split(/\r\n|\r|\n/), next = value.split('\n'), endings = previous.match(/\r\n|\r|\n/g) ?? [];
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old.at(-suffix - 1) === next.at(-suffix - 1)) suffix++;
  const fallback = endings[Math.min(prefix, endings.length - 1)] ?? '\n';
  return next.map((line, index) => {
    if (index === next.length - 1) return line;
    const ending = index < prefix ? endings[index] : index >= next.length - suffix ? endings[old.length - (next.length - index)] :
      old.length === next.length ? endings[index] : null;
    return line + (ending ?? fallback);
  }).join('');
}

export function createPersonalityUI({ document, api, onDenied = () => {} }) {
  const $ = id => document.getElementById(id), node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let snapshot = null, draft = null, selected = null, confirmation = null, busy = false, failed = false;
  let ownerEpoch = 0, request = 0, name = 'Your companion', notice = '';
  const date = value => new Date(value).toLocaleString();
  const current = (owner, token) => owner === ownerEpoch && token === request;
  function announce(value) { notice = value; if ($('announce')) $('announce').textContent = value; }
  function button(text, run, disabled = busy) {
    const result = node('button', { type: 'button', textContent: text, disabled }); result.addEventListener('click', run); return result;
  }
  function clear() {
    ownerEpoch++; request++; snapshot = null; draft = null; selected = null; confirmation = null; busy = false; failed = false; notice = '';
    $('personality-actions').replaceChildren(); $('personality-body').replaceChildren(); $('personality-notice').textContent = '';
  }
  function denied(error) {
    if (error.status !== 401 && error.status !== 403) return false;
    clear(); onDenied(); return true;
  }
  function errorText(error) {
    if (error.message === 'PERSONALITY_BUSY') return 'Finish or stop the current reply, wait for it to stop, then try again.';
    if (error.message === 'PERSONALITY_CONFLICT') return 'The personality changed. Review the latest version before trying again.';
    if (error.message === 'PERSONALITY_NOT_FOUND') return 'That version is no longer available. Reload the personality.';
    if (error.message === 'PERSONALITY_TOO_LARGE') return 'This personality is too large to open safely. It has not been truncated.';
    return 'That change could not be confirmed. Reload the personality and review it before trying again.';
  }
  async function load(companionName = name) {
    if (busy) return;
    name = companionName; const owner = ownerEpoch, token = ++request; failed = false;
    try {
      const value = checked(await api({ action: 'personality' }));
      if (!current(owner, token)) return;
      snapshot = value;
      if (draft && draft.revision !== value.revision) { draft.conflict = true; announce('The personality changed. Your draft is kept; close it and review the current version before editing again.'); }
    } catch (error) {
      if (!current(owner, token) || denied(error)) return;
      snapshot = null; failed = true; announce(errorText(error));
    }
    render();
  }
  async function viewVersion(revision) {
    if (busy || !snapshot) return;
    const owner = ownerEpoch, token = ++request, against = { revision: snapshot.revision, content: snapshot.content };
    confirmation = null; selected = null; render();
    try {
      const result = await api({ action: 'personalityVersion', revision }), version = checked(result?.version, true);
      if (!current(owner, token)) return;
      if (version.revision !== revision) throw new Error('INVALID_RESPONSE');
      selected = { version, against }; render();
    } catch (error) {
      if (!current(owner, token) || denied(error)) return;
      announce(errorText(error)); render();
    }
  }
  async function mutate(payload, success) {
    if (busy) return;
    const owner = ownerEpoch, token = ++request; busy = true; render(); let conflict = false;
    try {
      const result = checked(await api(payload), false, true);
      if (!current(owner, token)) return;
      snapshot = result; draft = null; selected = null; confirmation = null;
      announce(result.changed ? success : 'This personality is already current.');
    } catch (error) {
      if (!current(owner, token) || denied(error)) return;
      conflict = error.message === 'PERSONALITY_CONFLICT';
      if (conflict && draft) draft.conflict = true;
      confirmation = null; if (conflict) selected = null;
      announce(errorText(error));
    } finally { if (current(owner, token)) { busy = false; render(); } }
    if (conflict && current(owner, token)) await load(name);
  }
  function editor(root) {
    if (!draft) return;
    const form = node('form', { className: 'personality-editor' }), label = node('label', { textContent: 'Edit personality' });
    const input = node('textarea', { value: draft.content, rows: 14, disabled: busy, ariaLabel: 'Full personality text', spellcheck: false });
    input.addEventListener('input', () => { draft.content = editedContent(draft.content, input.value); }); label.append(input); form.append(label);
    if (draft.conflict) form.append(node('p', { textContent: 'Your draft is kept. Copy it before closing, then review the current personality and start a new edit.' }));
    const save = button('Save personality', () => {}, busy || draft.conflict || !snapshot); save.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy || draft.conflict || !snapshot) return;
      if (!contentValid(draft.content)) { announce('Use valid text up to 256 KiB. Your draft has been kept.'); render(); return; }
      mutate({ action: 'editPersonality', content: draft.content, expectedRevision: draft.revision }, 'Personality saved. Past chats and memories are unchanged.');
    });
    form.append(save, button('Close personality editor', () => { draft = null; render(); })); root.append(form);
  }
  function comparison(root) {
    if (!selected) return;
    const { version, against } = selected;
    const box = node('section', { className: 'personality-version' });
    box.append(node('h3', { textContent: 'Selected observed version' }), node('p', { className: 'personality-source',
      textContent: `App observed ${date(version.observedAtISO)} · ${SOURCES[version.source]} · file updated ${date(version.modifiedAtISO)}` }),
    node('pre', { className: 'personality-content', textContent: version.content }));
    const old = against.content.split('\n'), next = version.content.split('\n'); let prefix = 0, suffix = 0;
    while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
    while (suffix < old.length - prefix && suffix < next.length - prefix && old.at(-suffix - 1) === next.at(-suffix - 1)) suffix++;
    const removed = old.slice(prefix, old.length - suffix), added = next.slice(prefix, next.length - suffix), limit = 200;
    box.append(node('h3', { textContent: 'Line comparison with the current version you opened' }), node('p', { className: 'personality-source', textContent: '− lines removed from current · + lines in the selected version' }));
    const diff = node('div', { className: 'personality-diff' });
    for (const [kind, lines, prefix] of [['removed', removed, '− '], ['added', added, '+ ']]) {
      if (lines.length) diff.append(node('pre', { className: `personality-content ${kind}`, textContent: lines.slice(0, limit).map(line => prefix + line).join('\n') }));
    }
    if (removed.length > limit || added.length > limit) diff.append(node('p', { textContent: 'The comparison preview is limited to 200 removed and 200 added lines. The complete selected version is shown above.' }));
    if (!removed.length && !added.length) diff.append(node('p', { textContent: 'The text is identical.' }));
    box.append(diff);
    if (confirmation) box.append(node('p', { textContent: 'Replace the personality you reviewed with this observed version? Past chats and memories stay unchanged.' }),
      button('Confirm restore', () => mutate({ action: 'restorePersonality', revision: confirmation.target, expectedRevision: confirmation.current, confirm: true }, 'Observed personality restored. Past chats and memories are unchanged.')),
      button('Keep current personality', () => { confirmation = null; render(); }));
    else {
      const stale = snapshot?.revision !== against.revision;
      if (stale) box.append(node('p', { textContent: 'The current personality changed. Select an observed version again before restoring.' }));
      box.append(button('Restore this version', () => { confirmation = { target: version.revision, current: against.revision }; render(); }, busy || stale || version.revision === against.revision));
    }
    box.append(button('Close observed version', () => { selected = null; confirmation = null; render(); })); root.append(box);
  }
  function render() {
    $('personality-title').textContent = `${name}’s personality`;
    $('personality-intro').textContent = `${name} keeps growing and tells you when the personality changes. Suggestions stay in your chat. You can edit the current text or restore an observed version.`;
    $('personality-notice').textContent = notice;
    $('personality-actions').replaceChildren(button('Reload personality', () => load(name)), button('Edit personality', () => {
      if (draft || busy || !snapshot) return;
      request++; draft = { content: snapshot.content, revision: snapshot.revision, conflict: false }; selected = null; confirmation = null; render();
    }, busy || !snapshot || Boolean(draft)));
    const root = $('personality-body'); root.replaceChildren(); editor(root);
    if (!snapshot) { root.append(node('p', { textContent: failed ? 'The personality could not be opened. Reload to try again.' : 'Opening personality…' })); return; }
    root.append(node('p', { className: 'personality-source', textContent: `SOUL.md · file updated ${date(snapshot.modifiedAtISO)}` }),
      node('pre', { className: 'personality-content', textContent: snapshot.content }));
    root.append(node('h3', { textContent: 'Observed history' }), node('p', { className: 'personality-source',
      textContent: 'History keeps the last 20 versions the app saw after replies and owner changes. It may not include every change made between those observations.' }));
    if (!snapshot.history.length) root.append(node('p', { textContent: 'No versions have been observed yet.' }));
    const list = node('ul', { className: 'personality-history' });
    for (const item of snapshot.history) {
      const row = node('li'); row.append(node('span', { textContent: `${date(item.observedAtISO)} · ${SOURCES[item.source]}${item.revision === snapshot.revision ? ' · current text' : ''}` }),
        button('View observed version', () => viewVersion(item.revision))); list.append(row);
    }
    root.append(list); comparison(root);
  }
  return { load, clear };
}
