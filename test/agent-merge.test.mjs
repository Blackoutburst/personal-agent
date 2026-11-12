// The merge step (#85): git on temp repos (a bare "origin", the sandbox's bare clone with the agent branch) for the merge
// core, and the runner/reporter gating around it with fakes for the sandbox and the Board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeAccepted } from '../src/agent-merge.mjs';
import { AgentRunner } from '../src/agent-runner.mjs';
import { BoardReporter } from '../src/agent-runner-board.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { Roster } from '../src/agent-roster.mjs';
import { createRunnerApi } from '../src/agent-runner-api.mjs';

const ID = ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.test', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const PASS = "import test from 'node:test'; test('ok', () => {});\n";
const FAIL = "import test from 'node:test'; import assert from 'node:assert'; test('broken', () => assert.equal(1, 2));\n";

// origin (bare) with main, and a sandbox clone (bare) of it; agent branches are made in a work clone and pushed to the sandbox clone.
function repos(t) {
  const root = mkdtempSync(join(tmpdir(), 'merge-85-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), sandbox = join(root, 'sandbox.git'), seed = join(root, 'seed'), agent = join(root, 'agent');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '-b', 'main');
  writeFileSync(join(seed, 'shared.txt'), 'one\ntwo\nthree\n'); writeFileSync(join(seed, 'a.test.mjs'), PASS); writeFileSync(join(seed, 'package.json'), '{"type":"module"}\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');
  git(root, 'clone', '--quiet', '--mirror', origin, sandbox);
  git(root, 'clone', '--quiet', origin, agent);
  const onMain = (name, content, message = `main: ${name}`) => { // a commit that lands on origin/main by someone else
    writeFileSync(join(seed, name), content); git(seed, 'add', '.'); git(seed, 'commit', '-m', message); git(seed, 'push', 'origin', 'main');
  };
  const onBranch = (branch, files) => { // an agent branch in the sandbox clone
    git(agent, 'checkout', '-B', branch, 'origin/main');
    for (const [name, content] of Object.entries(files)) writeFileSync(join(agent, name), content);
    git(agent, 'add', '.'); git(agent, 'commit', '-m', `work on ${branch}`);
    git(agent, 'push', '--quiet', '--force', sandbox, `${branch}:refs/heads/${branch}`);
    return git(agent, 'rev-parse', 'HEAD');
  };
  const mainOf = () => git(origin, 'rev-parse', 'refs/heads/main');
  return { root, origin, sandbox, onMain, onBranch, mainOf, dir: root };
}
const BRANCH = 'agent/coder-1/t85';
const IDENTITY = { name: 'Blackoutburst', email: 'github@blackoutburst.dev' };
// A stand-in for the sandbox wrapper: runs the command in cwd (cchan-sandbox-run changes into --cwd as the sandbox user).
const inCwd = (command, cwd) => ['sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', cwd, ...command];
const merge = (r, head, extra = {}) => mergeAccepted({ origin: r.origin, source: r.sandbox, branch: BRANCH, expectedHead: head, ticketNumber: 85,
  identity: IDENTITY, tmp: r.root, ...extra });

test('merge: updates onto the moved main, runs the suite, merges with the configured identity and pushes (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  r.onMain('other.txt', 'someone else landed first\n'); // main moved after the branch was cut
  const before = r.mainOf();
  const result = await merge(r, head);
  assert.equal(result.status, 'merged', result.output);
  assert.equal(r.mainOf(), result.mergeCommit);
  assert.notEqual(result.mergeCommit, before);
  assert.equal(git(r.origin, 'rev-parse', `${result.mergeCommit}^1`), before, 'first parent is the old main');
  assert.equal(git(r.origin, 'rev-parse', `${result.mergeCommit}^2`), head, 'second parent is the reviewed head');
  assert.equal(git(r.origin, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', result.mergeCommit), 'Blackoutburst <github@blackoutburst.dev>|Blackoutburst <github@blackoutburst.dev>');
  assert.match(git(r.origin, 'log', '-1', '--format=%s', result.mergeCommit), /Merge agent\/coder-1\/t85 \(ticket #85\) into main/);
  assert.equal(git(r.origin, 'show', `${result.mergeCommit}:feature.txt`), 'feature');
  assert.equal(git(r.origin, 'show', `${result.mergeCommit}:other.txt`), 'someone else landed first');
  assert.deepEqual(execFileSync('ls', [r.root]).toString().split('\n').filter(name => name.startsWith('cchan-merge-')), [], 'the temp clone is removed');
});

test('merge: a conflict with main is not merged and nothing is pushed (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'shared.txt': 'one\nTWO from the branch\nthree\n' });
  r.onMain('shared.txt', 'one\nTWO from main\nthree\n');
  const before = r.mainOf();
  const result = await merge(r, head);
  assert.equal(result.status, 'conflict');
  assert.match(result.output, /shared\.txt/);
  assert.equal(r.mainOf(), before);
});

test('merge: a failing suite on the merge result is not merged and nothing is pushed (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'broken.test.mjs': FAIL });
  const before = r.mainOf();
  const result = await merge(r, head);
  assert.equal(result.status, 'tests_failed');
  assert.match(result.output, /broken|AssertionError|fail/i);
  assert.equal(r.mainOf(), before);
});

test('merge: the suite is run on the merged result, so a branch that only breaks against the new main is refused (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'needs.test.mjs': "import test from 'node:test'; import assert from 'node:assert'; import { existsSync } from 'node:fs'; test('no flag file', () => assert.equal(existsSync(new URL('./flag.txt', import.meta.url)), false));\n" });
  r.onMain('flag.txt', 'x\n'); // the branch passes alone, but not together with main
  const before = r.mainOf();
  assert.equal((await merge(r, head)).status, 'tests_failed');
  assert.equal(r.mainOf(), before);
});

test('merge: a branch that moved since the review is refused (#85)', async t => {
  const r = repos(t);
  const reviewed = r.onBranch(BRANCH, { 'feature.txt': 'one\n' });
  r.onBranch(BRANCH, { 'feature.txt': 'two\n', 'extra.txt': 'sneaked in after the review\n' });
  const before = r.mainOf();
  const result = await merge(r, reviewed);
  assert.equal(result.status, 'moved');
  assert.equal(r.mainOf(), before);
});

test('merge: an already merged head is reported, not pushed again; a rejected push is an error (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const first = await merge(r, head);
  assert.equal(first.status, 'merged');
  const again = await merge(r, head);
  assert.equal(again.status, 'already_merged');
  assert.equal(again.mergeCommit, first.mergeCommit);
  assert.equal(r.mainOf(), first.mergeCommit);
  const broken = await merge(repos(t), 'deadbeef', { origin: join(r.root, 'missing.git') });
  assert.equal(broken.status, 'error');
});

test('merge: a failed prepare step is an error, not a test failure, and nothing is pushed (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const before = r.mainOf();
  const result = await merge(r, head, { prepareCommand: ['node', '-e', 'process.exit(3)'] });
  assert.equal(result.status, 'error');
  assert.match(result.output, /Preparing the test run failed/);
  assert.equal(r.mainOf(), before);
});

test('merge: the test and prepare steps go through the sandbox wrapper, git does not (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const seen = [];
  const sandboxDir = join(r.root, 'sbroot', 'merge'); mkdirSync(join(r.root, 'sbroot'));
  const sandbox = (command, { cwd, timeoutMs }) => { seen.push({ command, cwd, timeoutMs }); return inCwd(command, cwd); };
  const result = await merge(r, head, { sandbox, sandboxDir, prepareCommand: ['node', '-e', '0'], testTimeoutMs: 90_000 });
  assert.equal(result.status, 'merged', result.output);
  // The sandbox makes its own copy (from a bundle on stdin), prepare and test run in it, and the sandbox removes it.
  assert.deepEqual(seen.map(s => s.command[0] === 'sh' ? ['sh', s.command.at(-2), s.command.at(-1)] : s.command[1] === '-e' && /process.version/.test(s.command[2]) ? 'node-check' : s.command),
    [['sh', sandboxDir, result.mergeCommit], 'node-check', ['node', '-e', '0'], ['node', '--test'], ['rm', '-rf', '--', seen[2].cwd.replace(/\/repo$/, '')]]);
  assert.equal(seen[0].cwd, join(r.root, 'sbroot'));
  assert.ok(seen.slice(2, 4).every(s => s.cwd.startsWith(`${sandboxDir}/cchan-merge-test-`) && s.cwd.endsWith('/repo') && s.timeoutMs === 90_000));
  assert.deepEqual(execFileSync('ls', [sandboxDir]).toString().trim(), '', 'the sandbox removed its copy');
});

test('merge: the test copy the sandbox makes holds exactly the merge result, and a bad answer from it stops the merge (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const sandboxDir = join(r.root, 'sbroot', 'merge'); mkdirSync(join(r.root, 'sbroot'));
  const check = ['bash', '-c', 'test "$(git rev-parse HEAD^2)" = "$0" && test "$(cat feature.txt)" = feature && test -z "$(git status --porcelain)"', head];
  const ok = await merge(r, head, { sandbox: (command, { cwd }) => inCwd(command, cwd), sandboxDir, testCommand: check });
  assert.equal(ok.status, 'merged', ok.output);
  const r2 = repos(t);
  const head2 = r2.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const before = r2.mainOf();
  // A sandbox step that names a directory outside its merge dir is not trusted as the test copy.
  const liar = (command, { cwd }) => command[0] === 'sh' ? ['echo', '/home/ubuntu'] : inCwd(command, cwd);
  const bad = await merge(r2, head2, { sandbox: liar, sandboxDir: join(r2.root, 'merge') });
  assert.equal(bad.status, 'error'); assert.match(bad.output, /test copy in the sandbox/);
  assert.equal(r2.mainOf(), before);
  assert.equal((await merge(r2, head2, { sandbox: liar })).status, 'error', 'a sandbox needs a sandboxDir');
});

test('merge: the tested code rewriting its .git/config (pushurl, insteadOf, origin url) cannot redirect the push (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const evil = join(r.root, 'evil.git');
  git(r.root, 'init', '--bare', '--initial-branch=main', evil);
  const before = r.mainOf();
  const seen = [];
  // The "test run": rewrites the config of the repository it runs in, points every
  // push at evil.git, and leaves a commit of its own on HEAD.
  const hostile = ['bash', '-c', [
    'set -e',
    `git config remote.origin.pushurl ${evil}`,
    `git config remote.origin.url ${evil}`,
    `git config url.${evil}.pushInsteadOf ${r.origin}`,
    `git config url.${evil}.insteadOf ${r.origin}`,
    'echo injected > injected.txt',
    'git -c user.name=x -c user.email=x@x add injected.txt',
    'git -c user.name=x -c user.email=x@x commit -qm injected',
    'pwd'
  ].join('\n')];
  const sandboxDir = join(r.root, 'sbroot', 'merge'); mkdirSync(join(r.root, 'sbroot'));
  const sandbox = (command, { cwd }) => { if (command === hostile) seen.push(cwd); return inCwd(command, cwd); };
  const result = await merge(r, head, { testCommand: hostile, sandbox, sandboxDir });
  assert.equal(result.status, 'merged', result.output);
  assert.equal(r.mainOf(), result.mergeCommit, 'the push landed on the real origin');
  assert.equal(git(r.origin, 'rev-parse', `${result.mergeCommit}^1`), before);
  assert.equal(git(r.origin, 'rev-parse', `${result.mergeCommit}^2`), head);
  assert.throws(() => git(r.origin, 'cat-file', '-e', `${result.mergeCommit}:injected.txt`), 'the commit made by the test run was not pushed');
  assert.equal(git(evil, 'for-each-ref').trim(), '', 'nothing reached the redirected URL');
  assert.ok(seen.length > 0 && seen.every(cwd => /cchan-merge-test-/.test(cwd)), 'the test ran in its own copy');
  assert.deepEqual(execFileSync('ls', [r.root]).toString().split('\n').filter(name => name.startsWith('cchan-merge')), [], 'the owner\'s clones are removed');
  assert.equal(execFileSync('ls', [sandboxDir]).toString().trim(), '', 'the test copy is removed');
});

test('SandboxOps.merge pushes to config.merge.origin and wraps the sandbox steps in sudo cchan-sandbox-run under the sandbox root (#85)', async t => {
  const { SandboxOps, WRAPPER } = await import('../src/agent-sandbox-ops.mjs');
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  // A stand-in for sudo (the real wrapper needs root and systemd): logs its arguments, then runs the command after `--`
  // in the --cwd directory, like cchan-sandbox-run would.
  const log = join(r.root, 'sudo.log'), fake = join(r.root, 'fake-sudo');
  writeFileSync(fake, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${log}\nargs=("$@"); cwd=.\nfor ((i=0;i<$#;i++)); do [ "\${args[i]}" = --cwd ] && cwd=\${args[i+1]}; [ "\${args[i]}" = -- ] && { cd "$cwd" && exec "\${args[@]:i+1}"; }; done\nexit 99\n`, { mode: 0o755 });
  const sbroot = join(r.root, 'sbroot'), owner = join(r.root, 'owner-tmp');
  const ops = new SandboxOps({ sudo: fake, root: sbroot });
  mkdirSync(join(sbroot, 'repos'), { recursive: true });
  mkdirSync(join(sbroot, 'bin')); symlinkSync(process.execPath, join(sbroot, 'bin', 'node')); // stands in for the root-owned /var/lib/cchan-agents/bin/node
  const clone = join(sbroot, 'repos', 'demo.git');
  execFileSync('git', ['clone', '--quiet', '--mirror', r.sandbox, clone]);
  // The sandbox user can rewrite its clone's remote: the push must not follow it.
  const evil = join(r.root, 'evil.git');
  git(r.root, 'init', '--bare', '--initial-branch=main', evil);
  git(clone, 'remote', 'set-url', 'origin', evil);
  const request = { repo: 'demo', branch: BRANCH, base: 'main', expectedHead: head, ticketNumber: 85, identity: IDENTITY, testCommand: ['node', '--test'],
    prepareCommand: ['node', '-e', '0'], tmp: owner };
  const none = await ops.merge({ ...request, origin: null, nodePath: null });
  assert.equal(none.status, 'error'); assert.match(none.output, /config\.merge\.origin/);
  const before = r.mainOf();
  const result = await ops.merge({ ...request, origin: r.origin, nodePath: null }); // null (from config) falls back to the default, never to bare `node`
  assert.equal(result.status, 'merged', result.output);
  assert.equal(r.mainOf(), result.mergeCommit); assert.notEqual(result.mergeCommit, before);
  assert.equal(git(evil, 'for-each-ref'), '', 'nothing went to the clone\'s remote');
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 5, 'make the copy, check node, prepare, test, remove the copy');
  assert.ok(calls[0].startsWith(`-n ${WRAPPER} --cwd ${sbroot} --max-seconds `) && / -- sh -c /.test(calls[0]), calls[0]);
  assert.ok(calls[0].endsWith(` sh ${join(sbroot, 'merge')} ${result.mergeCommit}`), calls[0]);
  for (const line of calls.slice(1, 4)) assert.match(line, new RegExp(`^-n ${WRAPPER} --cwd ${join(sbroot, 'merge')}/cchan-merge-test-[A-Za-z0-9]{8}/repo --max-seconds \\d+ -- ${join(sbroot, 'bin', 'node')} `));
  assert.match(calls[4], new RegExp(`^-n ${WRAPPER} --cwd ${sbroot} --max-seconds \\d+ -- rm -rf -- ${join(sbroot, 'merge')}/cchan-merge-test-[A-Za-z0-9]{8}$`));
  assert.equal(execFileSync('ls', [join(sbroot, 'merge')]).toString().trim(), '', 'the copy is gone');
  assert.equal(execFileSync('ls', [owner]).toString().trim(), '', 'the owner\'s clones are gone, and were never under the sandbox root');
});

test('merge: missing dependencies without a prepareCommand are an error, not a test failure (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'dep.test.mjs': "import 'not-installed-package';\n" });
  const before = r.mainOf();
  const result = await merge(r, head);
  assert.equal(result.status, 'error');
  assert.match(result.output, /dependencies are missing.*prepareCommand/s);
  assert.equal(r.mainOf(), before);
});

test('merge: a failed git checkout --detach stops the merge instead of going on (#85)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'feature.txt': 'feature\n' });
  const before = r.mainOf();
  // A git shim that fails `checkout` and passes everything else through.
  const bin = join(r.root, 'shim'); mkdirSync(bin);
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/bash\nfor a in "$@"; do [ "$a" = checkout ] && { echo "fatal: checkout refused" >&2; exit 1; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  let result;
  try { result = await merge(r, head); } finally { process.env.PATH = oldPath; }
  assert.equal(result.status, 'error');
  assert.match(result.output, /Could not check out/);
  assert.equal(r.mainOf(), before);
});

// ---------- The runner's gate, with fakes ----------

const TICKET = 'ticket-85', HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const workRun = (over = {}) => ({ id: 'coder-1-aaaaaa', agent: 'coder-1', ticketId: TICKET, ticketNumber: 85, repo: 'personal-agent', base: 'main', mode: 'work',
  branch: BRANCH, head: HEAD, commits: 1, state: 'succeeded', endedAt: 1000, createdAt: 900, cleanup: {}, ...over });
const reviewRun = (over = {}) => ({ id: 'rev-1-bbbbbb', agent: 'rev-1', role: 'reviewer', ticketId: TICKET, ticketNumber: 85, repo: 'personal-agent', base: 'main',
  mode: 'review', reviewBranch: BRANCH, reviewHead: HEAD, state: 'succeeded', endedAt: 2000, createdAt: 1500, result: { kind: 'review', verdict: 'approve' }, cleanup: {}, ...over });

function setup(t, { runs = [workRun(), reviewRun()], head = HEAD, mergeResult = { status: 'merged', mergeCommit: 'c'.repeat(40), output: 'ok' }, merge: mergeConfig = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-gate-85-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ runs, events: [], seq: 0 }));
  const roster = new Roster({ file: join(dir, 'roster.json') });
  roster.create({ name: 'merger-1', role: 'merger', kind: 'standing', model: 'sonnet' });
  roster.create({ name: 'coder-t85', role: 'coder', kind: 'task', ticketId: TICKET, model: 'sonnet' });
  const manager = new Manager({ file: join(dir, 'manager.json'), projects: ['proj'] });
  const calls = { merge: [], board: [] };
  const ops = {
    async branchInfo() { return { head, commits: 1 }; },
    async merge(request) { calls.merge.push(request); return typeof mergeResult === 'function' ? mergeResult(request) : mergeResult; },
    async unitActive() { return false; }, async stopUnit() {}
  };
  const reporter = {
    async beginMerge(run) { calls.board.push(['begin', run.id]); run.board = { merge: true }; return { number: 85, title: 'Runner merge' }; },
    async finish(run) { calls.board.push(['finish', run.state, run.errorCode ?? null]); return { done: run.state === 'succeeded' }; }
  };
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops, reporter, roster, manager, merge: mergeConfig === null ? null
    : { origin: 'https://github.com/Blackoutburst/personal-agent.git', identity: { name: 'Blackoutburst', email: 'github@blackoutburst.dev' }, ...mergeConfig } });
  t.after(() => runner.close());
  const accept = (over = {}) => manager.decide({ kind: 'accept', ticketId: TICKET, reviewRunId: 'rev-1-bbbbbb', reason: 'approved', ...over }, runner.list());
  const launch = (over = {}) => runner.launch({ mode: 'merge', agent: 'merger-1', ticketId: TICKET, repo: 'personal-agent', branch: BRANCH, ...over });
  // Resolves with the run.ended event once the Board step and the runner's follow-up (Manager line, archiving) are done too.
  const ended = () => new Promise(resolve => runner.on('event', event => {
    if (event.type !== 'run.ended') return;
    const wait = () => calls.board.some(call => call[0] === 'finish') ? setTimeout(() => resolve(event), 5) : setTimeout(wait, 2);
    wait();
  }));
  return { dir, runner, manager, roster, calls, accept, launch, ended };
}
const refused = (fn, code) => assert.throws(fn, error => error.code === code, `expected ${code}`);

test('agents_merge gate: refused without an accept, after a return, for another branch or a stale review (#85)', async t => {
  const s = setup(t);
  refused(() => s.launch(), 'NO_ACCEPT');
  s.accept();
  refused(() => s.launch({ branch: 'agent/other/t85' }), 'INVALID');
  refused(() => s.launch({ agent: 'coder-t85' }), 'FORBIDDEN'); // a coder has no merge action
  refused(() => s.launch({ branch: undefined }), 'INVALID');
  // work moved on after the review: the accept no longer covers the latest work
  const stale = setup(t, { runs: [workRun({ head: OTHER }), reviewRun()] });
  stale.manager.decide({ kind: 'accept', ticketId: TICKET, reviewRunId: 'rev-1-bbbbbb', reason: 'x' }, [workRun(), reviewRun()]);
  refused(() => stale.launch(), 'STALE_REVIEW');
  // an accept followed by a return is not a merge approval
  const returned = setup(t, { runs: [workRun(), reviewRun(), reviewRun({ id: 'rev-1-cccccc', endedAt: 3000, createdAt: 2500, result: { kind: 'review', verdict: 'changes_requested' } })] });
  returned.accept(); returned.manager.decide({ kind: 'return', ticketId: TICKET, reviewRunId: 'rev-1-cccccc', reason: 'changes' }, returned.runner.list());
  refused(() => returned.launch(), 'NO_ACCEPT');
  assert.equal(s.calls.merge.length, 0);
});

test('agents_merge gate: an accept backed by a changes_requested review, a non-independent review or a missing review is refused at decide (#85)', async t => {
  const s = setup(t, { runs: [workRun(), reviewRun({ result: { kind: 'review', verdict: 'changes_requested' } })] });
  assert.throws(() => s.accept(), error => error.code === 'VERDICT_MISMATCH');
  assert.throws(() => s.accept({ reviewRunId: undefined }), error => error.code === 'NO_REVIEW');
  refused(() => s.launch(), 'NO_ACCEPT');
  const self = setup(t, { runs: [workRun(), reviewRun({ agent: 'coder-1', role: 'reviewer' })] });
  assert.throws(() => self.accept(), error => error.code === 'NOT_INDEPENDENT');
});

test('agents_merge gate: needs merge enabled in the runner config, with a push target, and a manager (#85)', t => {
  const s = setup(t, { merge: null });
  s.accept();
  refused(() => s.launch(), 'FORBIDDEN');
  const noOrigin = setup(t, { merge: { origin: '' } });
  noOrigin.accept();
  assert.throws(() => noOrigin.launch(), error => error.code === 'FORBIDDEN' && /config\.merge\.origin/.test(error.message));
  assert.equal(noOrigin.calls.merge.length, 0);
});

test('agents_merge gate: the API maps the refusals to 409 and a launch needs no model budget (#85)', async t => {
  const s = setup(t);
  const api = createRunnerApi({ runner: s.runner, roster: s.roster, manager: s.manager });
  const body = { mode: 'merge', agent: 'merger-1', ticketId: TICKET, repo: 'personal-agent', branch: BRANCH };
  const no = await api('POST', '/runs', body);
  assert.equal(no.status, 409); assert.equal(no.body.error.code, 'NO_ACCEPT');
  s.accept();
  const yes = await api('POST', '/runs', body);
  assert.equal(yes.status, 202, JSON.stringify(yes.body));
  assert.equal(yes.body.run.mode, 'merge'); assert.equal(yes.body.run.mergeHead, HEAD);
});

test('merge run: approved head, merge, done; per-task agents archived, no Manager line (#85)', async t => {
  const s = setup(t);
  s.accept();
  const done = s.ended();
  s.launch();
  const event = await done;
  assert.equal(event.state, 'succeeded');
  assert.equal(s.calls.merge.length, 1);
  assert.deepEqual({ branch: s.calls.merge[0].branch, base: s.calls.merge[0].base, expectedHead: s.calls.merge[0].expectedHead, ticketNumber: s.calls.merge[0].ticketNumber },
    { branch: BRANCH, base: 'main', expectedHead: HEAD, ticketNumber: 85 });
  assert.deepEqual(s.calls.merge[0].identity, { name: 'Blackoutburst', email: 'github@blackoutburst.dev' });
  assert.equal(s.calls.merge[0].origin, 'https://github.com/Blackoutburst/personal-agent.git');
  const run = s.runner.list().find(item => item.mode === 'merge');
  assert.equal(run.mergeResult.mergeCommit, 'c'.repeat(40)); assert.deepEqual(run.cleanup, { unitGone: true, worktreeRemoved: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.roster.get('coder-t85').status, 'archived');
  assert.equal(s.roster.get('merger-1').status, 'active');
  assert.deepEqual(s.runner.events(0).filter(item => item.type === 'manager.attention'), []);
  refused(() => s.launch({ requestId: undefined }), 'ALREADY_MERGED');
});

test('merge run: a branch that moved after the review is not merged and raises a Manager line (#85)', async t => {
  const s = setup(t, { head: OTHER });
  s.accept();
  const done = s.ended(); s.launch();
  const event = await done;
  assert.equal(event.state, 'failed'); assert.equal(event.errorCode, 'BRANCH_MOVED');
  assert.equal(s.calls.merge.length, 0);
  const line = s.runner.events(0).find(item => item.type === 'manager.attention');
  assert.equal(line.kind, 'merge_failed'); assert.match(line.suggestion, /#85/); assert.match(line.suggestion, /stays in review/);
  assert.equal(s.roster.get('coder-t85').status, 'active');
});

for (const [status, code, text] of [['conflict', 'MERGE_CONFLICT', /conflict with main/], ['tests_failed', 'TESTS_FAILED', /test suite fails/]]) {
  test(`merge run: ${status} means no merge, the ticket goes back with the output and a Manager line is raised (#85)`, async t => {
    const s = setup(t, { mergeResult: { status, output: `${status} output here` } });
    s.accept();
    const done = s.ended(); s.launch();
    const event = await done;
    assert.equal(event.state, 'failed'); assert.equal(event.errorCode, code);
    const run = s.runner.list().find(item => item.mode === 'merge');
    assert.equal(run.mergeResult.mergeCommit, null); assert.match(run.mergeResult.output, /output here/);
    const line = s.runner.events(0).find(item => item.type === 'manager.attention');
    assert.equal(line.kind, 'merge_refused'); assert.match(line.suggestion, text); assert.match(line.suggestion, /back to todo/);
    assert.doesNotMatch(line.suggestion, /output here/, 'output stays on the ticket thread, not in the wake');
    assert.equal(s.roster.get('coder-t85').status, 'active', 'the coder agent stays: the ticket goes back to it');
  });
}

// ---------- The Board side ----------

function boardRun(over = {}) {
  return { id: 'merger-1-dddddd', agent: 'merger-1', ticketId: TICKET, ticketNumber: 85, mode: 'merge', base: 'main', mergeBranch: BRANCH, mergeHead: HEAD, state: 'succeeded',
    mergeResult: { status: 'merged', mergeCommit: 'c'.repeat(40), output: 'ok' }, cleanup: { unitGone: true, worktreeRemoved: true }, ...over };
}
function board() {
  const calls = [];
  return { calls, client: { async call(tool, args) {
    calls.push({ tool, args });
    if (tool === 'get_ticket') return { ticket: { id: TICKET, number: 85, title: 'Runner merge', project_id: 'proj', status: 'review', version: 7, thread_id: 'th-85' } };
    return { ticket: { version: 8 } };
  } } };
}

test('Board reporter: a merged branch sets the ticket done with the merge commit as evidence (#85)', async () => {
  const b = board(), reporter = new BoardReporter({ client: b.client, projects: ['proj'], ownerId: 'blackoutburst' });
  const run = boardRun();
  await reporter.beginMerge(run);
  assert.equal(b.calls.find(call => call.tool === 'claim_ticket'), undefined, 'not claimed while merging');
  const result = await reporter.finish(run);
  assert.deepEqual(result, { done: true });
  const update = b.calls.find(call => call.tool === 'update_ticket');
  assert.equal(update.args.changes.status, 'done'); assert.match(update.args.changes.evidence, new RegExp('c'.repeat(40)));
  assert.equal(update.args.changes.release_claim, true);
});

test('Board reporter: a conflict or failing suite returns the ticket to todo with the output on its thread (#85)', async () => {
  const b = board(), reporter = new BoardReporter({ client: b.client, projects: ['proj'], ownerId: 'blackoutburst' });
  const run = boardRun({ state: 'failed', errorCode: 'TESTS_FAILED', mergeResult: { status: 'tests_failed', mergeCommit: null, output: 'not ok 1 - broken test' } });
  await reporter.beginMerge(run);
  assert.deepEqual(await reporter.finish(run), { done: false });
  const update = b.calls.filter(call => call.tool === 'update_ticket').at(-1);
  assert.equal(update.args.changes.status, 'todo'); assert.equal(update.args.changes.release_claim, true);
  assert.ok(!b.calls.some(call => call.tool === 'update_ticket' && call.args.changes.status === 'done'));
  const post = b.calls.filter(call => call.tool === 'post_message').at(-1);
  assert.match(post.args.body, /not ok 1 - broken test/); assert.match(post.args.body, /Nothing was merged/);
});

test('Board reporter: a moved branch or push failure leaves the ticket in review (#85)', async () => {
  const b = board(), reporter = new BoardReporter({ client: b.client, projects: ['proj'], ownerId: 'blackoutburst' });
  const run = boardRun({ state: 'failed', errorCode: 'BRANCH_MOVED', mergeResult: { status: 'moved', output: 'moved' } });
  await reporter.beginMerge(run);
  await reporter.finish(run);
  assert.ok(!b.calls.some(call => call.tool === 'update_ticket'));
  assert.match(b.calls.filter(call => call.tool === 'post_message').at(-1).args.body, /stays in review/);
});

// A stand-in for the sandbox's node: `node` on this PATH is a fake old node, the real one is only reachable by path.
function fakeOldNode(r, version) {
  const bin = join(r.root, 'oldbin'); mkdirSync(bin);
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "${version} $('${process.execPath}' -p "require('./package.json').engines.node" 2>/dev/null)"\n`, { mode: 0o755 });
  return bin;
}
const withPath = (bin, cwdWrap = inCwd) => (command, { cwd }) => ['env', `PATH=${bin}:${process.env.PATH}`, ...cwdWrap(command, cwd)];

test('merge: an old node in the sandbox is refused with the version found, before any step runs (#92)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'package.json': JSON.stringify({ engines: { node: '>=24.22.1 <25' } }) });
  const sandboxDir = join(r.root, 'sbroot', 'merge'); mkdirSync(join(r.root, 'sbroot'));
  const bin = fakeOldNode(r, 'v12.22.9');
  const before = r.mainOf();
  const result = await merge(r, head, { sandbox: withPath(bin), sandboxDir, prepareCommand: ['node', '-e', 'process.exit(5)'] });
  assert.equal(result.status, 'error');
  assert.match(result.output, /too old: found v12\.22\.9, the repository needs >=24\.22\.1 <25/);
  assert.doesNotMatch(result.output, /SyntaxError|Preparing the test run/);
  assert.equal(r.mainOf(), before);
});

test('merge: with nodePath the prepare and test steps run on that node, not the first node on the sandbox PATH (#92)', async t => {
  const r = repos(t);
  const head = r.onBranch(BRANCH, { 'package.json': JSON.stringify({ engines: { node: '>=20' } }), 'ok.test.mjs': PASS });
  const sandboxDir = join(r.root, 'sbroot', 'merge'); mkdirSync(join(r.root, 'sbroot'));
  const bin = fakeOldNode(r, 'v12.22.9');
  const sandbox = withPath(bin);
  const old = await merge(r, head, { sandbox, sandboxDir });
  assert.match(old.output, /too old: found v12/, 'without nodePath the fake old node is what runs');
  const result = await merge(r, head, { sandbox, sandboxDir, nodePath: process.execPath, prepareCommand: ['node', '-e', '0'] });
  assert.equal(result.status, 'merged', result.output);
  // An unrunnable node path is a readable error too.
  const r2 = repos(t);
  const head2 = r2.onBranch(BRANCH, { 'x.txt': 'x\n' });
  const bad = await merge(r2, head2, { sandbox: withPath(bin), sandboxDir: join(r.root, 'sbroot', 'merge'), nodePath: '/nonexistent/node' });
  assert.equal(bad.status, 'error'); assert.match(bad.output, /could not be run.*config\.merge\.nodePath/s);
});

test('SandboxOps.merge default node is visible inside the sandbox: /opt is hidden, the default is under a bound path (#92)', async () => {
  const { SANDBOX_ROOT } = await import('../src/agent-sandbox-ops.mjs');
  const props = readFileSync(new URL('../ops/sandbox/properties', import.meta.url), 'utf8');
  const value = key => props.split('\n').find(l => l.startsWith(key + '='))?.slice(key.length + 1).split(/\s+/).filter(Boolean) ?? [];
  const hidden = value('TemporaryFileSystem').map(x => x.split(':')[0]), bound = value('BindPaths');
  const under = (path, dir) => path === dir || path.startsWith(dir + '/');
  assert.ok(hidden.includes('/opt'), 'the sandbox hides /opt, which is why the runner\'s process.execPath cannot be the default');
  const node = join(SANDBOX_ROOT, 'bin', 'node');
  assert.ok(bound.some(b => under(node, b)), 'the default node is under a BindPaths entry, re-exposed after the hidden /var/lib');
  assert.ok(!hidden.some(h => under(h, '/opt') && under(node, h)), 'and not under /opt');
  assert.ok(props.includes('PATH=/var/lib/cchan-agents/bin:'), 'the same dir is first on the sandbox PATH');
});
