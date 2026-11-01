import { GoalStore, GoalError } from './goals.mjs';
import { createCompanionProvisioner } from './provisioning.mjs';

const DEMO_PRINCIPAL = Object.freeze({ issuer: 'https://synthetic.invalid', subject: 'goals-development-fixture' });
const ACTIONS = new Set(['snapshot', 'saveGoal', 'reviewGoal', 'saveCard', 'confirmCard', 'revokeCard']);
const ERRORS = {
  GOALS_INVALID_REQUEST: [400, 'The goal or permission-card request is invalid.'],
  GOALS_NOT_FOUND: [404, 'The goal or permission card was not found.'],
  GOALS_CONFLICT: [409, 'This request conflicts with the current goal or permission card. Refresh before changing it.'],
  GOALS_UNAVAILABLE: [503, 'The private goal workspace is unavailable.'],
  GOALS_PAUSED: [409, 'This goal is paused. Its permission card does not authorize work.'],
  GOALS_NOT_CONFIRMED: [409, 'Review and confirm the current permission card first.'],
  GOALS_REVOKED: [409, 'This permission card is revoked.'],
  GOALS_CONFIRMATION_REQUIRED: [409, 'Review the current permission-card preview before confirming it.'],
  GOALS_NOT_YET_VALID: [409, 'The permission-card time window has not started.'],
  GOALS_EXPIRED: [409, 'The permission-card time window has ended.'],
  GOALS_REVIEW_REQUIRED: [409, 'This permission card requires a fresh review.'],
  GOALS_BUDGET_EXCEEDED: [409, 'This request exceeds the remaining permission-card budget.'],
  GOALS_CONTROL_CAPACITY: [409, 'Workspace control capacity is exhausted. New and reserved work is blocked.'],
  GOALS_SCOPE_DENIED: [409, 'This request is outside the permission card.'],
  GOALS_DECISION_REQUIRED: [409, 'This action requires a concrete user decision.'],
  GOALS_PROJECT_AUTHORITY_UNAVAILABLE: [503, 'Current Board project authority is not connected.'],
  GOALS_PROJECT_AUTHORITY_DENIED: [409, 'Current Board project authority does not permit this action.']
};
function fail(code) { const [status, message] = ERRORS[code]; return { status, body: { error: { code, message } } }; }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Only local private management actions are exposed. Dispatch/evaluation/reservations are internal seams.
export function createGoalsHttp({ access, store, mode }) {
  let goals;
  const syntheticAdmission = mode === 'demo' ? createCompanionProvisioner({ store,
    pilotSubjects: [DEMO_PRINCIPAL], validateAccount: async () => DEMO_PRINCIPAL }) : null;
  return async function goalsRequest(request) {
    const parsed = await access.read(request, 65536);
    if (parsed.failure) {
      if (parsed.failure.body.error.code === 'BAD_REQUEST') return { ...parsed.failure,
        body: { error: { code: 'BAD_REQUEST', message: 'A valid JSON goal request is required.' } } };
      return parsed.failure;
    }
    if (!['account', 'demo'].includes(mode)) return fail('GOALS_UNAVAILABLE');
    let companionId;
    if (mode === 'account') {
      const admitted = await access.authorize(request);
      if (admitted.failure) return admitted.failure;
      companionId = admitted.companionId;
    } else {
      try { ({ companionId } = await syntheticAdmission(null)); }
      catch { return fail('GOALS_UNAVAILABLE'); }
    }
    const payload = parsed.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !ACTIONS.has(payload.action)) return fail('GOALS_INVALID_REQUEST');
    const { expectedCompanionId, ...command } = payload;
    if (expectedCompanionId === undefined && command.action !== 'snapshot') return { status: 409,
      body: { error: { code: 'GOALS_WORKSPACE_REQUIRED', message: 'Open the current private workspace before changing it.' } } };
    if (expectedCompanionId !== undefined) {
      if (typeof expectedCompanionId !== 'string' || !UUID.test(expectedCompanionId)) return fail('GOALS_INVALID_REQUEST');
      if (expectedCompanionId !== companionId) return { status: 401,
        body: { error: { code: 'ACCOUNT_CHANGED', message: 'The signed-in account changed. Open a fresh workspace.' } } };
    }
    try {
      goals ??= new GoalStore(store);
      const data = goals.handle(companionId, command);
      return { status: 200, body: { version: 1, synthetic: mode === 'demo', companionId, data } };
    } catch (error) {
      return fail(error instanceof GoalError && Object.hasOwn(ERRORS, error.code) ? error.code : 'GOALS_UNAVAILABLE');
    }
  };
}
