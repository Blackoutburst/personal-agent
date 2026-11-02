import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, linkSync, symlinkSync, closeSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';
import { FileStore, FileError, inlineMime } from '../src/files.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = async function* (bytes) { yield bytes.subarray(0, 3); yield bytes.subarray(3); };
const rejects = (promise, code, status) => assert.rejects(promise, error => error instanceof FileError && error.code === code && (status === undefined || error.status === status));
function fixture(t, { limits = {}, now = 1_800_000_000_000 } = {}) {
  const temporary = mkdtempSync(join(resolve(ROOT, '..'), 'task31-files-synthetic-'));
  const dataDir = join(temporary, 'data'), workA = join(temporary, 'alice'), workB = join(temporary, 'bob');
  mkdirSync(workA, { mode: 0o700 }); mkdirSync(workB, { mode: 0o700 });
  const store = new BootstrapStore(dataDir, ROOT), conversations = new Conversations({ store });
  const owner = randomUUID(), otherOwner = randomUUID(), thread = randomUUID(), otherThread = randomUUID(), sameOwnerThread = randomUUID();
  for (const [id, companion] of [[thread, owner], [otherThread, otherOwner], [sameOwnerThread, owner]]) {
    store.db.prepare('INSERT INTO conv_threads(id,companion_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, companion, 'Synthetic files', now, now);
  }
  const schema = () => store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name<>'conv_files' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const originalSchema = schema(), clock = { now };
  const files = new FileStore({ store, dataDir, limits, now: () => clock.now,
    workspaceFor: id => id === owner ? { dir: workA } : id === otherOwner ? { dir: workB } : null });
  const rows = () => store.db.prepare('SELECT * FROM conv_files ORDER BY id').all();
  const upload = (bytes, extra = {}, companion = owner) => files.upload(companion, {
    threadId: companion === otherOwner ? otherThread : thread, requestId: randomUUID(), name: 'synthetic.bin', size: bytes.length, ...extra
  }, source(bytes));
  const bind = (id, companion = owner, selectedThread = thread) => {
    const message = randomUUID();
    store.db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,created_at) VALUES(?,?,?,?,?)').run(message, selectedThread, 'user', '', clock.now);
    files.tx(() => files.bindInTransaction(companion, selectedThread, message, [id])); return message;
  };
  t.after(async () => {
    try { await conversations.shutdown(); } finally { store.close(); }
    const absolute = realpathSync(temporary), suffix = relative(resolve(ROOT, '..'), absolute);
    assert.ok(!isAbsolute(suffix) && !suffix.startsWith('..') && suffix.startsWith('task31-files-synthetic-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  return { temporary, dataDir, workA, workB, owner, otherOwner, thread, otherThread, sameOwnerThread, store, files, rows, upload, bind, schema, originalSchema, clock };
}

test('stored MIME follows bytes rather than name and unsafe active formats stay attachment-only', async t => {
  const f = fixture(t);
  const samples = [
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'],
    [Buffer.from([255, 216, 255, 0]), 'image/jpeg'], [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('RIFF0000WEBP'), 'image/webp'], [Buffer.from('0000ftypisom'), 'video/mp4'],
    [Buffer.concat([Buffer.from([26, 69, 223, 163]), Buffer.from('webm')]), 'video/webm'],
    [Buffer.from('ID3sample'), 'audio/mpeg'], [Buffer.from('RIFF0000WAVE'), 'audio/wav'],
    [Buffer.from('OggS000OpusHead'), 'audio/ogg'], [Buffer.from('fLaCsample'), 'audio/flac'],
    [Buffer.from('0000ftypM4A '), 'audio/mp4'], [Buffer.from('<svg onload="alert(1)"/>'), 'application/octet-stream'],
    [Buffer.from('<html><script>private</script></html>'), 'application/octet-stream'], [Buffer.alloc(0), 'application/octet-stream']
  ];
  for (const [bytes, mime] of samples) {
    const dto = await f.upload(bytes, { name: mime === 'application/octet-stream' ? 'misleading.png' : 'misleading.html' });
    assert.equal(dto.mime, mime); assert.equal(dto.sha256, sha(bytes)); assert.equal(dto.size, bytes.length);
    assert.equal(dto.direction, 'user'); assert.equal(dto.url, `/api/files/${dto.id}`);
    assert.deepEqual(readFileSync(f.files.path(f.files.get(f.owner, dto.id))), bytes);
    assert.equal(inlineMime(mime), mime !== 'application/octet-stream');
  }
  assert.deepEqual(f.schema(), f.originalSchema, 'the existing identity/conversation table shapes are unchanged');
});

test('a replaced workspace root cannot turn a confined relative path into a foreign file send', async t => {
  if (process.platform === 'win32') return t.skip('POSIX link boundary is exercised by canonical Linux gate');
  const f = fixture(t), moved = f.workA + '-original';
  writeFileSync(join(f.workB, 'foreign.txt'), 'foreign synthetic bytes');
  renameSync(f.workA, moved); symlinkSync(f.workB, f.workA, 'dir');
  try { await rejects(f.files.outgoing(f.owner, { threadId: f.thread, requestId: 'root-link', path: 'foreign.txt' }, () => true), 'FILE_PATH_REJECTED', 403); assert.equal(f.rows().length, 0); }
  finally { unlinkSync(f.workA); renameSync(moved, f.workA); }
});

test('declared and streamed caps fail closed and reclaim every reservation/partial file', async t => {
  const f = fixture(t, { limits: { normal: 16, video: 64, quota: 100 } });
  await rejects(f.upload(Buffer.alloc(65)), 'FILE_TOO_LARGE', 413);
  await rejects(f.upload(Buffer.from('GIF89a' + 'x'.repeat(11))), 'FILE_TOO_LARGE', 413);
  await rejects(f.upload(Buffer.from('short'), { size: 6 }), 'INVALID_FILE', 400);
  await rejects(f.upload(Buffer.from('long'), { size: 3 }), 'FILE_TOO_LARGE', 413);
  assert.deepEqual(f.rows(), []);
  for (const owner of readdirSync(f.files.directory)) assert.deepEqual(readdirSync(join(f.files.directory, owner)), []);
  const video = await f.upload(Buffer.from('0000ftypisom' + 'v'.repeat(12)));
  assert.equal(video.mime, 'video/mp4'); assert.equal(video.size, 24, 'sniffed video may exceed the ordinary cap');
});

test('in-flight bytes and counts reserve owner quota atomically without blocking an unrelated owner', async t => {
  const f = fixture(t, { limits: { normal: 64, video: 64, quota: 20, count: 2 } });
  let release, reads = 0; const gate = new Promise(resolve => { release = resolve; });
  const pending = f.files.upload(f.owner, { threadId: f.thread, requestId: 'reserved', name: 'first.bin', size: 18 }, (async function* () {
    yield Buffer.alloc(8); await gate; yield Buffer.alloc(10);
  })());
  await rejects(f.files.upload(f.owner, { threadId: f.thread, requestId: 'over-quota', name: 'second.bin', size: 3 }, (async function* () { reads++; yield Buffer.alloc(3); })()), 'FILE_QUOTA', 413);
  await rejects(f.files.upload(f.owner, { threadId: f.thread, requestId: 'reserved', name: 'first.bin', size: 18 }, (async function* () { reads++; yield Buffer.alloc(18); })()), 'CONFLICT', 409);
  assert.equal(reads, 0, 'denied reservations do not consume their input');
  const other = await f.upload(Buffer.from('Bob'), {}, f.otherOwner); assert.equal(f.files.get(f.otherOwner, other.id).size, 3);
  release(); await pending; assert.equal(f.rows().filter(row => row.companion_id === f.owner).length, 1);
  await f.upload(Buffer.alloc(0)); await rejects(f.upload(Buffer.alloc(0)), 'FILE_QUOTA', 413);
});

test('exact upload retries return one immutable file while changed payloads have no effect', async t => {
  const f = fixture(t), bytes = Buffer.from('GIF89a1234'), input = { threadId: f.thread, requestId: 'stable-upload', name: 'hello.gif', size: bytes.length };
  const first = await f.files.upload(f.owner, input, source(bytes)), row = f.files.get(f.owner, first.id), path = f.files.path(row);
  assert.deepEqual(await f.files.upload(f.owner, { ...input }, source(bytes)), first);
  for (const change of [{ name: 'renamed.gif' }, { threadId: f.sameOwnerThread }, { caption: 'changed' }]) {
    await rejects(f.files.upload(f.owner, { ...input, ...change }, source(bytes)), 'CONFLICT', 409);
  }
  await rejects(f.files.upload(f.owner, input, source(Buffer.from('GIF89a5678'))), 'CONFLICT', 409);
  assert.deepEqual(f.rows(), [row]); assert.deepEqual(readFileSync(path), bytes);
  const bob = await f.files.upload(f.otherOwner, { ...input, threadId: f.otherThread }, source(bytes)); assert.notEqual(bob.id, first.id);
});

test('foreign thread, pending removal and mixed-owner binding refuse without partial effects', async t => {
  const f = fixture(t), alice = await f.upload(Buffer.from('Alice')), bob = await f.upload(Buffer.from('Bob'), {}, f.otherOwner);
  const before = f.rows(); let read = false;
  await rejects(f.files.upload(f.owner, { threadId: f.otherThread, requestId: 'foreign', name: 'x', size: 1 }, (async function* () { read = true; yield Buffer.from('x'); })()), 'NOT_FOUND', 404);
  assert.equal(read, false);
  assert.throws(() => f.files.get(f.otherOwner, alice.id), error => error.code === 'NOT_FOUND' && error.status === 404);
  assert.throws(() => f.files.removePending(f.otherOwner, alice.id), error => error.code === 'NOT_FOUND');
  assert.throws(() => f.files.tx(() => f.files.bindInTransaction(f.owner, f.thread, randomUUID(), [alice.id, bob.id])), error => error.code === 'NOT_FOUND');
  assert.deepEqual(f.rows(), before, 'the enclosing message transaction rolls back the first binding');
  const message = f.bind(alice.id); assert.deepEqual(f.files.list(message), [alice]);
  assert.throws(() => f.files.removePending(f.owner, alice.id), error => error.code === 'FILE_NOT_AVAILABLE');
  assert.deepEqual(f.files.removePending(f.otherOwner, bob.id), { removed: true });
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].id, alice.id);
});

test('incoming inbox copies are owner confined and thread deletion removes binary plus workspace copy only', async t => {
  const f = fixture(t), bytes = Buffer.from('GIF89a'), alice = await f.upload(bytes, { name: 'picture.gif' }), bob = await f.upload(bytes, {}, f.otherOwner);
  const message = f.bind(alice.id), otherMessage = f.bind(bob.id, f.otherOwner, f.otherThread);
  const [incoming] = f.files.incoming(f.owner, message), [other] = f.files.incoming(f.otherOwner, otherMessage);
  assert.equal(relative(f.workA, incoming.path).startsWith('..'), false); assert.deepEqual(readFileSync(incoming.path), bytes);
  assert.deepEqual(f.files.incoming(f.otherOwner, message), []);
  const stored = f.files.path(f.files.get(f.owner, alice.id)); f.files.deleteThread(f.owner, f.thread);
  assert.equal(existsSync(incoming.path), false); assert.equal(existsSync(stored), false);
  assert.deepEqual(readFileSync(other.path), bytes); assert.equal(f.files.get(f.otherOwner, bob.id).id, bob.id);
});

test('outgoing copies only the current owner workspace and late turn completion leaves no stored effect', async t => {
  const f = fixture(t), bytes = Buffer.from('GIF89a'), own = join(f.workA, 'ours.gif'), outside = join(f.workB, 'private.gif');
  writeFileSync(own, bytes); writeFileSync(outside, Buffer.from('other owner'));
  const input = { threadId: f.thread, requestId: 'outgoing', path: 'ours.gif', caption: 'A small gift.' };
  const dto = await f.files.outgoing(f.owner, input, () => true); assert.equal(dto.direction, 'companion'); assert.equal(dto.caption, input.caption);
  assert.equal(dto.sha256, sha(bytes)); assert.deepEqual(await f.files.outgoing(f.owner, input, () => true), dto);
  const before = f.rows();
  for (const path of [outside, relative(f.workA, outside), '.']) await rejects(f.files.outgoing(f.owner, { ...input, requestId: randomUUID(), path }, () => true), 'FILE_PATH_REJECTED', 403);
  await rejects(f.files.outgoing(f.owner, { ...input, requestId: 'ended' }, () => false), 'FILE_TURN_ENDED', 409);
  assert.deepEqual(f.rows(), before); assert.deepEqual(readFileSync(outside), Buffer.from('other owner')); assert.deepEqual(readFileSync(own), bytes);
});

test('shared hardlinks are refused both as outgoing sources and retained storage', { skip: process.platform === 'win32' ? 'Managed Windows sandbox refuses link creation; canonical Linux gate covers this proof.' : false }, async t => {
  const f = fixture(t), own = join(f.workA, 'shared.txt'), alias = join(f.workB, 'alias.txt'); writeFileSync(own, 'synthetic'); linkSync(own, alias);
  await rejects(f.files.outgoing(f.owner, { threadId: f.thread, requestId: 'linked', path: own }, () => true), 'FILE_PATH_REJECTED', 403); assert.deepEqual(f.rows(), []);
  const dto = await f.upload(Buffer.from('stored')), row = f.files.get(f.owner, dto.id); linkSync(f.files.path(row), join(f.workB, 'storage-alias'));
  assert.throws(() => f.files.open(row), error => error.code === 'FILE_UNAVAILABLE' && error.status === 503);
});

test('symlink files and symlink directories never become outgoing capabilities', { skip: process.platform === 'win32' ? 'Canonical Linux gate covers symlink privilege-independent proof.' : false }, async t => {
  const f = fixture(t), outside = join(f.workB, 'private.txt'); writeFileSync(outside, 'synthetic outside');
  symlinkSync(outside, join(f.workA, 'linked.txt')); symlinkSync(f.workB, join(f.workA, 'linked-dir'), 'dir');
  for (const path of ['linked.txt', 'linked-dir/private.txt']) await rejects(f.files.outgoing(f.owner, { threadId: f.thread, requestId: randomUUID(), path }, () => true), 'FILE_PATH_REJECTED', 403);
  assert.deepEqual(f.rows(), []); assert.equal(readFileSync(outside, 'utf8'), 'synthetic outside');
});

test('a FIFO is refused before an outgoing open can block the server', { skip: process.platform === 'win32' ? 'POSIX FIFO proof runs in canonical Linux gate.' : false }, async t => {
  const f = fixture(t), fifo = join(f.workA, 'synthetic.fifo');
  const result = spawnSync('mkfifo', [fifo], { timeout: 2000 }); assert.equal(result.status, 0);
  await rejects(f.files.outgoing(f.owner, { threadId: f.thread, requestId: 'fifo', path: fifo }, () => true), 'FILE_PATH_REJECTED', 403);
  assert.deepEqual(f.rows(), []);
});

test('replacing an inbox parent with a symlink cannot redirect thread deletion into another workspace', { skip: process.platform === 'win32' ? 'Canonical Linux gate covers symlink privilege-independent proof.' : false }, async t => {
  const f = fixture(t), dto = await f.upload(Buffer.from('GIF89a')), message = f.bind(dto.id), [incoming] = f.files.incoming(f.owner, message);
  const parent = dirname(incoming.path), retained = parent + '.retained', foreign = join(f.workB, 'victim'); mkdirSync(foreign);
  const target = join(foreign, incoming.path.slice(parent.length + 1)); writeFileSync(target, 'other owner data');
  renameSync(parent, retained); symlinkSync(foreign, parent, 'dir');
  assert.throws(() => f.files.deleteThread(f.owner, f.thread), error => error.code === 'FILE_UNAVAILABLE' && error.status === 503);
  assert.equal(readFileSync(target, 'utf8'), 'other owner data'); assert.equal(f.rows()[0].state, 'deleting', 'failed cleanup remains hidden and quota counted');
  unlinkSync(parent); renameSync(retained, parent); f.files.deleteThread(f.owner, f.thread);
  assert.deepEqual(f.rows(), []); assert.equal(existsSync(incoming.path), false); assert.equal(readFileSync(target, 'utf8'), 'other owner data');
});

test('current-turn failure and interrupted streams remove partial bytes so an explicit retry can succeed', async t => {
  const f = fixture(t), input = { threadId: f.thread, requestId: 'retry-after-abort', name: 'data.bin', size: 6 };
  await assert.rejects(f.files.upload(f.owner, input, (async function* () { yield Buffer.from('abc'); throw new Error('synthetic interruption'); })()), /synthetic interruption/);
  assert.deepEqual(f.rows(), []);
  await rejects(f.files.upload(f.owner, input, source(Buffer.from('abcdef')), { current: () => false }), 'FILE_TURN_ENDED', 409); assert.deepEqual(f.rows(), []);
  const accepted = await f.files.upload(f.owner, input, source(Buffer.from('abcdef'))); assert.equal(accepted.sha256, sha(Buffer.from('abcdef')));
});

test('restart recovery removes abandoned reservations, orphans and expired pending files while retaining bound history', async t => {
  const f = fixture(t, { limits: { pendingMs: 100 } }), pending = await f.upload(Buffer.from('pending')), bound = await f.upload(Buffer.from('bound'));
  const message = f.bind(bound.id), boundRow = f.files.get(f.owner, bound.id), ownerDir = dirname(f.files.path(boundRow));
  const orphan = randomUUID(); writeFileSync(join(ownerDir, orphan), 'orphan'); writeFileSync(join(ownerDir, orphan + '.part'), 'partial');
  const interrupted = randomUUID();
  f.store.db.prepare('INSERT INTO conv_files(id,companion_id,thread_id,request_id,name,size,direction,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(interrupted, f.owner, f.thread, 'interrupted', 'pending.bin', 4, 'user', 'uploading', f.clock.now);
  writeFileSync(join(ownerDir, interrupted + '.part'), 'part'); f.clock.now += 101;
  f.files.recover();
  assert.deepEqual(f.rows().map(row => row.id), [bound.id]); assert.deepEqual(f.files.list(message), [bound]);
  assert.deepEqual(readdirSync(ownerDir), [bound.id]); assert.equal(existsSync(join(ownerDir, pending.id)), false);
  const fd = f.files.open(f.files.get(f.owner, bound.id)); closeSync(fd);
  assert.deepEqual(f.schema(), f.originalSchema);
});
