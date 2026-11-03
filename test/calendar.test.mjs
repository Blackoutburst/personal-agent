import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Calendar, calendarOperation, frenchHolidays, zonedTime, addDays } from '../src/calendar.mjs';

function fixture({ zone = 'Europe/Paris', now = Date.UTC(2026, 10, 3, 9) } = {}) {
  const f = { now, queued: [], states: new Map(), changed: [] };
  f.reminders = {
    eventStates: (companionId, prefix) => [...f.states].filter(([key]) => key.startsWith(prefix)).map(([, state]) => state),
    enqueueEvent: (companionId, input) => { f.queued.push(input); f.states.set(input.requestId, 'queued'); }
  };
  f.calendar = new Calendar({ store: { db: new DatabaseSync(':memory:') }, timezoneFor: () => zone, now: () => f.now,
    reminders: f.reminders, changed: (companionId, id) => f.changed.push(id) });
  f.A = randomUUID(); f.B = randomUUID();
  f.add = (event, owner = f.A) => f.calendar.create(owner, { requestId: 'r-' + randomUUID(), event }).event;
  return f;
}

test('French public holidays include the moveable feasts', () => {
  const days = Object.fromEntries(frenchHolidays(2026).map(holiday => [holiday.title, holiday.date]));
  assert.equal(frenchHolidays(2026).length, 11);
  assert.equal(days['Lundi de Pâques'], '2026-04-06');
  assert.equal(days.Ascension, '2026-05-14');
  assert.equal(days['Lundi de Pentecôte'], '2026-05-25');
  assert.equal(Object.fromEntries(frenchHolidays(2027).map(holiday => [holiday.title, holiday.date]))['Lundi de Pâques'], '2027-03-29');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('local wall times convert to instants across summer time changes', () => {
  assert.equal(new Date(zonedTime('2026-07-01', '14:00', 'Europe/Paris')).toISOString(), '2026-07-01T12:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-12-01', '14:00', 'Europe/Paris')).toISOString(), '2026-12-01T13:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-03-29', '02:30', 'Europe/Paris')).toISOString(), '2026-03-29T00:30:00.000Z', 'Spring gap: the reading an hour earlier');
  assert.equal(new Date(zonedTime('2026-11-02', '09:00', 'UTC')).toISOString(), '2026-11-02T09:00:00.000Z');
});

test('the view expands yearly events, multi-day events and holidays in order, per owner', () => {
  const f = fixture(), c = f.calendar;
  f.add({ title: 'Leap birthday', start: '2024-02-29', yearly: true });
  f.add({ title: 'Trip', start: '2026-11-10', end: '2026-11-12' });
  f.add({ title: 'Lunch', start: '2026-11-11T12:30', end: '2026-11-11T14:00', location: 'Chez Paul' });
  f.add({ title: 'Breakfast', start: '2026-11-11T08:00' });
  f.add({ title: 'Not mine', start: '2026-11-11' }, f.B);
  let view = c.view(f.A, { from: '2026-11-11', days: 1 });
  assert.deepEqual(view.occurrences.map(item => item.title), ['Trip', 'Breakfast', 'Lunch'], 'All-day first, then by time');
  assert.equal(view.today, '2026-11-03'); assert.equal(view.timezone, 'Europe/Paris'); assert.equal(view.total, 4);
  assert.deepEqual(view.events.map(event => event.title).sort(), ['Breakfast', 'Lunch', 'Trip']);
  c.configure(f.A, { holidaysFr: true });
  view = c.view(f.A, { from: '2026-11-11', days: 1 });
  assert.deepEqual(view.occurrences.map(item => item.title), ['Trip', 'Armistice 1918', 'Breakfast', 'Lunch'], 'By start date');
  assert.equal(view.occurrences[1].holiday, true);
  assert.deepEqual(c.view(f.B, { from: '2026-11-11', days: 1 }).occurrences.map(item => item.title), ['Not mine']);
  const leap = c.view(f.A, { from: '2027-02-01', days: 60 }).occurrences.filter(item => item.title === 'Leap birthday');
  assert.deepEqual(leap.map(item => item.date), ['2027-02-28']);
  assert.deepEqual(c.view(f.A, { from: '2028-02-01', days: 60 }).occurrences.filter(item => item.title === 'Leap birthday').map(item => item.date), ['2028-02-29']);
  assert.deepEqual(c.view(f.A, { from: '2023-01-01', days: 400 }).occurrences.filter(item => item.title === 'Leap birthday'), [], 'Not before it began');
  const trip = c.view(f.A, { from: '2026-11-12', days: 1 }).occurrences.find(item => item.title === 'Trip');
  assert.deepEqual([trip.start, trip.end], ['2026-11-10', '2026-11-12'], 'A multi-day event shows on its later days too');
});

test('events validate, retry exactly, update with a version check and delete', () => {
  const f = fixture(), c = f.calendar;
  for (const event of [{ title: '', start: '2026-11-04' }, { title: 'x', start: '2026-13-01' }, { title: 'x', start: '2026-11-04T25:00' },
    { title: 'x', start: '2026-11-04', end: '2026-11-03' }, { title: 'x', start: '2026-11-04', allDay: false },
    { title: 'x', start: '2026-11-04', reminderMinutes: -1 }, { title: 'x', start: '2026-11-04', color: 'red' },
    { title: 'x', start: '2026-11-04T10:00', end: '2026-11-05' }, { title: 'x'.repeat(201), start: '2026-11-04' }]) {
    assert.throws(() => c.create(f.A, { requestId: 'bad', event }), error => error.code === 'CALENDAR_INVALID_REQUEST', JSON.stringify(event));
  }
  const input = { requestId: 'same', event: { title: ' Dinner ', start: '2026-11-04T20:00', notes: 'Bring wine' } };
  const first = c.create(f.A, input);
  assert.equal(first.event.title, 'Dinner'); assert.equal(first.created, true);
  assert.equal(c.create(f.A, input).event.id, first.event.id);
  assert.throws(() => c.create(f.A, { ...input, event: { ...input.event, title: 'Lunch' } }), error => error.code === 'CALENDAR_CONFLICT');
  const id = first.event.id, change = { id, expectedVersion: 1, event: { title: 'Dinner', start: '2026-11-04T21:00' } };
  const updated = c.update(f.A, change);
  assert.equal(updated.event.version, 2); assert.equal(updated.event.notes, null, 'An update replaces the whole event');
  assert.deepEqual(f.changed, [id]);
  assert.equal(c.update(f.A, change).event.version, 2, 'The same change resent after it applied is accepted');
  assert.throws(() => c.update(f.A, { ...change, event: { title: 'Other', start: '2026-11-04' } }), error => error.code === 'CALENDAR_CONFLICT');
  assert.throws(() => c.update(f.B, { ...change, expectedVersion: 2 }), error => error.code === 'CALENDAR_NOT_FOUND');
  assert.equal(c.remove(f.B, { id }).deleted, false);
  assert.equal(c.remove(f.A, { id }).deleted, true); assert.deepEqual(f.changed, [id, id]);
  assert.equal(c.view(f.A).total, 0);
});

test('reminders queue once per occurrence when due, before the event, and all-day events anchor at 09:00', () => {
  const f = fixture(), c = f.calendar;           // now: 2026-11-03 10:00 in Paris
  const soon = f.add({ title: 'Call mum', start: '2026-11-03T10:30', reminderMinutes: 30 });
  f.add({ title: 'Later', start: '2026-11-03T18:00', reminderMinutes: 30 });
  f.add({ title: 'Past', start: '2026-11-03T09:30', reminderMinutes: 60 });
  f.add({ title: 'No reminder', start: '2026-11-03T10:15' });
  const birthday = f.add({ title: 'Léa', start: '1990-11-04', yearly: true, reminderMinutes: 24 * 60 });
  assert.equal(c.enqueueDue(f.A), 2);
  assert.deepEqual(f.queued.map(item => item.requestId).sort(), [`cal-${birthday.id}-20261104-v1`, `cal-${soon.id}-20261103-v1`].sort());
  assert.ok(f.queued.every(item => item.kind === 'calendar'));
  assert.match(f.queued.find(item => item.requestId.includes(soon.id)).prompt, /"Call mum" on Tuesday 3 November at 10:30/);
  assert.match(f.queued.find(item => item.requestId.includes(birthday.id)).prompt, /all day[\s\S]*repeats every year/);
  assert.equal(c.enqueueDue(f.A), 0, 'Once per occurrence');
  // The waiting reminder is cancelled when the event changes; the new version may be reminded again.
  f.states.set(`cal-${soon.id}-20261103-v1`, 'cancelled');
  c.update(f.A, { id: soon.id, expectedVersion: 1, event: { title: 'Call mum', start: '2026-11-03T10:35', reminderMinutes: 40 } });
  assert.equal(c.enqueueDue(f.A), 1); assert.equal(f.queued.at(-1).requestId, `cal-${soon.id}-20261103-v2`);
  f.now += 8 * 3600000;                          // 18:00: "Later" has started, nothing more to send.
  assert.equal(c.enqueueDue(f.A), 0);
});

test('calendarOperation maps actions and errors; settings need the owner UI', () => {
  const f = fixture();
  assert.equal(calendarOperation(null, f.A, { action: 'calendar' }).status, 503);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'calendar' }).status, 200);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'calendarSettings', input: { holidaysFr: true } }).status, 400);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'calendarSettings', input: { holidaysFr: true } }, { allowSettings: true }).body.holidaysFr, true);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'calendar', input: { days: 1000 } }).status, 400);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'calendar', extra: 1 }).status, 400);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'deleteEvent', input: { id: 'nope' } }).status, 400);
  assert.equal(calendarOperation(f.calendar, f.A, { action: 'updateEvent', input: { id: randomUUID(), expectedVersion: 1, event: { title: 'x', start: '2026-11-04' } } }).status, 404);
});

test('the web calendar labels times, spans and reminders', async () => {
  const { timeLabel, reminderLabel } = await import('../public/calendar-ui.mjs');
  assert.equal(timeLabel({ allDay: false, start: '2026-11-04T14:00', end: '2026-11-04T14:45' }), '14:00–14:45');
  assert.equal(timeLabel({ allDay: false, start: '2026-11-04T22:00', end: null }), '22:00');
  assert.equal(timeLabel({ allDay: true, start: '2026-11-07', end: '2026-11-08' }), 'All day');
  assert.equal(timeLabel({ holiday: true, allDay: true, start: '2026-11-11', end: null }), 'Holiday');
  assert.match(timeLabel({ allDay: false, start: '2026-11-04T22:00', end: '2026-11-05T02:00' }), /^22:00 → .*5 Nov 02:00$/);
  assert.equal(reminderLabel(60), '1 hour before'); assert.equal(reminderLabel(4320), '3 days before');
  assert.equal(reminderLabel(0, true), 'At 09:00'); assert.equal(reminderLabel(null), '');
});

test('daily, weekly and monthly repeats (#47): month-end fallback, spans, old clients and reminders every month', () => {
  const f = fixture({ now: Date.UTC(2026, 10, 30, 7) }), c = f.calendar;      // 30 Nov 2026, 08:00 in Paris
  const rent = f.add({ title: 'Pay rent', start: '2026-01-01', repeat: 'monthly', reminderMinutes: 0 });
  const end = f.add({ title: 'Month end', start: '2026-01-31', repeat: 'monthly' });
  f.add({ title: 'Gym', start: '2026-11-02T18:00', end: '2026-11-02T19:00', repeat: 'weekly' });
  f.add({ title: 'Pills', start: '2026-11-28T08:00', repeat: 'daily' });
  f.add({ title: 'Ski week', start: '2026-12-26', end: '2027-01-02' });
  assert.equal(rent.repeat, 'monthly'); assert.equal(rent.yearly, false);
  const year = c.view(f.A, { from: '2027-01-01', days: 365 }).occurrences;
  assert.equal(year.filter(item => item.title === 'Pay rent').length, 12);
  assert.deepEqual(year.filter(item => item.title === 'Month end').slice(0, 4).map(item => item.date), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(c.view(f.A, { from: '2028-02-01', days: 29 }).occurrences.filter(item => item.title === 'Month end').map(item => item.date), ['2028-02-29']);
  const week = c.view(f.A, { from: '2026-11-30', days: 7 }).occurrences;
  assert.deepEqual(week.filter(item => item.title === 'Gym').map(item => item.start), ['2026-11-30T18:00']);
  assert.equal(week.filter(item => item.title === 'Pills').length, 7);
  assert.equal(c.view(f.A, { from: '2026-11-01', days: 27 }).occurrences.filter(item => item.title === 'Pills').length, 0, 'Not before it began');
  const ski = c.view(f.A, { from: '2027-01-01', days: 1 }).occurrences.find(item => item.title === 'Ski week');
  assert.deepEqual([ski.date, ski.end], ['2026-12-26', '2027-01-02'], 'A span across months shows from its first day');
  for (const event of [{ title: 'x', start: '2026-11-04', end: '2026-11-05', repeat: 'daily' }, { title: 'x', start: '2026-11-04', end: '2026-11-11', repeat: 'weekly' },
    { title: 'x', start: '2026-11-04', repeat: 'hourly' }, { title: 'x', start: '2026-11-04', repeat: 'monthly', yearly: true }]) {
    assert.throws(() => c.create(f.A, { requestId: 'bad', event }), error => error.code === 'CALENDAR_INVALID_REQUEST', JSON.stringify(event));
  }
  // An older app sends only "yearly": its edit keeps the monthly repeat it cannot show.
  const kept = c.update(f.A, { id: rent.id, expectedVersion: 1, event: { title: 'Pay the rent', start: '2026-01-01', yearly: false, reminderMinutes: 0 } }).event;
  assert.equal(kept.repeat, 'monthly');
  // The 1 December reminder (09:00 that day) is not due yet on 30 November; on the 1st it is, and again on 1 January.
  assert.equal(c.enqueueDue(f.A), 0);
  f.now = Date.UTC(2026, 11, 1, 8, 5); assert.equal(c.enqueueDue(f.A), 1);
  assert.match(f.queued.at(-1).prompt, /"Pay the rent" on Tuesday 1 December \(all day\)[\s\S]*repeats every month/);
  f.now = Date.UTC(2027, 0, 1, 8, 5); assert.equal(c.enqueueDue(f.A), 1);
  assert.equal(f.queued.at(-1).requestId, `cal-${rent.id}-20270101-v2`);
});

test('an existing yearly column becomes repeat on upgrade', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE calendar_events(companion_id TEXT NOT NULL, id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    title TEXT NOT NULL, all_day INTEGER NOT NULL, start TEXT NOT NULL, end_at TEXT, location TEXT, notes TEXT, yearly INTEGER NOT NULL,
    reminder_minutes INTEGER, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(companion_id, id),
    UNIQUE(companion_id, request_id))`);
  const A = randomUUID(), B = randomUUID();
  db.prepare("INSERT INTO calendar_events VALUES(?,?,'r1','f','Léa',1,'1990-11-04',NULL,NULL,NULL,1,NULL,1,0,0)").run(A, randomUUID());
  db.prepare("INSERT INTO calendar_events VALUES(?,?,'r2','f','Dentist',0,'2026-11-05T10:00',NULL,NULL,NULL,0,NULL,1,0,0)").run(A, randomUUID());
  void B;
  const c = new Calendar({ store: { db }, timezoneFor: () => 'Europe/Paris', now: () => Date.UTC(2026, 10, 3) });
  assert.deepEqual(c.view(A, { from: '2026-11-01', days: 30 }).events.map(event => [event.title, event.repeat]).sort(), [['Dentist', 'none'], ['Léa', 'yearly']]);
});

test('the month grid lays multi-day events as bars across a week and counts overflow (#47)', async () => {
  const { weekLayout } = await import('../public/calendar-ui.mjs');
  const days = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'];
  const one = (title, date, extra = {}) => ({ eventId: title, title, date, allDay: true, start: date, end: null, ...extra });
  const layout = weekLayout(days, [
    one('Ski', '2026-11-26', { end: '2026-12-02' }), one('Trip', '2026-11-20', { end: '2026-11-24' }), one('Expo', '2026-11-24', { end: '2026-11-25' }),
    one('A', '2026-11-27'), one('B', '2026-11-27'), one('C', '2026-11-27'), one('Noël', '2026-11-23', { holiday: true })
  ]);
  assert.deepEqual(layout.bars.map(bar => [bar.item.title, bar.from, bar.to, bar.lane, bar.continuesBefore, bar.continuesAfter]),
    [['Trip', 0, 1, 0, true, false], ['Expo', 1, 2, 1, false, false], ['Ski', 3, 6, 0, false, true]]);
  assert.equal(layout.lanes, 2);
  assert.deepEqual(layout.cells[4], { day: '2026-11-27', chips: [], more: 3 }, 'One free line: "+3" instead of a cut list');
  assert.deepEqual(layout.cells[0].chips.map(item => item.title), ['Noël']);
});
