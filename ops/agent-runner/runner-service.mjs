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
//                                    mode merge (#85): { mode: 'merge', agent (a merger), ticketId, repo, branch, requestId? }: refused unless C-chan
//                                    logged an accept citing an approving review of exactly this branch head; then merge, full suite, push
//   POST /runs/<id>/stop             stop a run (its unit and every child process)
//   GET  /events?after=N[&wait=S]    run and Board events after seq N; waits up to S seconds (max 30) for the next one
//   GET  /roster[?archived=1]        C-chan's agents and teams (#73)
//   POST /roster/agents              create an agent { name, role, model, kind?, ticketId?, actions?, repos?, skills?, instructions?, ... }
//   POST /roster/agents/<name>       update it { expectedVersion, ...changes }
//   POST /roster/agents/<name>/archive   { expectedVersion }
//   POST /roster/teams               create or update a team { name, purpose?, members?, expectedVersion? }
//   POST /roster/teams/<name>/archive    { expectedVersion, archiveMembers? }
//   GET  /manager                    manager mode (#76): approvals, budget, attention findings, recent decisions
//   POST /manager/approvals          { projectId, direction, requestId? }  a standing approval from Blackout (owner chat only)
//   POST /manager/approvals/<project>/revoke
//   POST /manager/decisions          { kind, ticketId|projectId, reason, reviewRunId? (accept/return), model?, agent?, requestId? }
// Routing lives in src/agent-runner-api.mjs.
import { createServer } from 'node:http';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { AgentRunner, AgentRunnerError } = await import(join(ROOT, 'src', 'agent-runner.mjs'));
const { OpsBoard } = await import(join(ROOT, 'src', 'agent-ops.mjs'));
const { SandboxOps } = await import(join(ROOT, 'src', 'agent-sandbox-ops.mjs'));
const { BoardReporter, BoardWatch, BoardRosterMirror } = await import(join(ROOT, 'src', 'agent-runner-board.mjs'));
const { Roster } = await import(join(ROOT, 'src', 'agent-roster.mjs'));
const { Manager, managerSweep } = await import(join(ROOT, 'src', 'agent-manager.mjs'));
const { createRunnerApi } = await import(join(ROOT, 'src', 'agent-runner-api.mjs'));
const { BoardClient } = await import(join(ROOT, 'src', 'board-client.mjs'));

const HOME = process.env.HOME ?? '/home/ubuntu';
const CONFIG = process.env.CCHAN_RUNNER_CONFIG ?? join(HOME, '.config', 'cchan-agent-runner', 'config.json');
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const socket = config.socket ?? join(HOME, 'personal-agent-data', 'agent-runner', 'runner.sock');
const stateFile = config.stateFile ?? join(HOME, 'personal-agent-data', 'agent-runner', 'runs.json');
const rosterFile = config.rosterFile ?? join(HOME, 'personal-agent-data', 'agent-runner', 'roster.json');
const managerFile = config.managerFile ?? join(HOME, 'personal-agent-data', 'agent-runner', 'manager.json');
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('config.projects: the Board projects agents may work in');
if (typeof config.ownerId !== 'string' || !config.ownerId) throw new Error('config.ownerId: who Needs-you questions go to');
const board = new BoardClient({ label: 'C-chan agent runner', sessionId: config.board?.sessionId ?? 'cchan-agent-runner',
  board: { configDir: config.board?.configDir ?? join(HOME, '.config', 'cchan-agent-runner', 'board'),
    pythonPath: config.board?.pythonPath ?? '/usr/bin/python3',
    connectPath: config.board?.connectPath ?? join(HOME, '.config', 'blackoutburst-board', 'connect.py') } });

const roster = new Roster({ file: rosterFile, log, mirror: config.boardRoster === false ? null : new BoardRosterMirror({ client: board, projects: config.projects }) });
// Manager mode (#76): standing approvals, budget, decisions. Its projects are the runner's (Blackout's) projects.
const manager = new Manager({ file: managerFile, projects: config.projects, log,
  ...(config.manager?.premiumMaxWeekly ? { premiumMaxWeekly: config.manager.premiumMaxWeekly } : {}) });
// Merge (#85): config.merge turns the merge step on; it needs `origin` (the push target, e.g. https://github.com/Blackoutburst/personal-agent.git). Defaults: Blackoutburst's configured git identity, `node --test`.
const runner = new AgentRunner({ file: stateFile, ops: new SandboxOps(), log, limits: config.limits ?? {}, roster, manager,
  merge: config.merge && typeof config.merge === 'object' ? config.merge : null,
  // Desktop release after a merge (#90, docs/MANAGER.md): off unless config.release.desktop is true.
  release: config.release?.desktop === true ? { dataDir: join(HOME, 'personal-agent-data'), ...config.release } : null,
  // Server deploy after a merge (#100, docs/MANAGER.md): off unless config.deploy.server is true. selfCommit: the release
  // this process runs from (~/personal-agent/releases/<sha>), which the guard waits for after a runner restart.
  deploy: config.deploy?.server === true ? { releaseRoot: join(HOME, 'personal-agent'), dataDir: join(HOME, 'personal-agent-data'),
    repo: join(HOME, '.cache', 'cchan-agent-runner', 'deploy.git'), releaseTool: join(ROOT, 'ops', 'release.mjs'),
    stateFile: join(dirname(stateFile), 'deploy.json'), ...config.deploy, selfCommit: /^[0-9a-f]{40}$/.test(basename(realpathSync(ROOT))) ? basename(realpathSync(ROOT)) : null } : null,
  reporter: new BoardReporter({ client: board, projects: config.projects, ownerId: config.ownerId, log }) });
runner.on('event', event => log(`event ${event.seq} ${event.type} ${event.runId ?? ''} #${event.ticketNumber ?? '?'} ${event.state ?? event.kind ?? ''}`));

const opsBoard = new OpsBoard({ client: board, projects: config.projects });
const watch = new BoardWatch({ client: board, projects: config.projects });
let boardState = { ok: null, at: null, error: null };
async function poll() {
  try {
    const events = await watch.poll();
    for (const event of events) runner.note(event);
    boardState = { ok: true, at: Date.now(), error: null };
    managerSweep({ manager, runner, tickets: watch.tickets(), boardEvents: events });
    await roster.resync();
  } catch (error) {
    if (boardState.ok !== false) log(`Board watch failed: ${error.code ? `${error.code}: ${error.message}` : error.message}`);
    boardState = { ok: false, at: Date.now(), error: String(error.code ?? 'ERROR') };
  }
}
const watchTimer = setInterval(poll, Math.max(10, config.watchSeconds ?? 20) * 1000);

const api = createRunnerApi({ runner, roster, manager, opsBoard, projects: config.projects, boardState: () => boardState,
  tickets: () => watch.tickets(), log });

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new AgentRunnerError('INVALID', 'Body too large.'); chunks.push(chunk); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new AgentRunnerError('INVALID', 'Body must be JSON.'); }
}

const server = createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  let parsed = {};
  if (request.method === 'POST') {
    try { parsed = await body(request); } catch (error) { return send(400, { error: { code: 'INVALID', message: error.message } }); }
  }
  const answer = await api(request.method, request.url, parsed);
  return send(answer.status, answer.body);
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
