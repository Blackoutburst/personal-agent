// The server deploy after a merge (#100): what to restart from what changed, the real release tool (ops/release.mjs)
// driven by deployServer with a fake systemctl and a loopback health server (deploy, health failure -> rollback), the
// bounded wait for an idle companion, the root script with fake systemctl/systemd-run (run as non-root), the runner
// guard against a fake systemd (healthy, no ack -> rollback, restart refused, links moved), and the runner wiring.
// Nothing here runs sudo, the real systemctl or touches ~/personal-agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { planDeploy, runnerFiles, deployServer, companionIdle, activityWriter, releaseLink, waitUntil, readJson, writeJson, ackFile } from '../src/server-deploy.mjs';
import { guardRunner } from '../ops/deploy/runner-guard.mjs';
import { AgentRunner } from '../src/agent-runner.mjs';
import { BoardReporter } from '../src/agent-runner-board.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { Roster } from '../src/agent-roster.mjs';
import { SandboxOps } from '../src/agent-sandbox-ops.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID = ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV }).trim();
const tmp = (t, prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const sh = (path, body) => { writeFileSync(path, body); chmodSync(path, 0o755); return path; };

// ---------- What to restart ----------

test('plan: docs/tests/client-only changes deploy nothing; server code restarts the companion; runner code also the runner (#100)', async () => {
  const files = await runnerFiles(path => { try { return readFileSync(join(ROOT, path), 'utf8'); } catch { return null; } });
  for (const path of ['ops/agent-runner/runner-service.mjs', 'src/agent-runner.mjs', 'src/agent-merge.mjs', 'src/server-deploy.mjs', 'src/board-client.mjs']) {
    assert.ok(files.has(path), `${path} is loaded by the runner`);
  }
  for (const path of ['server.mjs', 'src/conversations.mjs', 'public/companion-app.mjs']) assert.ok(!files.has(path), `${path} is not the runner's`);

  assert.deepEqual(planDeploy(['docs/MANAGER.md', 'test/x.test.mjs', 'desktop/main.js', 'android/app/build.gradle', 'README.md', 'scripts/build-desktop.sh'], files),
    { deploy: false, companion: false, runner: false, reinstall: false, paths: ['docs/MANAGER.md', 'test/x.test.mjs', 'desktop/main.js', 'android/app/build.gradle', 'README.md', 'scripts/build-desktop.sh'] });
  const server = planDeploy(['public/bubbles.mjs', 'docs/COMPANION.md'], files);
  assert.equal(server.deploy, true); assert.equal(server.companion, true); assert.equal(server.runner, false);
  const runner = planDeploy(['src/agent-runner.mjs'], files);
  assert.equal(runner.companion, true, 'switching current always restarts the companion through the release tool');
  assert.equal(runner.runner, true);
  assert.equal(planDeploy(['package-lock.json'], files).runner, true, 'dependencies are shared');
  assert.equal(planDeploy(['ops/deploy/cchan-deploy'], files).reinstall, true);
  assert.deepEqual(planDeploy(null, files), { deploy: true, companion: true, runner: true, reinstall: false, paths: null }, 'no deployed release: everything');
});

test('idle: no file, busy 0 or a dead writer is idle; a live busy writer is not; waitUntil is bounded (#100)', async t => {
  const dir = tmp(t, 'deploy-idle-'), file = join(dir, 'companion-activity.json');
  assert.equal(companionIdle(file), true);
  activityWriter(file)(1);
  assert.equal(companionIdle(file), false, 'this process is alive and busy');
  activityWriter(file)(0);
  assert.equal(companionIdle(file), true);
  writeJson(file, { busy: 2, pid: 999999999, at: 1 });
  assert.equal(companionIdle(file, { alive: () => false }), true, 'a stale file from a crashed companion');
  let clock = 0;
  const sleep = async ms => { clock += ms; };
  assert.deepEqual(await waitUntil(() => false, { timeoutMs: 10_000, intervalMs: 2000, sleep, now: () => clock }), { ok: false, waitedMs: 10_000 });
  clock = 0; let calls = 0;
  assert.deepEqual(await waitUntil(() => ++calls >= 3, { timeoutMs: 10_000, intervalMs: 2000, sleep, now: () => clock }), { ok: true, waitedMs: 4000 });
});

// ---------- deployServer with the real release tool ----------

// origin (bare) with an initial commit released by the real tool, a loopback health server that fails when the selected
// release contains BROKEN, and a fake systemctl that logs its arguments.
async function world(t) {
  const base = tmp(t, 'deploy-100-');
  const origin = join(base, 'origin.git'), seed = join(base, 'seed'), root = join(base, 'install'), data = join(base, 'data');
  const bin = join(base, 'bin'), log = join(base, 'systemctl.log');
  for (const path of [root, data, bin]) mkdirSync(path, { mode: 0o700 });
  git(base, 'init', '--bare', '--quiet', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '--quiet', '-b', 'main');
  mkdirSync(join(seed, 'src')); mkdirSync(join(seed, 'docs')); mkdirSync(join(seed, 'ops', 'agent-runner'), { recursive: true });
  writeFileSync(join(seed, 'server.mjs'), 'export const v = 1;\n');
  writeFileSync(join(seed, 'src', 'agent-runner.mjs'), 'export const r = 1;\n');
  writeFileSync(join(seed, 'ops', 'agent-runner', 'runner-service.mjs'), "import { r } from '../../src/agent-runner.mjs';\n");
  writeFileSync(join(seed, 'docs', 'X.md'), 'x\n');
  git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', 'first'); git(seed, 'push', '--quiet', 'origin', 'main');
  const first = git(seed, 'rev-parse', 'HEAD');
  const db = new DatabaseSync(join(data, 'bootstrap.sqlite')); db.exec('CREATE TABLE t (x)'); db.close(); chmodSync(join(data, 'bootstrap.sqlite'), 0o600);
  const systemctl = sh(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  let broken = () => existsSync(join(root, 'current', 'BROKEN'));
  const server = createServer((request, response) => {
    const ok = request.url === '/api/status' && !broken();
    response.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ service: { mode: 'account' }, storage: { state: 'ready' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const healthUrl = `http://127.0.0.1:${server.address().port}/api/status`;
  const env = { ...process.env, COMPANION_RELEASE_ROOT: root, COMPANION_RELEASE_REPO: seed, COMPANION_DATA_DIR: data, COMPANION_SYSTEMCTL: systemctl, COMPANION_HEALTH_URL: healthUrl };
  // Async: the health server answers from this process, so its event loop must keep running.
  const initial = await new Promise(resolve => execFile(process.execPath, [join(ROOT, 'ops', 'release.mjs'), 'release', first], { env, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stderr })));
  assert.equal(initial.status, 0, initial.stderr);
  writeFileSync(log, '');
  const push = (files, message) => {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(seed, path)), { recursive: true }); writeFileSync(join(seed, path), content); }
    git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', message); git(seed, 'push', '--quiet', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  const options = commit => ({ origin, commit, repo: join(base, 'cache', 'deploy.git'), releaseRoot: root, dataDir: data, releaseTool: join(ROOT, 'ops', 'release.mjs'),
    systemctl, healthUrl, idleWaitMs: 0 });
  return { base, root, data, first, push, options, log: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), setBroken: fn => { broken = fn; } };
}

test('deploy: a server change is released with the real tool, the companion restarted and health-checked; the runner untouched (#100)', async t => {
  const w = await world(t);
  const commit = w.push({ 'server.mjs': 'export const v = 2;\n' }, 'server change');
  const result = await deployServer(w.options(commit));
  assert.equal(result.status, 'deployed', result.output);
  assert.equal(result.previous, w.first);
  assert.deepEqual({ companion: result.plan.companion, runner: result.plan.runner }, { companion: true, runner: false });
  assert.equal(releaseLink(w.root, 'current'), commit); assert.equal(releaseLink(w.root, 'previous'), w.first);
  assert.equal(result.release.current, commit);
  assert.deepEqual(w.log(), ['stop personal-agent-account.service', 'start personal-agent-account.service']);
  assert.equal(readFileSync(join(w.root, 'current', 'server.mjs'), 'utf8'), 'export const v = 2;\n');
});

test('deploy: runner code changed: the plan restarts the runner too (#100)', async t => {
  const w = await world(t);
  const commit = w.push({ 'src/agent-runner.mjs': 'export const r = 2;\n' }, 'runner change');
  const result = await deployServer(w.options(commit));
  assert.equal(result.status, 'deployed', result.output);
  assert.equal(result.plan.runner, true);
});

test('deploy: docs-only changes, an already deployed commit and a commit not on main deploy nothing (#100)', async t => {
  const w = await world(t);
  const docs = w.push({ 'docs/X.md': 'y\n' }, 'docs');
  const skipped = await deployServer(w.options(docs));
  assert.deepEqual([skipped.status, skipped.reason], ['skipped', 'nothing_to_deploy']);
  assert.equal(releaseLink(w.root, 'current'), w.first); assert.deepEqual(w.log(), []);
  const same = await deployServer(w.options(w.first));
  assert.deepEqual([same.status, same.reason], ['skipped', 'already_deployed']);
  const orphan = await deployServer(w.options('d'.repeat(40)));
  assert.equal(orphan.status, 'error'); assert.match(orphan.output, /not on origin\/main/);
  assert.deepEqual(w.log(), []);
});

test('deploy: a failed health check rolls back to the previous release (real tool) and says so (#100)', async t => {
  const w = await world(t);
  const commit = w.push({ 'server.mjs': 'export const v = 3;\n', BROKEN: 'x' }, 'broken server');
  const result = await deployServer(w.options(commit));
  assert.equal(result.status, 'rolled_back', result.output);
  assert.equal(result.errorCode, 'HEALTH');
  assert.equal(releaseLink(w.root, 'current'), w.first, 'the previous release is selected again');
  assert.deepEqual(w.log(), ['stop personal-agent-account.service', 'start personal-agent-account.service',
    'stop personal-agent-account.service', 'start personal-agent-account.service']);
});

test('deploy: waits for the companion to be idle before stopping it, and the wait is bounded (#100)', async t => {
  const w = await world(t);
  let clock = 0, busyUntil = 6000, checks = 0, stops = 0;
  const sleep = async ms => { clock += ms; };
  const idle = () => { checks++; assert.equal(w.log().length, stops, 'not stopped while a turn runs'); return clock >= busyUntil; };
  const commit = w.push({ 'server.mjs': 'export const v = 4;\n' }, 'change');
  const result = await deployServer({ ...w.options(commit), idleWaitMs: 60_000, idleIntervalMs: 2000, sleep, now: () => clock, idle });
  assert.equal(result.status, 'deployed', result.output);
  assert.deepEqual(result.idle, { ok: true, waitedMs: 6000 }); assert.equal(checks, 4);

  clock = 0; busyUntil = Infinity; stops = w.log().length;
  const next = w.push({ 'server.mjs': 'export const v = 5;\n' }, 'change 2');
  const bounded = await deployServer({ ...w.options(next), idleWaitMs: 10_000, idleIntervalMs: 2000, sleep, now: () => clock, idle });
  assert.equal(bounded.status, 'deployed', 'after the bound it goes ahead');
  assert.deepEqual(bounded.idle, { ok: false, waitedMs: 10_000 });
});

test('deploy: a refusing release tool keeps the previous release (#100)', async t => {
  const w = await world(t);
  const commit = w.push({ 'server.mjs': 'export const v = 6;\n' }, 'change');
  writeFileSync(join(w.root, '.release-lock'), 'held');
  const result = await deployServer(w.options(commit));
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'LOCKED');
  assert.equal(releaseLink(w.root, 'current'), w.first);
});

// ---------- The root script and sudoers rule ----------

const DEPLOY = join(ROOT, 'ops', 'deploy', 'cchan-deploy');
function fakeBin(t) {
  const dir = tmp(t, 'deploy-bin-'), log = join(dir, 'calls.log');
  sh(join(dir, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n`);
  sh(join(dir, 'systemd-run'), `#!/bin/sh\necho "systemd-run $*" >> "${log}"\n`);
  return { dir, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('root script: four fixed verbs, fixed units and paths, nothing else (#100)', { skip: process.getuid?.() === 0 && 'runs as non-root only' }, t => {
  const bin = fakeBin(t), env = { PATH: '/usr/bin:/bin', CCHAN_DEPLOY_TEST_BIN: bin.dir };
  const call = (...args) => spawnSync('/bin/sh', [DEPLOY, ...args], { env, encoding: 'utf8' });
  for (const verb of ['stop-companion', 'start-companion', 'restart-runner', 'guard-runner']) assert.equal(call(verb).status, 0, verb);
  assert.deepEqual(bin.calls(), [
    'systemctl stop personal-agent-account.service',
    'systemctl start personal-agent-account.service',
    'systemctl --no-block restart cchan-agent-runner.service',
    'systemd-run --unit=cchan-deploy-guard --collect --no-block --quiet --uid=ubuntu --gid=ubuntu --working-directory=/home/ubuntu '
      + '--property=UMask=0077 --property=PrivateTmp=true --property=RuntimeMaxSec=1800 --setenv=HOME=/home/ubuntu '
      + '--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin /opt/blackoutburst-platform-runtime/node-v24.22.1 /usr/local/lib/cchan-deploy/runner-guard.mjs'
  ]);
  for (const args of [[], ['stop-companion', 'x'], ['restart'], ['stop-companion;id'], ['--help'], ['guard-runner', '/tmp/evil.mjs']]) {
    assert.equal(call(...args).status, 64, JSON.stringify(args));
  }
  assert.equal(bin.calls().length, 4, 'refused calls run nothing');
});

test('root script review: no caller input reaches a command, the test override is non-root only; sudoers lists exactly four lines (#100)', () => {
  const script = readFileSync(DEPLOY, 'utf8');
  const code = script.split('\n').filter(line => !line.trim().startsWith('#'));
  assert.ok(!code.some(line => /\$(2|@|\*|\{2|\{@)/.test(line)), 'no argument but the verb is ever used');
  assert.ok(code.some(line => /\[ "\$#" -eq 1 \]/.test(line)), 'exactly one argument');
  assert.match(script, /\[ "\$\(id -u\)" != 0 \] && \[ -n "\$\{CCHAN_DEPLOY_TEST_BIN:-\}" \]/);
  assert.match(script, /^SYSTEMCTL=\/usr\/bin\/systemctl$/m); assert.match(script, /^SYSTEMD_RUN=\/usr\/bin\/systemd-run$/m);
  assert.match(script, /--uid=ubuntu --gid=ubuntu/, 'the guard never runs as root');
  assert.ok(!/personal-agent\/(current|releases)/.test(code.join('\n')), 'nothing from a release directory is executed');
  const sudoers = readFileSync(join(ROOT, 'ops', 'deploy', 'cchan-deploy.sudoers'), 'utf8').split('\n').filter(line => line && !line.startsWith('#')).join(' ').replace(/\\\s+/g, ' ');
  const commands = /Cmnd_Alias CCHAN_DEPLOY = (.*?) ubuntu/.exec(sudoers)[1].split(',').map(item => item.trim());
  assert.deepEqual(commands, ['stop-companion', 'start-companion', 'restart-runner', 'guard-runner'].map(verb => `/usr/local/sbin/cchan-deploy ${verb}`));
  assert.match(sudoers, /ubuntu ALL=\(root\) NOPASSWD: CCHAN_DEPLOY\s*$/);
  const install = readFileSync(join(ROOT, 'ops', 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /visudo -cf/); assert.match(install, /-o root -g root -m 0440 "\$tmp" \/etc\/sudoers\.d\/cchan-deploy/);
  const helper = spawnSync('/bin/sh', [join(ROOT, 'ops', 'deploy', 'systemctl-deploy'), 'restart', 'personal-agent-account.service'], { encoding: 'utf8' });
  assert.equal(helper.status, 64, 'the release helper refuses anything but stop/start of the companion');
  assert.equal(spawnSync('/bin/sh', [join(ROOT, 'ops', 'deploy', 'systemctl-deploy'), 'stop', 'cchan-agent-runner.service']).status, 64);
});

// ---------- The guard against a fake systemd ----------

// A fake systemd for the guard: `sudo -n cchan-deploy restart-runner` "starts" a new runner (newRunner decides whether it
// acknowledges and stays up); `systemctl show` reports the unit. The previous release has a fake release.mjs whose
// rollback swaps the links like the real one.
function guardWorld(t, { newRunner = 'healthy', restartOk = true } = {}) {
  const base = tmp(t, 'guard-100-'), root = join(base, 'install'), state = join(base, 'agent-runner', 'deploy.json');
  const prev = 'a'.repeat(40), next = 'b'.repeat(40);
  for (const sha of [prev, next]) mkdirSync(join(root, 'releases', sha, 'ops'), { recursive: true });
  writeFileSync(join(root, 'releases', prev, 'ops', 'release.mjs'), `import { symlinkSync, renameSync, appendFileSync } from 'node:fs';
const root = process.env.COMPANION_RELEASE_ROOT;
appendFileSync(root + '/rollback.log', process.argv.slice(2).join(' ') + ' ' + process.env.COMPANION_SYSTEMCTL + '\\n');
symlinkSync('releases/${prev}', root + '/.c'); renameSync(root + '/.c', root + '/current');
symlinkSync('releases/${next}', root + '/.p'); renameSync(root + '/.p', root + '/previous');
console.log(JSON.stringify({ current: '${prev}', previous: '${next}' }));
`);
  symlinkSync(`releases/${next}`, join(root, 'current')); symlinkSync(`releases/${prev}`, join(root, 'previous'));
  writeJson(state, { status: 'pending', phase: 'runner_restart', runId: 'merger-1-x', commit: next, previous: prev, releaseRoot: root, repo: '/repo', dataDir: '/data' });
  const unit = { active: true, pid: 100 }, calls = [];
  let clock = 0, restarts = 0;
  const run = async (binary, args, options = {}) => {
    calls.push([binary, ...args].join(' '));
    if (binary === 'sudo') {
      assert.deepEqual(args, ['-n', '/usr/local/sbin/cchan-deploy', 'restart-runner']);
      if (!restartOk) return { ok: false, stdout: '', output: 'sudo: a password is required' };
      restarts++;
      const pid = 100 + restarts;
      if (restarts > 1 || newRunner === 'healthy') { unit.active = true; unit.pid = pid; if (restarts === 1) writeJson(ackFile(state), { commit: next, pid }); }
      else if (newRunner === 'crash') { unit.active = false; unit.pid = 0; }
      else if (newRunner === 'dies') { unit.active = true; unit.pid = pid; writeJson(ackFile(state), { commit: next, pid }); setTimeout(() => {}, 0); unit.dieAt = clock + 5000; }
      return { ok: true, stdout: '', output: '' };
    }
    if (binary === 'systemctl') {
      if (unit.dieAt !== undefined && clock >= unit.dieAt) { unit.active = true; unit.pid = 999; delete unit.dieAt; } // systemd restarted it: new pid
      return { ok: true, stdout: `ActiveState=${unit.active ? 'active' : 'failed'}\nMainPID=${unit.pid}`, output: '' };
    }
    const r = spawnSync(binary, args, { env: options.env, encoding: 'utf8' });
    return { ok: r.status === 0, stdout: r.stdout.trim(), output: `${r.stdout}${r.stderr}` };
  };
  const guard = extra => guardRunner({ stateFile: state, sudo: 'sudo', systemctl: 'systemctl', run, sleep: async ms => { clock += ms; }, now: () => clock,
    graceMs: 1000, startTimeoutMs: 30_000, settleMs: 10_000, pollMs: 1000, ...extra });
  return { base, root, state, prev, next, calls, guard, restarts: () => restarts };
}

test('guard: restarts the runner, sees the new one acknowledge and stay up: deployed (#100)', async t => {
  const g = guardWorld(t);
  const result = await g.guard();
  assert.equal(result.status, 'deployed'); assert.equal(result.runner, 'healthy');
  assert.equal(readJson(g.state).status, 'deployed');
  assert.equal(g.restarts(), 1); assert.equal(releaseLink(g.root, 'current'), g.next);
  assert.ok(!existsSync(join(g.root, 'rollback.log')));
});

for (const [kind, why] of [['crash', /did not acknowledge/], ['dies', /did not stay up/]]) {
  test(`guard: a new runner that ${kind === 'crash' ? 'never comes up' : 'dies after starting'} is rolled back with the previous release's tool and restarted (#100)`, async t => {
    const g = guardWorld(t, { newRunner: kind });
    const result = await g.guard();
    assert.equal(result.status, 'rolled_back', result.output);
    assert.match(result.reason, why);
    assert.equal(releaseLink(g.root, 'current'), g.prev, 'current points at the previous release again');
    assert.equal(readFileSync(join(g.root, 'rollback.log'), 'utf8').trim(), 'rollback /usr/local/lib/cchan-deploy/systemctl-deploy');
    assert.equal(g.restarts(), 2, 'restarted again so it runs the previous code');
    assert.equal(result.runnerRestart, 'requested');
  });
}

test('guard: a refused restart leaves the old runner running and reports it; moved links are not rolled back (#100)', async t => {
  const refused = guardWorld(t, { restartOk: false });
  const r1 = await refused.guard();
  assert.equal(r1.status, 'runner_restart_failed'); assert.match(r1.output, /password/);
  const moved = guardWorld(t, { newRunner: 'crash' });
  rmSync(join(moved.root, 'previous')); symlinkSync(`releases/${'c'.repeat(40)}`, join(moved.root, 'previous'));
  const r2 = await moved.guard();
  assert.equal(r2.status, 'rollback_failed'); assert.match(r2.output, /links changed/);
  assert.ok(!existsSync(join(moved.root, 'rollback.log')));
  const nothing = guardWorld(t); writeJson(nothing.state, { status: 'deployed' });
  assert.equal((await nothing.guard()).status, 'nothing');
});

// ---------- Self-restart across real processes, with a fake sudo, fake systemd-run and fake systemctl ----------

// P1 (the old runner, a real AgentRunner) merges, "deploys" (fake deployServer), hands its restart to the guard through
// SandboxOps.startRunnerGuard -> fake sudo -> ops/deploy/cchan-deploy guard-runner (test mode) -> fake systemd-run, which
// starts the real guard detached; P1 then exits. The guard restarts the runner through the same chain (fake systemctl
// starts P2, a real AgentRunner on the deployed commit), sees P2 acknowledge and stay up, and P2 reports the deploy.
test('self-restart: the guard outlives the runner that started it, restarts it and the new runner reports the deploy (#100)', { timeout: 60_000 }, async t => {
  const base = tmp(t, 'selfrestart-100-'), bin = join(base, 'bin'), dataDir = join(base, 'agent-runner');
  mkdirSync(bin); mkdirSync(dataDir);
  const stateFile = join(dataDir, 'deploy.json'), runsFile = join(dataDir, 'runs.json'), commit = 'e'.repeat(40);
  const node = process.execPath, guard = join(ROOT, 'ops', 'deploy', 'runner-guard.mjs');
  // The runner script: role old (merge + deploy + hand over, then exit) or new (recover, report, exit when done).
  const runnerScript = join(base, 'runner.mjs');
  writeFileSync(runnerScript, `
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const { AgentRunner } = await import(${JSON.stringify(join(ROOT, 'src', 'agent-runner.mjs'))});
const { SandboxOps } = await import(${JSON.stringify(join(ROOT, 'src', 'agent-sandbox-ops.mjs'))});
const { Roster } = await import(${JSON.stringify(join(ROOT, 'src', 'agent-roster.mjs'))});
const { Manager } = await import(${JSON.stringify(join(ROOT, 'src', 'agent-manager.mjs'))});
const role = process.argv[2], dir = ${JSON.stringify(dataDir)}, commit = ${JSON.stringify(commit)};
const posts = [];
const reporter = { async beginMerge() { return { number: 100, title: 'Deploy' }; }, async finish() { return { done: true }; }, async deploy(run) { posts.push(run.deploy.status + ':' + (run.deploy.runner ?? '')); writeFileSync(dir + '/posts-' + role, JSON.stringify(posts)); } };
const sandbox = new SandboxOps({ sudo: ${JSON.stringify(join(bin, 'sudo'))} });
const ops = { async branchInfo() { return { head: 'a'.repeat(40), commits: 1 }; }, async merge() { return { status: 'merged', mergeCommit: commit, output: 'ok' }; },
  async deployServer() { return { status: 'deployed', commit, previous: 'f'.repeat(40), plan: { companion: true, runner: true }, idle: { ok: true, waitedMs: 0 }, output: 'released' }; },
  startRunnerGuard: () => sandbox.startRunnerGuard({ deployCli: ${JSON.stringify(DEPLOY)} }), async unitActive() { return false; }, async stopUnit() {} };
const roster = new Roster({ file: dir + '/roster.json' });
const manager = new Manager({ file: dir + '/manager.json', projects: ['proj'] });
const runner = new AgentRunner({ file: dir + '/runs.json', ops, reporter, roster, manager, merge: { origin: '/origin' },
  deploy: { server: true, stateFile: dir + '/deploy.json', selfCommit: role === 'new' ? commit : 'f'.repeat(40), releaseRoot: '/none', repo: '/none', dataDir: '/none', watchMs: 50, runnerPollMs: 10 } });
if (role === 'old') {
  if (!roster.get('merger-1')) roster.create({ name: 'merger-1', role: 'merger', kind: 'standing', model: 'sonnet' });
  manager.decide({ kind: 'accept', ticketId: 'ticket-100', reviewRunId: 'rev-1-bbbbbb', reason: 'approved' }, runner.list());
  runner.launch({ mode: 'merge', agent: 'merger-1', ticketId: 'ticket-100', repo: 'personal-agent', branch: 'agent/coder-1/t100' });
  // Exit as systemd would stop us, as soon as the guard was handed the restart.
  const timer = setInterval(() => { const run = runner.list().find(item => item.mode === 'merge'); if (run?.deploy?.status === 'runner_restarting' && existsSync(dir + '/guard-started')) { process.exit(0); } }, 20);
} else {
  await runner.recover();
  const timer = setInterval(() => { const run = runner.list().find(item => item.mode === 'merge'); if (run?.deploy?.status === 'deployed') { writeFileSync(dir + '/done', JSON.stringify(run.deploy)); setTimeout(() => process.exit(0), 300); } }, 20);
}
`);
  // Seed runs.json with the reviewed work so the merge gate passes (as in the desktop release tests).
  const HEAD = 'a'.repeat(40), BRANCH = 'agent/coder-1/t100';
  writeFileSync(runsFile, JSON.stringify({ runs: [
    { id: 'coder-1-aaaaaa', agent: 'coder-1', ticketId: 'ticket-100', ticketNumber: 100, repo: 'personal-agent', base: 'main', mode: 'work', branch: BRANCH, head: HEAD, commits: 1, state: 'succeeded', endedAt: 1000, createdAt: 900, cleanup: {} },
    { id: 'rev-1-bbbbbb', agent: 'rev-1', role: 'reviewer', ticketId: 'ticket-100', ticketNumber: 100, repo: 'personal-agent', base: 'main', mode: 'review', reviewBranch: BRANCH, reviewHead: HEAD, state: 'succeeded', endedAt: 2000, createdAt: 1500, result: { kind: 'review', verdict: 'approve' }, cleanup: {} }
  ], events: [], seq: 0 }));
  // Fake sudo: drop -n and run the command as ourselves (the root script then uses CCHAN_DEPLOY_TEST_BIN, non-root only).
  sh(join(bin, 'sudo'), `#!/bin/sh\n[ "$1" = -n ] || exit 1\nshift\necho "sudo $*" >> "${base}/sudo.log"\nexec env CCHAN_DEPLOY_TEST_BIN="${bin}" /bin/sh "$@"\n`);
  // Fake systemd-run: start the real guard detached in its own session (like a transient unit), with test overrides.
  const guardTest = JSON.stringify({ sudo: join(bin, 'sudo'), systemctl: join(bin, 'systemctl'), deployCli: DEPLOY, graceMs: 200, settleMs: 600, pollMs: 50, startTimeoutMs: 15000 });
  sh(join(bin, 'systemd-run'), `#!/bin/sh\necho "systemd-run $*" >> "${base}/systemd.log"\ntouch "${dataDir}/guard-started"\nCCHAN_DEPLOY_STATE="${stateFile}" CCHAN_GUARD_TEST='${guardTest}' setsid "${node}" "${guard}" > "${base}/guard.out" 2>&1 < /dev/null &\nexit 0\n`);
  // Fake systemctl: restart starts P2 detached and records its pid; show reports it.
  sh(join(bin, 'systemctl'), `#!/bin/sh
echo "systemctl $*" >> "${base}/systemd.log"
case "$*" in
  "--no-block restart cchan-agent-runner.service") setsid "${node}" "${runnerScript}" new > "${base}/p2.out" 2>&1 < /dev/null & echo $! > "${base}/mainpid"; exit 0 ;;
  "show cchan-agent-runner.service -p ActiveState -p MainPID") pid=$(cat "${base}/mainpid" 2>/dev/null || echo 0); if [ "$pid" != 0 ] && kill -0 "$pid" 2>/dev/null; then echo ActiveState=active; else echo ActiveState=inactive; fi; echo "MainPID=$pid"; exit 0 ;;
esac
exit 1
`);
  const old = spawnSync(node, [runnerScript, 'old'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(old.status, 0, old.stderr);
  assert.ok(!existsSync(join(dataDir, 'done')), 'the old runner exited before the deploy finished');
  const ok = await waitUntil(() => existsSync(join(dataDir, 'done')), { timeoutMs: 30_000, intervalMs: 100 });
  assert.ok(ok.ok, `guard: ${existsSync(join(base, 'guard.out')) ? readFileSync(join(base, 'guard.out'), 'utf8') : 'no output'}; p2: ${existsSync(join(base, 'p2.out')) ? readFileSync(join(base, 'p2.out'), 'utf8') : 'none'}`);
  const final = JSON.parse(readFileSync(join(dataDir, 'done'), 'utf8'));
  assert.equal(final.status, 'deployed'); assert.equal(final.runner, 'healthy');
  assert.deepEqual(final.units, ['personal-agent-account.service', 'cchan-agent-runner.service']);
  assert.deepEqual(readFileSync(join(base, 'sudo.log'), 'utf8').trim().split('\n'), [
    `sudo ${DEPLOY} guard-runner`, `sudo ${DEPLOY} restart-runner`]);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'posts-old'), 'utf8')), ['runner_restarting:']);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'posts-new'), 'utf8')), ['deployed:healthy']);
  assert.ok(!existsSync(stateFile) && !existsSync(ackFile(stateFile)), 'the shared files are cleared after reporting');
  const runs = JSON.parse(readFileSync(runsFile, 'utf8'));
  const line = runs.events.find(event => event.type === 'manager.attention' && event.kind === 'deployed');
  assert.ok(line, 'one Manager line for the deploy'); assert.match(line.suggestion, /#100: deployed eeeeeeeeee .*cchan-agent-runner\.service.*health check passed/);
});

// ---------- The runner wiring, with fakes ----------

const TICKET = 'ticket-100', HEAD = 'a'.repeat(40), MERGED = 'c'.repeat(40), BRANCH = 'agent/coder-1/t100';
function setup(t, { deploy = { server: true }, deployResult = { status: 'deployed', commit: MERGED, previous: 'b'.repeat(40), plan: { companion: true, runner: false }, idle: { ok: true, waitedMs: 0 }, output: 'released' },
  guardError = null, active = [] } = {}) {
  const dir = tmp(t, 'deploy-runner-100-');
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ runs: [
    { id: 'coder-1-aaaaaa', agent: 'coder-1', ticketId: TICKET, ticketNumber: 100, repo: 'personal-agent', base: 'main', mode: 'work', branch: BRANCH, head: HEAD, commits: 1, state: 'succeeded', endedAt: 1000, createdAt: 900, cleanup: {} },
    { id: 'rev-1-bbbbbb', agent: 'rev-1', role: 'reviewer', ticketId: TICKET, ticketNumber: 100, repo: 'personal-agent', base: 'main', mode: 'review', reviewBranch: BRANCH, reviewHead: HEAD, state: 'succeeded', endedAt: 2000, createdAt: 1500, result: { kind: 'review', verdict: 'approve' }, cleanup: {} },
    ...active
  ], events: [], seq: 0 }));
  const roster = new Roster({ file: join(dir, 'roster.json') });
  roster.create({ name: 'merger-1', role: 'merger', kind: 'standing', model: 'sonnet' });
  const manager = new Manager({ file: join(dir, 'manager.json'), projects: ['proj'] });
  const calls = { deploy: [], guard: 0, posts: [] };
  const ops = {
    async branchInfo() { return { head: HEAD, commits: 1 }; },
    async merge() { return { status: 'merged', mergeCommit: MERGED, output: 'ok' }; },
    async deployServer(request) { calls.deploy.push(request); if (deployResult instanceof Error) throw deployResult; return deployResult; },
    async startRunnerGuard() { calls.guard++; if (guardError) throw guardError; return { started: true }; },
    async unitActive() { return false; }, async stopUnit() {}
  };
  const client = { async call(tool, args) {
    if (tool === 'get_ticket') return { id: TICKET, number: 100, title: 'Deploy', status: 'review', project_id: 'proj', thread_id: 'thread-100', version: 1 };
    if (tool === 'post_message') calls.posts.push(args.body);
    return { version: 2 };
  } };
  const reporter = new BoardReporter({ client, projects: ['proj'], ownerId: 'owner' });
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops, reporter, roster, manager, merge: { origin: '/origin' },
    deploy: deploy && { stateFile: join(dir, 'deploy.json'), releaseRoot: '/r', repo: '/m', dataDir: '/d', watchMs: 20, runnerPollMs: 5, ...deploy } });
  t.after(() => runner.close());
  manager.decide({ kind: 'accept', ticketId: TICKET, reviewRunId: 'rev-1-bbbbbb', reason: 'approved' }, runner.list());
  const merged = async (until = run => !run.deploy || !['running', 'runner_waiting'].includes(run.deploy.status)) => {
    const run = runner.launch({ mode: 'merge', agent: 'merger-1', ticketId: TICKET, repo: 'personal-agent', branch: BRANCH });
    const ok = await waitUntil(() => { const now = runner.get(run.id); return ['succeeded', 'failed'].includes(now.state) && (deploy?.server !== true || now.deploy) && until(now); }, { timeoutMs: 5000, intervalMs: 5 });
    assert.ok(ok.ok, 'timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
    return runner.get(run.id);
  };
  const lines = () => runner.events(0).filter(event => event.type === 'manager.attention' && event.kind?.startsWith('deploy'));
  return { dir, runner, calls, merged, lines };
}

test('runner: with config.deploy on, a merge deploys from the merge commit, posts and raises a "deployed" Manager line (#100)', async t => {
  const s = setup(t);
  const run = await s.merged();
  assert.equal(s.calls.deploy.length, 1);
  assert.deepEqual({ commit: s.calls.deploy[0].commit, origin: s.calls.deploy[0].origin, base: s.calls.deploy[0].base }, { commit: MERGED, origin: '/origin', base: 'main' });
  assert.equal(run.deploy.status, 'deployed'); assert.deepEqual(run.deploy.units, ['personal-agent-account.service']); assert.equal(run.deploy.health, 'passed');
  assert.equal(s.calls.guard, 0, 'runner code did not change: no runner restart');
  assert.ok(s.calls.posts.some(body => /^Deployed cccccccccc to the server\. Restarted: personal-agent-account\.service\. Health check passed/.test(body)), s.calls.posts.join('\n'));
  const [line] = s.lines();
  assert.equal(line.kind, 'deployed'); assert.match(line.suggestion, /#100: deployed cccccccccc .*personal-agent-account\.service.*health check passed.*Tell Blackout/);
});

test('runner: with config.deploy off (absent or server not true), nothing is deployed (#100)', async t => {
  for (const deploy of [null, { server: false }, { server: 'yes' }]) {
    const s = setup(t, { deploy });
    const run = await s.merged();
    assert.equal(run.state, 'succeeded'); assert.equal(s.calls.deploy.length, 0); assert.equal(run.deploy, undefined);
    assert.deepEqual(s.lines(), []); assert.ok(!s.calls.posts.some(body => /Deploy/.test(body)));
  }
});

test('runner: a rolled back deploy reports the health failure on the thread and as a deploy_failed line (#100)', async t => {
  const s = setup(t, { deployResult: { status: 'rolled_back', errorCode: 'HEALTH', commit: MERGED, previous: 'b'.repeat(40), plan: { companion: true, runner: false }, output: 'HEALTH output' } });
  const run = await s.merged();
  assert.equal(run.deploy.status, 'rolled_back'); assert.equal(run.state, 'succeeded', 'the merge stays done');
  const [line] = s.lines();
  assert.equal(line.kind, 'deploy_failed'); assert.match(line.suggestion, /failed its health check and was rolled back to bbbbbbbbbb/);
  assert.doesNotMatch(line.suggestion, /HEALTH output/);
  assert.ok(s.calls.posts.some(body => /rolled back/.test(body) && /HEALTH output/.test(body)));
});

test('runner: docs-only merges deploy nothing and say nothing; a thrown deploy is an error line (#100)', async t => {
  const quiet = setup(t, { deployResult: { status: 'skipped', reason: 'nothing_to_deploy', commit: MERGED, output: 'docs' } });
  assert.equal((await quiet.merged()).deploy.status, 'skipped');
  assert.deepEqual(quiet.lines(), []); assert.ok(!quiet.calls.posts.some(body => /Deploy/.test(body)));
  const thrown = setup(t, { deployResult: new Error('spawn git ENOENT') });
  const run = await thrown.merged();
  assert.equal(run.deploy.status, 'error'); assert.equal(thrown.lines()[0].kind, 'deploy_failed');
});

test('runner: runner code changed: waits for active runs (bounded), writes the hand-over and starts the guard (#100)', async t => {
  const busy = { id: 'coder-2-dddddd', agent: 'coder-2', ticketId: 'other', ticketNumber: 7, repo: 'personal-agent', base: 'main', mode: 'work', state: 'running', unit: 'cchan-agent-coder-2-t7', createdAt: 1 };
  const s = setup(t, { active: [busy], deploy: { server: true, runnerWaitMs: 50, selfCommit: 'b'.repeat(40) },
    deployResult: { status: 'deployed', commit: MERGED, previous: 'b'.repeat(40), plan: { companion: true, runner: true }, idle: { ok: true, waitedMs: 0 }, output: 'released' } });
  const run = await s.merged(now => now.deploy?.status === 'runner_restarting');
  assert.equal(s.calls.guard, 1);
  assert.equal(run.deploy.runnerWait.ok, false, 'the bound passed with a run still active');
  const state = readJson(join(s.dir, 'deploy.json'));
  assert.deepEqual({ status: state.status, phase: state.phase, commit: state.commit, previous: state.previous, runId: state.runId, releaseRoot: state.releaseRoot },
    { status: 'pending', phase: 'runner_restart', commit: MERGED, previous: 'b'.repeat(40), runId: run.id, releaseRoot: '/r' });
  assert.ok(s.calls.posts.some(body => /Restarting the runner now/.test(body)));
  // This process was not restarted; the guard reports the restart was refused: the old runner reports it.
  writeJson(join(s.dir, 'deploy.json'), { ...state, status: 'runner_restart_failed', output: 'sudo: refused' });
  await waitUntil(() => s.runner.get(run.id).deploy.status === 'deployed', { timeoutMs: 2000, intervalMs: 10 });
  const end = s.runner.get(run.id).deploy;
  assert.equal(end.runner, 'restart_failed'); assert.deepEqual(end.units, ['personal-agent-account.service']);
  assert.equal(s.lines().at(-1).kind, 'deploy_failed'); assert.match(s.lines().at(-1).suggestion, /still runs the previous code/);
  assert.ok(!existsSync(join(s.dir, 'deploy.json')));
});

test('runner: a guard that cannot be started reports a deployed companion with the runner not restarted (#100)', async t => {
  const s = setup(t, { guardError: Object.assign(new Error('Command failed'), { stderr: 'sudo: a password is required' }),
    deployResult: { status: 'deployed', commit: MERGED, previous: 'b'.repeat(40), plan: { companion: true, runner: true }, output: 'released' } });
  const run = await s.merged(now => now.deploy?.status === 'deployed');
  assert.equal(run.deploy.runner, 'restart_failed'); assert.match(run.deploy.output, /password is required/);
  assert.equal(s.lines()[0].kind, 'deploy_failed');
});

test('runner: on startup the new runner acknowledges a pending restart and reports the guard\'s rollback; a cut-off deploy is interrupted (#100)', async t => {
  const dir = tmp(t, 'deploy-recover-100-'), stateFile = join(dir, 'deploy.json');
  const run = { id: 'merger-1-cccccc', agent: 'merger-1', ticketId: TICKET, ticketNumber: 100, repo: 'personal-agent', base: 'main', mode: 'merge', state: 'succeeded',
    mergeResult: { status: 'merged', mergeCommit: MERGED }, deploy: { status: 'runner_restarting', commit: MERGED, previous: 'b'.repeat(40), units: ['personal-agent-account.service', 'cchan-agent-runner.service'], output: 'released' }, cleanup: {} };
  const cut = { ...run, id: 'merger-1-dddddd', deploy: { status: 'running', commit: MERGED } };
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ runs: [run, cut], events: [], seq: 0 }));
  writeJson(stateFile, { status: 'pending', phase: 'runner_restart', runId: run.id, commit: MERGED, previous: 'b'.repeat(40) });
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops: { async stopUnit() {}, async unitActive() { return false; } }, reporter: {},
    deploy: { server: true, stateFile, selfCommit: MERGED, pid: 4242, watchMs: 10 } });
  t.after(() => runner.close());
  await runner.recover();
  assert.deepEqual({ commit: readJson(ackFile(stateFile)).commit, pid: readJson(ackFile(stateFile)).pid }, { commit: MERGED, pid: 4242 });
  assert.equal(runner.get(cut.id).deploy.status, 'interrupted');
  writeJson(stateFile, { ...readJson(stateFile), status: 'rolled_back', reason: 'The new runner did not acknowledge the deploy in time.', output: 'rollback ok' });
  await waitUntil(() => runner.get(run.id).deploy.status === 'rolled_back', { timeoutMs: 2000, intervalMs: 10 });
  const end = runner.get(run.id).deploy;
  assert.equal(end.status, 'rolled_back'); assert.equal(end.runner, 'rolled_back'); assert.match(end.output, /did not acknowledge/);
  const lines = runner.events(0).filter(event => event.type === 'manager.attention');
  assert.ok(lines.some(line => line.kind === 'deploy_failed' && /the new runner did not stay up/.test(line.suggestion)));
  assert.ok(lines.some(line => line.kind === 'deploy_failed' && /cut off by a runner restart/.test(line.suggestion)));
  assert.ok(!existsSync(stateFile) && !existsSync(ackFile(stateFile)));
});
