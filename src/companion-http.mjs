// POST /api/companion: the signed-in owner's companion profile (name and look) and its memory
// (view and forget). Account mode only; every request revalidates the platform session.
import { CompanionError, readMemory, forgetMemory, ensureWorkspace } from './companion.mjs';

const fail = (status, code, message) => ({ status, body: { error: { code, message } } });

// profiles: Profiles. workspaceFor(companionId) -> {dir, owner} or null when no agent is configured.
// onForget(companionId): called after a memory was removed (starts a new agent session).
// onLook(companionId): called when the name or look changed, so the agent's next session knows.
export function createCompanionHttp({ access, profiles, workspaceFor, runtimeStatus, onForget = () => {}, onLook = () => {} }) {
  return async function companion(request) {
    const parsed = await access.read(request, 4096);
    if (parsed.failure) return parsed.failure;
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    const companionId = admitted.companionId, payload = parsed.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'INVALID_REQUEST', 'Invalid request.');
    const only = keys => Object.keys(payload).every(key => keys.includes(key));
    try {
      switch (payload.action) {
        case 'get': {
          if (!only(['action'])) break;
          const runtime = await runtimeStatus(companionId);
          return { status: 200, body: { profile: profiles.get(companionId), runtime: { state: runtime.state, ...(runtime.provider ? { provider: runtime.provider } : {}) } } };
        }
        case 'setProfile': {
          if (!only(['action', 'profile'])) break;
          const before = profiles.get(companionId), profile = profiles.set(companionId, payload.profile);
          if (!before || ['name', 'character', 'color'].some(key => before[key] !== profile[key])) onLook(companionId);
          return { status: 200, body: { profile } };
        }
        case 'memory': {
          if (!only(['action'])) break;
          const workspace = workspaceFor(companionId);
          if (!workspace) return { status: 200, body: { files: [] } };
          ensureWorkspace(workspace.dir, workspace.owner);
          return { status: 200, body: { files: readMemory(workspace.dir) } };
        }
        case 'forget': {
          if (!only(['action', 'file', 'id'])) break;
          const workspace = workspaceFor(companionId);
          if (!workspace) return fail(404, 'NOT_FOUND', 'Nothing to forget.');
          const removed = forgetMemory(workspace.dir, payload.file, payload.id);
          if (removed) onForget(companionId);
          return { status: 200, body: { removed, files: readMemory(workspace.dir) } };
        }
        default: break;
      }
      return fail(400, 'INVALID_REQUEST', 'Invalid request.');
    } catch (error) {
      if (error instanceof CompanionError) return fail(error.status, error.code, 'Invalid request.');
      return fail(503, 'UNAVAILABLE', 'Your companion is unavailable right now.');
    }
  };
}
