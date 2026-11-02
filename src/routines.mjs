// Calendar slots for private routines. UTC arithmetic below advances civil date labels,
// never the due instant: a local day can be shorter or longer than 24 hours.
const MINUTE = 60000, DAY = 24 * 60 * MINUTE, MAX_CACHE = 256;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const formatters = new Map(), slots = new Map();
const invalid = () => new RangeError('Invalid routine calendar.');
function requireCalendar(value) { if (!value) throw invalid(); }
function retain(cache, key, value) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, value); return value;
}
function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    requireCalendar(typeof timeZone === 'string' && timeZone.length > 0 && timeZone.length <= 100);
    value = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    retain(formatters, timeZone, value);
  }
  return value;
}
function parts(format, time) {
  const value = Object.fromEntries(format.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  requireCalendar(value.year >= 1 && value.year <= 9999);
  return value;
}
function civil(value) {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour ?? 0, value.minute ?? 0, value.second ?? 0, 0);
  return date.getTime();
}
function dayLabel(value) {
  return String(value.year).padStart(4, '0') + '-' + String(value.month).padStart(2, '0') + '-' + String(value.day).padStart(2, '0');
}
function dayParts(day) {
  const [year, month, selected] = day.split('-').map(Number); return { year, month, day: selected };
}
function shiftDay(day, count) {
  const date = new Date(civil(dayParts(day))); date.setUTCDate(date.getUTCDate() + count);
  return dayLabel({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}
function monday(day) {
  const weekday = new Date(civil(dayParts(day))).getUTCDay() || 7;
  return shiftDay(day, 1 - weekday);
}
function dueOn(timeZone, day, localTime) {
  const key = JSON.stringify([timeZone, day, localTime]);
  if (slots.has(key)) return slots.get(key);
  const format = formatter(timeZone), [hour, minute] = localTime.split(':').map(Number);
  const target = civil({ ...dayParts(day), hour, minute }), offsets = new Set();
  // Observe both sides of nearby transitions, including full-day date-line changes.
  for (let distance = -2 * DAY; distance <= 2 * DAY; distance += 6 * 60 * MINUTE) {
    const time = target + distance;
    offsets.add(civil(parts(format, time)) - time);
  }
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  const exact = candidates.filter(time => civil(parts(format, time)) === target);
  if (exact.length) return retain(slots, key, exact[0]); // Earlier occurrence of a repeated wall time.
  // A skipped wall time lies across a forward clock jump. Find its first valid
  // instant rather than normalizing 02:30 to 03:30; minute schedules choose 03:00.
  const before = candidates.filter(time => civil(parts(format, time)) < target);
  const after = candidates.filter(time => civil(parts(format, time)) > target);
  requireCalendar(before.length && after.length);
  let low = Math.max(...before), high = Math.min(...after);
  requireCalendar(low < high && high - low <= 2 * DAY);
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (civil(parts(format, middle)) < target) low = middle; else high = middle;
  }
  const first = parts(format, high);
  if (first.second !== 0) high += (60 - first.second) * 1000;
  requireCalendar(civil(parts(format, high)) >= target);
  return retain(slots, key, high);
}

// Latest scheduled slot at or before now; callers apply their activation boundary
// and durable period receipts. This visits at most the current and previous period.
export function latestRoutineSlot(input) {
  try {
    requireCalendar(input && typeof input === 'object' && !Array.isArray(input)
      && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
    const descriptors = Object.getOwnPropertyDescriptors(input), required = ['now', 'timeZone', 'routine', 'localTime'];
    requireCalendar(required.every(key => Object.hasOwn(descriptors, key)) && Reflect.ownKeys(descriptors).every(key =>
      typeof key === 'string' && [...required, 'weekday'].includes(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')));
    const { now, timeZone, routine, localTime, weekday = 1 } = input;
    requireCalendar(Number.isSafeInteger(now) && now >= 0 && now <= 8640000000000000
      && ['dailyDigest', 'weeklyCheckin'].includes(routine) && typeof localTime === 'string' && CLOCK.test(localTime)
      && Number.isSafeInteger(weekday) && weekday >= 1 && weekday <= 7);
    const current = dayLabel(parts(formatter(timeZone), now));
    let period = routine === 'dailyDigest' ? current : monday(current);
    let localDate = routine === 'dailyDigest' ? period : shiftDay(period, weekday - 1);
    let dueAt = dueOn(timeZone, localDate, localTime);
    if (dueAt > now) {
      period = shiftDay(period, routine === 'dailyDigest' ? -1 : -7);
      localDate = routine === 'dailyDigest' ? period : shiftDay(period, weekday - 1);
      dueAt = dueOn(timeZone, localDate, localTime);
    }
    requireCalendar(Number.isSafeInteger(dueAt) && dueAt <= now);
    return { period, localDate, dueAt };
  } catch { throw invalid(); }
}
