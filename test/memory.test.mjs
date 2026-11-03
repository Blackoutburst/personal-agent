import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { memorySnapshot, editMemory, forgetMemory, forgetAllMemory, exportMemory, MemoryError, MEMORY_LIMITS } from '../src/memory.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), WORK = resolve(ROOT, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const noop = () => {};
const failure = (code, status) => error => error instanceof MemoryError && error.code === code && error.status === status && !error.message.includes(WORK) && !error.message.includes('canary');
function fixture(t, seed = true) {
  const temporary = fs.mkdtempSync(join(WORK, 'task16-memory-synthetic-')), dir = join(temporary, 'owner'), other = join(temporary, 'other-owner');
  fs.mkdirSync(dir, { mode: 0o700 }); fs.mkdirSync(other, { mode: 0o700 });
  const write = (file, text) => { fs.mkdirSync(dirname(join(dir, file)), { recursive: true, mode: 0o700 }); fs.writeFileSync(join(dir, file), text, { mode: 0o600 }); };
  if (seed) { write('USER.md', '# Owner\n\n## Likes\n- Tea\n- Tea\n\nUnstructured prose stays.\n'); write('MEMORY.md', '# Memories\n\n## Promises\n* Call on Sunday\n'); }
  fs.writeFileSync(join(other, 'private.md'), 'OTHER-OWNER-SYNTHETIC-CANARY');
  t.after(() => {
    const actual = fs.realpathSync(temporary), suffix = relative(WORK, actual);
    assert.ok(!isAbsolute(suffix) && !suffix.startsWith('..') && suffix.startsWith('task16-memory-synthetic-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const read = file => fs.readFileSync(join(dir, file));
  const temps = () => fs.readdirSync(dir).filter(name => name.startsWith('.memory-'));
  return { temporary, dir, other, write, read, temps };
}
const document = (snapshot, file = 'USER.md') => snapshot.files.find(value => value.file === file);
const items = file => file.sections.flatMap(section => section.items);

test('complete snapshots preserve BOM/prose/line endings, truthful dates and unique file/line-bound bullet identities', t => {
  const f = fixture(t), raw = '\uFEFF# Owner\r\nProse before.\r\n\r\n## Likes\r\n- Tea\r\n\r\n## Again\r\n* Tea\r\nTail prose.\r\n';
  f.write('USER.md', raw); f.write('MEMORY.md', raw);
  f.write('memory/2026-11-02.md', '# Diary\nA paragraph, not a bullet.\n- A day\n'); f.write('memory/2024-02-29.md', 'Leap day prose.');
  f.write('memory/2026-02-30.md', 'Invalid date must not be exported.'); f.write('memory/README.md', 'Not a diary day.');
  const date = new Date('2026-11-01T12:34:56.000Z'); fs.utimesSync(join(f.dir, 'USER.md'), date, date);
  const snapshot = memorySnapshot(f.dir), user = document(snapshot), memory = document(snapshot, 'MEMORY.md');
  assert.deepEqual(snapshot.files.map(file => file.file), ['USER.md', 'MEMORY.md', 'memory/2024-02-29.md', 'memory/2026-11-02.md']);
  assert.equal(user.content, raw); assert.equal(user.revision, sha(Buffer.from(raw))); assert.equal(user.revision, sha(Buffer.from(user.content)));
  assert.equal(user.modifiedAtISO, date.toISOString()); assert.equal(user.readOnly, false); assert.equal(snapshot.files[2].readOnly, true);
  assert.deepEqual(items(user).map(item => [item.text, item.line]), [['Tea', 4], ['Tea', 7]]);
  assert.notEqual(items(user)[0].id, items(user)[1].id); assert.notEqual(items(user)[0].id, items(memory)[0].id);
  assert.ok(items(user).every(item => /^[a-f0-9]{16}$/.test(item.id))); assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes('OTHER-OWNER-SYNTHETIC-CANARY'));
});

test('absent notes are an explicit empty snapshot without initialization, and export is a complete private copy', t => {
  const f = fixture(t, false); f.write('SOUL.md', 'Independent soul');
  const before = fs.readdirSync(f.dir); const empty = memorySnapshot(f.dir);
  assert.deepEqual(empty.files, []); assert.deepEqual(fs.readdirSync(f.dir), before);
  f.write('USER.md', 'No bullets here: export still contains this paragraph.\n'); f.write('memory/2026-11-03.md', 'Whole diary text.\n');
  const exported = exportMemory(f.dir, { now: () => Date.UTC(2026, 10, 3) });
  assert.deepEqual(Object.keys(exported), ['format', 'exportedAt', 'files']); assert.equal(exported.format, 'companion-memory-v1');
  assert.equal(exported.exportedAt, '2026-11-03T00:00:00.000Z'); assert.equal(exported.files[0].content, f.read('USER.md').toString());
  assert.equal(exported.files[1].content, 'Whole diary text.\n'); assert.equal(exported.files.some(file => file.file === 'SOUL.md'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= MEMORY_LIMITS.jsonBytes);
});

test('a correction changes only the selected duplicate occurrence and preserves unrelated native text/format', t => {
  const f = fixture(t), raw = '# Owner\r\nUnchanged paragraph.\r\n## Likes\r\n  * Tea \t\r\n- Tea\r\nEnd.\r\n'; f.write('USER.md', raw);
  const before = memorySnapshot(f.dir), user = document(before), otherBytes = f.read('MEMORY.md'), item = items(user)[0]; let called = 0;
  const result = editMemory(f.dir, { file: 'USER.md', id: item.id, text: '  Coffee  ', expectedRevision: user.revision }, () => {
    called++; assert.deepEqual(f.read('USER.md'), Buffer.from(raw)); assert.equal(f.temps().length, 1);
    const prepared = fs.readFileSync(join(f.dir, f.temps()[0]), 'utf8'); assert.ok(prepared.includes('Coffee'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(join(f.dir, f.temps()[0])).mode & 0o777, 0o600);
  });
  assert.equal(called, 1); assert.equal(result.changed, true); assert.equal(f.read('USER.md').toString(), raw.replace('  * Tea \t', '  * Coffee \t'));
  assert.deepEqual(f.read('MEMORY.md'), otherBytes); assert.equal(items(document(result))[1].text, 'Tea'); assert.equal(items(document(result))[1].id, items(user)[1].id);
  assert.notEqual(document(result).revision, user.revision); assert.notEqual(result.revision, before.revision); assert.deepEqual(f.temps(), []);
  assert.equal(document(result).modifiedAtISO, fs.statSync(join(f.dir, 'USER.md')).mtime.toISOString());
});

test('full-byte CAS rejects another device or native prose edit before reset, even if bullet ID is unchanged', t => {
  const f = fixture(t), first = memorySnapshot(f.dir), user = document(first), item = items(user)[0]; let callbacks = 0;
  f.write('USER.md', user.content + 'Native writer added prose.\n');
  assert.throws(() => forgetMemory(f.dir, { file: 'USER.md', id: item.id, expectedRevision: user.revision }, () => callbacks++), failure('MEMORY_CONFLICT', 409));
  assert.equal(callbacks, 0); assert.ok(f.read('USER.md').toString().includes('Native writer added prose.'));
  const reloaded = memorySnapshot(f.dir), a = document(reloaded), secondView = structuredClone(a);
  editMemory(f.dir, { file: 'USER.md', id: items(a)[0].id, text: 'Coffee', expectedRevision: a.revision }, () => callbacks++);
  assert.throws(() => editMemory(f.dir, { file: 'USER.md', id: items(secondView)[1].id, text: 'Water', expectedRevision: secondView.revision }, () => callbacks++), failure('MEMORY_CONFLICT', 409));
  assert.equal(callbacks, 1); assert.deepEqual(f.temps(), []);
});

test('a BOM-prefixed first bullet remains editable without losing the file BOM or following raw prose', t => {
  const f = fixture(t), original = '\uFEFF  * Tea \t\r\nFollowing prose.\r\n'; f.write('USER.md', original);
  const before = document(memorySnapshot(f.dir)); assert.deepEqual(items(before).map(item => [item.text, item.line]), [['Tea', 0]]);
  const edited = document(editMemory(f.dir, { file: before.file, id: items(before)[0].id, text: 'Coffee', expectedRevision: before.revision }, noop));
  assert.equal(edited.content, original.replace('Tea', 'Coffee'));
  const removed = document(forgetMemory(f.dir, { file: edited.file, id: items(edited)[0].id, expectedRevision: edited.revision }, noop));
  assert.equal(removed.content, '\uFEFFFollowing prose.\r\n'); assert.equal(removed.revision, sha(Buffer.from(removed.content)));
});

test('embedded CR stays in complete raw notes but cannot become a section title or bullet control', t => {
  const f = fixture(t), raw = '## Valid\r\n- Kept\r\n## Bad\rHeading\n- Bad\rItem\n- Tail\r\n'; f.write('USER.md', raw);
  const snapshot = memorySnapshot(f.dir), user = document(snapshot);
  assert.equal(user.content, raw); assert.equal(user.revision, sha(Buffer.from(raw)));
  assert.deepEqual(user.sections.map(section => section.title), ['Valid']);
  assert.deepEqual(items(user).map(item => [item.text, item.line]), [['Kept', 1], ['Tail', 4]]);
  assert.equal(exportMemory(f.dir).files[0].content, raw);
  assert.equal(forgetMemory(f.dir, { file: user.file, id: items(user)[1].id, expectedRevision: user.revision }, noop).removed, true);
  assert.equal(f.read('USER.md').toString(), '## Valid\r\n- Kept\r\n## Bad\rHeading\n- Bad\rItem\n');
});

test('forget uses occurrence identity, current no-ops do not reset, and mtime alone is not a content conflict', t => {
  const f = fixture(t), before = memorySnapshot(f.dir), user = document(before), target = items(user)[0]; let callbacks = 0;
  const changedTime = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(join(f.dir, 'USER.md'), changedTime, changedTime);
  assert.equal(memorySnapshot(f.dir).revision, before.revision);
  const result = forgetMemory(f.dir, { file: 'USER.md', id: target.id, expectedRevision: user.revision }, () => callbacks++);
  assert.equal(result.removed, true); assert.deepEqual(items(document(result)).map(item => item.text), ['Tea']); assert.equal(callbacks, 1);
  assert.ok(document(result).content.includes('Unstructured prose stays.'));
  const remaining = items(document(result))[0];
  assert.equal(editMemory(f.dir, { file: 'USER.md', id: remaining.id, text: 'Tea', expectedRevision: document(result).revision }, () => callbacks++).changed, false);
  assert.equal(forgetMemory(f.dir, { file: 'USER.md', id: '0'.repeat(16), expectedRevision: document(result).revision }, () => callbacks++).removed, false);
  assert.equal(callbacks, 1);
});

test('invalid edit fields, foreign-file IDs and diary writes refuse without visible effects or callback', t => {
  const f = fixture(t); f.write('memory/2026-11-03.md', '- Diary stays\n'); const before = memorySnapshot(f.dir), user = document(before), item = items(user)[0]; let called = 0;
  const input = { file: 'USER.md', id: item.id, text: 'New fact', expectedRevision: user.revision };
  for (const patch of [{ file: '../USER.md' }, { file: 'SOUL.md' }, { expectedRevision: 'x' }, { id: 'bad' }, { text: 'line\nbreak' }, { text: '\u0000' },
    { text: 'x'.repeat(4001) }, { text: '   ' }, { text: '\ud800' }, { owner: 'someone' }]) assert.throws(() => editMemory(f.dir, { ...input, ...patch }, () => called++), failure('INVALID_REQUEST', 400));
  const diary = document(before, 'memory/2026-11-03.md');
  assert.throws(() => editMemory(f.dir, { file: diary.file, id: items(diary)[0].id, text: 'No', expectedRevision: diary.revision }, noop), failure('MEMORY_READ_ONLY', 403));
  assert.throws(() => forgetMemory(f.dir, { file: diary.file, id: items(diary)[0].id, expectedRevision: diary.revision }, noop), failure('MEMORY_READ_ONLY', 403));
  assert.throws(() => editMemory(f.dir, { ...input, id: items(document(before, 'MEMORY.md'))[0].id }, noop), failure('MEMORY_NOT_FOUND', 404));
  let accessed = false; const getter = Object.defineProperty({ ...input }, 'text', { enumerable: true, get() { accessed = true; return 'No'; } });
  assert.throws(() => editMemory(f.dir, getter, noop), failure('INVALID_REQUEST', 400)); assert.equal(accessed, false);
  assert.equal(called, 0); assert.deepEqual(memorySnapshot(f.dir), before); assert.deepEqual(f.temps(), []);
});

test('failed reset and asynchronous callback cannot publish prepared changes or leak diagnostic paths', async t => {
  const f = fixture(t), before = memorySnapshot(f.dir), user = document(before), input = { file: 'USER.md', id: items(user)[0].id, text: 'Coffee', expectedRevision: user.revision };
  assert.throws(() => editMemory(f.dir, input, () => { throw new Error(join(f.other, 'private.md')); }), failure('MEMORY_UNAVAILABLE', 503));
  assert.deepEqual(memorySnapshot(f.dir), before); assert.deepEqual(f.temps(), []);
  assert.throws(() => editMemory(f.dir, input, () => { throw new MemoryError('MEMORY_BUSY', 409); }), failure('MEMORY_BUSY', 409));
  assert.deepEqual(memorySnapshot(f.dir), before);
  assert.throws(() => editMemory(f.dir, input, () => { throw Object.assign(new Error('Native owner lane busy.'), { code: 'MEMORY_BUSY', status: 409 }); }), failure('MEMORY_BUSY', 409));
  assert.deepEqual(memorySnapshot(f.dir), before);
  assert.throws(() => editMemory(f.dir, input, async () => { throw new Error('synthetic callback failure'); }), failure('INVALID_REQUEST', 400));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(memorySnapshot(f.dir), before); assert.deepEqual(f.temps(), []);
});

test('forget-all validates the global revision, prepares every replacement before reset, and preserves unrelated files', t => {
  const f = fixture(t);
  const untouched = { 'SOUL.md': 'Private soul stays.', 'AGENTS.md': 'Instructions stay.', 'chat.json': 'Visible chat stays.',
    'inbox/saved.txt': 'Attachment stays.', 'memory/README.md': 'Unrecognized notes stay.', 'memory/2026-02-30.md': 'Invalid diary date stays.' };
  for (const [file, bytes] of Object.entries(untouched)) f.write(file, bytes);
  f.write('memory/2026-11-01.md', 'First diary'); f.write('memory/2026-11-03.md', 'Last diary');
  const first = memorySnapshot(f.dir); f.write('memory/2026-11-02.md', 'New diary'); let called = 0;
  assert.throws(() => forgetAllMemory(f.dir, { confirm: true, expectedRevision: first.revision }, () => called++), failure('MEMORY_CONFLICT', 409)); assert.equal(called, 0);
  const snapshot = memorySnapshot(f.dir);
  assert.throws(() => forgetAllMemory(f.dir, { confirm: false, expectedRevision: snapshot.revision }, noop), failure('INVALID_REQUEST', 400));
  const cleared = forgetAllMemory(f.dir, { confirm: true, expectedRevision: snapshot.revision }, () => {
    called++; assert.equal(f.temps().length, 2); assert.ok(f.read('USER.md').length > 0); assert.ok(fs.existsSync(join(f.dir, 'memory/2026-11-01.md')));
  });
  assert.equal(cleared.cleared, true); assert.equal(called, 1); assert.deepEqual(cleared.files.map(file => [file.file, file.content]), [['USER.md', ''], ['MEMORY.md', '']]);
  for (const [file, bytes] of Object.entries(untouched)) assert.equal(f.read(file).toString(), bytes, file);
  assert.equal(fs.existsSync(join(f.dir, 'memory/2026-11-02.md')), false);
  forgetAllMemory(f.dir, { confirm: true, expectedRevision: cleared.revision }, () => called++); assert.equal(called, 2, 'explicit clear intent resets even when notes are empty');
  assert.deepEqual(f.temps(), []);
});

test('partial multi-file publication failure never reports success; fresh revision can finish the remaining clear', t => {
  const f = fixture(t); f.write('memory/2026-11-03.md', 'Diary still exists until cleared'); f.write('SOUL.md', 'Soul stays');
  const before = memorySnapshot(f.dir), originalRename = fs.renameSync; let callbacks = 0;
  fs.renameSync = (from, to) => { if (basename(to) === 'MEMORY.md') throw Object.assign(new Error('/private/canary'), { code: 'EIO' }); return originalRename(from, to); };
  try { assert.throws(() => forgetAllMemory(f.dir, { confirm: true, expectedRevision: before.revision }, () => callbacks++), failure('MEMORY_UNAVAILABLE', 503)); }
  finally { fs.renameSync = originalRename; }
  assert.equal(callbacks, 1); assert.equal(f.read('USER.md').length, 0); assert.ok(f.read('MEMORY.md').length > 0); assert.equal(f.read('SOUL.md').toString(), 'Soul stays');
  assert.deepEqual(f.temps(), []); const current = memorySnapshot(f.dir); assert.notEqual(current.revision, before.revision);
  const done = forgetAllMemory(f.dir, { confirm: true, expectedRevision: current.revision }, () => callbacks++);
  assert.equal(done.cleared, true); assert.equal(callbacks, 2); assert.deepEqual(done.files.map(file => file.content), ['', '']);
});

test('invalid UTF8/control bytes and oversized files fail explicitly without presenting or rewriting a truncated view', t => {
  const f = fixture(t);
  for (const bytes of [Buffer.from([255]), Buffer.from([0xc0, 0xaf]), Buffer.from('prefix\u0007suffix')]) {
    f.write('USER.md', bytes); assert.throws(() => memorySnapshot(f.dir), failure('MEMORY_UNAVAILABLE', 503));
    assert.throws(() => exportMemory(f.dir), failure('MEMORY_UNAVAILABLE', 503)); assert.deepEqual(f.read('USER.md'), bytes);
  }
  const tooLarge = Buffer.alloc(MEMORY_LIMITS.fileBytes + 1, 65); f.write('USER.md', tooLarge);
  assert.throws(() => memorySnapshot(f.dir), failure('MEMORY_TOO_LARGE', 413)); assert.deepEqual(f.read('USER.md'), tooLarge);
});

test('aggregate bytes, document count and projection item count are bounded across the complete view', t => {
  const bytes = fixture(t, false);
  for (let i = 1; i <= 9; i++) bytes.write(`memory/2026-11-${String(i).padStart(2, '0')}.md`, Buffer.alloc(MEMORY_LIMITS.fileBytes, 65));
  assert.throws(() => memorySnapshot(bytes.dir), failure('MEMORY_TOO_LARGE', 413));
  const documents = fixture(t);
  for (let i = 0; i < MEMORY_LIMITS.documents - 1; i++) documents.write(`memory/${new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10)}.md`, '');
  assert.throws(() => memorySnapshot(documents.dir), failure('MEMORY_TOO_LARGE', 413));
  const bullets = fixture(t); bullets.write('USER.md', '- a\n'.repeat(5001)); bullets.write('MEMORY.md', '- b\n'.repeat(5000));
  assert.throws(() => memorySnapshot(bullets.dir), failure('MEMORY_TOO_LARGE', 413));
  bullets.write('USER.md', '- a\n'.repeat(5000)); const bounded = memorySnapshot(bullets.dir);
  assert.equal(bounded.files.reduce((sum, file) => sum + items(file).length, 0), 10000); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < MEMORY_LIMITS.jsonBytes);
});

test('symlink roots, memory directories and allowed files never escape the owning workspace', { skip: process.platform === 'win32' ? 'Canonical Linux gate covers symlink creation without Windows privilege.' : false }, t => {
  const f = fixture(t), outside = join(f.other, 'private.md'), alias = join(f.temporary, 'alias'); fs.symlinkSync(f.dir, alias, 'dir');
  assert.throws(() => memorySnapshot(alias), failure('MEMORY_UNSAFE', 503));
  fs.unlinkSync(join(f.dir, 'USER.md')); fs.symlinkSync(outside, join(f.dir, 'USER.md'));
  assert.throws(() => memorySnapshot(f.dir), failure('MEMORY_UNSAFE', 503)); assert.throws(() => exportMemory(f.dir), failure('MEMORY_UNSAFE', 503));
  fs.unlinkSync(join(f.dir, 'USER.md')); f.write('USER.md', '- Own note'); fs.symlinkSync(f.other, join(f.dir, 'memory'), 'dir');
  assert.throws(() => memorySnapshot(f.dir), failure('MEMORY_UNSAFE', 503)); assert.equal(fs.readFileSync(outside, 'utf8'), 'OTHER-OWNER-SYNTHETIC-CANARY');
});

test('hardlinked notes and valid diary FIFOs are refused before reading, without blocking or changing them', { skip: process.platform === 'win32' ? 'Managed Windows sandbox refuses link creation; canonical Linux gate covers links/FIFOs.' : false }, t => {
  const f = fixture(t), link = join(f.other, 'shared'); fs.linkSync(join(f.dir, 'USER.md'), link);
  assert.throws(() => memorySnapshot(f.dir), failure('MEMORY_UNSAFE', 503)); fs.unlinkSync(link);
  fs.mkdirSync(join(f.dir, 'memory')); const fifo = join(f.dir, 'memory/2026-11-03.md');
  assert.equal(spawnSync('mkfifo', [fifo], { timeout: 2000 }).status, 0);
  assert.throws(() => memorySnapshot(f.dir), failure('MEMORY_UNSAFE', 503)); assert.throws(() => exportMemory(f.dir), failure('MEMORY_UNSAFE', 503));
});

test('a newline-suffixed date filename is unrelated and never viewed, exported or removed by forget-all', { skip: process.platform === 'win32' ? 'Windows forbids LF filenames; canonical Linux gate covers exact filename matching.' : false }, t => {
  const f = fixture(t), unrelated = 'memory/2026-11-03.md\n', bytes = 'UNRELATED NEWLINE-FILENAME CONTENT\n';
  f.write(unrelated, bytes); f.write('memory/2026-11-03.md', 'A real diary day.\n');
  const before = memorySnapshot(f.dir);
  assert.deepEqual(before.files.map(file => file.file), ['USER.md', 'MEMORY.md', 'memory/2026-11-03.md']);
  assert.ok(!JSON.stringify(exportMemory(f.dir)).includes('UNRELATED NEWLINE-FILENAME CONTENT'));
  forgetAllMemory(f.dir, { expectedRevision: before.revision, confirm: true }, noop);
  assert.equal(f.read(unrelated).toString(), bytes); assert.equal(fs.existsSync(join(f.dir, 'memory/2026-11-03.md')), false);
});

test('a changed original or temporary link in the before-change window cannot be published', { skip: process.platform === 'win32' ? 'Canonical Linux gate covers temporary symlink substitution.' : false }, t => {
  const f = fixture(t), before = memorySnapshot(f.dir), user = document(before), input = { file: 'USER.md', id: items(user)[0].id, text: 'Coffee', expectedRevision: user.revision };
  assert.throws(() => editMemory(f.dir, input, () => {
    const temp = join(f.dir, f.temps()[0]); fs.unlinkSync(temp); fs.symlinkSync(join(f.other, 'private.md'), temp);
  }), failure('MEMORY_UNSAFE', 503));
  assert.equal(f.read('USER.md').toString(), user.content); assert.equal(fs.readFileSync(join(f.other, 'private.md'), 'utf8'), 'OTHER-OWNER-SYNTHETIC-CANARY'); assert.deepEqual(f.temps(), []);
});
