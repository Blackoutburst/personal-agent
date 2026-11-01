import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync,
  lstatSync, existsSync, chmodSync, symlinkSync, readlinkSync, linkSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BootstrapStore } from '../src/store.mjs';

const POSIX = process.platform !== 'win32';
const SIDECARS = ['-journal', '-wal', '-shm'];

function fixture(t, createDirectory = true) {
  const temporary = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporary, 'store-privacy-synthetic-'));
  const source = join(root, 'checkout');
  const data = join(root, 'private-data');
  mkdirSync(source, { mode: 0o700 });
  if (createDirectory) mkdirSync(data, { mode: 0o700 });
  t.after(() => {
    const actual = realpathSync(root);
    assert.equal(dirname(actual), temporary);
    assert.ok(basename(actual).startsWith('store-privacy-synthetic-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return { root, source, data, filename: join(data, 'bootstrap.sqlite') };
}

function retained(t) {
  const f = fixture(t);
  const store = new BootstrapStore(f.data, f.source);
  try { store.put('synthetic', 'retained', { text: 'synthetic private state' }); }
  finally { store.close(); }
  return { ...f, bytes: readFileSync(f.filename) };
}

function refuses(data, source) {
  let unexpected;
  try { assert.throws(() => { unexpected = new BootstrapStore(data, source); }); }
  finally { unexpected?.close(); }
}

test('safe cold creation and reopen retain state in a regular private database', t => {
  const f = fixture(t, false);
  const store = new BootstrapStore(f.data, f.source);
  try { store.put('synthetic', 'cold', { count: 1 }); }
  finally { store.close(); }
  const info = lstatSync(f.filename);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.nlink, 1);
  if (POSIX) {
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o7777, 0o600);
    assert.equal(lstatSync(f.data).uid, process.getuid());
    assert.equal(lstatSync(f.data).mode & 0o7777, 0o700);
  }
  const reopened = new BootstrapStore(f.data, f.source);
  try { assert.deepEqual(reopened.get('synthetic', 'cold'), { count: 1 }); }
  finally { reopened.close(); }
});

test('POSIX unsafe retained database modes refuse without repairing mode or changing bytes', { skip: !POSIX }, t => {
  const f = retained(t);
  for (const mode of [0o640, 0o644]) {
    chmodSync(f.filename, mode);
    refuses(f.data, f.source);
    assert.equal(lstatSync(f.filename).mode & 0o7777, mode);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
  }
});

test('POSIX unsafe final data directory refuses before creating SQLite files', { skip: !POSIX }, t => {
  const f = fixture(t);
  chmodSync(f.data, 0o755);
  refuses(f.data, f.source);
  assert.equal(lstatSync(f.data).mode & 0o7777, 0o755);
  assert.equal(existsSync(f.filename), false);
});

test('external data directory links and linked ancestors refuse even when their targets are outside source', t => {
  const f = fixture(t);
  const alias = join(f.root, 'external-alias');
  try { symlinkSync(f.data, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) return t.skip('Filesystem cannot create directory links');
    throw error;
  }
  refuses(alias, f.source);
  assert.equal(existsSync(f.filename), false);
  refuses(join(alias, 'nested'), f.source);
  assert.equal(existsSync(join(f.data, 'nested')), false);
  assert.ok(lstatSync(alias).isSymbolicLink());
});

test('hard-linked SQLite sidecars refuse without touching the retained database or linked target', t => {
  for (const suffix of SIDECARS) {
    const f = retained(t);
    const target = join(f.root, 'synthetic-sidecar-target');
    const payload = Buffer.from('synthetic linked sidecar must remain unchanged');
    writeFileSync(target, payload, { mode: 0o600 });
    const sidecar = f.filename + suffix;
    try { linkSync(target, sidecar); }
    catch (error) {
      if (['EPERM', 'ENOSYS', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Filesystem cannot create hard links');
      throw error;
    }
    assert.equal(lstatSync(f.filename).nlink, 1, 'The main DB is safe; the sidecar itself must be rejected');
    refuses(f.data, f.source);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.deepEqual(readFileSync(target), payload);
    assert.equal(lstatSync(sidecar).nlink, 2);
    assert.equal(lstatSync(sidecar).ino, lstatSync(target).ino);
  }
});

test('dangling SQLite sidecars refuse without creating their targets or modifying retained data', t => {
  for (const suffix of SIDECARS) {
    const f = retained(t);
    const missing = join(f.root, 'missing-sidecar-target');
    const sidecar = f.filename + suffix;
    try { symlinkSync(missing, sidecar, 'file'); }
    catch (error) {
      if (['EPERM', 'ENOSYS', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Filesystem cannot create file symlinks');
      throw error;
    }
    const before = readlinkSync(sidecar);
    refuses(f.data, f.source);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.equal(existsSync(missing), false);
    assert.ok(lstatSync(sidecar).isSymbolicLink());
    assert.equal(readlinkSync(sidecar), before);
  }
});

test('POSIX unsafe regular sidecar permissions refuse before SQLite can recover or remove them', { skip: !POSIX }, t => {
  for (const suffix of SIDECARS) {
    const f = retained(t);
    const sidecar = f.filename + suffix;
    const payload = Buffer.from('synthetic sidecar is not recovery input');
    writeFileSync(sidecar, payload, { mode: 0o644 });
    chmodSync(sidecar, 0o644);
    refuses(f.data, f.source);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
    assert.deepEqual(readFileSync(sidecar), payload);
    assert.equal(lstatSync(sidecar).mode & 0o7777, 0o644);
  }
});

test('POSIX ancestors may be readable but not writable by others except root-owned sticky directories', { skip: !POSIX }, t => {
  const f = retained(t);
  chmodSync(f.root, 0o755);
  const accepted = new BootstrapStore(f.data, f.source); accepted.close();
  const bytes = readFileSync(f.filename);
  chmodSync(f.root, 0o777);
  refuses(f.data, f.source);
  assert.deepEqual(readFileSync(f.filename), bytes);
  chmodSync(f.root, 0o1777);
  if (process.getuid() === 0) {
    const sticky = new BootstrapStore(f.data, f.source); sticky.close();
  } else {
    refuses(f.data, f.source);
    assert.deepEqual(readFileSync(f.filename), bytes);
  }
  chmodSync(f.root, 0o700);
});

test('POSIX foreign-owned retained file and final directory refuse when actual chown is permitted', {
  skip: !POSIX || process.getuid?.() !== 0,
}, t => {
  const f = retained(t);
  const owner = lstatSync(f.filename);
  try { chownSync(f.filename, 1, owner.gid); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('OS does not permit changing ownership');
    throw error;
  }
  try {
    refuses(f.data, f.source);
    assert.equal(lstatSync(f.filename).uid, 1);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
  } finally { chownSync(f.filename, owner.uid, owner.gid); }
  const directoryOwner = lstatSync(f.data);
  chownSync(f.data, 1, directoryOwner.gid);
  try {
    refuses(f.data, f.source);
    assert.equal(lstatSync(f.data).uid, 1);
    assert.deepEqual(readFileSync(f.filename), f.bytes);
  } finally { chownSync(f.data, directoryOwner.uid, directoryOwner.gid); }
});
