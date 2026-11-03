// Private saved-note controls. A generation fences stale loads, mutations and exports after sign-out.
export function createMemoryUI({ document, api, onDenied = () => {}, downloads = globalThis }) {
  const $ = id => document.getElementById(id);
  let snapshot = null, ownerEpoch = 0, request = 0, busy = false, name = 'Your companion';
  let editing = null, confirming = null, confirmingAll = false, notice = '', failed = false;
  const urls = new Set();
  const node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  function button(text, run, className = '') {
    const result = node('button', { type: 'button', textContent: text, className, disabled: busy });
    result.addEventListener('click', run); return result;
  }
  const title = file => ({ 'USER.md': 'About you', 'MEMORY.md': 'Our memories' })[file] ?? `Diary · ${file.slice(7, -3)}`;
  function date(value) { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleString() : 'date unavailable'; }
  function announce(text) { notice = text; if ($('announce')) $('announce').textContent = text; }
  function clear() {
    ownerEpoch++; request++; snapshot = null; busy = false; editing = null; confirming = null; confirmingAll = false; notice = ''; failed = false;
    for (const url of urls) downloads.URL?.revokeObjectURL(url); urls.clear();
    $('memory-groups').replaceChildren(); $('memory-actions').replaceChildren(); $('memory-notice').textContent = '';
  }
  function errorText(error) {
    if (error.message === 'MEMORY_BUSY') return 'Finish or stop the current reply, wait for it to stop, then try again.';
    if (error.message === 'MEMORY_CONFLICT') return 'Your saved notes changed. They have been reloaded; review them before trying again.';
    if (error.message === 'MEMORY_TOO_LARGE') return 'These saved notes are too large to open safely. Your saved files have not been truncated.';
    return 'That could not be completed. Reload your saved notes and try again.';
  }
  function denied(error) {
    if (error.status !== 401 && error.status !== 403) return false;
    // MEMORY_READ_ONLY is a document decision, not loss of the owner's session.
    if (error.message === 'MEMORY_READ_ONLY') return false;
    clear(); onDenied(); return true;
  }
  async function load(companionName = name, { preserveDraft = false } = {}) {
    if (busy) return;
    name = companionName; const token = ++request, owner = ownerEpoch;
    if (!preserveDraft) { editing = null; confirming = null; confirmingAll = false; }
    failed = false;
    try {
      const value = await api({ action: 'memory' });
      if (token !== request || owner !== ownerEpoch) return;
      snapshot = value;
    } catch (error) {
      if (token !== request || owner !== ownerEpoch) return;
      if (denied(error)) return;
      snapshot = null; failed = true; announce(errorText(error));
    }
    render();
  }
  async function mutate(payload, success) {
    if (busy) return;
    const token = ++request, owner = ownerEpoch; busy = true; render();
    let conflict = false;
    try {
      const result = await api(payload);
      if (token !== request || owner !== ownerEpoch) return;
      snapshot = result; editing = null; confirming = null; confirmingAll = false;
      announce(payload.action === 'forget' && !result.removed ? 'That note is no longer in memory.' : success);
    } catch (error) {
      if (token !== request || owner !== ownerEpoch) return;
      if (denied(error)) return;
      conflict = error.message === 'MEMORY_CONFLICT';
      if (conflict && editing) editing.conflict = true;
      confirming = null; confirmingAll = false; announce(errorText(error));
    } finally {
      if (token === request && owner === ownerEpoch) { busy = false; render(); }
    }
    if (conflict && token === request && owner === ownerEpoch) await load(name, { preserveDraft: true });
  }
  async function exportNotes() {
    if (busy) return;
    const token = ++request, owner = ownerEpoch; busy = true; render();
    try {
      const result = await api({ action: 'exportMemory' });
      if (token !== request || owner !== ownerEpoch) return;
      const blob = new downloads.Blob([JSON.stringify(result.export, null, 2) + '\n'], { type: 'application/json' });
      const url = downloads.URL.createObjectURL(blob); urls.add(url);
      const link = node('a', { href: url, download: 'companion-memory.json' }); link.click();
      downloads.setTimeout(() => { downloads.URL.revokeObjectURL(url); urls.delete(url); }, 1000);
      announce('Saved notes and diary exported. Keep the downloaded copy private.');
    } catch (error) {
      if (token !== request || owner !== ownerEpoch) return;
      if (!denied(error)) announce(errorText(error));
    } finally { if (token === request && owner === ownerEpoch) { busy = false; render(); } }
  }
  function renderEditor(root) {
    if (!editing) return;
    const form = node('form', { className: 'memory-editor' });
    const label = node('label', { textContent: `Correct note in ${title(editing.file)}` });
    const input = node('textarea', { value: editing.text, rows: 3, maxLength: 4000, disabled: busy, ariaLabel: 'Correct this saved note' });
    input.addEventListener('input', () => { editing.text = input.value; }); label.append(input); form.append(label);
    if (editing.conflict) form.append(node('p', { textContent: 'Your draft is kept below. Copy it if needed, then close and choose the current note to edit.' }));
    const save = button('Save correction', () => {}); save.type = 'submit'; save.disabled = busy || editing.conflict;
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy || editing.conflict) return;
      const text = editing.text.trim();
      if (!text || text.length > 4000 || /[\x00-\x1f\x7f]/.test(text) || new TextEncoder().encode(text).length > 16000) { announce('Use one nonempty line without tabs, up to 4,000 characters.'); render(); return; }
      mutate({ action: 'editMemory', file: editing.file, id: editing.id, text, expectedRevision: editing.revision }, 'Memory corrected. Past chats are not changed.');
    });
    form.append(save, button('Close', () => { editing = null; render(); })); root.append(form);
  }
  function render() {
    $('memories-title').textContent = `What ${name} remembers`;
    $('memories-intro').textContent = `${name} writes things down as you talk. You can correct or remove saved notes and read the diary. Past chats stay as they are.`;
    $('memory-notice').textContent = notice;
    const actions = $('memory-actions'); actions.replaceChildren();
    actions.append(button('Reload saved notes', () => load(name)), button('Export saved notes and diary', exportNotes));
    actions.lastChild.disabled = busy || !snapshot?.revision || !snapshot.files.length;
    if (confirmingAll) {
      actions.append(node('p', { textContent: 'Clear all saved notes and the diary? Personality and conversations stay. This cannot be undone here.' }),
        button('Confirm forget everything', () => mutate({ action: 'forgetAll', expectedRevision: confirmingAll.revision, confirm: true }, 'Saved notes and diary cleared. Personality and past chats are unchanged.'), 'danger'),
        button('Keep saved notes', () => { confirmingAll = false; render(); }));
    } else {
      const all = button('Forget everything the companion remembers', () => { confirmingAll = { revision: snapshot.revision }; editing = null; render(); }, 'danger');
      all.disabled = busy || !snapshot?.revision || !snapshot.files.length; actions.append(all);
    }
    const root = $('memory-groups'); root.replaceChildren(); renderEditor(root);
    if (!snapshot) { root.append(node('p', { className: 'empty', textContent: failed ? 'Saved notes could not be loaded.' : 'Loading saved notes…' })); return; }
    if (!snapshot.files.length) root.append(node('p', { className: 'empty', textContent: 'No saved notes yet.' }));
    for (const file of snapshot.files) {
      const card = node('section', { className: 'memory-card' });
      card.append(node('h2', { textContent: title(file.file) }), node('p', { className: 'memory-source', textContent: `${file.file} · file updated ${date(file.modifiedAtISO)}${file.readOnly ? ' · read only' : ''}` }));
      const items = new Map(file.sections.flatMap(section => section.items).map(item => [item.line, item]));
      const content = node('div', { className: 'memory-content' });
      file.content.split('\n').forEach((line, index) => {
        const item = !file.readOnly && items.get(index), row = node('div', { className: item ? 'memory-item' : 'memory-line' });
        row.append(node('span', { textContent: line || '\u00a0', className: 'memory-line-text' }));
        if (item) {
          const controls = node('span', { className: 'memory-controls' });
          if (confirming?.file === file.file && confirming.id === item.id) {
            controls.append(button('Confirm forget', () => mutate({ action: 'forget', file: confirming.file, id: confirming.id, expectedRevision: confirming.revision }, "Removed from memory. Past chats aren't changed.")),
              button('Keep', () => { confirming = null; render(); }));
          } else controls.append(button('Edit', () => { editing = { file: file.file, id: item.id, text: item.text, revision: file.revision, conflict: false }; confirming = null; render(); }),
            button('Forget', () => { confirming = { file: file.file, id: item.id, revision: file.revision }; editing = null; render(); }, 'forget'));
          row.append(controls);
        }
        content.append(row);
      });
      card.append(content); root.append(card);
    }
  }
  return { load, clear };
}
