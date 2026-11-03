// The calendar (#44) on the Calendar tab: a week view and an agenda, an event editor, and the French public
// holidays switch. Events and holidays come from /api/schedules (src/calendar.mjs); identity stays in the session.
const DAY = 86400000;
const REMINDERS = [[null, 'No reminder'], [0, 'When it starts'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before'],
  [120, '2 hours before'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];
const addDays = (key, days) => new Date(Date.parse(key + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
const weekday = key => (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7;            // Monday 0 … Sunday 6
const dayLabel = (key, options = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
export function reminderLabel(minutes, allDay = false) {
  if (minutes === null || minutes === undefined) return '';
  const known = REMINDERS.find(([value]) => value === minutes)?.[1];
  const text = known ?? (minutes % 1440 === 0 ? `${minutes / 1440} days before` : minutes % 60 === 0 ? `${minutes / 60} hours before` : `${minutes} minutes before`);
  return allDay && minutes === 0 ? 'At 09:00' : text;
}
// "14:00–15:30", "All day", or a span across days.
export function timeLabel(item) {
  if (item.holiday) return 'Holiday';
  if (item.allDay) return 'All day';
  const start = item.start.slice(11);
  if (!item.end) return start;
  return item.end.slice(0, 10) === item.start.slice(0, 10) ? `${start}–${item.end.slice(11)}` : `${start} → ${dayLabel(item.end.slice(0, 10))} ${item.end.slice(11)}`;
}

export function createCalendarUI({ document, fetchImpl = fetch, requestId = () => globalThis.crypto?.randomUUID?.() ?? 'ev-' + Date.now().toString(36) + Math.random().toString(36).slice(2), visible = () => false }) {
  const $ = id => document.getElementById(id), node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const home = $('calendar-home');
  if (!home) return { show: async () => {}, clear() {}, refreshIfOpen: async () => {} };
  let mode = 'week', from = null, today = null, data = null, busy = false, draft = null, notice = '', epoch = 0;

  const heading = node('h2', { textContent: 'Calendar' });
  const bar = node('div', { className: 'cal-bar' });
  const prev = node('button', { type: 'button', className: 'cal-nav', textContent: '‹' }), next = node('button', { type: 'button', className: 'cal-nav', textContent: '›' });
  prev.setAttribute('aria-label', 'Previous week'); next.setAttribute('aria-label', 'Next week');
  const range = node('span', { className: 'cal-range' }), todayButton = node('button', { type: 'button', textContent: 'Today' });
  const modes = node('div', { className: 'cal-modes', role: 'group' });
  const weekButton = node('button', { type: 'button', textContent: 'Week' }), agendaButton = node('button', { type: 'button', textContent: 'Agenda' });
  modes.append(weekButton, agendaButton);
  const add = node('button', { type: 'button', className: 'cal-add', textContent: 'Add event' });
  bar.append(prev, range, next, todayButton, modes, add);
  const status = node('p', { className: 'cal-notice' }); status.setAttribute('role', 'status');
  const editor = node('div'), list = node('div', { className: 'cal-days' });
  const holidayLabel = node('label', { className: 'cal-holidays' }), holidays = node('input', { type: 'checkbox' });
  holidayLabel.append(holidays, document.createTextNode(' Show French public holidays'));
  home.append(heading, bar, status, editor, list, holidayLabel);
  home.hidden = true;

  async function call(body) {
    const owner = epoch;
    const response = await fetchImpl('api/schedules', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let result = null;
    try { result = await response.json(); } catch { /* below */ }
    if (owner !== epoch) throw new Error('STALE');
    if (!response.ok) { const error = new Error(result?.error?.code ?? 'CALENDAR_UNAVAILABLE'); error.status = response.status; error.text = result?.error?.message; throw error; }
    return result;
  }
  const span = () => mode === 'week' ? 7 : 60;
  async function load() {
    if (!today) { const first = await call({ action: 'calendar', input: { days: 1 } }); today = first.today; }
    if (!from) from = mode === 'week' ? addDays(today, -weekday(today)) : today;
    data = await call({ action: 'calendar', input: { from, days: span() } });
    render();
  }
  async function refresh() {
    try { await load(); }
    catch (error) { if (error.message === 'STALE') return; notice = error.text ?? 'The calendar is unavailable right now.'; render(); }
  }

  function item(entry) {
    const li = node('li', { className: 'cal-item' + (entry.holiday ? ' holiday' : '') });
    const time = node('span', { className: 'cal-time', textContent: timeLabel(entry) });
    const body = node('div', { className: 'cal-body' });
    const title = node('strong', { textContent: entry.title });
    body.append(title);
    const until = entry.allDay && entry.end && entry.end !== entry.start ? `${dayLabel(entry.start)} – ${dayLabel(entry.end)}` : null;
    const extras = [until, entry.location, entry.yearly ? 'Every year' : null,
      entry.reminderMinutes != null ? 'Reminder ' + reminderLabel(entry.reminderMinutes, entry.allDay).toLowerCase() : null].filter(Boolean);
    if (extras.length) body.append(node('span', { className: 'cal-extra', textContent: extras.join(' · ') }));
    li.append(time, body);
    if (!entry.holiday) {
      const edit = node('button', { type: 'button', className: 'cal-edit', textContent: 'Edit', disabled: busy || Boolean(draft) });
      edit.setAttribute('aria-label', `Edit ${entry.title}`);
      edit.addEventListener('click', () => { const event = data.events.find(value => value.id === entry.eventId); if (event) openEditor(event); });
      li.append(edit);
    }
    return li;
  }
  function render() {
    home.hidden = false;
    status.textContent = notice;
    weekButton.setAttribute('aria-pressed', String(mode === 'week')); agendaButton.setAttribute('aria-pressed', String(mode === 'agenda'));
    prev.hidden = next.hidden = mode !== 'week';
    for (const button of [prev, next, todayButton, weekButton, agendaButton, add]) button.disabled = busy || Boolean(draft) || !data;
    holidays.disabled = busy || !data; holidays.checked = Boolean(data?.holidaysFr);
    if (!data) { list.replaceChildren(); range.textContent = ''; return; }
    range.textContent = mode === 'week' ? `${dayLabel(data.from, { day: 'numeric', month: 'short' })} – ${dayLabel(addDays(data.from, 6), { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Next 60 days';
    const byDay = new Map();
    for (const entry of data.occurrences) {
      // A multi-day event shows on each of its days inside the range.
      const last = (entry.end ?? entry.start).slice(0, 10);
      for (let day = entry.date < data.from ? data.from : entry.date; day <= last && day < addDays(data.from, data.days); day = addDays(day, 1)) {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(entry);
        if (!entry.allDay) break;
      }
    }
    const days = mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(data.from, i)) : [...byDay.keys()].sort();
    const blocks = days.map(day => {
      const block = node('section', { className: 'cal-day' + (day === data.today ? ' today' : '') });
      const title = node('h3', { textContent: dayLabel(day, { weekday: 'long', day: 'numeric', month: 'long' }) });
      if (day === data.today) title.append(node('span', { className: 'cal-today', textContent: 'Today' }));
      block.append(title);
      const entries = byDay.get(day) ?? [];
      if (entries.length) { const ul = node('ul'); ul.append(...entries.map(item)); block.append(ul); }
      else block.append(node('p', { className: 'cal-empty', textContent: 'Nothing planned' }));
      return block;
    });
    if (!blocks.length) blocks.push(node('p', { className: 'cal-empty', textContent: 'Nothing in the next 60 days. Add an event, or ask your companion in chat.' }));
    list.replaceChildren(...blocks);
  }

  function field(labelText, input) { const label = node('label', { className: 'cal-field' }); label.append(node('span', { textContent: labelText }), input); return label; }
  function openEditor(event = null) {
    notice = '';
    const start = event?.start ?? (data?.today ?? today);
    draft = { id: event?.id ?? null, version: event?.version ?? null, requestId: requestId() };
    const form = node('form', { className: 'cal-editor' });
    const title = node('input', { type: 'text', maxLength: 200, required: true, value: event?.title ?? '' });
    const allDay = node('input', { type: 'checkbox', checked: event ? event.allDay : false });
    const date = node('input', { type: 'date', required: true, value: start.slice(0, 10) });
    const time = node('input', { type: 'time', value: event && !event.allDay ? start.slice(11) : '09:00' });
    const endDate = node('input', { type: 'date', value: event?.end ? event.end.slice(0, 10) : '' });
    const endTime = node('input', { type: 'time', value: event?.end && !event.allDay ? event.end.slice(11) : '' });
    const location = node('input', { type: 'text', maxLength: 200, value: event?.location ?? '' });
    const notes = node('textarea', { maxLength: 1000, rows: 2, value: event?.notes ?? '' });
    const yearly = node('input', { type: 'checkbox', checked: Boolean(event?.yearly) });
    const reminder = node('select');
    for (const [value, label] of REMINDERS) reminder.append(node('option', { value: value === null ? '' : String(value), textContent: label }));
    const custom = event?.reminderMinutes != null && !REMINDERS.some(([value]) => value === event.reminderMinutes);
    if (custom) reminder.append(node('option', { value: String(event.reminderMinutes), textContent: reminderLabel(event.reminderMinutes) }));
    reminder.value = event?.reminderMinutes == null ? '' : String(event.reminderMinutes);
    const allDayLabel = node('label', { className: 'cal-check' }); allDayLabel.append(allDay, document.createTextNode(' All day'));
    const yearlyLabel = node('label', { className: 'cal-check' }); yearlyLabel.append(yearly, document.createTextNode(' Every year'));
    const sync = () => { time.hidden = endTime.hidden = allDay.checked; time.required = !allDay.checked; };
    allDay.addEventListener('change', sync); sync();
    const startRow = node('div', { className: 'cal-row' }); startRow.append(field('Date', date), field('Time', time));
    const endRow = node('div', { className: 'cal-row' }); endRow.append(field('Ends (optional)', endDate), field('End time', endTime));
    const actions = node('div', { className: 'cal-actions' });
    const save = node('button', { type: 'submit', textContent: event ? 'Save event' : 'Add event' });
    const cancel = node('button', { type: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => { draft = null; editor.replaceChildren(); render(); });
    actions.append(save, cancel);
    if (event) {
      const remove = node('button', { type: 'button', className: 'danger', textContent: 'Delete' });
      remove.addEventListener('click', async () => {
        if (!globalThis.confirm?.(event.yearly ? `Delete “${event.title}” for every year?` : `Delete “${event.title}”?`)) return;
        await mutate({ action: 'deleteEvent', input: { id: event.id } }, 'Event deleted.');
      });
      actions.append(remove);
    }
    form.append(field('Title', title), allDayLabel, startRow, endRow, field('Location', location), field('Notes', notes),
      yearlyLabel, field('Reminder', reminder), actions);
    form.addEventListener('submit', async submit => {
      submit.preventDefault();
      const whole = allDay.checked, startValue = whole ? date.value : `${date.value}T${time.value}`;
      let end = null;
      if (endDate.value || (!whole && endTime.value)) end = whole ? endDate.value : `${endDate.value || date.value}T${endTime.value || time.value}`;
      if (end && end < startValue) { notice = 'The end is before the start.'; status.textContent = notice; return; }
      const value = { title: title.value, allDay: whole, start: startValue, end, location: location.value || null, notes: notes.value || null,
        yearly: yearly.checked, reminderMinutes: reminder.value === '' ? null : Number(reminder.value) };
      await mutate(event ? { action: 'updateEvent', input: { id: event.id, expectedVersion: event.version, event: value } }
        : { action: 'createEvent', input: { requestId: draft.requestId, event: value } }, event ? 'Event saved.' : 'Event added.');
    });
    editor.replaceChildren(form);
    render();
    title.focus?.();
  }
  async function mutate(body, done) {
    busy = true; render();
    try {
      await call(body);
      draft = null; editor.replaceChildren(); notice = done;
      await load();
    } catch (error) {
      if (error.message === 'STALE') return;
      notice = error.text ?? 'The calendar could not save this. Try again.';
      if (error.message === 'CALENDAR_CONFLICT' || error.status === 404) { draft = null; editor.replaceChildren(); await load().catch(() => {}); }
    } finally { busy = false; render(); }
  }

  prev.addEventListener('click', () => { from = addDays(from, -7); notice = ''; void refresh(); });
  next.addEventListener('click', () => { from = addDays(from, 7); notice = ''; void refresh(); });
  todayButton.addEventListener('click', () => { from = null; notice = ''; void refresh(); });
  weekButton.addEventListener('click', () => { if (mode !== 'week') { mode = 'week'; from = null; void refresh(); } });
  agendaButton.addEventListener('click', () => { if (mode !== 'agenda') { mode = 'agenda'; from = null; void refresh(); } });
  add.addEventListener('click', () => openEditor());
  holidays.addEventListener('change', async () => {
    busy = true; render();
    try { await call({ action: 'calendarSettings', input: { holidaysFr: holidays.checked } }); await load(); }
    catch (error) { if (error.message !== 'STALE') notice = 'Could not change this setting.'; }
    finally { busy = false; render(); }
  });

  return {
    async show() { if (visible()) await refresh(); },
    async refreshIfOpen() { if (visible() && !draft && !busy) await refresh(); },
    clear() { epoch++; data = null; today = null; from = null; draft = null; busy = false; notice = ''; editor.replaceChildren(); list.replaceChildren(); home.hidden = true; }
  };
}
