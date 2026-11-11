// The desktop release after a merge (#90): the gate and the build/publish steps on temp repos with a fake build and a
// fake publish (shell scripts committed into the repo, like the real ones), and the runner/reporter wiring with fakes.
// Nothing here runs the real scripts/build-desktop.sh or scripts/publish-desktop.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseDesktop, compareVersions, servedDesktopVersion } from '../src/desktop-release.mjs';
import { AgentRunner } from '../src/agent-runner.mjs';
import { BoardReporter } from '../src/agent-runner-board.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { Roster } from '../src/agent-roster.mjs';

const ID = ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.test', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const sha = text => createHash('sha256').update(text).digest('hex');

// A fake build: writes the installer, blockmap and latest.yml for the package.json version into desktop/dist; it also
// records where it ran and with which HOME. FAKE_BUILD_FAIL in the repo makes it fail.
const BUILD = `#!/bin/sh
set -eu
cd "$(dirname "$0")/../desktop"
[ ! -f ../FAKE_BUILD_FAIL ] || { echo "electron-builder exploded" >&2; exit 3; }
v=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' package.json)
mkdir -p dist
printf 'installer %s\\n' "$v" > "dist/Companion-Setup-$v-x64.exe"
printf 'blockmap %s\\n' "$v" > "dist/Companion-Setup-$v-x64.exe.blockmap"
printf 'version: %s\\n' "$v" > dist/latest.yml
printf '%s %s\\n' "$(git rev-parse HEAD 2>/dev/null || echo none)" "$HOME" > "$FAKE_LOG"
echo "built $v"
`;
// A fake publish with the real one's order: installer + blockmap, then latest.yml, then desktop.json. FAKE_PUBLISH_FAIL
// makes it fail after latest.yml was replaced (the worst moment for a half-published feed).
const PUBLISH = `#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
v=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' desktop/package.json)
d="$COMPANION_DATA_DIR/downloads"; mkdir -p "$d"
cp "desktop/dist/Companion-Setup-$v-x64.exe" "desktop/dist/Companion-Setup-$v-x64.exe.blockmap" "$d/"
cp desktop/dist/latest.yml "$d/latest.yml"
[ ! -f FAKE_PUBLISH_FAIL ] || { echo "disk full" >&2; exit 4; }
printf '{"version":"%s","file":"Companion-Setup-%s-x64.exe"}\\n' "$v" "$v" > "$d/desktop.json"
echo "published $v"
`;

function repos(t, version = '0.4.0') {
  const root = mkdtempSync(join(tmpdir(), 'release-90-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), data = join(root, 'data'), log = join(root, 'build.log');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '-b', 'main');
  mkdirSync(join(seed, 'desktop')); mkdirSync(join(seed, 'scripts'));
  writeFileSync(join(seed, 'scripts', 'build-desktop.sh'), BUILD); writeFileSync(join(seed, 'scripts', 'publish-desktop.sh'), PUBLISH);
  writeFileSync(join(seed, 'desktop', 'package.json'), JSON.stringify({ name: 'companion-desktop', version }, null, 2) + '\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', '--quiet', 'origin', 'main');
  // What agents_merge does: a --no-ff merge of a branch onto main, pushed. Returns the merge commit.
  const mergeBranch = (files, name = 'agent/coder-1/t90') => {
    git(seed, 'checkout', '--quiet', '-B', name, 'main');
    for (const [file, content] of Object.entries(files)) {
      if (content === null) rmSync(join(seed, file)); else writeFileSync(join(seed, file), content);
    }
    git(seed, 'add', '-A'); git(seed, 'commit', '--quiet', '-m', `work on ${name}`);
    git(seed, 'checkout', '--quiet', 'main');
    git(seed, 'merge', '--quiet', '--no-ff', '--no-edit', name);
    git(seed, 'push', '--quiet', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  const bump = (v, extra = {}) => mergeBranch({ 'desktop/package.json': JSON.stringify({ name: 'companion-desktop', version: v }, null, 2) + '\n', ...extra });
  // What the server serves now (a previous publish).
  const serve = v => {
    mkdirSync(join(data, 'downloads'), { recursive: true });
    writeFileSync(join(data, 'downloads', `Companion-Setup-${v}-x64.exe`), `installer ${v}\n`);
    writeFileSync(join(data, 'downloads', 'latest.yml'), `version: ${v}\n`);
    writeFileSync(join(data, 'downloads', 'desktop.json'), JSON.stringify({ version: v, file: `Companion-Setup-${v}-x64.exe` }) + '\n');
  };
  const feed = () => ['latest.yml', 'desktop.json'].map(name => { try { return readFileSync(join(data, 'downloads', name), 'utf8'); } catch { return null; } });
  const release = (commit, extra = {}) => {
    return releaseDesktop({ origin, commit, dataDir: data, tmp: root, buildCommand: ['sh', 'scripts/build-desktop.sh'], publishCommand: ['sh', 'scripts/publish-desktop.sh'], ...extra });
  };
  const built = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split(' ') : null;
  return { root, origin, seed, data, mergeBranch, bump, serve, feed, release, built };
}

// The release gives the build a scrubbed environment (PATH, HOME, LANG, CI), so FAKE_LOG goes in through a wrapper.
function withLog(r) {
  return (commit, extra = {}) => r.release(commit, { buildCommand: ['sh', '-c', `FAKE_LOG=${join(r.root, 'build.log')} exec sh scripts/build-desktop.sh`], ...extra });
}

test('versions compare as x.y.z numbers; anything else is not comparable (#90)', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.4.0', '0.4.1'), -1);
  assert.equal(compareVersions('0.4', '0.4.0'), null);
  assert.equal(compareVersions('0.5.0-beta', '0.4.0'), null);
  assert.equal(servedDesktopVersion('/nonexistent-dir-90'), null);
});

test('release: a merge that raises the version builds and publishes it from exactly the merge commit (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const commit = r.bump('0.5.0');
  const result = await withLog(r)(commit);
  assert.equal(result.status, 'published', result.output);
  assert.deepEqual({ version: result.version, previous: result.previous, served: result.served, file: result.file },
    { version: '0.5.0', previous: '0.4.0', served: '0.4.0', file: 'Companion-Setup-0.5.0-x64.exe' });
  assert.equal(result.sha256, sha('installer 0.5.0\n'));
  assert.equal(servedDesktopVersion(r.data), '0.5.0');
  assert.deepEqual(r.feed(), ['version: 0.5.0\n', '{"version":"0.5.0","file":"Companion-Setup-0.5.0-x64.exe"}\n']);
  const [builtAt, home] = r.built();
  assert.equal(builtAt, commit, 'built from the merge commit itself');
  assert.notEqual(home, process.env.HOME, 'the build gets its own HOME');
  assert.equal(git(r.origin, 'rev-parse', 'main'), commit, 'main untouched');
  assert.deepEqual(execFileSync('ls', [r.root]).toString().split('\n').filter(name => name.startsWith('cchan-release-')), [], 'the clone is removed');
});

test('release: nothing is published for a merge without a version bump (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const commit = r.mergeBranch({ 'desktop/main.js': 'console.log(1)\n' });
  const result = await withLog(r)(commit);
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'no_bump');
  assert.equal(r.built(), null, 'no build ran');
  assert.deepEqual(r.feed(), ['version: 0.4.0\n', '{"version":"0.4.0","file":"Companion-Setup-0.4.0-x64.exe"}\n']);
});

test('release: a lower version, or one the server already serves, publishes nothing (#90)', async t => {
  const r = repos(t, '0.4.0'); r.serve('0.4.0');
  const lower = await withLog(r)(r.bump('0.3.9'));
  assert.equal(lower.status, 'skipped'); assert.equal(lower.reason, 'not_higher');
  const r2 = repos(t, '0.4.0'); r2.serve('0.6.0'); // published by hand ahead of main
  const behind = await withLog(r2)(r2.bump('0.5.0'));
  assert.equal(behind.status, 'skipped'); assert.equal(behind.reason, 'not_higher'); assert.match(behind.output, /already serves 0\.6\.0/);
  assert.equal(r.built(), null); assert.equal(r2.built(), null);
  assert.equal(servedDesktopVersion(r.data), '0.4.0'); assert.equal(servedDesktopVersion(r2.data), '0.6.0');
});

test('release: the first publish (nothing served yet) goes out; a non x.y.z version is an error (#90)', async t => {
  const r = repos(t);
  const first = await withLog(r)(r.bump('0.4.1'));
  assert.equal(first.status, 'published', first.output); assert.equal(first.served, null);
  assert.equal(servedDesktopVersion(r.data), '0.4.1');
  const bad = await withLog(r)(r.bump('banana'));
  assert.equal(bad.status, 'error'); assert.match(bad.output, /not x\.y\.z/);
  assert.equal(servedDesktopVersion(r.data), '0.4.1');
});

test('release: a failed build publishes nothing and the previous version stays served (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const before = r.feed();
  const commit = r.bump('0.5.0', { FAKE_BUILD_FAIL: 'x' });
  const result = await withLog(r)(commit);
  assert.equal(result.status, 'build_failed'); assert.match(result.output, /electron-builder exploded/); assert.match(result.output, /exit 3/);
  assert.deepEqual(r.feed(), before);
  assert.equal(existsSync(join(r.data, 'downloads', 'Companion-Setup-0.5.0-x64.exe')), false);
  assert.equal(git(r.origin, 'rev-parse', 'main'), commit, 'main untouched');
});

test('release: a publish that fails half-way puts the previous feed back and removes the new installer files (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const before = r.feed();
  const commit = r.bump('0.5.0', { FAKE_PUBLISH_FAIL: 'x' });
  const result = await withLog(r)(commit);
  assert.equal(result.status, 'publish_failed'); assert.match(result.output, /disk full/);
  assert.deepEqual(r.feed(), before, 'latest.yml (already replaced by the script) and desktop.json are as before');
  assert.equal(existsSync(join(r.data, 'downloads', 'Companion-Setup-0.5.0-x64.exe')), false);
  assert.equal(existsSync(join(r.data, 'downloads', 'Companion-Setup-0.5.0-x64.exe.blockmap')), false);
  assert.equal(existsSync(join(r.data, 'downloads', 'Companion-Setup-0.4.0-x64.exe')), true, 'the served installer stays');
  assert.equal(git(r.origin, 'rev-parse', 'main'), commit);
});

test('release: a publish that exits 0 but serves the wrong thing is caught and rolled back (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const before = r.feed();
  const commit = r.bump('0.5.0');
  const result = await withLog(r)(commit, { publishCommand: ['sh', '-c', 'cp desktop/dist/latest.yml "$COMPANION_DATA_DIR/downloads/latest.yml"'] });
  assert.equal(result.status, 'publish_failed'); assert.match(result.output, /serves 0\.4\.0 instead of 0\.5\.0/);
  assert.deepEqual(r.feed(), before);
});

test('release: only a commit on origin/main is released (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  git(r.seed, 'checkout', '--quiet', '-b', 'agent/x/t1');
  writeFileSync(join(r.seed, 'desktop', 'package.json'), '{"version":"9.9.9"}\n'); git(r.seed, 'commit', '--quiet', '-am', 'branch only');
  git(r.seed, 'push', '--quiet', 'origin', 'agent/x/t1');
  const result = await withLog(r)(git(r.seed, 'rev-parse', 'HEAD'));
  assert.equal(result.status, 'error'); assert.match(result.output, /not on origin\/main/);
  assert.equal(r.built(), null); assert.equal(servedDesktopVersion(r.data), '0.4.0');
});

// ---------- The runner's wiring, with fakes ----------

const TICKET = 'ticket-90', HEAD = 'a'.repeat(40), MERGED = 'c'.repeat(40), BRANCH = 'agent/coder-1/t90';
const workRun = () => ({ id: 'coder-1-aaaaaa', agent: 'coder-1', ticketId: TICKET, ticketNumber: 90, repo: 'personal-agent', base: 'main', mode: 'work',
  branch: BRANCH, head: HEAD, commits: 1, state: 'succeeded', endedAt: 1000, createdAt: 900, cleanup: {} });
const reviewRun = () => ({ id: 'rev-1-bbbbbb', agent: 'rev-1', role: 'reviewer', ticketId: TICKET, ticketNumber: 90, repo: 'personal-agent', base: 'main',
  mode: 'review', reviewBranch: BRANCH, reviewHead: HEAD, state: 'succeeded', endedAt: 2000, createdAt: 1500, result: { kind: 'review', verdict: 'approve' }, cleanup: {} });

function setup(t, { release = { desktop: true, dataDir: '/data' }, mergeResult = { status: 'merged', mergeCommit: MERGED, output: 'ok' },
  releaseResult = { status: 'published', version: '0.5.0', previous: '0.4.0', served: '0.4.0', sha256: 'f'.repeat(64), file: 'Companion-Setup-0.5.0-x64.exe', output: 'built' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-90-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ runs: [workRun(), reviewRun()], events: [], seq: 0 }));
  const roster = new Roster({ file: join(dir, 'roster.json') });
  roster.create({ name: 'merger-1', role: 'merger', kind: 'standing', model: 'sonnet' });
  const manager = new Manager({ file: join(dir, 'manager.json'), projects: ['proj'] });
  const calls = { merge: [], release: [], posts: [] };
  const ops = {
    async branchInfo() { return { head: HEAD, commits: 1 }; },
    async merge(request) { calls.merge.push(request); return mergeResult; },
    async releaseDesktop(request) { calls.release.push(request); if (releaseResult instanceof Error) throw releaseResult; return releaseResult; },
    async unitActive() { return false; }, async stopUnit() {}
  };
  // The real BoardReporter's merge/release posting, over a fake Board client.
  const client = { async call(tool, args) {
    if (tool === 'get_ticket') return { id: TICKET, number: 90, title: 'Release', status: 'review', project_id: 'proj', thread_id: 'thread-90', version: 1 };
    if (tool === 'post_message') calls.posts.push(args.body);
    return { version: 2 };
  } };
  const reporter = new BoardReporter({ client, projects: ['proj'], ownerId: 'owner' });
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops, reporter, roster, manager, release,
    merge: { origin: 'https://github.com/Blackoutburst/personal-agent.git' } });
  t.after(() => runner.close());
  manager.decide({ kind: 'accept', ticketId: TICKET, reviewRunId: 'rev-1-bbbbbb', reason: 'approved' }, runner.list());
  const merged = async () => {
    const run = runner.launch({ mode: 'merge', agent: 'merger-1', ticketId: TICKET, repo: 'personal-agent', branch: BRANCH });
    const end = Date.now() + 3000;
    for (;;) {
      const now = runner.get(run.id);
      if (now.state === 'succeeded' || now.state === 'failed') {
        if (!(release?.desktop === true && now.state === 'succeeded' && mergeResult.status === 'merged') || (now.release && now.release.status !== 'running')) {
          await new Promise(resolve => setTimeout(resolve, 10)); return runner.get(run.id);
        }
      }
      if (Date.now() > end) throw new Error('timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const lines = () => runner.events(0).filter(event => event.type === 'manager.attention');
  return { dir, runner, calls, merged, lines };
}

test('runner: after a merge the release runs from the merge commit, the thread gets version and sha256, no Manager line (#90)', async t => {
  const s = setup(t);
  const run = await s.merged();
  assert.equal(s.calls.release.length, 1);
  assert.deepEqual({ commit: s.calls.release[0].commit, origin: s.calls.release[0].origin, base: s.calls.release[0].base, dataDir: s.calls.release[0].dataDir },
    { commit: MERGED, origin: 'https://github.com/Blackoutburst/personal-agent.git', base: 'main', dataDir: '/data' });
  assert.equal(run.release.status, 'published'); assert.equal(run.release.version, '0.5.0'); assert.equal(run.release.commit, MERGED);
  const post = s.calls.posts.find(body => /^Desktop 0\.5\.0 published/.test(body));
  assert.ok(post, s.calls.posts.join('\n---\n'));
  assert.match(post, new RegExp(`sha256 ${'f'.repeat(64)}`)); assert.match(post, /Companion-Setup-0\.5\.0-x64\.exe/);
  assert.ok(s.calls.posts.findIndex(body => /^Merge commit/.test(body)) < s.calls.posts.indexOf(post), 'merge recorded first, then the release');
  assert.deepEqual(s.lines(), []);
  assert.ok(s.runner.events(0).some(event => event.type === 'release.ended' && event.release === 'published'));
});

test('runner: a merge without a bump releases nothing and says nothing about it on the thread (#90)', async t => {
  const s = setup(t, { releaseResult: { status: 'skipped', reason: 'no_bump', version: '0.4.0', previous: '0.4.0', output: 'stays at 0.4.0' } });
  const run = await s.merged();
  assert.equal(run.release.status, 'skipped');
  assert.deepEqual(s.calls.posts.filter(body => /Desktop/.test(body)), []);
  assert.deepEqual(s.lines(), []);
});

test('runner: a lower version is skipped with a thread note and no Manager line (#90)', async t => {
  const s = setup(t, { releaseResult: { status: 'skipped', reason: 'not_higher', version: '0.3.0', previous: '0.4.0', output: 'went from 0.4.0 to 0.3.0, which is not higher.' } });
  const run = await s.merged();
  assert.equal(run.release.status, 'skipped');
  assert.ok(s.calls.posts.some(body => /^Desktop release skipped .*not higher.*Nothing was published/.test(body)));
  assert.deepEqual(s.lines(), []);
});

for (const [status, text] of [['build_failed', /nothing was published/], ['publish_failed', /previously published version is still served/]]) {
  test(`runner: ${status} raises a Manager line, posts the output, and the merge stays done (#90)`, async t => {
    const s = setup(t, { releaseResult: { status, version: '0.5.0', previous: '0.4.0', served: '0.4.0', output: 'boom output' } });
    const run = await s.merged();
    assert.equal(run.state, 'succeeded', 'the merge itself is not undone'); assert.equal(run.mergeResult.mergeCommit, MERGED);
    assert.equal(run.release.status, status);
    const line = s.lines().find(item => item.kind === 'release_failed');
    assert.ok(line); assert.match(line.suggestion, /#90/); assert.match(line.suggestion, text); assert.match(line.suggestion, /Main is merged and unchanged/);
    assert.doesNotMatch(line.suggestion, /boom output/);
    assert.ok(s.calls.posts.some(body => /Desktop release 0\.5\.0 .* failed/.test(body) && /boom output/.test(body)));
  });
}

test('runner: a thrown release is an error with a Manager line (#90)', async t => {
  const s = setup(t, { releaseResult: new Error('spawn bash ENOENT') });
  const run = await s.merged();
  assert.equal(run.release.status, 'error'); assert.match(run.release.output, /ENOENT/);
  assert.equal(s.lines().filter(item => item.kind === 'release_failed').length, 1);
});

test('runner: turned off by config (absent or desktop not true) nothing is released (#90)', async t => {
  for (const release of [null, { desktop: false, dataDir: '/data' }, { desktop: 'yes' }]) {
    const s = setup(t, { release });
    const run = await s.merged();
    assert.equal(run.state, 'succeeded');
    assert.equal(s.calls.release.length, 0); assert.equal(run.release, undefined);
    assert.deepEqual(s.calls.posts.filter(body => /Desktop/.test(body)), []);
  }
});

test('runner: a failed merge or an already merged head releases nothing (#90)', async t => {
  const failed = setup(t, { mergeResult: { status: 'tests_failed', output: 'red' } });
  assert.equal((await failed.merged()).state, 'failed');
  const already = setup(t, { mergeResult: { status: 'already_merged', mergeCommit: MERGED, output: 'already' } });
  assert.equal((await already.merged()).state, 'succeeded');
  assert.equal(failed.calls.release.length + already.calls.release.length, 0);
});

test('runner: a release cut off by a restart is marked interrupted with a Manager line (#90)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-recover-90-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = { id: 'merger-1-cccccc', agent: 'merger-1', ticketId: TICKET, ticketNumber: 90, repo: 'personal-agent', base: 'main', mode: 'merge',
    state: 'succeeded', mergeResult: { status: 'merged', mergeCommit: MERGED }, release: { status: 'running', commit: MERGED, startedAt: 1 }, cleanup: {} };
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ runs: [run], events: [], seq: 0 }));
  const runner = new AgentRunner({ file: join(dir, 'runs.json'), ops: { async stopUnit() {}, async unitActive() { return false; } }, reporter: {}, release: { desktop: true } });
  t.after(() => runner.close());
  await runner.recover();
  assert.equal(runner.get(run.id).release.status, 'interrupted');
  const line = runner.events(0).find(item => item.type === 'manager.attention');
  assert.equal(line.kind, 'release_failed'); assert.match(line.suggestion, /runner restart/);
});
