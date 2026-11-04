const WATCH_FIELDS = ['id', 'version', 'kind', 'condition', 'state', 'nextCheckAt', 'lastCheckAt', 'lastResult', 'urls', 'evidence', 'consecutiveStale', 'deliveryPending', 'createdAt'];
const WATCH_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function noteText(value, maximum, bytes, singleLine = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || new TextEncoder().encode(value).length > bytes ||
      (singleLine ? /[\x00-\x1f\x7f]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function watchDate(value) { try { return typeof value === 'string' && new Date(value).toISOString() === value; } catch { return false; } }
function watchUrl(value) {
  if (!noteText(value, 2048, 8192, true) || value !== value.trim() || /[\x00-\x20\x7f]/.test(value)) return false;
  try { const url = new URL(value); return /^https?:\/\//i.test(value) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function watchList(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('INVALID_WATCH_RESPONSE');
  if (value.filter(row => ['active', 'paused'].includes(row?.state)).length > 10 || value.filter(row => ['complete', 'cancelled'].includes(row?.state)).length > 10) throw new Error('INVALID_WATCH_RESPONSE');
  const ids = new Set();
  return value.map(row => {
    // Topic watches (#40) add their interval and recent digests.
    const topic = row?.kind === 'topic_watch', fields = topic ? [...WATCH_FIELDS, 'intervalHours', 'digests'] : WATCH_FIELDS;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== fields.length || !fields.every(field => Object.hasOwn(row, field)) ||
        typeof row.id !== 'string' || row.id.length !== 36 || !WATCH_ID.test(row.id) || ids.has(row.id) || !['release_watch', 'topic_watch'].includes(row.kind) ||
        topic && (!Number.isSafeInteger(row.intervalHours) || row.intervalHours < 6 || row.intervalHours > 168 || !Array.isArray(row.digests) || row.digests.length > 5
          || !row.digests.every(item => item && watchDate(item.at) && noteText(item.evidence, 1000, 4000) && Array.isArray(item.urls) && item.urls.length <= 8 && item.urls.every(watchUrl))) ||
        !Number.isSafeInteger(row.version) || row.version < 1 || !noteText(row.condition, 1000, 4000) ||
        !['active', 'paused', 'complete', 'cancelled'].includes(row.state) || !watchDate(row.createdAt) ||
        ![row.nextCheckAt, row.lastCheckAt].every(value => value === null || watchDate(value)) || ![null, 'found', 'not_yet', 'stale'].includes(row.lastResult) ||
        !Array.isArray(row.urls) || row.urls.length > 8 || !row.urls.every(watchUrl) || (row.evidence !== null && (!noteText(row.evidence, 1000, 4000) || /[\r\n]/.test(row.evidence))) ||
        !Number.isSafeInteger(row.consecutiveStale) || row.consecutiveStale < 0 || typeof row.deliveryPending !== 'boolean') throw new Error('INVALID_WATCH_RESPONSE');
    ids.add(row.id); return { ...row, urls: [...row.urls], ...(topic ? { digests: row.digests.map(item => ({ ...item, urls: [...item.urls] })) } : {}) };
  });
}

// Me › Watches (reminders, release and topic watches) and the schedule settings in the Me tab. Identity remains in the authenticated API.
export function createRemindersUI({ document, fetchImpl = fetch, requestId = () => globalThis.crypto.randomUUID(), visible = () => false }) {
  const $ = id => document.getElementById(id);
  let schedules = null, generation = 0, ownerEpoch = 0, busy = false, message = null, dirty = false, editVersion = 0;
  let watches = null, watchProblem = false, watchDraft = null, watchPending = null, watchNotice = '', watchConfirmation = null, watchNeedsReview = false;
  const expanded = new Set(), node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const watchPanel = node('section', { id: 'release-watches', className: 'release-watches', hidden: true });
  watchPanel.setAttribute('aria-label', 'Watches');
  const watchHeading = node('h2', { textContent: 'Watches' }), watchTip = node('p', { className: 'watch-tip',
    textContent: 'Ask your companion in chat to watch for a release (checked every six hours until it is out) or to follow a topic (a short digest with sources whenever there is something new). Checks use its web tools and may be mistaken or unavailable.' });
  const watchStatus = node('p', { className: 'watch-notice' }), watchRows = node('ul', { className: 'watch-list' }), watchEditor = node('div'), watchActions = node('div', { className: 'watch-actions' });
  watchStatus.setAttribute('role', 'status'); watchPanel.append(watchHeading, watchTip, watchStatus, watchRows, watchEditor, watchActions);
  ($('watches-home') ?? $('upcoming')).append(watchPanel);
  const routines = [
    { key: 'dailyDigest', row: 'schedule-daily', fields: { enabled: 'schedule-daily-enabled', localTime: 'schedule-daily-time' } },
    { key: 'weeklyCheckin', row: 'schedule-weekly', fields: { enabled: 'schedule-weekly-enabled', localTime: 'schedule-weekly-time', weekday: 'schedule-weekly-day' } }
  ];
  // #51 Board wake cap: sent only after the owner edits it; capEdited holds that edit's token.
  let capEdited = 0;
  const capOffered = () => Boolean(schedules?.settings && Object.hasOwn(schedules.settings, 'boardWakeCap') && $('schedule-board'));
  const supported = new Set(), routineEdits = new Map(routines.map(routine => [routine.key, new Map()]));
  function validRoutine(value, weekly) {
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.enabled === 'boolean'
      && typeof value.localTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)
      && (!weekly || Number.isInteger(value.weekday) && value.weekday >= 1 && value.weekday <= 7);
  }
  function clearRoutine(routine) {
    supported.delete(routine.key); routineEdits.get(routine.key).clear();
    if ($(routine.row)) $(routine.row).hidden = true;
    for (const [field, id] of Object.entries(routine.fields)) {
      const input = $(id); if (!input) continue;
      if (field === 'enabled') input.checked = false; else input.value = '';
      input.disabled = true;
    }
  }
  function renderRoutines() {
    for (const routine of routines) {
      const value = schedules?.settings?.[routine.key], edits = routineEdits.get(routine.key);
      if (!$(routine.row) || !Object.values(routine.fields).every(id => $(id)) || !validRoutine(value, routine.key === 'weeklyCheckin')) {
        clearRoutine(routine); continue;
      }
      supported.add(routine.key); $(routine.row).hidden = false;
      for (const [field, id] of Object.entries(routine.fields)) {
        if (!edits.has(field)) {
          if (field === 'enabled') $(id).checked = value.enabled; else $(id).value = String(value[field]);
        }
        $(id).disabled = field !== 'enabled' && !$(routine.fields.enabled).checked;
      }
    }
  }

  async function request(body, owner = ownerEpoch, token = generation) {
    const response = await fetchImpl('api/schedules', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (owner !== ownerEpoch || token !== generation) throw new Error('STALE_REQUEST');
    if (response.status === 401 || response.status === 403) clear();
    let result;
    try { result = await response.json(); } catch { throw new Error('SCHEDULER_UNAVAILABLE'); }
    if (owner !== ownerEpoch || token !== generation) throw new Error('STALE_REQUEST');
    if (!response.ok) { const error = new Error(typeof result?.error?.code === 'string' ? result.error.code : 'SCHEDULER_UNAVAILABLE'); error.status = response.status; throw error; }
    return result;
  }
  function clear() {
    ownerEpoch++; generation++; schedules = null; busy = false; dirty = false; editVersion++; message = null;
    watches = null; watchProblem = false; watchDraft = null; watchPending = null; watchConfirmation = null; watchNeedsReview = false; watchNotice = ''; expanded.clear();
    watchPanel.hidden = true; watchRows.replaceChildren(); watchEditor.replaceChildren(); watchActions.replaceChildren(); watchStatus.textContent = '';
    $('schedule-list').replaceChildren(); $('upcoming-count').textContent = '';
    $('schedule-note').textContent = 'Sign in to see your reminders.';
    $('schedule-checkins').checked = false; $('schedule-quiet-start').value = ''; $('schedule-quiet-end').value = '';
    capEdited = 0;
    if ($('schedule-board')) { $('schedule-board').hidden = true; $('schedule-board-cap').value = ''; $('schedule-board-cap').disabled = false; $('schedule-board-unlimited').checked = false; }
    $('schedule-zone').textContent = ''; $('schedule-save').disabled = true; $('schedule-settings').hidden = true;
    routines.forEach(clearRoutine);
    $('upcoming').open = false;
  }
  function accept(next) {
    schedules = next;
    watchProblem = false;
    if (!Object.hasOwn(next, 'releaseWatches')) {
      watches = null; watchDraft = null; watchPending = null; watchConfirmation = null; watchNeedsReview = false; watchNotice = ''; expanded.clear();
    } else {
      try { watches = watchList(next.releaseWatches); }
      catch { watches = null; watchProblem = true; watchDraft = null; watchPending = null; watchConfirmation = null; watchNeedsReview = false; expanded.clear(); }
    }
  }
  function watchButton(text, run, disabled = busy || Boolean(watchPending) || watchNeedsReview) {
    const button = node('button', { type: 'button', textContent: text, disabled }); button.addEventListener('click', run); return button;
  }
  function watchTime(value) {
    if (value === null) return 'Not scheduled';
    try { return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short', timeZone: schedules.timezone }).format(new Date(value)); } catch { return value; }
  }
  function currentWatch(id) { return watches?.find(watch => watch.id === id); }
  function usable(watch, owner) { return owner === ownerEpoch && !busy && !watchPending && !watchDraft && !watchNeedsReview && currentWatch(watch.id)?.version === watch.version; }
  function openEditor(watch, owner) {
    if (!usable(watch, owner) || watchDraft || !['active', 'paused'].includes(watch.state)) return;
    const topic = watch.kind === 'topic_watch';
    const form = node('form', { className: 'watch-editor' }), label = node('label', { textContent: topic ? 'Topic' : 'Watch condition' });
    const input = node('textarea', { value: watch.condition, maxLength: 1000, rows: 3 }); input.setAttribute('aria-label', topic ? 'Topic watch topic' : 'Release watch condition');
    label.append(input);
    const draft = { id: watch.id, version: watch.version, original: watch, text: watch.condition, hours: topic ? String(watch.intervalHours) : null, owner, blocked: false, form, input };
    const save = watchButton(topic ? 'Save watch' : 'Save condition', () => {}, false), close = watchButton('Close condition editor', () => {
      if (owner !== ownerEpoch || busy) return;
      watchDraft = null;
      if (watchPending?.body.input.id === watch.id) { watchPending = null; watchNeedsReview = true; watchNotice = 'The change may already have applied. Reload to review the current watch.'; }
      renderWatches();
    }, false);
    save.type = 'submit'; input.addEventListener('input', () => { if (watchDraft === draft && owner === ownerEpoch) draft.text = input.value; });
    const fields = [label];
    if (topic) {
      const hoursLabel = node('label', { className: 'watch-hours', textContent: 'Check every (hours, 6 to 168)' });
      const hours = node('input', { type: 'number', min: 6, max: 168, step: 1, value: draft.hours });
      hours.setAttribute('aria-label', 'Hours between checks');
      hours.addEventListener('input', () => { if (watchDraft === draft && owner === ownerEpoch) draft.hours = hours.value; });
      hoursLabel.append(hours); fields.push(hoursLabel); draft.hoursInput = hours;
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (watchDraft !== draft || owner !== ownerEpoch || draft.blocked || busy || watchPending) return;
      const condition = draft.text.trim();
      if (!noteText(condition, 1000, 4000)) { watchNotice = 'Use a nonempty condition of at most 1000 characters.'; renderWatches(); return; }
      const change = { requestId: null, id: draft.id, expectedVersion: draft.version, operation: 'edit' };
      if (!topic || condition !== draft.original.condition) change.condition = condition;
      if (topic) {
        const hours = Number(String(draft.hours).trim());
        if (!Number.isInteger(hours) || hours < 6 || hours > 168) { watchNotice = 'Check every 6 to 168 hours.'; renderWatches(); return; }
        if (hours !== draft.original.intervalHours) change.intervalHours = hours;
        if (!Object.hasOwn(change, 'condition') && !Object.hasOwn(change, 'intervalHours')) { watchNotice = 'Nothing to save yet.'; renderWatches(); return; }
      }
      change.requestId = requestId(); return mutateWatch(change, owner);
    });
    draft.save = save; draft.close = close; form.append(...fields, save, close); watchDraft = draft; watchConfirmation = null; watchNotice = ''; watchEditor.replaceChildren(form); renderWatches();
  }
  function sourceLinks(urls) {
    return urls.map(url => node('a', { href: url, textContent: url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }));
  }
  function renderWatches() {
    watchPanel.hidden = watches === null && !watchProblem;
    watchStatus.textContent = busy && watchPending ? 'Saving watch…' : watchProblem ? 'Watches could not be read. Reload to try again.' : watchNotice;
    watchRows.replaceChildren(); watchActions.replaceChildren();
    if (!watches) { watchEditor.replaceChildren(); return; }
    const renderedOwner = ownerEpoch;
    if (!watches.length) watchRows.append(node('li', { textContent: 'No watches yet.' }));
    for (const watch of watches) {
      const topic = watch.kind === 'topic_watch';
      const row = node('li', { className: 'watch-row' }), title = node('strong', { textContent: watch.condition });
      const state = watch.deliveryPending ? (watch.lastResult === 'found' ? 'Found · waiting for delivery after quiet hours' : 'Check unavailable · notice waiting for delivery after quiet hours')
        : ({ active: 'Active', paused: 'Paused', complete: 'Complete', cancelled: 'Cancelled' })[watch.state];
      const result = ({ found: topic ? 'Something new' : 'Found', not_yet: topic ? 'Nothing new' : 'Not yet', stale: 'Couldn’t check' })[watch.lastResult];
      row.append(node('span', { className: 'watch-kind', textContent: topic ? `Topic · every ${watch.intervalHours} h` : 'Release' }), title,
        node('small', { textContent: state + (watch.state === 'active' && !watch.deliveryPending ? ` · Next check: ${watchTime(watch.nextCheckAt)}` : '') }),
        node('small', { textContent: watch.lastCheckAt ? `Last checked ${watchTime(watch.lastCheckAt)}${result ? ' · ' + result : ''}` : 'Not checked yet' }));
      if (watch.evidence !== null || watch.urls.length) {
        const latest = node('div', { className: 'watch-result' });
        if (watch.evidence !== null) latest.append(node('p', { className: 'watch-evidence', textContent: watch.evidence }));
        latest.append(...sourceLinks(watch.urls)); row.append(latest);
      }
      const controls = node('div', { className: 'watch-actions' });
      controls.append(watchButton(expanded.has(watch.id) ? 'Hide watch details' : 'Inspect watch', () => {
        if (renderedOwner !== ownerEpoch) return;
        if (expanded.has(watch.id)) expanded.delete(watch.id); else expanded.add(watch.id); renderWatches();
      }, false));
      if (['active', 'paused'].includes(watch.state)) {
        controls.append(watchButton(topic ? 'Edit watch' : 'Edit condition', () => openEditor(watch, renderedOwner), busy || Boolean(watchPending) || Boolean(watchDraft) || watchNeedsReview),
          watchButton(watch.state === 'paused' ? 'Resume watch' : 'Pause watch', () => {
            if (usable(watch, renderedOwner)) return mutateWatch({ requestId: requestId(), id: watch.id, expectedVersion: watch.version, operation: watch.state === 'paused' ? 'resume' : 'pause' }, renderedOwner);
          }, busy || Boolean(watchPending) || Boolean(watchDraft) || watchNeedsReview), watchButton('Cancel watch', () => {
            if (!usable(watch, renderedOwner)) return;
            watchConfirmation = { watch, owner: renderedOwner }; renderWatches();
          }, busy || Boolean(watchPending) || Boolean(watchDraft) || watchNeedsReview));
      }
      row.append(controls);
      if (expanded.has(watch.id)) {
        const details = node('div', { className: 'watch-details' });
        details.append(node('p', { textContent: `Last check: ${watch.lastCheckAt ? watchTime(watch.lastCheckAt) : 'Not checked yet'}` }),
          node('p', { textContent: `Last result: ${result ?? 'No result yet'}` }));
        if (watch.consecutiveStale) details.append(node('p', { textContent: `Consecutive checks unavailable: ${watch.consecutiveStale}` }));
        if (topic) {
          details.append(node('p', { textContent: watch.digests.length ? 'Recent digests:' : 'No digests yet.' }));
          for (const digest of watch.digests) {
            const item = node('div', { className: 'watch-digest' });
            item.append(node('small', { textContent: watchTime(digest.at) }), node('p', { textContent: digest.evidence }), ...sourceLinks(digest.urls));
            details.append(item);
          }
        }
        row.append(details);
      }
      if (watchConfirmation?.watch.id === watch.id) {
        const pinned = watchConfirmation;
        const confirmation = node('div', { className: 'watch-confirmation' }); confirmation.append(node('p', { textContent: `Cancel this watch: ${pinned.watch.condition}? A message already delivered cannot be undone.` }),
          watchButton('Confirm cancel watch', () => {
            if (watchConfirmation !== pinned || !usable(pinned.watch, pinned.owner)) return;
            return mutateWatch({ requestId: requestId(), id: pinned.watch.id, expectedVersion: pinned.watch.version, operation: 'cancel' }, pinned.owner);
          }, busy || Boolean(watchPending) || watchNeedsReview || watch.version !== pinned.watch.version),
          watchButton('Keep watch', () => { if (pinned.owner === ownerEpoch && !busy) { watchConfirmation = null; renderWatches(); } }, busy));
        if (watch.version !== pinned.watch.version) confirmation.append(node('p', { textContent: 'This watch changed. Close this confirmation and review it before cancelling.' })); row.append(confirmation);
      }
      watchRows.append(row);
    }
    if (watchDraft) {
      const draft = watchDraft, current = currentWatch(draft.id);
      if (!current || !['active', 'paused'].includes(current.state)) { draft.blocked = true; watchStatus.textContent = 'This watch is closed or unavailable. Your draft is kept; close it to review current watches.'; }
      draft.input.disabled = busy || Boolean(watchPending); draft.save.disabled = busy || Boolean(watchPending) || draft.blocked; draft.close.disabled = busy;
      if (watchEditor.children[0] !== draft.form) watchEditor.replaceChildren(draft.form);
    } else watchEditor.replaceChildren();
    watchActions.append(watchButton('Reload watches', () => { if (renderedOwner === ownerEpoch) return refresh(true); }, busy));
    if (watchPending && !busy) {
      const pending = watchPending;
      watchActions.append(watchButton('Retry same watch change', () => { if (pending === watchPending && pending.owner === ownerEpoch) return mutateWatch(null, pending.owner, pending); }, false),
        watchButton('Stop retrying watch change', () => {
          if (pending !== watchPending || pending.owner !== ownerEpoch) return;
          watchPending = null; watchNeedsReview = true; if (watchDraft) watchDraft.blocked = true;
          watchNotice = 'The change may already have applied. Review the current watch before starting another change.'; renderWatches();
        }, false));
    }
  }
  async function mutateWatch(input, owner, retry = null) {
    if (owner !== ownerEpoch || busy || (watchPending && retry !== watchPending)) return;
    const pending = retry ?? { owner, body: Object.freeze({ action: 'updateWatch', input: Object.freeze({ ...input }) }) };
    watchPending = pending; watchConfirmation = null; busy = true; watchNotice = ''; const current = ++generation; render();
    try {
      const next = await request(pending.body, owner);
      if (owner !== ownerEpoch || current !== generation) return;
      const returned = watchList(next.releaseWatches), selected = returned.find(watch => watch.id === pending.body.input.id);
      const { operation, condition } = pending.body.input;
      if (!selected || selected.version <= pending.body.input.expectedVersion ||
          (operation === 'edit' ? (condition !== undefined && selected.condition !== condition)
            || (pending.body.input.intervalHours !== undefined && selected.intervalHours !== pending.body.input.intervalHours) : selected.state !== ({ pause: 'paused', resume: 'active', cancel: 'cancelled' })[operation])) throw new Error('INVALID_WATCH_RESPONSE');
      accept(next); watchPending = null; watchDraft = null;
      watchNotice = 'Watch saved.'; $('announce').textContent = watchNotice;
    } catch (error) {
      if (owner !== ownerEpoch || current !== generation) return;
      if (error.status === 409 || error.status === 404) {
        watchPending = null; watchNeedsReview = true; if (watchDraft) watchDraft.blocked = true;
        watchNotice = watchDraft ? 'This watch changed. Your draft is kept. Reload release watches, then close the editor and review the current watch before trying again.' : 'This watch changed. Reload release watches and review its current state before trying again.';
        try { const next = await request({ action: 'list' }, owner); if (owner === ownerEpoch && current === generation) accept(next); }
        catch { if (owner === ownerEpoch && current === generation) watchNotice = 'This watch changed, but current watches could not be loaded. Reload to review them.'; }
      } else watchNotice = 'The watch change could not be confirmed. Retry only the same change, or reload to review its current state.';
    } finally { if (owner === ownerEpoch && current === generation) { busy = false; render(); } }
  }
  function render() {
    if (!schedules) return;
    const items = schedules.items.filter(item => item.canCancel || ['missed', 'interrupted', 'error'].includes(item.state));
    const cancellable = items.filter(item => item.canCancel).length;
    $('upcoming-count').textContent = cancellable ? `(${cancellable})` : '';
    $('schedule-list').replaceChildren();
    for (const item of items) {
      const row = document.createElement('li'), copy = document.createElement('div');
      const title = document.createElement('strong'), detail = document.createElement('small');
      title.textContent = item.text;
      let when;
      try { when = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short', timeZone: schedules.timezone }).format(new Date(item.dueAt)); }
      catch { when = 'Saved reminder'; }
      detail.textContent = item.canCancel ? when : `${when} · Not delivered`;
      copy.append(title, detail); row.append(copy);
      if (item.canCancel) {
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'button'; cancel.textContent = 'Cancel';
        cancel.setAttribute('aria-label', `Cancel reminder: ${item.text}`); cancel.disabled = busy;
        const owner = ownerEpoch;
        cancel.addEventListener('click', () => { if (owner === ownerEpoch) return change({ action: 'cancel', input: { id: item.id } }); }); row.append(cancel);
      }
      $('schedule-list').append(row);
    }
    $('schedule-note').textContent = message ?? (items.length ? 'Reminders wait until quiet hours end.' : 'Ask your companion to remind you of something.');
    $('schedule-settings').hidden = false;
    if (!dirty) {
      $('schedule-checkins').checked = schedules.settings.heartbeatEnabled;
      $('schedule-quiet-start').value = schedules.settings.quietStart;
      $('schedule-quiet-end').value = schedules.settings.quietEnd;
    }
    if ($('schedule-board')) $('schedule-board').hidden = !capOffered();
    if (capOffered() && !capEdited) {
      const cap = schedules.settings.boardWakeCap;
      $('schedule-board-unlimited').checked = cap === null;
      $('schedule-board-cap').value = cap === null ? '' : String(cap);
      $('schedule-board-cap').disabled = cap === null;
    }
    renderRoutines();
    renderWatches();
    $('schedule-zone').textContent = `Your timezone: ${schedules.timezone}. Daily and weekly times use this zone. Quiet hours can delay delivery. Occasional check-ins run at most every six hours and stay silent without a useful update.${capOffered() ? ' Board wakes per day limits how often your companion wakes to answer Board mentions in any 24 hours.' : ''}`;
    $('schedule-save').disabled = busy;
  }
  async function refresh(reviewWatches = false) {
    if (busy) return;
    const current = ++generation;
    try {
      const next = await request({ action: 'list' });
      if (current !== generation) return;
      accept(next);
      if (reviewWatches) { watchNeedsReview = false; watchNotice = watchDraft?.blocked ? 'Your draft is kept. Close the editor and review the current watch before starting a new edit.' : ''; }
      render();
    } catch {
      if (current === generation) $('schedule-note').textContent = 'I can’t load your reminders right now. Leave this tab and come back to try again.';
    }
  }
  async function change(body) {
    if (busy) return;
    busy = true; message = null;
    const current = ++generation, edited = editVersion, sentCap = capEdited;
    const sentRoutineEdits = routines.map(routine => [routine.key, new Map(Object.keys(body.input?.[routine.key] ?? {})
      .map(field => [field, routineEdits.get(routine.key).get(field)]))]);
    render();
    try {
      const next = await request(body);
      if (current === generation) {
        accept(next);
        if (body.action === 'configure') {
          if (edited === editVersion) dirty = false;
          if (sentCap && capEdited === sentCap) capEdited = 0;
          for (const [key, sent] of sentRoutineEdits) for (const [field, token] of sent) {
            if (routineEdits.get(key).get(field) === token) routineEdits.get(key).delete(field);
          }
        }
        $('announce').textContent = body.action === 'cancel' ? 'Reminder cancelled.' : 'Reminder preferences saved.';
      }
    } catch {
      if (current === generation) message = 'I couldn’t confirm that change. Leave this tab and come back to check its current state.';
    } finally {
      // A cleared or superseded request cannot unlock a newer owner's mutation.
      if (current === generation) { busy = false; render(); }
    }
  }

  $('upcoming').addEventListener('toggle', () => {
    if ($('upcoming').open) { message = null; return refresh(); }
  });
  for (const id of ['schedule-checkins', 'schedule-quiet-start', 'schedule-quiet-end']) {
    $(id).addEventListener('input', () => { dirty = true; editVersion++; });
  }
  for (const id of ['schedule-board-cap', 'schedule-board-unlimited']) $(id)?.addEventListener('input', () => {
    capEdited = ++editVersion;
    $('schedule-board-cap').disabled = $('schedule-board-unlimited').checked;
  });
  for (const routine of routines) for (const [field, id] of Object.entries(routine.fields)) {
    $(id)?.addEventListener('input', () => {
      if (!supported.has(routine.key)) return;
      routineEdits.get(routine.key).set(field, ++editVersion); renderRoutines();
    });
  }
  $('schedule-settings').addEventListener('submit', event => {
    event.preventDefault();
    const input = { heartbeatEnabled: $('schedule-checkins').checked,
      quietStart: $('schedule-quiet-start').value, quietEnd: $('schedule-quiet-end').value };
    for (const routine of routines) {
      if (!supported.has(routine.key) || !routineEdits.get(routine.key).size) continue;
      input[routine.key] = Object.fromEntries([...routineEdits.get(routine.key).keys()].map(field => [field,
        field === 'enabled' ? $(routine.fields[field]).checked : field === 'weekday' ? Number($(routine.fields[field]).value) : $(routine.fields[field]).value]));
    }
    if (capEdited && capOffered()) {
      const unlimited = $('schedule-board-unlimited').checked, cap = Number($('schedule-board-cap').value);
      if (!unlimited && !(Number.isInteger(cap) && cap >= 1 && cap <= 10000)) {
        message = 'Board wakes per day must be a whole number from 1 to 10000, or choose No limit.'; render(); return;
      }
      input.boardWakeCap = unlimited ? null : cap;
    }
    return change({ action: 'configure', input });
  });
  const isOpen = () => visible() || $('upcoming').open;
  return Object.freeze({ clear, refresh, show: () => { message = null; return refresh(); },
    refreshIfOpen: () => isOpen() && !busy ? refresh() : Promise.resolve() });
}
