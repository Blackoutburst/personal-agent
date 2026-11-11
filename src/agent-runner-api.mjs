// The runner's JSON API (#72, #73, #75, #76; docs/AGENT-RUNNER.md, docs/MANAGER.md) as a plain function, so the Unix-socket
// service (ops/agent-runner/runner-service.mjs) and the tests share one routing table.
//   api(method, url, body) -> Promise<{ status, body }>     body: the parsed JSON request body ({} when none)
import { AgentRunnerError } from './agent-runner.mjs';
import { RosterError } from './agent-roster.mjs';
import { ManagerError } from './agent-manager.mjs';
import { buildOps } from './agent-ops.mjs';

export const STATUS = { INVALID: 400, NOT_FOUND: 404, BUSY: 409, QUEUE_FULL: 429, HARD_LIMIT: 403, PROVIDER_UNAVAILABLE: 409,
  FORBIDDEN: 403, PAUSED: 409, CONFLICT: 409, EXISTS: 409, LIMIT: 429, BUDGET: 409, NO_REVIEW: 409, NOT_INDEPENDENT: 409,
  STALE_REVIEW: 409, VERDICT_MISMATCH: 409, NO_ACCEPT: 409, ALREADY_MERGED: 409 };
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,100}$/;

// tickets(): the watch's latest ticket snapshot for manager attention, or null before the first poll.
export function createRunnerApi({ runner, roster, manager = null, opsBoard = null, projects = [], boardState = () => ({ ok: null }),
  tickets = () => null, log = () => {} }) {
  const waiters = new Set();
  runner.on('event', () => { for (const wake of waiters) wake(); waiters.clear(); });
  const ok = (status, body) => ({ status, body });
  const missing = () => ok(404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });

  async function route(method, url, body) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (method === 'GET' && url.pathname === '/status') {
      const runs = runner.list();
      return ok(200, { limits: runner.limits, running: runs.filter(run => ['preparing', 'running', 'stopping'].includes(run.state)).length,
        queued: runs.filter(run => run.state === 'queued').length, board: boardState(), projects, roster: roster.summary(),
        ...(manager ? { manager: { approvals: manager.approvals().length, usage: manager.usage() } } : {}) });
    }
    if (method === 'GET' && parts[0] === 'runs' && parts.length === 1) return ok(200, { runs: runner.list({ active: url.searchParams.get('active') === '1' }) });
    if (method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
      const run = runner.get(parts[1]);
      return run ? ok(200, { run }) : ok(404, { error: { code: 'NOT_FOUND', message: 'No such run.' } });
    }
    // Read-only data for the Studio Ops app (#75): agents, pipeline, decisions and usage.
    if (method === 'GET' && url.pathname === '/ops') {
      let listed = null;
      if (opsBoard) {
        try { listed = await opsBoard.tickets(); } catch (error) { log(`ops: Board read failed: ${error.code ? `${error.code}: ${error.message}` : error.message}`); }
      }
      return ok(200, buildOps({ runs: runner.list(), events: runner.events(0), tickets: listed, manager }));
    }
    if (method === 'GET' && parts[0] === 'tickets' && parts[2] === 'messages' && parts.length === 3 && /^[A-Za-z0-9_-]{1,100}$/.test(parts[1])) {
      let history = null;
      try { history = await opsBoard?.messages(parts[1]); } catch { return ok(502, { error: { code: 'BOARD_UNAVAILABLE', message: 'The Board is not reachable.' } }); }
      return history ? ok(200, history) : ok(404, { error: { code: 'NOT_FOUND', message: 'No such ticket.' } });
    }
    if (method === 'POST' && url.pathname === '/runs') return ok(202, { run: runner.launch(body) });
    if (method === 'POST' && parts[0] === 'runs' && parts[2] === 'stop' && parts.length === 3) return ok(200, { run: runner.stop(parts[1]) });
    if (method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0), wait = Math.min(30, Number(url.searchParams.get('wait') ?? 0));
      let events = runner.events(Number.isFinite(after) ? after : 0);
      if (!events.length && wait > 0) {
        await new Promise(resolve => { const timer = setTimeout(resolve, wait * 1000); waiters.add(() => { clearTimeout(timer); resolve(); }); });
        events = runner.events(Number.isFinite(after) ? after : 0);
      }
      return ok(200, { events, last: runner.events(0).at(-1)?.seq ?? 0 });
    }
    if (parts[0] === 'roster') {
      if (method === 'GET' && parts.length === 1) return ok(200, roster.list({ includeArchived: url.searchParams.get('archived') === '1' }));
      if (method === 'POST' && parts[1] === 'agents' && parts.length === 2) return ok(201, { agent: roster.create(body) });
      if (method === 'POST' && parts[1] === 'agents' && NAME.test(parts[2] ?? '') && parts.length === 3) return ok(200, { agent: roster.update(parts[2], body) });
      if (method === 'POST' && parts[1] === 'agents' && NAME.test(parts[2] ?? '') && parts[3] === 'archive' && parts.length === 4) {
        return ok(200, { agent: roster.archive(parts[2], { expectedVersion: body.expectedVersion }) });
      }
      if (method === 'POST' && parts[1] === 'teams' && parts.length === 2) return ok(200, { team: roster.saveTeam(body) });
      if (method === 'POST' && parts[1] === 'teams' && NAME.test(parts[2] ?? '') && parts[3] === 'archive' && parts.length === 4) {
        return ok(200, { team: roster.archiveTeam(parts[2], { expectedVersion: body.expectedVersion, archiveMembers: body.archiveMembers === true }) });
      }
    }
    // Manager mode (#76): standing approvals, the budget, attention findings and C-chan's decision log.
    if (parts[0] === 'manager' && manager) {
      if (method === 'GET' && parts.length === 1) return ok(200, manager.view({ tickets: tickets(), runs: runner.list() }));
      if (method === 'POST' && parts[1] === 'approvals' && parts.length === 2) {
        return ok(200, { approval: manager.approve({ projectId: body.projectId, direction: body.direction, requestId: body.requestId ?? null }) });
      }
      if (method === 'POST' && parts[1] === 'approvals' && PROJECT.test(parts[2] ?? '') && parts[3] === 'revoke' && parts.length === 4) {
        return ok(200, { approval: manager.revoke({ projectId: parts[2] }) });
      }
      if (method === 'POST' && parts[1] === 'decisions' && parts.length === 2) return ok(201, { decision: manager.decide(body, runner.list()) });
    }
    return missing();
  }

  return async function api(method, path, body = {}) {
    try {
      return await route(method, new URL(path, 'http://runner'), body ?? {});
    } catch (error) {
      const known = error instanceof AgentRunnerError || error instanceof RosterError || error instanceof ManagerError;
      const code = known ? error.code : 'RUNNER_ERROR';
      if (!known) log(`request failed: ${error.message}`);
      return { status: STATUS[code] ?? 500, body: { error: { code, message: known ? error.message : 'The runner failed.' } } };
    }
  };
}
