// The desktop release after a merge (#90, #91): the gate, the sandboxed build, the runner's own publish and the
// pair-atomic feed on temp repos, with a fake build (a shell script committed into the repo, like the real one) and a
// fake sandbox wrapper; then the runner/reporter wiring with fakes. Nothing here runs the real scripts/build-desktop.sh,
// the real cchan-sandbox-run or sudo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseDesktop, compareVersions, servedDesktopVersion, parseLatestYml, checkLatestYml, publishDesktop } from '../src/desktop-release.mjs';
import { SandboxOps, WRAPPER } from '../src/agent-sandbox-ops.mjs';
import { AgentRunner } from '../src/agent-runner.mjs';
import { BoardReporter } from '../src/agent-runner-board.mjs';
import { Manager } from '../src/agent-manager.mjs';
import { Roster } from '../src/agent-roster.mjs';

const ID = ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.test', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const sha = (text, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(text).digest(encoding);
const installer = v => `installer ${v}\n`;
const yml = (v, digest = sha(installer(v), 'sha512', 'base64')) => `version: ${v}\nfiles:\n  - url: Companion-Setup-${v}-x64.exe\n    sha512: ${digest}\n    size: ${installer(v).length}\npath: Companion-Setup-${v}-x64.exe\nsha512: ${digest}\nreleaseDate: '2026-11-12T00:00:00.000Z'\n`;

// A fake build: writes the installer, blockmap and an electron-builder style latest.yml (with the installer's sha512)
// for the package.json version into desktop/dist, and logs the commit, HOME and whether it ran under the fake sandbox.
// FAKE_BUILD_FAIL / FAKE_BAD_YML / FAKE_NO_BLOCKMAP in the repo make it fail or build something inconsistent.
const BUILD = `#!/bin/sh
set -eu
cd "$(dirname "$0")/../desktop"
[ ! -f ../FAKE_BUILD_FAIL ] || { echo "electron-builder exploded" >&2; exit 3; }
v=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' package.json)
mkdir -p dist
printf 'installer %s\\n' "$v" > "dist/Companion-Setup-$v-x64.exe"
[ -f ../FAKE_NO_BLOCKMAP ] || printf 'blockmap %s\\n' "$v" > "dist/Companion-Setup-$v-x64.exe.blockmap"
d=$(node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "dist/Companion-Setup-$v-x64.exe")
[ ! -f ../FAKE_BAD_YML ] || d=AAAA
s=$(wc -c < "dist/Companion-Setup-$v-x64.exe" | tr -d ' ')
printf 'version: %s\\nfiles:\\n  - url: Companion-Setup-%s-x64.exe\\n    sha512: %s\\n    size: %s\\npath: Companion-Setup-%s-x64.exe\\nsha512: %s\\n' "$v" "$v" "$d" "$s" "$v" "$d" > dist/latest.yml
printf '%s %s %s %s\\n' "$(git rev-parse HEAD 2>/dev/null || echo none)" "$HOME" "\${FAKE_SANDBOX:-owner}" "$(pwd)" > "$FAKE_LOG"
echo "built $v"
`;

// The fake sandbox: a wrapper that runs the command in cwd with FAKE_SANDBOX=1, recording every call.
const inCwd = (command, cwd) => ['/usr/bin/env', 'FAKE_SANDBOX=1', 'sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', cwd, ...command];

function repos(t, version = '0.4.0') {
  const root = mkdtempSync(join(tmpdir(), 'release-91-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), data = join(root, 'data'), log = join(root, 'build.log');
  const sandboxDir = join(root, 'sbroot', 'release'); mkdirSync(join(root, 'sbroot'));
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '-b', 'main');
  mkdirSync(join(seed, 'desktop')); mkdirSync(join(seed, 'scripts'));
  writeFileSync(join(seed, 'scripts', 'build-desktop.sh'), BUILD);
  // The merged publish script must never run: if anything executes it, it leaves a marker.
  writeFileSync(join(seed, 'scripts', 'publish-desktop.sh'), `#!/bin/sh\ntouch ${join(root, 'PUBLISH_SCRIPT_RAN')}\n`);
  writeFileSync(join(seed, 'desktop', 'package.json'), JSON.stringify({ name: 'companion-desktop', version }, null, 2) + '\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', '--quiet', 'origin', 'main');
  // What agents_merge does: a --no-ff merge of a branch onto main, pushed. Returns the merge commit.
  const mergeBranch = (files, name = 'agent/coder-1/t91') => {
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
  const downloads = join(data, 'downloads');
  // What the server serves now: a previous hand publish (plain files, as scripts/publish-desktop.sh leaves them).
  const serve = (v, json = JSON.stringify({ version: v, file: `Companion-Setup-${v}-x64.exe` }) + '\n') => {
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, `Companion-Setup-${v}-x64.exe`), installer(v));
    writeFileSync(join(downloads, 'latest.yml'), yml(v));
    writeFileSync(join(downloads, 'desktop.json'), json);
  };
  const feed = () => ['latest.yml', 'desktop.json'].map(name => { try { return readFileSync(join(downloads, name), 'utf8'); } catch { return null; } });
  const seen = [];
  const sandbox = (command, opts) => { seen.push({ command, ...opts }); return inCwd(command, opts.cwd); };
  const buildCommand = ['sh', '-c', `FAKE_LOG=${log} exec sh scripts/build-desktop.sh`];
  const release = (commit, extra = {}) => releaseDesktop({ origin, commit, dataDir: data, tmp: join(root, 'tmp'), buildCommand, sandbox, sandboxDir, ...extra });
  const built = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split(' ') : null;
  const publishScriptRan = () => existsSync(join(root, 'PUBLISH_SCRIPT_RAN'));
  const leftovers = () => [...(existsSync(sandboxDir) ? execFileSync('ls', [sandboxDir]).toString().split('\n').filter(Boolean) : []),
    ...(existsSync(join(root, 'tmp')) ? execFileSync('ls', [join(root, 'tmp')]).toString().split('\n').filter(Boolean) : [])];
  return { root, origin, seed, data, downloads, sandboxDir, mergeBranch, bump, serve, feed, release, built, seen, buildCommand, publishScriptRan, leftovers };
}

const fileIn = (r, name) => join(r.downloads, name);
const servedFiles = r => execFileSync('ls', ['-A', r.downloads]).toString().split('\n').filter(Boolean).sort();

test('versions compare as x.y.z numbers; anything else is not comparable (#90)', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.4.0', '0.4.1'), -1);
  assert.equal(compareVersions('0.4', '0.4.0'), null);
  assert.equal(compareVersions('0.5.0-beta', '0.4.0'), null);
  assert.equal(servedDesktopVersion('/nonexistent-dir-90'), null);
});

test('latest.yml: the release reads version, path and sha512 and checks them against the installer (#91)', () => {
  const v = '0.5.0', file = `Companion-Setup-${v}-x64.exe`, sha512 = sha(installer(v), 'sha512', 'base64'), size = installer(v).length;
  assert.deepEqual(parseLatestYml(yml(v)), { version: v, path: file, sha512, files: [{ url: file, sha512, size }] });
  assert.equal(checkLatestYml(yml(v), { version: v, file, sha512, size }), null);
  assert.match(checkLatestYml(yml('0.4.0'), { version: v, file, sha512, size }), /names version 0\.4\.0/);
  assert.match(checkLatestYml(yml(v, 'AAAA'), { version: v, file, sha512, size }), /sha512 .* does not match/);
  assert.match(checkLatestYml(`version: ${v}\npath: ${file}\n`, { version: v, file, sha512, size }), /no sha512/);
  assert.match(checkLatestYml(yml(v), { version: v, file, sha512, size: size + 1 }), /size/);
});

test('release: the build runs through the sandbox wrapper (SandboxOps), the runner publishes, the merged publish script never runs (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const commit = r.bump('0.5.0');
  // A fake sudo standing in for `sudo -n cchan-sandbox-run --cwd X --max-seconds N -- cmd`: it checks that exact shape,
  // logs it, and runs cmd in X with FAKE_SANDBOX=1. Everything SandboxOps sends through it is what would run sandboxed.
  const sudoLog = join(r.root, 'sudo.log'), sudo = join(r.root, 'sudo');
  writeFileSync(sudo, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${sudoLog}\n[ "$1" = -n ] && [ "$2" = ${WRAPPER} ] && [ "$3" = --cwd ] && [ "$5" = --max-seconds ] && [ "$7" = -- ] || exit 99\ncwd=$4; shift 7\ncd "$cwd" && FAKE_SANDBOX=1 exec "$@"\n`);
  chmodSync(sudo, 0o755);
  const ops = new SandboxOps({ sudo, root: join(r.root, 'sbroot') });
  const result = await ops.releaseDesktop({ origin: r.origin, commit, base: 'main', dataDir: r.data, tmp: join(r.root, 'tmp'), buildCommand: r.buildCommand,
    publishCommand: ['sh', 'scripts/publish-desktop.sh'] /* an old config key: ignored */ });
  assert.equal(result.status, 'published', result.output);
  const [builtAt, , where, cwd] = r.built();
  assert.equal(builtAt, commit, 'built from the merge commit itself');
  assert.equal(where, '1', 'the build ran under the sandbox wrapper');
  assert.ok(cwd.startsWith(join(r.root, 'sbroot', 'release', 'cchan-release-build-')), cwd);
  const calls = readFileSync(sudoLog, 'utf8').trim().split('\n');
  assert.deepEqual(calls.map(line => line.split(' -- ')[1].split(' ')[0]), ['sh', 'sh', 'cat', 'cat', 'cat', 'rm'], calls.join('\n'));
  assert.ok(calls.every(line => line.startsWith(`-n ${WRAPPER} --cwd `)));
  assert.equal(r.publishScriptRan(), false, 'scripts/publish-desktop.sh never ran');
  assert.deepEqual(r.leftovers(), [], 'the sandbox copy and the runner temp dir are removed');
  assert.equal(servedDesktopVersion(r.data), '0.5.0');
});

test('release: a merge that raises the version is built in the sandbox and published with matching sha256/sha512 (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const commit = r.bump('0.5.0');
  const result = await r.release(commit);
  assert.equal(result.status, 'published', result.output);
  assert.deepEqual({ version: result.version, previous: result.previous, served: result.served, file: result.file, notes: result.notes },
    { version: '0.5.0', previous: '0.4.0', served: '0.4.0', file: 'Companion-Setup-0.5.0-x64.exe', notes: [] });
  assert.equal(result.sha256, sha(installer('0.5.0')));
  assert.equal(result.sha512, sha(installer('0.5.0'), 'sha512', 'base64'));
  // What the sandbox was asked to do: make its copy, build, hand out the three files, remove its copy.
  assert.deepEqual(r.seen.map(s => s.command[0] === 'sh' && s.command[1] === '-c' && s.command[2].includes('mktemp') ? 'copy' : s.command.slice(0, 3).join(' ')),
    ['copy', r.buildCommand.join(' '), 'cat -- desktop/dist/Companion-Setup-0.5.0-x64.exe', 'cat -- desktop/dist/Companion-Setup-0.5.0-x64.exe.blockmap', 'cat -- desktop/dist/latest.yml', `rm -rf --`]);
  const [builtAt, , where] = r.built();
  assert.equal(builtAt, commit); assert.equal(where, '1');
  // Served: installer, blockmap and the pair, byte for byte what the build made.
  assert.equal(sha(readFileSync(fileIn(r, 'Companion-Setup-0.5.0-x64.exe'))), result.sha256);
  assert.equal(sha(readFileSync(fileIn(r, 'Companion-Setup-0.5.0-x64.exe')), 'sha512', 'base64'), result.sha512);
  assert.equal(readFileSync(fileIn(r, 'Companion-Setup-0.5.0-x64.exe.blockmap'), 'utf8'), 'blockmap 0.5.0\n');
  const [latest, desktop] = r.feed();
  assert.equal(checkLatestYml(latest, { version: '0.5.0', file: result.file, sha512: result.sha512, size: installer('0.5.0').length }), null);
  assert.deepEqual(JSON.parse(desktop), { version: '0.5.0', file: 'Companion-Setup-0.5.0-x64.exe' });
  // The pair are fixed symlinks into the one switched feed pointer.
  assert.equal(readlinkSync(fileIn(r, 'latest.yml')), '.feed/current/latest.yml');
  assert.equal(readlinkSync(fileIn(r, 'desktop.json')), '.feed/current/desktop.json');
  assert.ok(lstatSync(fileIn(r, '.feed/current')).isSymbolicLink());
  assert.equal(git(r.origin, 'rev-parse', 'main'), commit, 'main untouched');
  assert.equal(r.publishScriptRan(), false);
  assert.deepEqual(r.leftovers(), []);
});

test('release: without a sandbox (temp repos only) the build runs in its own copy with a throw-away HOME (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const result = await r.release(r.bump('0.5.0'), { sandbox: null, sandboxDir: null });
  assert.equal(result.status, 'published', result.output);
  const [, home, where, cwd] = r.built();
  assert.equal(where, 'owner'); assert.notEqual(home, process.env.HOME);
  assert.ok(cwd.startsWith(join(r.root, 'tmp', 'cchan-release-build-')), cwd);
  assert.deepEqual(r.leftovers(), []);
});

test('release: nothing is built or published for a merge without a version bump (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const result = await r.release(r.mergeBranch({ 'desktop/main.js': 'console.log(1)\n' }));
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'no_bump');
  assert.equal(r.built(), null, 'no build ran'); assert.deepEqual(r.seen, [], 'nothing went to the sandbox');
  assert.deepEqual(r.feed(), [yml('0.4.0'), '{"version":"0.4.0","file":"Companion-Setup-0.4.0-x64.exe"}\n']);
});

test('release: a lower version, or one the server already serves, publishes nothing (#90)', async t => {
  const r = repos(t, '0.4.0'); r.serve('0.4.0');
  const lower = await r.release(r.bump('0.3.9'));
  assert.equal(lower.status, 'skipped'); assert.equal(lower.reason, 'not_higher');
  const r2 = repos(t, '0.4.0'); r2.serve('0.6.0'); // published by hand ahead of main
  const behind = await r2.release(r2.bump('0.5.0'));
  assert.equal(behind.status, 'skipped'); assert.equal(behind.reason, 'not_higher'); assert.match(behind.output, /already serves 0\.6\.0/);
  assert.equal(r.built(), null); assert.equal(r2.built(), null);
  assert.equal(servedDesktopVersion(r.data), '0.4.0'); assert.equal(servedDesktopVersion(r2.data), '0.6.0');
});

test('release: the first publish (nothing served yet) goes out; a non x.y.z version is an error (#90)', async t => {
  const r = repos(t);
  const first = await r.release(r.bump('0.4.1'));
  assert.equal(first.status, 'published', first.output); assert.equal(first.served, null);
  assert.equal(servedDesktopVersion(r.data), '0.4.1');
  const bad = await r.release(r.bump('banana'));
  assert.equal(bad.status, 'error'); assert.match(bad.output, /not x\.y\.z/);
  assert.equal(servedDesktopVersion(r.data), '0.4.1');
});

test('release: a served or previous version that is not x.y.z does not block later releases (#91)', async t => {
  // A served desktop.json with a non-x.y.z version (the server serves nothing for it): replaced, with a note.
  for (const served of ['banana', '0.5.0-beta']) {
    const r = repos(t); r.serve('0.4.0', JSON.stringify({ version: served, file: 'Companion-Setup-0.4.0-x64.exe' }) + '\n');
    const result = await r.release(r.bump('0.4.1'));
    assert.equal(result.status, 'published', result.output); assert.equal(result.served, served);
    assert.match(result.notes.join(' '), /not x\.y\.z/);
    assert.equal(servedDesktopVersion(r.data), '0.4.1');
    // And the release after it goes on normally.
    assert.equal((await r.release(r.bump('0.4.2'))).status, 'published');
  }
  // The version before the merge was not x.y.z: only the served version is compared.
  const r = repos(t, 'banana'); r.serve('0.4.0');
  const fixed = await r.release(r.bump('0.5.0'));
  assert.equal(fixed.status, 'published', fixed.output); assert.match(fixed.notes.join(' '), /before this merge .* not x\.y\.z/);
  const r2 = repos(t, 'banana'); r2.serve('0.6.0');
  const still = await r2.release(r2.bump('0.5.0'));
  assert.equal(still.status, 'skipped'); assert.equal(still.reason, 'not_higher');
});

test('release: a failed build publishes nothing and the previous version stays served (#90)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const before = r.feed(), files = servedFiles(r);
  const commit = r.bump('0.5.0', { FAKE_BUILD_FAIL: 'x' });
  const result = await r.release(commit);
  assert.equal(result.status, 'build_failed'); assert.match(result.output, /electron-builder exploded/); assert.match(result.output, /exit 3/);
  assert.deepEqual(r.feed(), before); assert.deepEqual(servedFiles(r), files, 'downloads untouched');
  assert.equal(git(r.origin, 'rev-parse', 'main'), commit, 'main untouched');
  assert.deepEqual(r.leftovers(), []);
});

test('release: a build whose files do not hold together (wrong sha512 in latest.yml, no blockmap) publishes nothing (#91)', async t => {
  for (const [flag, text] of [['FAKE_BAD_YML', /latest\.yml's sha512 .* does not match/], ['FAKE_NO_BLOCKMAP', /blockmap could not be read/]]) {
    const r = repos(t); r.serve('0.4.0');
    const before = r.feed(), files = servedFiles(r);
    const result = await r.release(r.bump('0.5.0', { [flag]: 'x' }));
    assert.equal(result.status, 'build_failed'); assert.match(result.output, text);
    assert.deepEqual(r.feed(), before); assert.deepEqual(servedFiles(r), files);
  }
});

test('release: a build copy the sandbox reports outside its release dir is refused (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const liar = (command, { cwd }) => command[0] === 'sh' && String(command[2]).includes('mktemp') ? ['echo', '/home/ubuntu'] : inCwd(command, cwd);
  const result = await r.release(r.bump('0.5.0'), { sandbox: liar });
  assert.equal(result.status, 'error'); assert.match(result.output, /build copy in the sandbox/);
  assert.equal(r.built(), null); assert.equal(servedDesktopVersion(r.data), '0.4.0');
  assert.equal((await r.release(r.bump('0.5.1'), { sandboxDir: null })).status, 'error', 'a sandbox needs a sandboxDir');
});

// A publish that fails at each moment, from a hand-published (plain files) folder and from one the runner already
// published to: the pair served before is served after, byte for byte; the new installer files are gone.
for (const stage of ['copied', 'staged', 'swapped']) {
  test(`release: a publish failing after "${stage}" leaves the previous feed served intact (#91)`, async t => {
    const r = repos(t); r.serve('0.4.0');
    const before = r.feed();
    const failed = await r.release(r.bump('0.5.0'), { fault: s => { if (s === stage) throw new Error(`disk full at ${s}`); } });
    assert.equal(failed.status, 'publish_failed'); assert.match(failed.output, new RegExp(`disk full at ${stage}`));
    assert.deepEqual(r.feed(), before);
    assert.equal(existsSync(fileIn(r, 'Companion-Setup-0.5.0-x64.exe')), false);
    assert.equal(existsSync(fileIn(r, 'Companion-Setup-0.5.0-x64.exe.blockmap')), false);
    assert.equal(existsSync(fileIn(r, 'Companion-Setup-0.4.0-x64.exe')), true, 'the served installer stays');
    // Now from a runner-published feed: 0.5.1 goes out, 0.6.0 fails, 0.5.1 is still served.
    assert.equal((await r.release(r.bump('0.5.1'))).status, 'published');
    const published = r.feed();
    const again = await r.release(r.bump('0.6.0'), { fault: s => { if (s === stage) throw new Error('boom'); } });
    assert.equal(again.status, 'publish_failed');
    assert.deepEqual(r.feed(), published);
    assert.equal(existsSync(fileIn(r, 'Companion-Setup-0.6.0-x64.exe')), false);
    assert.equal(r.publishScriptRan(), false);
  });
}

test('release: latest.yml and desktop.json switch together, in one rename (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const old = r.feed(), seenAt = {};
  const result = await r.release(r.bump('0.5.0'), { fault: s => { seenAt[s] = r.feed(); } });
  assert.equal(result.status, 'published', result.output);
  assert.deepEqual(seenAt.copied, old, 'the installer files are in place, the pair is still the old one');
  assert.deepEqual(seenAt.staged, old, 'the new pair is staged, the old one is still served');
  assert.deepEqual(seenAt.swapped, r.feed(), 'one rename later both are new');
  assert.match(seenAt.swapped[0], /^version: 0\.5\.0/); assert.match(seenAt.swapped[1], /"0\.5\.0"/);
});

test('release: a real filesystem failure while publishing changes nothing served; a later hand publish is picked up (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const before = r.feed();
  writeFileSync(fileIn(r, '.feed'), 'in the way\n'); // the feed dir cannot be made
  const failed = await r.release(r.bump('0.5.0'));
  assert.equal(failed.status, 'publish_failed', failed.output);
  assert.deepEqual(r.feed(), before);
  rmSync(fileIn(r, '.feed'));
  assert.equal((await r.release(r.bump('0.5.1'))).status, 'published');
  // Blackout publishes 0.6.0 by hand (scripts/publish-desktop.sh renames plain files over the symlinks).
  writeFileSync(fileIn(r, 'Companion-Setup-0.6.0-x64.exe'), installer('0.6.0'));
  writeFileSync(fileIn(r, 'latest.yml'), yml('0.6.0'));
  writeFileSync(fileIn(r, 'desktop.json.tmp'), '{"version":"0.6.0","file":"Companion-Setup-0.6.0-x64.exe"}\n');
  execFileSync('mv', [fileIn(r, 'desktop.json.tmp'), fileIn(r, 'desktop.json')]);
  assert.equal(servedDesktopVersion(r.data), '0.6.0');
  assert.equal((await r.release(r.bump('0.6.1'))).status, 'published');
  assert.equal(servedDesktopVersion(r.data), '0.6.1');
  // Feed dirs: only the current one and the one before it are kept.
  const dirs = execFileSync('ls', [fileIn(r, '.feed')]).toString().split('\n').filter(Boolean);
  assert.equal(dirs.length, 3, dirs.join(' ')); assert.ok(dirs.includes('current'));
});

test('publishDesktop: a swap back that fails says where to look (#91)', async t => {
  const r = repos(t); r.serve('0.4.0');
  const art = join(r.root, 'art'); mkdirSync(art);
  writeFileSync(join(art, 'i'), installer('0.5.0')); writeFileSync(join(art, 'b'), 'bm\n'); writeFileSync(join(art, 'l'), yml('0.5.0'));
  const result = await publishDesktop({ downloads: r.downloads, version: '0.5.0', file: 'Companion-Setup-0.5.0-x64.exe', artifacts: { installer: join(art, 'i'), blockmap: join(art, 'b'), latest: join(art, 'l') },
    sha256: sha(installer('0.5.0')), sha512: sha(installer('0.5.0'), 'sha512', 'base64'),
    fault: s => { if (s === 'swapped') { rmSync(join(r.downloads, '.feed'), { recursive: true }); writeFileSync(join(r.downloads, '.feed'), 'x'); throw new Error('boom'); } } });
  assert.equal(result.ok, false); assert.match(result.problem, /Putting the previous feed back failed too/); assert.match(result.problem, /\.feed\/current/);
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

test('runner: a published release with a note (a non-x.y.z version left out of the gate) says so on the thread (#91)', async t => {
  const s = setup(t, { releaseResult: { status: 'published', version: '0.5.0', previous: '0.4.0', served: 'banana', sha256: 'f'.repeat(64), sha512: 'x', file: 'Companion-Setup-0.5.0-x64.exe',
    notes: ['downloads/desktop.json named "banana", which is not x.y.z (the server served nothing); it was replaced.'], output: 'built' } });
  const run = await s.merged();
  assert.equal(run.release.status, 'published'); assert.equal(run.release.sha512, 'x'); assert.equal(run.release.notes.length, 1);
  const post = s.calls.posts.find(body => /^Desktop 0\.5\.0 published/.test(body));
  assert.match(post, /Built in the agent sandbox, published by the runner/); assert.match(post, /Note: .*banana.*not x\.y\.z/);
  assert.deepEqual(s.lines(), []);
});
