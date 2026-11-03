// The calendar (#44, month grid #47) on the Calendar tab: a Monday-first month grid with event chips, multi-day bars,
// the selected day's events, an event editor and the French public holidays switch. Events and holidays come from
// /api/schedules (src/calendar.mjs); identity stays in the session. The look is the app's own theme.
const DAY = 86400000, ROWS = 3;
const REMINDERS = [[null, 'No reminder'], [0, 'When it starts'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before'],
  [120, '2 hours before'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];
export const REPEATS = [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const addDays = (key, days) => new Date(Date.parse(key + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
const between = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const weekday = key => (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7;            // Monday 0 … Sunday 6
const dayLabel = (key, options = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
const monthTitle = month => dayLabel(month + '-01', { month: 'long', year: 'numeric' });
const shiftMonth = (month, by) => { const [y, m] = month.split('-').map(Number), index = y * 12 + m - 1 + by; return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`; };
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
const lastDay = item => (item.end ?? item.start).slice(0, 10);
const multiDay = item => !item.holiday && lastDay(item) > item.date;
const repeatLabel = repeat => repeat && repeat !== 'none' ? REPEATS.find(([value]) => value === repeat)?.[1] : null;

// One week row of the grid: multi-day bars in lanes (as segments clipped to the week) and single-day items per day.
// visible: how many lines a day tile shows; the rest is counted in "+N".
export function weekLayout(days, occurrences, visible = ROWS) {
  const first = days[0], last = days[6];
  const bars = occurrences.filter(item => multiDay(item) && item.date <= last && lastDay(item) >= first)
    .map(item => ({ item, from: Math.max(0, between(first, item.date)), to: Math.min(6, between(first, lastDay(item))) }))
    .sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || a.item.title.localeCompare(b.item.title));
  const lanes = [];
  for (const bar of bars) {
    let lane = lanes.findIndex(end => end < bar.from);
    if (lane < 0) { lane = lanes.length; lanes.push(-1); }
    lanes[lane] = bar.to; bar.lane = lane;
    bar.continuesBefore = bar.item.date < first; bar.continuesAfter = lastDay(bar.item) > last;
  }
  const shownLanes = Math.min(lanes.length, visible);
  const cells = days.map((day, index) => {
    const singles = occurrences.filter(item => !multiDay(item) && item.date === day);
    const hiddenBars = bars.filter(bar => bar.lane >= shownLanes && bar.from <= index && bar.to >= index).length;
    const room = Math.max(0, visible - shownLanes);
    const fits = singles.length + hiddenBars <= room;
    const chips = fits ? singles : singles.slice(0, Math.max(0, room - 1));
    return { day, chips, more: singles.length - chips.length + hiddenBars };
  });
  return { bars: bars.filter(bar => bar.lane < shownLanes), lanes: shownLanes, cells };
}

export function createCalendarUI({ document, fetchImpl = fetch, requestId = () => globalThis.crypto?.randomUUID?.() ?? 'ev-' + Date.now().toString(36) + Math.random().toString(36).slice(2), visible = () => false }) {
  const $ = id => document.getElementById(id), node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const home = $('calendar-home');
  if (!home) return { show: async () => {}, clear() {}, refreshIfOpen: async () => {} };
  let month = null, selected = null, today = null, data = null, busy = false, draft = null, notice = '', epoch = 0;

  const bar = node('div', { className: 'cal-bar' });
  const title = node('h2', { className: 'cal-month' });
  const prev = node('button', { type: 'button', className: 'cal-nav', textContent: '‹' }), next = node('button', { type: 'button', className: 'cal-nav', textContent: '›' });
  prev.setAttribute('aria-label', 'Previous month'); next.setAttribute('aria-label', 'Next month');
  const todayButton = node('button', { type: 'button', className: 'cal-today-button', textContent: 'Today' });
  bar.append(title, prev, next, todayButton);
  const status = node('p', { className: 'cal-notice' }); status.setAttribute('role', 'status');
  const head = node('div', { className: 'cal-weekdays' });
  head.append(...WEEKDAYS.map(name => node('span', { textContent: name })));
  const grid = node('div', { className: 'cal-grid' });
  const panel = node('section', { className: 'cal-panel' }); panel.setAttribute('aria-live', 'polite');
  const holidayLabel = node('label', { className: 'cal-holidays' }), holidays = node('input', { type: 'checkbox' });
  holidayLabel.append(holidays, document.createTextNode(' Show French public holidays'));
  const fab = node('button', { type: 'button', className: 'cal-fab', textContent: '+' });
  fab.setAttribute('aria-label', 'Add an event');
  const sheet = node('div', { className: 'cal-sheet', hidden: true });
  home.append(bar, status, head, grid, panel, holidayLabel, fab, sheet);
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
  // The grid: from the Monday on or before the 1st, whole weeks to the Sunday on or after the month's last day.
  const gridRange = () => {
    const first = month + '-01', from = addDays(first, -weekday(first)), end = addDays(shiftMonth(month, 1) + '-01', -1);
    return { from, days: between(from, addDays(end, 6 - weekday(end))) + 1 };
  };
  async function load() {
    if (!today) { const first = await call({ action: 'calendar', input: { days: 1 } }); today = first.today; }
    if (!month) month = today.slice(0, 7);
    if (!selected) selected = today;
    data = await call({ action: 'calendar', input: gridRange() });
    render();
  }
  async function refresh() {
    try { await load(); }
    catch (error) { if (error.message === 'STALE') return; notice = error.text ?? 'The calendar is unavailable right now.'; render(); }
  }
  // Changing month selects the given day, else today when it is in that month, else the 1st.
  const go = (nextMonth, day = null) => { month = nextMonth; selected = day ?? (today?.slice(0, 7) === nextMonth ? today : nextMonth + '-01'); notice = ''; void refresh(); };
  const eventOf = entry => data?.events.find(value => value.id === entry.eventId);
  const open = entry => { if (entry.holiday || busy) return; const event = eventOf(entry); if (event) openEditor(event); };

  function chip(entry, className = 'cal-chip') {
    const button = node('button', { type: 'button', className: className + (entry.holiday ? ' holiday' : entry.allDay ? ' all-day' : ' timed') });
    if (!entry.allDay && !entry.holiday) button.append(node('span', { className: 'cal-chip-time', textContent: entry.start.slice(11) }));
    button.append(node('span', { className: 'cal-chip-title', textContent: entry.title }));
    button.title = `${entry.title} · ${timeLabel(entry)}`;
    button.setAttribute('aria-label', `${entry.title}, ${timeLabel(entry)}${entry.holiday ? '' : ', open'}`);
    button.addEventListener('click', click => { click.stopPropagation(); if (entry.holiday) { selected = entry.date < data.from ? data.from : entry.date; render(); } else open(entry); });
    return button;
  }
  function renderGrid() {
    const days = Array.from({ length: data.days }, (_, i) => addDays(data.from, i));
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) {
      const week = days.slice(i, i + 7), layout = weekLayout(week, data.occurrences);
      const row = node('div', { className: 'cal-week' });
      row.style.gridTemplateRows = layout.lanes ? `auto repeat(${layout.lanes}, var(--cal-line)) 1fr` : "auto 1fr";
      week.forEach((day, index) => {
        const tile = node('button', { type: 'button', className: 'cal-tile' + (day.slice(0, 7) !== month ? ' other' : '')
          + (day === data.today ? ' today' : '') + (day === selected ? ' selected' : '') });
        tile.style.gridColumn = String(index + 1); tile.style.gridRow = '1 / -1';
        tile.setAttribute('aria-label', dayLabel(day, { weekday: 'long', day: 'numeric', month: 'long' }) + (day === data.today ? ', today' : ''));
        tile.addEventListener('click', () => { selected = day; if (day.slice(0, 7) !== month) go(day.slice(0, 7), day); else render(); panel.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); });
        const number = node('span', { className: 'cal-date', textContent: String(Number(day.slice(8))) });
        row.append(tile, Object.assign(number, { style: `grid-column:${index + 1};grid-row:1` }));
      });
      for (const segment of layout.bars) {
        const element = chip(segment.item, 'cal-span' + (segment.continuesBefore ? ' before' : '') + (segment.continuesAfter ? ' after' : ''));
        element.style.gridColumn = `${segment.from + 1} / ${segment.to + 2}`; element.style.gridRow = String(segment.lane + 2);
        if (week[0].slice(0, 7) !== month && week[6].slice(0, 7) !== month) element.classList?.add('other');
        row.append(element);
      }
      layout.cells.forEach((cell, index) => {
        const box = node('div', { className: 'cal-cell' + (cell.day.slice(0, 7) !== month ? ' other' : '') });
        box.style.gridColumn = String(index + 1); box.style.gridRow = String(layout.lanes + 2);
        box.append(...cell.chips.map(entry => chip(entry)));
        if (cell.more) {
          const more = node('button', { type: 'button', className: 'cal-more', textContent: `+${cell.more}` });
          more.setAttribute('aria-label', `${cell.more} more on ${dayLabel(cell.day, { day: 'numeric', month: 'long' })}`);
          more.addEventListener('click', click => { click.stopPropagation(); selected = cell.day; render(); panel.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); });
          box.append(more);
        }
        row.append(box);
      });
      weeks.push(row);
    }
    grid.style.setProperty?.('--cal-weeks', String(weeks.length));
    grid.replaceChildren(...weeks);
  }
  function renderPanel() {
    if (!selected || !data) { panel.replaceChildren(); return; }
    const entries = data.occurrences.filter(item => item.date <= selected && lastDay(item) >= selected);
    const heading = node('h3', { textContent: dayLabel(selected, { weekday: 'long', day: 'numeric', month: 'long' }) });
    if (selected === data.today) heading.append(node('span', { className: 'cal-badge', textContent: 'Today' }));
    const list = node('ul', { className: 'cal-list' });
    for (const entry of entries) {
      const li = node('li', { className: 'cal-item' + (entry.holiday ? ' holiday' : '') });
      const body = node('div', { className: 'cal-body' });
      body.append(node('strong', { textContent: entry.title }));
      const span = multiDay(entry) ? `${dayLabel(entry.date)} – ${dayLabel(lastDay(entry))}` : null;
      const extras = [timeLabel(entry), span, entry.location, repeatLabel(entry.repeat ?? (entry.yearly ? 'yearly' : 'none')),
        entry.reminderMinutes != null ? 'Reminder ' + reminderLabel(entry.reminderMinutes, entry.allDay).toLowerCase() : null].filter(Boolean);
      body.append(node('span', { className: 'cal-extra', textContent: extras.join(' · ') }));
      li.append(body);
      if (!entry.holiday) {
        const edit = node('button', { type: 'button', className: 'cal-edit', textContent: 'Edit', disabled: busy });
        edit.setAttribute('aria-label', `Edit ${entry.title}`);
        edit.addEventListener('click', () => open(entry));
        li.append(edit);
      }
      list.append(li);
    }
    const add = node('button', { type: 'button', className: 'cal-add', textContent: 'Add an event on this day', disabled: busy });
    add.addEventListener('click', () => openEditor(null, selected));
    panel.replaceChildren(heading, entries.length ? list : node('p', { className: 'cal-empty', textContent: 'Nothing planned.' }), add);
  }
  function render() {
    home.hidden = false;
    status.textContent = notice;
    title.textContent = month ? monthTitle(month) : 'Calendar';
    for (const button of [prev, next, todayButton, fab]) button.disabled = busy || !data;
    holidays.disabled = busy || !data; holidays.checked = Boolean(data?.holidaysFr);
    if (!data) { grid.replaceChildren(); panel.replaceChildren(); return; }
    renderGrid(); renderPanel();
  }

  function field(labelText, input) { const label = node('label', { className: 'cal-field' }); label.append(node('span', { textContent: labelText }), input); return label; }
  function closeEditor() { draft = null; sheet.hidden = true; sheet.replaceChildren(); render(); }
  function openEditor(event = null, day = null) {
    notice = '';
    const start = event?.start ?? (day ?? selected ?? data?.today ?? today);
    draft = { id: event?.id ?? null, version: event?.version ?? null, requestId: requestId() };
    const form = node('form', { className: 'cal-editor' });
    form.setAttribute('role', 'dialog'); form.setAttribute('aria-label', event ? 'Edit event' : 'New event');
    const heading = node('h3', { textContent: event ? 'Edit event' : 'New event' });
    const name = node('input', { type: 'text', maxLength: 200, required: true, value: event?.title ?? '', placeholder: 'Title' });
    const allDay = node('input', { type: 'checkbox', checked: event ? event.allDay : false });
    const date = node('input', { type: 'date', required: true, value: start.slice(0, 10) });
    const time = node('input', { type: 'time', value: event && !event.allDay ? start.slice(11) : '09:00' });
    const endDate = node('input', { type: 'date', value: event?.end ? event.end.slice(0, 10) : '' });
    const endTime = node('input', { type: 'time', value: event?.end && !event.allDay ? event.end.slice(11) : '' });
    const location = node('input', { type: 'text', maxLength: 200, value: event?.location ?? '' });
    const notes = node('textarea', { maxLength: 1000, rows: 2, value: event?.notes ?? '' });
    const repeat = node('select');
    for (const [value, label] of REPEATS) repeat.append(node('option', { value, textContent: label }));
    repeat.value = event?.repeat ?? (event?.yearly ? 'yearly' : 'none');
    const reminder = node('select');
    for (const [value, label] of REMINDERS) reminder.append(node('option', { value: value === null ? '' : String(value), textContent: label }));
    const custom = event?.reminderMinutes != null && !REMINDERS.some(([value]) => value === event.reminderMinutes);
    if (custom) reminder.append(node('option', { value: String(event.reminderMinutes), textContent: reminderLabel(event.reminderMinutes) }));
    reminder.value = event?.reminderMinutes == null ? '' : String(event.reminderMinutes);
    const allDayLabel = node('label', { className: 'cal-check' }); allDayLabel.append(allDay, document.createTextNode(' All day'));
    const sync = () => { time.hidden = endTime.hidden = allDay.checked; time.required = !allDay.checked; };
    allDay.addEventListener('change', sync); sync();
    const startRow = node('div', { className: 'cal-row' }); startRow.append(field('Date', date), field('Time', time));
    const endRow = node('div', { className: 'cal-row' }); endRow.append(field('Ends (optional)', endDate), field('End time', endTime));
    const optionRow = node('div', { className: 'cal-row' }); optionRow.append(field('Repeat', repeat), field('Reminder', reminder));
    const formNotice = node('p', { className: 'cal-notice' }); formNotice.setAttribute('role', 'status');
    const actions = node('div', { className: 'cal-actions' });
    const save = node('button', { type: 'submit', className: 'cal-save', textContent: event ? 'Save' : 'Add event' });
    const cancel = node('button', { type: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', closeEditor);
    actions.append(save, cancel);
    if (event) {
      const remove = node('button', { type: 'button', className: 'danger', textContent: 'Delete' });
      remove.addEventListener('click', async () => {
        const repeating = (event.repeat ?? (event.yearly ? 'yearly' : 'none')) !== 'none';
        if (!globalThis.confirm?.(repeating ? `Delete “${event.title}” and all its repeats?` : `Delete “${event.title}”?`)) return;
        await mutate({ action: 'deleteEvent', input: { id: event.id } }, 'Event deleted.', formNotice);
      });
      actions.append(remove);
    }
    form.append(heading, field('Title', name), allDayLabel, startRow, endRow, optionRow, field('Location', location), field('Notes', notes), formNotice, actions);
    form.addEventListener('submit', async submit => {
      submit.preventDefault();
      const whole = allDay.checked, startValue = whole ? date.value : `${date.value}T${time.value}`;
      let end = null;
      if (endDate.value || (!whole && endTime.value)) end = whole ? endDate.value : `${endDate.value || date.value}T${endTime.value || time.value}`;
      if (end && end < startValue) { formNotice.textContent = 'The end is before the start.'; return; }
      const value = { title: name.value, allDay: whole, start: startValue, end, location: location.value || null, notes: notes.value || null,
        repeat: repeat.value, reminderMinutes: reminder.value === '' ? null : Number(reminder.value) };
      selected = date.value;
      await mutate(event ? { action: 'updateEvent', input: { id: event.id, expectedVersion: event.version, event: value } }
        : { action: 'createEvent', input: { requestId: draft.requestId, event: value } }, event ? 'Event saved.' : 'Event added.', formNotice);
    });
    const backdrop = node('div', { className: 'cal-backdrop' });
    backdrop.addEventListener('click', closeEditor);
    sheet.replaceChildren(backdrop, form);
    sheet.hidden = false;
    render();
    name.focus?.();
  }
  async function mutate(body, done, formNotice) {
    busy = true; render();
    try {
      await call(body);
      draft = null; sheet.hidden = true; sheet.replaceChildren(); notice = done;
      if (selected && selected.slice(0, 7) !== month) month = selected.slice(0, 7);
      await load();
    } catch (error) {
      if (error.message === 'STALE') return;
      const text = error.text ?? 'The calendar could not save this. Try again.';
      if (error.message === 'CALENDAR_CONFLICT' || error.status === 404) { draft = null; sheet.hidden = true; sheet.replaceChildren(); notice = text; await load().catch(() => {}); }
      else if (formNotice) formNotice.textContent = text;
      else notice = text;
    } finally { busy = false; render(); }
  }

  prev.addEventListener('click', () => go(shiftMonth(month, -1)));
  next.addEventListener('click', () => go(shiftMonth(month, 1)));
  todayButton.addEventListener('click', () => { selected = today; go(today.slice(0, 7)); });
  fab.addEventListener('click', () => openEditor(null, selected));
  // Swipe left or right on the grid for the next or previous month.
  let touch = null;
  grid.addEventListener('touchstart', event => { const point = event.touches?.[0]; touch = point ? { x: point.clientX, y: point.clientY } : null; }, { passive: true });
  grid.addEventListener('touchend', event => {
    const point = event.changedTouches?.[0];
    if (!touch || !point || busy || draft) return;
    const dx = point.clientX - touch.x, dy = point.clientY - touch.y; touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(shiftMonth(month, dx < 0 ? 1 : -1));
  });
  document.addEventListener?.('keydown', event => { if (event.key === 'Escape' && draft && !busy) closeEditor(); });
  holidays.addEventListener('change', async () => {
    busy = true; render();
    try { await call({ action: 'calendarSettings', input: { holidaysFr: holidays.checked } }); await load(); }
    catch (error) { if (error.message !== 'STALE') notice = 'Could not change this setting.'; }
    finally { busy = false; render(); }
  });

  return {
    async show() { if (visible()) await refresh(); },
    async refreshIfOpen() { if (visible() && !draft && !busy) await refresh(); },
    clear() { epoch++; data = null; today = null; month = null; selected = null; draft = null; busy = false; notice = ''; sheet.hidden = true; sheet.replaceChildren(); grid.replaceChildren(); panel.replaceChildren(); home.hidden = true; }
  };
}
