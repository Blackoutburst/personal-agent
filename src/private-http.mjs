import { PrivateStateError } from './private-state.mjs';

const ERRORS = {
  PRIVATE_STATE_INVALID_REQUEST: [400, 'Invalid private-state request.'],
  PRIVATE_STATE_INVALID_CURSOR: [400, 'Invalid private-state cursor.'],
  PRIVATE_STATE_NOT_FOUND: [404, 'The private record was not found.'],
  PRIVATE_STATE_CONFLICT: [409, 'The private mutation conflicts with committed state.'],
  PRIVATE_STATE_UNAVAILABLE: [503, 'Private state is unavailable.']
};

function failed(code) {
  const [status, message] = ERRORS[code];
  return { status, body: { error: { code, message } } };
}

function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

export function createPrivateHttp({ access, state }) {
  return async function privateState(request) {
    const parsed = await access.read(request, 65536);
    if (parsed.failure) {
      return parsed.failure.body?.error?.code === 'BAD_REQUEST' ?
        { ...failed('PRIVATE_STATE_INVALID_REQUEST'), ...(parsed.failure.closeConnection ? { closeConnection: true } : {}) } : parsed.failure;
    }
    // Cookie validation and identity provisioning are fresh for every operation.
    // Companion IDs, owner claims and runtime authority never come from this body.
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    const input = parsed.value;
    try {
      if (shape(input, ['action', 'id']) && input.action === 'read') {
        return { status: 200, body: state.read(admitted.companionId, input.id) };
      }
      if (shape(input, ['action', 'kind'], ['threadId', 'cursor', 'limit']) && input.action === 'list') {
        const { action, ...options } = input;
        return { status: 200, body: state.list(admitted.companionId, options) };
      }
      if (shape(input, ['action'], ['cursor', 'limit']) && input.action === 'changes') {
        const { action, ...options } = input;
        return { status: 200, body: state.changes(admitted.companionId, options) };
      }
      if (shape(input, ['action', 'mutation']) && input.action === 'mutate') {
        return { status: 200, body: state.mutate(admitted.companionId, input.mutation) };
      }
      return failed('PRIVATE_STATE_INVALID_REQUEST');
    } catch (error) {
      const code = error instanceof PrivateStateError && Object.hasOwn(ERRORS, error.code) ? error.code : 'PRIVATE_STATE_UNAVAILABLE';
      return failed(code);
    }
  };
}
