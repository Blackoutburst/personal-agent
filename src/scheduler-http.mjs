import { SchedulerError } from './scheduler.mjs';
import { calendarOperation, isCalendarAction } from './calendar.mjs';
import { githubOperation } from './github.mjs';
import { xOperation } from './x-posts.mjs';
import { mailOperation } from './mail.mjs';

const failure = (status, code, message) => ({ status, body: { error: { code, message } } });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Shared by the freshly authenticated owner UI and the application-owned tool broker.
// Only the browser path may change quiet hours or opt in to proactive heartbeats.
// Calendar actions (#44) travel the same two paths.
export async function schedulerOperation(scheduler, companionId, payload, { allowSettings = false, calendar = null, github = null, x = null, mail = null } = {}) {
  // GitHub tools (#45) exist only on the companion's tool path; the owner manages the link in Me › Connectors.
  if (!allowSettings && exact(payload, ['action', 'input']) && payload.action === 'github') return githubOperation(github, companionId, payload.input);
  // X post reading (#46) likewise exists only for the companion's tools.
  if (!allowSettings && exact(payload, ['action', 'input']) && payload.action === 'x') return xOperation(x, companionId, payload.input);
  // The mail connector (#50) likewise: its limits are enforced in src/mail.mjs.
  if (!allowSettings && exact(payload, ['action', 'input']) && payload.action === 'mail') return mailOperation(mail, companionId, payload.input);
  if (payload && typeof payload === 'object' && isCalendarAction(payload.action)) return calendarOperation(calendar, companionId, payload, { allowSettings });
  if (!scheduler) return failure(503, 'SCHEDULER_UNAVAILABLE', 'Reminders are unavailable right now.');
  try {
    let value;
    if (exact(payload, ['action']) && payload.action === 'list') value = scheduler.list(companionId);
    else if (exact(payload, ['action', 'input']) && payload.action === 'create') value = scheduler.create(companionId, payload.input);
    else if (exact(payload, ['action', 'input']) && payload.action === 'cancel') value = scheduler.cancel(companionId, payload.input);
    else if (!allowSettings && exact(payload, ['action', 'input']) && payload.action === 'createWatch') value = scheduler.createWatch(companionId, payload.input);
    else if (exact(payload, ['action', 'input']) && payload.action === 'updateWatch') value = scheduler.updateWatch(companionId, payload.input);
    else if (allowSettings && exact(payload, ['action', 'input']) && payload.action === 'configure') value = scheduler.configure(companionId, payload.input);
    else return failure(400, 'SCHEDULER_INVALID_REQUEST', 'Invalid reminder request.');
    return { status: 200, body: await value };
  } catch (error) {
    const code = error instanceof SchedulerError ? error.code : 'SCHEDULER_UNAVAILABLE';
    const status = { SCHEDULER_INVALID_REQUEST: 400, SCHEDULER_NOT_FOUND: 404, SCHEDULER_CONFLICT: 409, SCHEDULER_CAPACITY: 409 }[code] ?? 503;
    return failure(status, code, status === 503 ? 'Reminders are unavailable right now.' : 'This reminder request could not be completed.');
  }
}

export function createSchedulerHttp({ access, scheduler, calendar = null }) {
  return async request => {
    const parsed = await access.read(request, 16384);
    if (parsed.failure) return parsed.failure;
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    return schedulerOperation(scheduler, admitted.companionId, parsed.value, { allowSettings: true, calendar });
  };
}
