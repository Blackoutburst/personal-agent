import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, readlinkSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createReleaseTool } from '../ops/release.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'companion-release-test-'));
  const repoDir = join(base, 'repo'), rootDir = join(base, 'install');
  const dataDir = join(base, 'data'), runtimeDir = join(base, 'runtime');
  for (const path of [repoDir, rootDir, dataDir, runtimeDir, join(base, 'hooks')]) mkdirSync(path, { mode: 0o700 });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=' + join(base, 'hooks'), '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@synthetic.invalid', ...args],
    { cwd: repoDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  const commit = value => {
    writeFileSync(join(repoDir, 'server.mjs'), 'export const version = ' + JSON.stringify(value) + ';\n');
    git('add', '--', 'server.mjs'); git('commit', '--quiet', '-m', value);
    return git('rev-parse', 'HEAD');
  };
  const first = commit('first'), second = commit('second');
  const initial = join(rootDir, 'releases', first);
  mkdirSync(initial, { recursive: true, mode: 0o700 });
  writeFileSync(join(initial, 'server.mjs'), 'export const version = "first";\n', { mode: 0o600 });
  symlinkSync(join('releases', first), join(rootDir, 'current'), 'dir');
  const dbPath = join(dataDir, 'bootstrap.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE private_notes (owner TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE conv_threads (id TEXT PRIMARY KEY, provider_session TEXT, session_turns INTEGER NOT NULL)');
  db.prepare('INSERT INTO conv_threads VALUES (?,?,?)').run('alice-thread', 'older-native-session', 2);
  const put = db.prepare('INSERT INTO private_notes VALUES (?,?)');
  put.run('alice', 'ALICE_DB_SYNTHETIC'); put.run('bob', 'BOB_DB_SYNTHETIC'); db.close(); chmodSync(dbPath, 0o600);
  const chat = join(dataDir, 'files', 'alice', 'chat.txt');
  mkdirSync(join(dataDir, 'files', 'alice'), { recursive: true, mode: 0o700 });
  writeFileSync(chat, 'ALICE_CHAT_BYTES', { mode: 0o600 });
  for (const label of ['alice', 'bob']) {
    const workspace = join(runtimeDir, label, 'workspace');
    mkdirSync(join(workspace, 'inbox'), { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, 'MEMORY.md'), label.toUpperCase() + '_MEMORY', { mode: 0o600 });
    writeFileSync(join(workspace, 'inbox', 'kept.txt'), label.toUpperCase() + '_INBOX', { mode: 0o600 });
    const home = join(runtimeDir, label, 'claude-home');
    mkdirSync(home, { mode: 0o700 }); writeFileSync(join(home, 'DO_NOT_COPY'), 'PROVIDER_LOGIN_SECRET_' + label, { mode: 0o600 });
  }
  mkdirSync(join(base, '.config', 'personal-agent'), { recursive: true, mode: 0o700 });
  writeFileSync(join(base, '.config', 'personal-agent', 'owners.json'), 'EXTERNAL_CONFIG_SECRET', { mode: 0o600 });
  const f = { base, repoDir, rootDir, dataDir, runtimeDir, dbPath, chat, first, second, git,
    trace: [], healthAnswers: [], running: true, stopHook: null,
    tool(extra = {}) { return createReleaseTool({ repoDir, rootDir, dataDir, runtimeDir,
      service: async action => { f.trace.push(action); if (action === 'stop') { f.running = false; await f.stopHook?.(); }
        else if (action === 'start') f.running = true; else assert.fail('Unexpected fake systemctl action: ' + action); },
      health: async () => { f.trace.push('health'); return f.healthAnswers.length ? f.healthAnswers.shift() : true; },
      now: () => new Date('2026-11-03T10:00:00Z'), ...extra }); },
    rows() { const db = new DatabaseSync(dbPath); try { return db.prepare('SELECT * FROM private_notes ORDER BY owner').all().map(row => ({ ...row })); } finally { db.close(); } },
    mutate() { const db = new DatabaseSync(dbPath); db.exec("UPDATE private_notes SET value='CHANGED'; UPDATE conv_threads SET provider_session='newer-native-session', session_turns=3"); db.close(); writeFileSync(chat, 'CHANGED_CHAT'); writeFileSync(join(runtimeDir, 'bob', 'workspace', 'MEMORY.md'), 'CHANGED_MEMORY'); },
    current() { return resolve(rootDir, readlinkSync(join(rootDir, 'current'))); } };
  t.after(() => { assert.ok(base.startsWith(join(tmpdir(), 'companion-release-test-'))); rmSync(base, { recursive: true, force: true }); });
  return f;
}
function allFiles(path) {
  const paths = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name), stat = lstatSync(child);
    assert.ok(!stat.isSymbolicLink(), 'Backup must not contain links');
    if (stat.isDirectory()) paths.push(...allFiles(child)); else paths.push(child);
  }
  return paths;
}
function privateModes(path) {
  const stat = lstatSync(path);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600, path);
  if (stat.isDirectory()) for (const name of readdirSync(path)) privateModes(join(path, name));
}

test('release snapshots quiesced private state before switching and keeps an exact previous target', async t => {
  const f = fixture(t);
  f.stopHook = () => { assert.equal(f.current(), join(f.rootDir, 'releases', f.first)); const db = new DatabaseSync(f.dbPath);
    db.prepare('UPDATE private_notes SET value=? WHERE owner=?').run('QUIESCED_ALICE', 'alice'); db.close(); };
  const result = await f.tool().release(f.second);
  assert.equal(result.current, f.second); assert.equal(result.previous, f.first);
  assert.equal(f.current(), join(f.rootDir, 'releases', f.second));
  assert.equal(resolve(f.rootDir, readlinkSync(join(f.rootDir, 'previous'))), join(f.rootDir, 'releases', f.first));
  assert.match(readFileSync(join(f.current(), 'server.mjs'), 'utf8'), /second/);
  assert.deepEqual(f.trace, ['stop', 'start', 'health']);
  const snapshot = new DatabaseSync(join(result.backup, 'bootstrap.sqlite'));
  try { assert.equal(snapshot.prepare('SELECT value FROM private_notes WHERE owner=?').get('alice').value, 'QUIESCED_ALICE'); } finally { snapshot.close(); }
  assert.equal(f.rows()[1].value, 'BOB_DB_SYNTHETIC');
  privateModes(result.backup);
});

test('a failed release health check automatically restores the original release and starts it', async t => {
  const f = fixture(t); f.healthAnswers.push(false, true);
  await assert.rejects(f.tool().release(f.second));
  assert.equal(f.current(), join(f.rootDir, 'releases', f.first));
  assert.equal(existsSync(join(f.rootDir, 'previous')), false);
  assert.equal(f.running, true);
  assert.deepEqual(f.trace, ['stop', 'start', 'health', 'stop', 'start', 'health']);
  assert.equal(f.rows()[0].value, 'ALICE_DB_SYNTHETIC');
});

test('rollback uses only the recorded previous release and preserves both private owners', async t => {
  const f = fixture(t), tool = f.tool();
  await tool.release(f.second); f.trace.length = 0;
  const result = await tool.rollback();
  assert.equal(result.current, f.first); assert.equal(result.previous, f.second);
  assert.equal(f.current(), join(f.rootDir, 'releases', f.first));
  assert.deepEqual(f.rows(), [{ owner: 'alice', value: 'ALICE_DB_SYNTHETIC' }, { owner: 'bob', value: 'BOB_DB_SYNTHETIC' }]);
  assert.deepEqual(f.trace, ['stop', 'start', 'health']);
});

test('backup includes database chat bytes and both workspaces while excluding all provider/config homes', async t => {
  const f = fixture(t), set = await f.tool().backup();
  assert.ok(isAbsolute(set)); assert.ok(relative(join(f.rootDir, 'backups'), set) && !relative(join(f.rootDir, 'backups'), set).startsWith('..'));
  assert.equal(readFileSync(join(set, 'files', 'alice', 'chat.txt'), 'utf8'), 'ALICE_CHAT_BYTES');
  for (const label of ['alice', 'bob']) {
    assert.equal(readFileSync(join(set, 'workspaces', label, 'MEMORY.md'), 'utf8'), label.toUpperCase() + '_MEMORY');
    assert.equal(readFileSync(join(set, 'workspaces', label, 'inbox', 'kept.txt'), 'utf8'), label.toUpperCase() + '_INBOX');
  }
  const files = allFiles(set); assert.ok(files.every(path => !/claude-home|codex-home|owners\.json|DO_NOT_COPY/.test(path)));
  for (const path of files.filter(path => !path.endsWith('bootstrap.sqlite'))) {
    const text = readFileSync(path, 'utf8'); assert.ok(!text.includes('PROVIDER_LOGIN_SECRET')); assert.ok(!text.includes('EXTERNAL_CONFIG_SECRET'));
  }
  privateModes(set); assert.deepEqual(f.trace, ['stop', 'start', 'health']); assert.equal(f.running, true);
});

test('restore recovers database chat and workspace bytes without touching provider homes', async t => {
  const f = fixture(t), tool = f.tool(), set = await tool.backup();
  const unchangedSet = Object.fromEntries(allFiles(set).map(path => [relative(set, path), createHash('sha256').update(readFileSync(path)).digest('hex')]));
  f.mutate();
  writeFileSync(join(f.runtimeDir, 'alice', 'workspace', 'new-after-backup.txt'), 'NEW');
  const result = await tool.restore(set);
  assert.equal(result.restored, set); assert.equal(result.sessionsReset, true);
  assert.deepEqual(Object.fromEntries(allFiles(set).map(path => [relative(set, path), createHash('sha256').update(readFileSync(path)).digest('hex')])), unchangedSet, 'Restoring must not mutate or rehash the retained backup set');
  const restoredDb = new DatabaseSync(f.dbPath);
  try { assert.deepEqual({ ...restoredDb.prepare('SELECT provider_session, session_turns FROM conv_threads').get() }, { provider_session: null, session_turns: 0 }); } finally { restoredDb.close(); }
  assert.equal(f.rows()[0].value, 'ALICE_DB_SYNTHETIC'); assert.equal(f.rows()[1].value, 'BOB_DB_SYNTHETIC');
  assert.equal(readFileSync(f.chat, 'utf8'), 'ALICE_CHAT_BYTES');
  assert.equal(readFileSync(join(f.runtimeDir, 'bob', 'workspace', 'MEMORY.md'), 'utf8'), 'BOB_MEMORY');
  assert.equal(existsSync(join(f.runtimeDir, 'alice', 'workspace', 'new-after-backup.txt')), false);
  assert.equal(readFileSync(join(f.runtimeDir, 'alice', 'claude-home', 'DO_NOT_COPY'), 'utf8'), 'PROVIDER_LOGIN_SECRET_alice');
  assert.equal(f.running, true);
});

test('failed restore health verification preserves the pre-restore private state and restarts it', async t => {
  const f = fixture(t), tool = f.tool(), set = await tool.backup(); f.mutate(); f.trace.length = 0;
  f.healthAnswers.push(false, true);
  await assert.rejects(tool.restore(set));
  assert.equal(f.rows()[0].value, 'CHANGED'); assert.equal(readFileSync(f.chat, 'utf8'), 'CHANGED_CHAT');
  const heldDb = new DatabaseSync(f.dbPath);
  try { assert.equal(heldDb.prepare('SELECT provider_session FROM conv_threads').get().provider_session, 'newer-native-session'); } finally { heldDb.close(); }
  assert.equal(readFileSync(join(f.runtimeDir, 'bob', 'workspace', 'MEMORY.md'), 'utf8'), 'CHANGED_MEMORY');
  assert.equal(f.running, true); assert.ok(f.trace.includes('health'));
});

test('restore refuses corrupted and external sets before stopping or mutating live data', async t => {
  const f = fixture(t), tool = f.tool(), set = await tool.backup(); f.trace.length = 0;
  writeFileSync(join(set, 'files', 'alice', 'chat.txt'), 'CORRUPT');
  await assert.rejects(tool.restore(set)); assert.deepEqual(f.trace, []); assert.equal(readFileSync(f.chat, 'utf8'), 'ALICE_CHAT_BYTES');
  await assert.rejects(tool.restore(f.dataDir)); assert.deepEqual(f.trace, []);
});

test('restore refuses a malicious traversal manifest and linked payload without publishing bytes', async t => {
  const f = fixture(t), tool = f.tool(), set = await tool.backup(); f.trace.length = 0;
  const manifestPath = join(set, 'manifest.json'), original = readFileSync(manifestPath);
  const manifest = JSON.parse(original);
  manifest.files.push({ path: '../../outside', size: 1, sha256: '0'.repeat(64) });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(tool.restore(set)); assert.deepEqual(f.trace, []);
  writeFileSync(manifestPath, original);
  const payload = join(set, 'files', 'alice', 'chat.txt'); rmSync(payload);
  symlinkSync(join(f.runtimeDir, 'alice', 'claude-home', 'DO_NOT_COPY'), payload);
  await assert.rejects(tool.restore(set)); assert.deepEqual(f.trace, []);
});

test('backup refuses workspace escape links and restarts after snapshot failure without reading their target', async t => {
  const f = fixture(t);
  symlinkSync(join(f.runtimeDir, 'bob', 'claude-home', 'DO_NOT_COPY'), join(f.runtimeDir, 'alice', 'workspace', 'foreign-link'));
  await assert.rejects(f.tool().backup());
  assert.equal(f.running, true); assert.ok(f.trace.includes('start'));
  assert.equal(f.rows()[0].value, 'ALICE_DB_SYNTHETIC');
});

test('an overlapping operation is refused while one fake service is quiescing', async t => {
  const f = fixture(t); let release, started;
  const stopEntered = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { release = resolve; });
  const tool = f.tool({ service: async action => { f.trace.push(action); if (action === 'stop') { started(); await stopped; } } });
  const pending = tool.backup(); await stopEntered;
  await assert.rejects(f.tool().backup()); release(); await pending;
  assert.equal(f.trace.filter(action => action === 'stop').length, 1);
});

test('invalid revision and unsafe current target refuse before service commands', async t => {
  const f = fixture(t), tool = f.tool();
  await assert.rejects(tool.release('not-a-revision'));
  assert.deepEqual(f.trace, []);
  rmSync(join(f.rootDir, 'current')); symlinkSync(f.dataDir, join(f.rootDir, 'current'), 'dir');
  await assert.rejects(tool.backup()); assert.deepEqual(f.trace, []);
});

test('a cached release with wrong bytes cannot impersonate the requested Git commit', async t => {
  const f = fixture(t), target = join(f.rootDir, 'releases', f.second);
  mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, 'server.mjs'), 'WRONG_CACHED_SOURCE', { mode: 0o600 });
  await assert.rejects(f.tool().release(f.second));
  assert.deepEqual(f.trace, []); assert.equal(f.current(), join(f.rootDir, 'releases', f.first));
  assert.equal(readFileSync(join(target, 'server.mjs'), 'utf8'), 'WRONG_CACHED_SOURCE');
});

test('a verified existing release can be selected again without losing its previous target', async t => {
  const f = fixture(t), tool = f.tool();
  await tool.release(f.second);
  const result = await tool.release(f.second);
  assert.equal(result.current, f.second); assert.equal(result.previous, f.first);
  assert.equal(f.current(), join(f.rootDir, 'releases', f.second));
});

test('an unhealthy recovery gets a final stop attempt with the original private state retained', async t => {
  const f = fixture(t); f.healthAnswers.push(false, false);
  await assert.rejects(f.tool().release(f.second), error => error.code === 'RECOVERY');
  assert.equal(f.current(), join(f.rootDir, 'releases', f.first));
  assert.equal(f.trace.at(-1), 'stop'); assert.equal(f.running, false);
  assert.equal(f.rows()[0].value, 'ALICE_DB_SYNTHETIC');
});

test('CLI entry through the current symlink runs validation without touching services', t => {
  const f = fixture(t), ops = join(f.current(), 'ops');
  mkdirSync(ops, { mode: 0o700 });
  writeFileSync(join(ops, 'release.mjs'), readFileSync(new URL('../ops/release.mjs', import.meta.url)), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(f.rootDir, 'current', 'ops', 'release.mjs'), 'invalid-operation'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /"error":"INVALID"/); assert.deepEqual(f.trace, []);
});

test('Git archive long paths and executable modes survive a private release extraction', async t => {
  const f = fixture(t), directory = 'nested/' + 'x'.repeat(110), name = directory + '/payload.txt';
  mkdirSync(join(f.repoDir, directory), { recursive: true });
  writeFileSync(join(f.repoDir, name), 'CANONICAL_LONG_PATH');
  f.git('add', '--', name); f.git('update-index', '--chmod=+x', '--', 'server.mjs');
  f.git('commit', '--quiet', '-m', 'long path and executable');
  const rev = f.git('rev-parse', 'HEAD'), result = await f.tool().release(rev);
  assert.equal(result.current, rev);
  assert.equal(readFileSync(join(f.current(), name), 'utf8'), 'CANONICAL_LONG_PATH');
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(join(f.current(), name)).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(f.current(), 'server.mjs')).mode & 0o777, 0o700);
  }
});

test('a Git source link is refused before extraction can publish outside the release', async t => {
  const f = fixture(t);
  symlinkSync(f.chat, join(f.repoDir, 'unsafe-link'));
  f.git('add', '--', 'unsafe-link'); f.git('commit', '--quiet', '-m', 'unsafe synthetic link');
  await assert.rejects(f.tool().release(f.git('rev-parse', 'HEAD')));
  assert.deepEqual(f.trace, []); assert.equal(f.current(), join(f.rootDir, 'releases', f.first));
  assert.equal(readFileSync(f.chat, 'utf8'), 'ALICE_CHAT_BYTES');
});

test('rollback refuses modified previous-release bytes before stopping the current service', async t => {
  const f = fixture(t), tool = f.tool();
  await tool.release(f.second); f.trace.length = 0;
  writeFileSync(join(f.rootDir, 'releases', f.first, 'server.mjs'), 'MODIFIED_PREVIOUS');
  await assert.rejects(tool.rollback());
  assert.deepEqual(f.trace, []); assert.equal(f.current(), join(f.rootDir, 'releases', f.second));
  assert.equal(f.rows()[1].value, 'BOB_DB_SYNTHETIC');
});

test('an invalid newline-suffixed runtime label cannot produce an unrestorable completed set', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), workspace = join(f.runtimeDir, 'invalid\n', 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'DO_NOT_INCLUDE'), 'INVALID_LABEL_CONTENT', { mode: 0o600 });
  const tool = f.tool(), set = await tool.backup(), manifest = JSON.parse(readFileSync(join(set, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.workspaces, ['alice', 'bob']);
  assert.ok(allFiles(set).every(path => !path.includes('invalid\n')));
  assert.equal((await tool.restore(set)).restored, set, 'Every published set must validate for restore');
});

test('npm dependencies install once per lock file outside the release folder, before the service is touched (#68)', async t => {
  const f = fixture(t), lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': {}, 'node_modules/fake': { version: '1.0.0' } } });
  writeFileSync(join(f.repoDir, 'package.json'), '{"name":"x","dependencies":{"fake":"1.0.0"}}');
  writeFileSync(join(f.repoDir, 'package-lock.json'), lock);
  f.git('add', '--', 'package.json', 'package-lock.json'); f.git('commit', '--quiet', '-m', 'deps');
  const installs = [];
  const install = async dir => {
    installs.push(dir); f.trace.push('install');
    assert.equal(readFileSync(join(dir, 'package-lock.json'), 'utf8'), lock);
    mkdirSync(join(dir, 'node_modules', 'fake'), { recursive: true }); writeFileSync(join(dir, 'node_modules', 'fake', 'index.js'), 'module.exports = 1;\n');
  };
  const key = createHash('sha256').update(lock).digest('hex');
  await f.tool({ install }).release(f.git('rev-parse', 'HEAD'));
  assert.deepEqual(f.trace.slice(0, 2), ['install', 'stop'], 'installed before the service stops');
  assert.equal(readFileSync(join(f.rootDir, 'deps', key, 'node_modules', 'fake', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(existsSync(join(f.current(), 'node_modules')), false, 'the release folder stays Git source only');
  f.git('commit', '--quiet', '--allow-empty', '-m', 'same lock');
  await f.tool({ install }).release(f.git('rev-parse', 'HEAD'));
  assert.equal(installs.length, 1, 'the same lock file reuses its folder');
  assert.deepEqual(readdirSync(join(f.rootDir, 'deps')), [key], 'no stage folder is left behind');

  // A failed install refuses the release before any service command and leaves nothing half installed.
  writeFileSync(join(f.repoDir, 'package-lock.json'), lock.replace('1.0.0', '2.0.0'));
  f.git('add', '--', 'package-lock.json'); f.git('commit', '--quiet', '-m', 'new lock');
  f.trace.length = 0;
  await assert.rejects(f.tool({ install: async () => { throw new Error('npm failed'); } }).release(f.git('rev-parse', 'HEAD')), error => error.code === 'SOURCE');
  assert.deepEqual(f.trace, []); assert.deepEqual(readdirSync(join(f.rootDir, 'deps')), [key]);
  // An installer that leaves a link behind is refused too.
  await assert.rejects(f.tool({ install: async dir => { mkdirSync(join(dir, 'node_modules')); symlinkSync('/etc', join(dir, 'node_modules', 'bad')); } })
    .release(f.git('rev-parse', 'HEAD')));
  assert.deepEqual(f.trace, []); assert.deepEqual(readdirSync(join(f.rootDir, 'deps')), [key]);
});
