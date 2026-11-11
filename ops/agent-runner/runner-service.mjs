// cchan-agent-runner.service (#72, docs/AGENT-RUNNER.md): C-chan's agent runner as its own small service. It runs as
// the owner account because launching into the sandbox needs `sudo cchan-sandbox-run`, which the companion service
// (NoNewPrivileges) cannot do. It listens only on a Unix socket under the companion's data dir (0600): the companion
// reaches it, the sandboxed agents cannot see it (ProtectHome).
//
// API (JSON over HTTP on the socket):
//   GET  /status                     limits, run counts, Board connection
//   GET  /runs[?active=1]            runs, newest last
//   GET  /runs/<id>                  one run
//   POST /runs                       launch { agent, ticketId, repo, model, provider?, base?, instructions?, maxTurns?, maxSeconds?, requestId? }
//   POST /runs/<id>/stop             stop a run (its unit and every child process)
//   GET  /events?after=N[&wait=S]    run and Board events after seq N; waits up to S seconds (max 30) for the next one
import { createServer } from 'node:http';
import { chmodSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { AgentRunner, AgentRunnerError } = await import(join(ROOT, 'src', 'agent-runner.mjs'));
const { SandboxOps } = await import(join(ROOT, 'src', 'agent-sandbox-ops.mjs'));
const { BoardReporter, BoardWatch } = await import(join(ROOT, 'src', 'agent-runner-board.mjs'));
const { BoardClient } = await import(join(ROOT, 'src', 'board-client.mjs'));

const HOME = process.env.HOME ?? '/home/ubuntu';
const CONFIG = process.env.CCHAN_RUNNER_CONFIG ?? join(HOME, '.config', 'cchan-agent-runner', 'config.json');
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const socket = config.socket ?? join(HOME, 'personal-agent-data', 'agent-runner', 'runner.sock');
const stateFile = config.stateFile ?? join(HOME, 'personal-agent-data', 'agent-runner', 'runs.json');
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('config.projects: the Board projects agents may work in');
if (typeof config.ownerId !== 'string' || !config.ownerId) throw new Error('config.ownerId: who Needs-you questions go to');
const board = new BoardClient({ label: 'C-chan agent runner', sessionId: config.board?.sessionId ?? 'cchan-agent-runner',
  board: { configDir: config.board?.configDir ?? join(HOME, '.config', 'cchan-agent-runner', 'board'),
    pythonPath: config.board?.pythonPath ?? '/usr/bin/python3',
    connectPath: config.board?.connectPath ?? join(HOME, '.config', 'blackoutburst-board', 'connect.py') } });

const runner = new AgentRunner({ file: stateFile, ops: new SandboxOps(), log, limits: config.limits ?? {},
  reporter: new BoardReporter({ client: board, projects: config.projects, ownerId: config.ownerId, log }) });
runner.on('event', event => log(`event ${event.seq} ${event.type} ${event.runId ?? ''} #${event.ticketNumber ?? '?'} ${event.state ?? ''}`));

const watch = new BoardWatch({ client: board, projects: config.projects });
let boardState = { ok: null, at: null, error: null };
async function poll() {
  try {
    for (const event of await watch.poll()) runner.note(event);
    boardState = { ok: true, at: Date.now(), error: null };
  } catch (error) {
    if (boardState.ok !== false) log(`Board watch failed: ${error.code ?? error.message}`);
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

const STATUS = { INVALID: 400, NOT_FOUND: 404, BUSY: 409, QUEUE_FULL: 429, HARD_LIMIT: 403, PROVIDER_UNAVAILABLE: 409 };
const server = createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    const url = new URL(request.url, 'http://runner');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && url.pathname === '/status') {
      const runs = runner.list();
      return send(200, { limits: runner.limits, running: runs.filter(run => ['preparing', 'running', 'stopping'].includes(run.state)).length,
        queued: runs.filter(run => run.state === 'queued').length, board: boardState, projects: config.projects });
    }
    if (request.method === 'GET' && parts[0] === 'runs' && parts.length === 1) return send(200, { runs: runner.list({ active: url.searchParams.get('active') === '1' }) });
    if (request.method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
      const run = runner.get(parts[1]);
      return run ? send(200, { run }) : send(404, { error: { code: 'NOT_FOUND', message: 'No such run.' } });
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
    return send(404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
  } catch (error) {
    const code = error instanceof AgentRunnerError ? error.code : 'RUNNER_ERROR';
    if (!(error instanceof AgentRunnerError)) log(`request failed: ${error.message}`);
    return send(STATUS[code] ?? 500, { error: { code, message: error instanceof AgentRunnerError ? error.message : 'The runner failed.' } });
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
