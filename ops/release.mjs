#!/usr/bin/env node
// Operator-only release/data tool. Provider homes and external configuration are never traversed.
import { constants, lstatSync, mkdirSync, readdirSync, openSync, closeSync, fstatSync,
  readSync, writeSync, fsyncSync, chmodSync, renameSync, unlinkSync, rmdirSync, rmSync,
  readlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

// Strict end-of-input: JavaScript's $ also accepts a final line terminator.
const execute = promisify(execFile), SHA = /^[a-f0-9]{40}(?![\s\S])/, LABEL = /^[a-z][a-z0-9-]{0,31}(?![\s\S])/;
const MAX_ENTRIES = 200000, MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const COMPATIBILITY = 'Additive schemas only; operator must verify matching peer-card and current feature readers. Provider homes/configuration excluded; restored chats start fresh native sessions.';
const MESSAGES = { INVALID: 'Invalid release operation or configuration.', UNSAFE: 'Unsafe filesystem object or path.',
  LOCKED: 'Another operation is active; inspect a stale lock before removing it.', SOURCE: 'The source revision or archive is invalid.',
  BACKUP: 'The private snapshot could not be completed.', SET: 'The backup set is invalid or has changed.',
  SERVICE: 'The service command failed.', HEALTH: 'Health verification failed; the prior state was recovered.',
  RECOVERY: 'Recovery failed; stop was attempted. Inspect service state and preserved files before retrying.', FAILED: 'The operation failed; inspect the preserved state.' };

class OperationError extends Error {
  constructor(code) { super(MESSAGES[code]); this.name = 'OperationError'; this.code = code; }
}
const refuse = (code = 'UNSAFE') => { throw new OperationError(code); };
const present = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inside = (path, root) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };

function directory(path, create = false, privateMode = false) {
  const parent = dirname(path);
  if (parent !== path) directory(parent);
  let info = present(path);
  if (!info && create) { mkdirSync(path, { mode: 0o700 }); info = lstatSync(path); }
  if (!info?.isDirectory() || info.isSymbolicLink()) refuse();
  if (privateMode && process.platform !== 'win32') {
    if (info.uid !== process.getuid()) refuse();
    chmodSync(path, 0o700);
  }
}

function regular(path) {
  directory(dirname(path)); const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || process.platform !== 'win32' && info.uid !== process.getuid()) refuse();
  return info;
}

function readRegular(path, max = Infinity) {
  const before = regular(path); if (before.size > max) refuse();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (info.ino !== before.ino || info.dev !== before.dev || info.nlink !== 1 || !info.isFile()) refuse();
    const bytes = Buffer.alloc(info.size); let offset = 0, count;
    while (offset < bytes.length && (count = readSync(fd, bytes, offset, bytes.length - offset, null))) offset += count;
    if (offset !== bytes.length) refuse(); return bytes;
  } finally { closeSync(fd); }
}

function writePrivate(path, bytes) {
  directory(dirname(path)); const fd = openSync(path, 'wx', 0o600);
  try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function copyRegular(source, destination) {
  const before = regular(source), input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let output;
  try {
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) refuse();
    if (destination !== undefined) { directory(dirname(destination)); output = openSync(destination, 'wx', 0o600); }
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let size = 0, count;
    while ((count = readSync(input, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, count)); size += count;
      if (output !== undefined) { let offset = 0; while (offset < count) offset += writeSync(output, buffer, offset, count - offset); }
    }
    const after = fstatSync(input);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) refuse();
    if (output !== undefined) fsyncSync(output); return { size, sha256: hash.digest('hex') };
  } finally { closeSync(input); if (output !== undefined) closeSync(output); }
}

function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path)) refuse();
  return path;
}

function walk(path, visit, prefix = '') {
  directory(path);
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const selected = join(path, entry.name), name = safeRelative(prefix ? prefix + '/' + entry.name : entry.name);
    const info = lstatSync(selected);
    if (info.isSymbolicLink() || process.platform !== 'win32' && info.uid !== process.getuid()) refuse();
    if (info.isDirectory()) { visit(selected, name, true); walk(selected, visit, name); }
    else { regular(selected); visit(selected, name, false); }
  }
}

function copyTree(source, destination, prefix, files, directories) {
  directory(source); directory(destination, true, true); directories.push(prefix);
  walk(source, (path, name, dir) => {
    const target = join(destination, ...name.split('/')), key = prefix + '/' + name;
    if (dir) { directory(target, true, true); directories.push(key); }
    else files.push({ path: key, ...copyRegular(path, target) });
  });
}

// Only tool-created, direct temporary children are recursively removed.
function cleanTemporary(path, parent, prefix) {
  if (dirname(path) !== parent || !basename(path).startsWith(prefix)) refuse();
  const info = present(path); if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) { walk(path, () => {}); rmSync(path, { recursive: true }); }
  else { regular(path); unlinkSync(path); }
}

function tarNumber(bytes) {
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(value)) refuse('SOURCE');
  const number = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) refuse('SOURCE'); return number;
}

function extractArchive(archive, destination) {
  const fd = openSync(archive, 'r'), total = fstatSync(fd).size; let offset = 0, nextPath = null;
  const read = size => { const bytes = Buffer.alloc(size); let at = 0, count;
    while (at < size && (count = readSync(fd, bytes, at, size - at, offset + at))) at += count;
    if (at !== size) refuse('SOURCE'); return bytes; };
  try {
    while (offset + 512 <= total) {
      const header = read(512); offset += 512;
      if (header.every(byte => byte === 0)) return;
      const checksum = tarNumber(header.subarray(148, 156)); let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (sum !== checksum) refuse('SOURCE');
      const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/, '');
      const size = tarNumber(header.subarray(124, 136)), type = text(156, 157), prefix = text(345, 500);
      if (offset + size > total) refuse('SOURCE');
      if (type === 'g' || type === 'x') {
        if (size > 1024 * 1024) refuse('SOURCE'); const pax = read(size); let at = 0;
        while (at < pax.length) {
          const space = pax.indexOf(32, at), length = Number(pax.subarray(at, space).toString());
          if (space < at || !Number.isSafeInteger(length) || length < 4 || at + length > pax.length) refuse('SOURCE');
          const record = pax.subarray(space + 1, at + length - 1).toString('utf8'), equal = record.indexOf('=');
          if (equal < 1) refuse('SOURCE');
          if (type === 'x' && record.slice(0, equal) === 'path') nextPath = record.slice(equal + 1);
          else if (!['comment', 'mtime', 'atime', 'ctime'].includes(record.slice(0, equal))) refuse('SOURCE');
          at += length;
        }
      } else {
        const name = safeRelative((nextPath ?? (prefix ? prefix + '/' : '') + text(0, 100)).replace(/\/$/, '')); nextPath = null;
        const target = join(destination, ...name.split('/'));
        if (!inside(target, destination)) refuse('SOURCE');
        // Git archives are trusted source, but links/devices never become deployment files.
        if (type === '5') { if (size !== 0) refuse('SOURCE'); directory(target, true, true); }
        else if (type === '0' || type === '') {
          directory(dirname(target)); const output = openSync(target, 'wx', tarNumber(header.subarray(100, 108)) & 0o111 ? 0o700 : 0o600);
          try {
            let at = 0; const buffer = Buffer.alloc(64 * 1024);
            while (at < size) { const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - at), offset + at);
              if (!count) refuse('SOURCE'); let written = 0; while (written < count) written += writeSync(output, buffer, written, count - written); at += count; }
            fsyncSync(output);
          } finally { closeSync(output); }
        } else refuse('SOURCE');
      }
      offset += Math.ceil(size / 512) * 512;
    }
    refuse('SOURCE');
  } finally { closeSync(fd); }
}

export function createReleaseTool({ repoDir = process.cwd(), rootDir, dataDir, runtimeDir, service, health, now = () => new Date() } = {}) {
  if (![repoDir, rootDir, dataDir, runtimeDir].every(path => typeof path === 'string' && isAbsolute(path))
      || typeof service !== 'function' || typeof health !== 'function' || typeof now !== 'function') refuse('INVALID');
  repoDir = resolve(repoDir); rootDir = resolve(rootDir); dataDir = resolve(dataDir); runtimeDir = resolve(runtimeDir);
  const releases = join(rootDir, 'releases'), backups = join(rootDir, 'backups'), lock = join(rootDir, '.release-lock');
  if (dataDir === rootDir || runtimeDir === rootDir || dataDir === runtimeDir || inside(rootDir, dataDir)
      || [dataDir, runtimeDir].some(path => path === releases || path === backups || inside(path, releases) || inside(path, backups))
      || runtimeDir === join(dataDir, 'files') || inside(runtimeDir, join(dataDir, 'files'))) refuse('INVALID');

  const callService = async action => { try { await service(action); } catch { refuse('SERVICE'); } };
  const checkHealth = async () => { try { return await health() === true; } catch { return false; } };
  const start = async () => { await callService('start'); if (!await checkHealth()) refuse('HEALTH'); };
  const recoveryFailure = async () => { try { await callService('stop'); } catch { /* operator must inspect actual state */ } refuse('RECOVERY'); };
  const linkValue = name => {
    const path = join(rootDir, name), info = present(path); if (!info) return null;
    if (!info.isSymbolicLink()) refuse(); const target = resolve(rootDir, readlinkSync(path));
    if (dirname(target) !== releases || !SHA.test(basename(target))) refuse();
    directory(target); walk(target, () => {}); return basename(target);
  };
  const links = () => ({ current: linkValue('current'), previous: linkValue('previous') });
  const setLink = (name, sha) => {
    linkValue(name); const target = join(rootDir, name);
    if (sha === null) { if (present(target)) unlinkSync(target); return; }
    const temporary = join(rootDir, '.link-' + randomUUID());
    try { symlinkSync(join('releases', sha), temporary, 'dir'); renameSync(temporary, target); }
    finally { if (present(temporary)?.isSymbolicLink()) unlinkSync(temporary); }
  };
  const setLinks = state => { setLink('previous', state.previous); setLink('current', state.current); };

  const locked = async action => {
    directory(rootDir, true, true); directory(releases, true, true); directory(backups, true, true);
    try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') refuse('LOCKED'); throw error; }
    try {
      directory(dataDir); if (present(runtimeDir)) directory(runtimeDir); links();
      return await action();
    } catch (error) { throw error instanceof OperationError ? error : new OperationError('FAILED'); }
    finally { rmdirSync(lock); }
  };

  const workspaceLabels = () => {
    if (!present(runtimeDir)) return [];
    directory(runtimeDir); const labels = [];
    // Do not enumerate a label's siblings (claude-home/codex-home). Inspect only its workspace.
    for (const name of readdirSync(runtimeDir).sort()) {
      if (!LABEL.test(name)) continue;
      const parent = join(runtimeDir, name); directory(parent);
      const workspace = join(parent, 'workspace'); if (!present(workspace)) continue;
      directory(workspace); labels.push(name);
    }
    return labels;
  };

  const snapshot = () => {
    const stamp = new Date(now()); if (!Number.isFinite(stamp.getTime())) refuse('INVALID');
    const stage = join(backups, '.stage-' + randomUUID()), set = join(backups, stamp.toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    directory(stage, true, true);
    try {
      const database = join(dataDir, 'bootstrap.sqlite'); regular(database);
      for (const suffix of ['-wal', '-shm', '-journal']) if (present(database + suffix)) regular(database + suffix);
      let db;
      try { db = new DatabaseSync(database, { readOnly: true }); db.exec("PRAGMA busy_timeout=5000; VACUUM INTO '" + join(stage, 'bootstrap.sqlite').replace(/'/g, "''") + "'"); }
      finally { db?.close(); }
      chmodSync(join(stage, 'bootstrap.sqlite'), 0o600);
      const files = [{ path: 'bootstrap.sqlite', ...copyRegular(join(stage, 'bootstrap.sqlite')) }], directories = [];
      const filesPresent = !!present(join(dataDir, 'files'));
      if (filesPresent) copyTree(join(dataDir, 'files'), join(stage, 'files'), 'files', files, directories);
      const workspaces = workspaceLabels(); directory(join(stage, 'workspaces'), true, true); directories.push('workspaces');
      for (const label of workspaces) copyTree(join(runtimeDir, label, 'workspace'), join(stage, 'workspaces', label), 'workspaces/' + label, files, directories);
      const manifest = { version: 1, createdAt: stamp.toISOString(), sourceCommit: linkValue('current'), compatibility: COMPATIBILITY,
        filesPresent, workspaces, directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      if (files.length > MAX_ENTRIES || directories.length > MAX_ENTRIES || manifestBytes.length > MAX_MANIFEST_BYTES) refuse('BACKUP');
      writePrivate(join(stage, 'manifest.json'), manifestBytes);
      renameSync(stage, set); return set;
    } catch (error) { cleanTemporary(stage, backups, '.stage-'); throw error instanceof OperationError ? error : new OperationError('BACKUP'); }
  };

  const validateSet = input => {
    try {
      if (typeof input !== 'string' || !input || input.split(/[\\/]/).includes('..')
          || !isAbsolute(input) && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(input)) refuse('SET');
      const set = isAbsolute(input) ? resolve(input) : join(backups, input);
      if (dirname(set) !== backups || basename(set).startsWith('.')) refuse('SET'); directory(set);
      const manifest = JSON.parse(readRegular(join(set, 'manifest.json'), MAX_MANIFEST_BYTES).toString('utf8'));
      if (manifest.version !== 1 || manifest.sourceCommit !== null && !SHA.test(manifest.sourceCommit)
          || typeof manifest.filesPresent !== 'boolean' || !Array.isArray(manifest.workspaces) || !Array.isArray(manifest.directories)
          || !Array.isArray(manifest.files) || manifest.files.length > MAX_ENTRIES || manifest.directories.length > MAX_ENTRIES
          || new Set(manifest.workspaces).size !== manifest.workspaces.length || manifest.workspaces.some(label => !LABEL.test(label))) refuse('SET');
      const allowed = (path, dir) => {
        safeRelative(path);
        return path === 'bootstrap.sqlite' && !dir || path === 'files' && dir && manifest.filesPresent
          || path.startsWith('files/') && manifest.filesPresent || path === 'workspaces' && dir
          || manifest.workspaces.some(label => path === 'workspaces/' + label && dir || path.startsWith('workspaces/' + label + '/'));
      };
      const expected = new Map([['manifest.json', false]]);
      for (const path of manifest.directories) { if (!allowed(path, true) || expected.has(path)) refuse('SET'); expected.set(path, true); }
      for (const file of manifest.files) {
        if (!file || !allowed(file.path, false) || expected.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse('SET');
        expected.set(file.path, false); const fingerprint = copyRegular(join(set, ...file.path.split('/')));
        if (fingerprint.size !== file.size || fingerprint.sha256 !== file.sha256) refuse('SET');
      }
      if (!expected.has('bootstrap.sqlite') || !expected.has('workspaces') || manifest.filesPresent && !expected.has('files')
          || manifest.workspaces.some(label => !expected.has('workspaces/' + label))) refuse('SET');
      walk(set, (path, name, dir) => { if (!expected.has(name) || expected.get(name) !== dir) refuse('SET'); expected.delete(name); });
      if (expected.size) refuse('SET'); return { set, manifest };
    } catch { refuse('SET'); }
  };

  const archive = async sha => {
    const destination = join(releases, sha);
    const stage = join(releases, '.stage-' + randomUUID()), tar = join(releases, '.archive-' + randomUUID());
    directory(stage, true, true);
    try {
      await execute('git', ['-C', repoDir, 'archive', '--format=tar', '--output=' + tar, sha], { maxBuffer: 1024 * 1024 });
      regular(tar); extractArchive(tar, stage);
      if (present(destination)) {
        const inventory = path => {
          directory(path); const entries = [{ path: '', dir: true, mode: lstatSync(path).mode & 0o777 }];
          walk(path, (selected, name, dir) => entries.push({ path: name, dir, mode: lstatSync(selected).mode & 0o777,
            ...(dir ? {} : copyRegular(selected)) }));
          return JSON.stringify(entries);
        };
        if (inventory(stage) !== inventory(destination)) refuse('SOURCE');
      } else renameSync(stage, destination);
    } catch { refuse('SOURCE'); }
    finally { cleanTemporary(stage, releases, '.stage-'); cleanTemporary(tar, releases, '.archive-'); }
  };

  const changeRelease = async target => {
    const original = links(); let stopped = false, started = false, backup;
    try {
      stopped = true; await callService('stop'); backup = snapshot();
      const previous = target === original.current ? original.previous : original.current;
      setLinks({ current: target, previous }); started = true; await start();
      return { current: target, previous, backup };
    } catch (error) {
      if (stopped) {
        try {
          if (started) await callService('stop');
          setLinks(original);
          if (original.current) await start();
        } catch { await recoveryFailure(); }
      }
      throw error;
    }
  };

  const prepareRestore = ({ set, manifest }) => {
    const plan = [];
    const add = (target, source, dir) => {
      directory(dirname(target), true, true);
      const token = randomUUID(), stage = source ? join(dirname(target), '.restore-stage-' + token) : null;
      const entry = { target, stage, held: join(dirname(target), '.restore-old-' + token), dir, moved: false, applied: false }; plan.push(entry);
      if (present(target)) { if (dir) { directory(target); walk(target, () => {}); } else regular(target); }
      if (source) {
        const key = relative(set, source).split(sep).join('/'), copied = [];
        if (dir) copyTree(source, stage, key, copied, []);
        else copied.push({ path: key, ...copyRegular(source, stage) });
        const expected = manifest.files.filter(file => file.path === key || file.path.startsWith(key + '/'));
        if (expected.length !== copied.length || copied.some(file => !expected.some(value =>
          value.path === file.path && value.size === file.size && value.sha256 === file.sha256))) refuse('SET');
      }
    };
    try {
      add(join(dataDir, 'bootstrap.sqlite'), join(set, 'bootstrap.sqlite'), false);
      // No provider-home restoration: invalidate DB resume mappings in the live staged copy only.
      const db = new DatabaseSync(plan[0].stage);
      try {
        const table = db.prepare("SELECT type FROM sqlite_master WHERE name='conv_threads'").get();
        if (table) {
          const columns = db.prepare('PRAGMA table_info(conv_threads)').all().map(column => column.name);
          if (table.type !== 'table' || !columns.includes('provider_session') || !columns.includes('session_turns')
              || db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='conv_threads'").get()) refuse('SET');
          db.exec('UPDATE conv_threads SET provider_session=NULL, session_turns=0');
        }
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') refuse('SET');
      } finally { db.close(); }
      add(join(dataDir, 'files'), manifest.filesPresent ? join(set, 'files') : null, true);
      for (const label of manifest.workspaces) add(join(runtimeDir, label, 'workspace'), join(set, 'workspaces', label), true);
      return plan;
    } catch (error) { for (const entry of plan) if (entry.stage) cleanTemporary(entry.stage, dirname(entry.target), '.restore-stage-'); throw error; }
  };

  const cleanupPlan = plan => { for (const entry of plan) {
    if (entry.stage) cleanTemporary(entry.stage, dirname(entry.target), '.restore-stage-');
  } };
  const restoreOriginal = plan => {
    for (const entry of [...plan].reverse()) {
      if ((entry.applied || entry.moved) && present(entry.target)) {
        if (entry.dir) { directory(entry.target); walk(entry.target, () => {}); } else regular(entry.target);
        entry.stage ??= join(dirname(entry.target), '.restore-stage-' + randomUUID());
        renameSync(entry.target, entry.stage);
      }
      if (entry.moved) renameSync(entry.held, entry.target);
    }
  };

  return {
    release: (rev = 'HEAD') => locked(async () => {
      if (typeof rev !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/.test(rev)) refuse('SOURCE');
      let sha;
      try { directory(repoDir); const result = await execute('git', ['-C', repoDir, 'rev-parse', '--verify', '--end-of-options', rev + '^{commit}'], { maxBuffer: 1024 * 1024 }); sha = result.stdout.trim(); }
      catch { refuse('SOURCE'); }
      if (!SHA.test(sha)) refuse('SOURCE'); await archive(sha); return changeRelease(sha);
    }),
    rollback: () => locked(async () => { const target = linkValue('previous'); if (!target) refuse('INVALID'); await archive(target); return changeRelease(target); }),
    backup: () => locked(async () => {
      let started = false;
      try { await callService('stop'); const set = snapshot(); started = true; await start(); return set; }
      catch (error) { try { if (started) await callService('stop'); await start(); } catch { await recoveryFailure(); } throw error; }
    }),
    restore: input => locked(async () => {
      const selected = validateSet(input), plan = prepareRestore(selected); let stopped = false, started = false, committed = false, backup;
      try {
        stopped = true; await callService('stop'); backup = snapshot();
        // Quiesced SQLite sidecars belong to the old database and must never attach to the restored copy.
        for (const suffix of ['-wal', '-shm', '-journal']) if (present(join(dataDir, 'bootstrap.sqlite') + suffix)) {
          const target = join(dataDir, 'bootstrap.sqlite') + suffix; regular(target);
          plan.push({ target, stage: null, held: join(dataDir, '.restore-old-' + randomUUID()), dir: false, moved: false, applied: false });
        }
        for (const entry of plan) {
          if (present(entry.target)) { if (entry.dir) directory(entry.target); else regular(entry.target); renameSync(entry.target, entry.held); entry.moved = true; }
          if (entry.stage) renameSync(entry.stage, entry.target);
          entry.applied = true;
        }
        started = true; await start(); committed = true;
        for (const entry of plan) cleanTemporary(entry.held, dirname(entry.target), '.restore-old-');
        return { restored: selected.set, backup, sessionsReset: true };
      } catch (error) {
        if (stopped && !committed) {
          try {
            if (started) await callService('stop');
            // A failed new process may have created fresh SQLite sidecars.
            for (const suffix of ['-wal', '-shm', '-journal']) { const path = join(dataDir, 'bootstrap.sqlite') + suffix;
              if (present(path) && !plan.some(entry => entry.target === path && !entry.moved)) { regular(path); unlinkSync(path); } }
            restoreOriginal(plan); await start();
          } catch { await recoveryFailure(); }
        }
        throw error;
      } finally { cleanupPlan(plan); }
    })
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['release', 'rollback', 'backup', 'restore'].includes(command) || args.length > (['release', 'restore'].includes(command) ? 1 : 0)
      || command === 'restore' && args.length !== 1) refuse('INVALID');
  const rootDir = process.env.COMPANION_RELEASE_ROOT ?? join(homedir(), 'personal-agent');
  const executable = process.env.COMPANION_SYSTEMCTL ?? '/usr/bin/systemctl';
  if (!isAbsolute(executable)) refuse('INVALID');
  const healthUrl = new URL(process.env.COMPANION_HEALTH_URL ?? 'http://127.0.0.1:4318/api/status');
  if (healthUrl.protocol !== 'http:' || healthUrl.hostname !== '127.0.0.1' || healthUrl.username || healthUrl.password
      || healthUrl.pathname !== '/api/status' || healthUrl.search || healthUrl.hash) refuse('INVALID');
  const tool = createReleaseTool({ repoDir: process.env.COMPANION_RELEASE_REPO ?? dirname(dirname(fileURLToPath(import.meta.url))), rootDir,
    dataDir: process.env.COMPANION_DATA_DIR ?? join(homedir(), 'personal-agent-data'),
    runtimeDir: process.env.COMPANION_RUNTIME_DIR ?? join(process.env.COMPANION_DATA_DIR ?? join(homedir(), 'personal-agent-data'), 'runtimes'),
    service: action => execute(executable, [action, 'personal-agent-account.service'], { maxBuffer: 1024 * 1024 }),
    health: async () => {
      // Poll briefly for ordinary startup, without following a redirect off loopback.
      for (let attempt = 0; attempt < 20; attempt++) {
        try { const response = await fetch(healthUrl, { redirect: 'error', signal: AbortSignal.timeout(2000) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(); }
          const reader = response.body.getReader(), parts = []; let size = 0;
          try { while (true) { const { value, done } = await reader.read(); if (done) break;
            size += value.length; if (size > 64 * 1024) throw new Error(); parts.push(value); } }
          finally { await reader.cancel(); }
          const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
          if (body.service?.mode === 'account' && body.storage?.state === 'ready') return true; } catch { /* bounded retry */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return false;
    } });
  console.log(JSON.stringify(await tool[command](...args)));
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(error => { const known = error instanceof OperationError ? error : new OperationError('FAILED');
    console.error(JSON.stringify({ error: known.code, message: known.message })); process.exitCode = 1; });
}
