import { SchedulerError } from './scheduler.mjs';

const failure = (status, code, message) => ({ status, body: { error: { code, message } } });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Shared by the freshly authenticated owner UI and the application-owned tool broker.
// Only the browser path may change quiet hours or opt in to proactive heartbeats.
export async function schedulerOperation(scheduler, companionId, payload, { allowSettings = false } = {}) {
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

export function createSchedulerHttp({ access, scheduler }) {
  return async request => {
    const parsed = await access.read(request, 16384);
    if (parsed.failure) return parsed.failure;
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    return schedulerOperation(scheduler, admitted.companionId, parsed.value, { allowSettings: true });
  };
}
