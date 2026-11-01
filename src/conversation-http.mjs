import { ConversationDemo, ConversationDemoError } from './conversation-demo.mjs';

const UNAVAILABLE = { status: 503, body: { error: { code: 'CONVERSATION_UNAVAILABLE',
  message: 'Personal Codex is not connected. Your account connection is separate.' } } };
const DEMO_ERRORS = {
  CONVERSATION_DEMO_INVALID_REQUEST: [400, 'The synthetic conversation request is invalid.'],
  CONVERSATION_DEMO_NOT_FOUND: [404, 'The synthetic conversation was not found.'],
  CONVERSATION_DEMO_CONFLICT: [409, 'This request conflicts with a retained synthetic request.'],
  CONVERSATION_DEMO_CAPACITY: [409, 'The bounded synthetic fixture is full. No message was removed.'],
  CONVERSATION_DEMO_UNAVAILABLE: [503, 'The synthetic conversation fixture is unavailable.']
};

// Positive results are development fixtures only. Account mode never imports or exposes their data.
export function createConversationHttp({ access, store, mode }) {
  let fixture;
  return async function conversation(request) {
    const parsed = await access.read(request, 16384);
    if (parsed.failure) {
      if (parsed.failure.body.error.code === 'BAD_REQUEST') {
        return { ...parsed.failure, body: { error: { code: 'BAD_REQUEST', message: 'A valid JSON conversation request is required.' } } };
      }
      return parsed.failure;
    }
    if (mode === 'account') {
      const admitted = await access.authorize(request);
      if (admitted.failure) return admitted.failure;
      // A verified platform account cannot activate a provider, select a runtime or consume demo history.
      return structuredClone(UNAVAILABLE);
    }
    if (mode !== 'demo') return structuredClone(UNAVAILABLE);
    try {
      fixture ??= new ConversationDemo(store);
      return { status: 200, body: fixture.handle(parsed.value) };
    } catch (error) {
      const known = error instanceof ConversationDemoError && Object.hasOwn(DEMO_ERRORS, error.code);
      const code = known ? error.code : 'CONVERSATION_DEMO_UNAVAILABLE';
      const [status, message] = DEMO_ERRORS[code];
      return { status, body: { error: { code, message } } };
    }
  };
}
