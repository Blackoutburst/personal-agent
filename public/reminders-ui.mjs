// The ongoing chat's Upcoming controls. Identity remains in the authenticated API.
export function createRemindersUI({ document, fetchImpl = fetch }) {
  const $ = id => document.getElementById(id);
  let schedules = null, generation = 0, busy = false, message = null, dirty = false, editVersion = 0;
  const routines = [
    { key: 'dailyDigest', row: 'schedule-daily', fields: { enabled: 'schedule-daily-enabled', localTime: 'schedule-daily-time' } },
    { key: 'weeklyCheckin', row: 'schedule-weekly', fields: { enabled: 'schedule-weekly-enabled', localTime: 'schedule-weekly-time', weekday: 'schedule-weekly-day' } }
  ];
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

  async function request(body) {
    const response = await fetchImpl('api/schedules', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 401 || response.status === 403) clear();
    if (!response.ok) throw new Error('Reminders could not be loaded.');
    return response.json();
  }
  function clear() {
    generation++; schedules = null; busy = false; dirty = false; editVersion++; message = null;
    $('schedule-list').replaceChildren(); $('upcoming-count').textContent = '';
    $('schedule-note').textContent = 'Sign in to see your reminders.';
    $('schedule-checkins').checked = false; $('schedule-quiet-start').value = ''; $('schedule-quiet-end').value = '';
    $('schedule-zone').textContent = ''; $('schedule-save').disabled = true; $('schedule-settings').hidden = true;
    routines.forEach(clearRoutine);
    $('upcoming').open = false;
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
        cancel.addEventListener('click', () => change({ action: 'cancel', input: { id: item.id } })); row.append(cancel);
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
    renderRoutines();
    $('schedule-zone').textContent = `Your timezone: ${schedules.timezone}. Daily and weekly times use this zone. Quiet hours can delay delivery. Occasional check-ins run at most every six hours and stay silent without a useful update.`;
    $('schedule-save').disabled = busy;
  }
  async function refresh() {
    if (busy) return;
    const current = ++generation;
    try {
      const next = await request({ action: 'list' });
      if (current !== generation) return;
      schedules = next; render();
    } catch {
      if (current === generation) $('schedule-note').textContent = 'I can’t load your reminders right now. Close and reopen Upcoming to try again.';
    }
  }
  async function change(body) {
    if (busy) return;
    busy = true; message = null;
    const current = ++generation, edited = editVersion;
    const sentRoutineEdits = routines.map(routine => [routine.key, new Map(Object.keys(body.input?.[routine.key] ?? {})
      .map(field => [field, routineEdits.get(routine.key).get(field)]))]);
    render();
    try {
      const next = await request(body);
      if (current === generation) {
        schedules = next;
        if (body.action === 'configure') {
          if (edited === editVersion) dirty = false;
          for (const [key, sent] of sentRoutineEdits) for (const [field, token] of sent) {
            if (routineEdits.get(key).get(field) === token) routineEdits.get(key).delete(field);
          }
        }
        $('announce').textContent = body.action === 'cancel' ? 'Reminder cancelled.' : 'Reminder preferences saved.';
      }
    } catch {
      if (current === generation) message = 'I couldn’t confirm that change. Reopen Upcoming to check its current state.';
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
    return change({ action: 'configure', input });
  });
  return Object.freeze({ clear, refresh, refreshIfOpen: () => $('upcoming').open && !busy ? refresh() : Promise.resolve() });
}
