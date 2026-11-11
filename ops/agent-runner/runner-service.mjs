// cchan-agent-runner.service (#72, docs/AGENT-RUNNER.md): C-chan's agent runner as its own small service. It runs as
// the owner account because launching into the sandbox needs `sudo cchan-sandbox-run`, which the companion service
// (NoNewPrivileges) cannot do. It listens only on a Unix socket under the companion's data dir (0600): the companion
// reaches it, the sandboxed agents cannot see it (ProtectHome).
//
// API (JSON over HTTP on the socket):
//   GET  /status                     limits, run counts, Board connection, roster summary
//   GET  /runs[?active=1]            runs, newest last
//   GET  /runs/<id>                  one run
//   GET  /ops                        agents, pipeline, decisions, usage (read-only, for the Studio Ops app)
//   GET  /tickets/<id>/messages      a ticket's Board thread (read-only)
//   POST /runs                       launch { agent, ticketId, repo, model, provider?, base?, instructions?, maxTurns?, maxSeconds?, requestId? }
//   POST /runs/<id>/stop             stop a run (its unit and every child process)
//   GET  /events?after=N[&wait=S]    run and Board events after seq N; waits up to S seconds (max 30) for the next one
//   GET  /roster[?archived=1]        C-chan's agents and teams (#73)
//   POST /roster/agents              create an agent { name, role, model, kind?, ticketId?, actions?, repos?, skills?, instructions?, ... }
//   POST /roster/agents/<name>       update it { expectedVersion, ...changes }
//   POST /roster/agents/<name>/archive   { expectedVersion }
//   POST /roster/teams               create or update a team { name, purpose?, members?, expectedVersion? }
//   POST /roster/teams/<name>/archive    { expectedVersion, archiveMembers? }
import { createServer } from 'node:http';
import { chmodSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { AgentRunner, AgentRunnerError } = await import(join(ROOT, 'src', 'agent-runner.mjs'));
const { buildOps, OpsBoard } = await import(join(ROOT, 'src', 'agent-ops.mjs'));
const { SandboxOps } = await import(join(ROOT, 'src', 'agent-sandbox-ops.mjs'));
const { BoardReporter, BoardWatch, BoardRosterMirror } = await import(join(ROOT, 'src', 'agent-runner-board.mjs'));
const { Roster, RosterError } = await import(join(ROOT, 'src', 'agent-roster.mjs'));
const { BoardClient } = await import(join(ROOT, 'src', 'board-client.mjs'));

const HOME = process.env.HOME ?? '/home/ubuntu';
const CONFIG = process.env.CCHAN_RUNNER_CONFIG ?? join(HOME, '.config', 'cchan-agent-runner', 'config.json');
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const socket = config.socket ?? join(HOME, 'personal-agent-data', 'agent-runner', 'runner.sock');
const stateFile = config.stateFile ?? join(HOME, 'personal-agent-data', 'agent-runner', 'runs.json');
const rosterFile = config.rosterFile ?? join(HOME, 'personal-agent-data', 'agent-runner', 'roster.json');
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('config.projects: the Board projects agents may work in');
if (typeof config.ownerId !== 'string' || !config.ownerId) throw new Error('config.ownerId: who Needs-you questions go to');
const board = new BoardClient({ label: 'C-chan agent runner', sessionId: config.board?.sessionId ?? 'cchan-agent-runner',
  board: { configDir: config.board?.configDir ?? join(HOME, '.config', 'cchan-agent-runner', 'board'),
    pythonPath: config.board?.pythonPath ?? '/usr/bin/python3',
    connectPath: config.board?.connectPath ?? join(HOME, '.config', 'blackoutburst-board', 'connect.py') } });

const roster = new Roster({ file: rosterFile, log, mirror: config.boardRoster === false ? null : new BoardRosterMirror({ client: board, projects: config.projects }) });
const runner = new AgentRunner({ file: stateFile, ops: new SandboxOps(), log, limits: config.limits ?? {}, roster,
  reporter: new BoardReporter({ client: board, projects: config.projects, ownerId: config.ownerId, log }) });
runner.on('event', event => log(`event ${event.seq} ${event.type} ${event.runId ?? ''} #${event.ticketNumber ?? '?'} ${event.state ?? ''}`));

const opsBoard = new OpsBoard({ client: board, projects: config.projects });
const watch = new BoardWatch({ client: board, projects: config.projects });
let boardState = { ok: null, at: null, error: null };
async function poll() {
  try {
    for (const event of await watch.poll()) runner.note(event);
    boardState = { ok: true, at: Date.now(), error: null };
    await roster.resync();
  } catch (error) {
    if (boardState.ok !== false) log(`Board watch failed: ${error.code ? `${error.code}: ${error.message}` : error.message}`);
    boardState = { ok: false, at: Date.now(), error: String(error.code ?? 'ERROR') };
  }
}
const watchTimer = setInterval(poll, Math.max(10, config.watchSeconds ?? 20) * 1000);

const waiters = new Set();
runner.on('event', () => { for (const wake of waiters) wake(); waiters.clear(); });

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new AgentRunnerError('INVALID', 'Body too large.'); chunks.push(chunk); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new AgentRunnerError('INVALID', 'Body must be JSON.'); }
}

const STATUS = { INVALID: 400, NOT_FOUND: 404, BUSY: 409, QUEUE_FULL: 429, HARD_LIMIT: 403, PROVIDER_UNAVAILABLE: 409,
  FORBIDDEN: 403, PAUSED: 409, CONFLICT: 409, EXISTS: 409, LIMIT: 429 };
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const server = createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    const url = new URL(request.url, 'http://runner');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && url.pathname === '/status') {
      const runs = runner.list();
      return send(200, { limits: runner.limits, running: runs.filter(run => ['preparing', 'running', 'stopping'].includes(run.state)).length,
        queued: runs.filter(run => run.state === 'queued').length, board: boardState, projects: config.projects, roster: roster.summary() });
    }
    if (request.method === 'GET' && parts[0] === 'runs' && parts.length === 1) return send(200, { runs: runner.list({ active: url.searchParams.get('active') === '1' }) });
    if (request.method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
      const run = runner.get(parts[1]);
      return run ? send(200, { run }) : send(404, { error: { code: 'NOT_FOUND', message: 'No such run.' } });
    }
    // Read-only data for the Studio Ops app (#75): agents, pipeline, decisions and usage.
    if (request.method === 'GET' && url.pathname === '/ops') {
      let tickets = null;
      try { tickets = await opsBoard.tickets(); } catch (error) { log(`ops: Board read failed: ${error.code ? `${error.code}: ${error.message}` : error.message}`); }
      return send(200, buildOps({ runs: runner.list(), events: runner.events(0), tickets }));
    }
    if (request.method === 'GET' && parts[0] === 'tickets' && parts[2] === 'messages' && parts.length === 3 && /^[A-Za-z0-9_-]{1,100}$/.test(parts[1])) {
      let history = null;
      try { history = await opsBoard.messages(parts[1]); } catch (error) { return send(502, { error: { code: 'BOARD_UNAVAILABLE', message: 'The Board is not reachable.' } }); }
      return history ? send(200, history) : send(404, { error: { code: 'NOT_FOUND', message: 'No such ticket.' } });
    }
    if (request.method === 'POST' && url.pathname === '/runs') return send(202, { run: runner.launch(await body(request)) });
    if (request.method === 'POST' && parts[0] === 'runs' && parts[2] === 'stop' && parts.length === 3) return send(200, { run: runner.stop(parts[1]) });
    if (request.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0), wait = Math.min(30, Number(url.searchParams.get('wait') ?? 0));
      let events = runner.events(Number.isFinite(after) ? after : 0);
      if (!events.length && wait > 0) {
        await new Promise(resolve => { const timer = setTimeout(resolve, wait * 1000); waiters.add(() => { clearTimeout(timer); resolve(); }); });
        events = runner.events(Number.isFinite(after) ? after : 0);
      }
      const last = runner.events(0).at(-1)?.seq ?? 0;
      return send(200, { events, last });
    }
    if (parts[0] === 'roster') {
      if (request.method === 'GET' && parts.length === 1) return send(200, roster.list({ includeArchived: url.searchParams.get('archived') === '1' }));
      if (request.method === 'POST' && parts[1] === 'agents' && parts.length === 2) return send(201, { agent: roster.create(await body(request)) });
      if (request.method === 'POST' && parts[1] === 'agents' && NAME.test(parts[2] ?? '') && parts.length === 3) return send(200, { agent: roster.update(parts[2], await body(request)) });
      if (request.method === 'POST' && parts[1] === 'agents' && NAME.test(parts[2] ?? '') && parts[3] === 'archive' && parts.length === 4) {
        const { expectedVersion } = await body(request);
        return send(200, { agent: roster.archive(parts[2], { expectedVersion }) });
      }
      if (request.method === 'POST' && parts[1] === 'teams' && parts.length === 2) return send(200, { team: roster.saveTeam(await body(request)) });
      if (request.method === 'POST' && parts[1] === 'teams' && NAME.test(parts[2] ?? '') && parts[3] === 'archive' && parts.length === 4) {
        const { expectedVersion, archiveMembers } = await body(request);
        return send(200, { team: roster.archiveTeam(parts[2], { expectedVersion, archiveMembers: archiveMembers === true }) });
      }
    }
    return send(404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
  } catch (error) {
    const known = error instanceof AgentRunnerError || error instanceof RosterError;
    const code = known ? error.code : 'RUNNER_ERROR';
    if (!known) log(`request failed: ${error.message}`);
    return send(STATUS[code] ?? 500, { error: { code, message: known ? error.message : 'The runner failed.' } });
  }
});

mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
if (existsSync(socket)) rmSync(socket);
server.listen(socket, async () => {
  chmodSync(socket, 0o600);
  log(`listening on ${socket}; limits ${JSON.stringify(runner.limits)}`);
  await runner.recover();
  await poll();
});

const shutdown = () => {
  log('stopping: active runs are stopped and cleaned up on the next start');
  clearInterval(watchTimer); runner.close(); board.close(); server.close(); process.exit(0);
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
