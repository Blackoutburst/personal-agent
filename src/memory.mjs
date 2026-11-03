import fs from 'node:fs';
import { resolve, isAbsolute, parse, relative, sep, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MEMORY_LIMITS = Object.freeze({ fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024,
  documents: 1024, items: 10000, jsonBytes: 16 * 1024 * 1024, directoryEntries: 4096 });
const WRITABLE = ['USER.md', 'MEMORY.md'], SHA = /^[a-f0-9]{64}$/, ITEM = /^[a-f0-9]{16}$/;
const ERRORS = Object.freeze({
  INVALID_REQUEST: [400, 'Check the memory request.'],
  MEMORY_CONFLICT: [409, 'Memory changed. Reload it before trying again.'],
  MEMORY_BUSY: [409, 'Wait for the current reply to finish or stop it before changing memory.'],
  MEMORY_NOT_FOUND: [404, 'That memory is no longer available.'],
  MEMORY_READ_ONLY: [403, 'Diary entries are read-only.'],
  MEMORY_TOO_LARGE: [413, 'Memory exceeds the supported size or item limit.'],
  MEMORY_UNSAFE: [503, 'Memory files could not be accessed safely.'],
  MEMORY_UNAVAILABLE: [503, 'Memory is unavailable right now.']
});
export class MemoryError extends Error {
  constructor(code = 'MEMORY_UNAVAILABLE', status) {
    const key = Object.hasOwn(ERRORS, code) ? code : 'MEMORY_UNAVAILABLE';
    super(ERRORS[key][1]); this.name = 'MemoryError'; this.code = key;
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : ERRORS[key][0];
  }
}
const fail = code => { throw new MemoryError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const fixed = error => error instanceof MemoryError ? error : new MemoryError();
function shape(value, keys) {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST');
    const fields = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(fields);
    if (actual.length !== keys.length || actual.some(key => !keys.includes(key) || !fields[key].enumerable || !Object.hasOwn(fields[key], 'value'))) fail('INVALID_REQUEST');
    return Object.fromEntries(keys.map(key => [key, fields[key].value]));
  } catch { fail('INVALID_REQUEST'); }
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function directory(path) {
  const info = fs.lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('MEMORY_UNSAFE');
  return info;
}
function rootFor(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0')) fail('INVALID_REQUEST');
  const path = resolve(dir), volume = parse(path).root;
  let current = volume; let info = directory(current);
  for (const part of relative(volume, path).split(sep).filter(Boolean)) { current = join(current, part); info = directory(current); }
  return { path, info };
}
function rootCurrent(root) {
  const current = rootFor(root.path);
  if (current.info.ino !== root.info.ino || current.info.dev !== root.info.dev) fail('MEMORY_UNSAFE');
}
function maybeStat(path) {
  try { return fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function diaryName(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
  if (!match || match[0] !== name) return false;
  const date = new Date(0); date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3])); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}
function memoryDirectory(root) {
  const path = join(root.path, 'memory');
  if (!maybeStat(path)) return null;
  return { path, info: directory(path) };
}
function rawBytes(root, path, maximum) {
  rootCurrent(root);
  const before = maybeStat(path); if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('MEMORY_UNSAFE');
  if (!Number.isSafeInteger(before.size) || before.size > maximum) fail('MEMORY_TOO_LARGE');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) fail('MEMORY_UNSAFE');
    if (opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) fail('MEMORY_CONFLICT');
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (true) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null); if (!count) break;
      size += count; if (size > maximum) fail('MEMORY_TOO_LARGE'); if (size > before.size) fail('MEMORY_CONFLICT');
    }
    const after = fs.fstatSync(fd), retained = maybeStat(path);
    if (!retained || retained.isSymbolicLink() || retained.nlink !== 1 || retained.ino !== opened.ino || retained.dev !== opened.dev) fail('MEMORY_UNSAFE');
    if (size !== before.size || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        retained.mtimeMs !== before.mtimeMs || retained.ctimeMs !== before.ctimeMs) fail('MEMORY_CONFLICT');
    rootCurrent(root); return { bytes: bytes.subarray(0, size), info: after };
  } finally { fs.closeSync(fd); }
}
function contentOf(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('MEMORY_UNAVAILABLE'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail('MEMORY_UNAVAILABLE');
  return content;
}
function sections(file, content, budget) {
  const result = []; let current = null;
  content.split('\n').forEach((raw, line) => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw, parsed = line === 0 ? value.replace(/^\uFEFF/, '') : value;
    // Raw notes remain complete; an internal CR is not a safe single-line edit locator.
    if (parsed.includes('\r')) return;
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(parsed);
    if (heading) { current = { title: heading[1], items: [] }; return; }
    const bullet = /^([ \t]*[-*][ \t]+)(.*?)[ \t]*$/.exec(parsed), text = bullet?.[2].trim();
    if (!text) return;
    if (++budget.items > MEMORY_LIMITS.items) fail('MEMORY_TOO_LARGE');
    if (!current) current = { title: '', items: [] };
    if (!current.items.length) result.push(current);
    current.items.push({ id: hash(`${file}\0${line}\0${text}`).slice(0, 16), text, line });
  });
  return result;
}
function document(file, bytes, info, budget) {
  const content = contentOf(bytes);
  return { file, content, revision: hash(bytes), modifiedAtISO: info.mtime.toISOString(), readOnly: !WRITABLE.includes(file), sections: sections(file, content, budget) };
}
function snapshotOf(records) {
  const files = records.map(record => record.document), revision = hash(JSON.stringify(files.map(file => [file.file, file.revision])));
  if (files.reduce((count, file) => count + file.sections.reduce((sum, section) => sum + section.items.length, 0), 0) > MEMORY_LIMITS.items ||
      Buffer.byteLength(JSON.stringify({ files, revision })) > MEMORY_LIMITS.jsonBytes - 1024) fail('MEMORY_TOO_LARGE');
  return { files, revision };
}
function load(dir) {
  const root = rootFor(dir), records = [], budget = { bytes: 0, items: 0 };
  const add = file => {
    if (records.length >= MEMORY_LIMITS.documents) fail('MEMORY_TOO_LARGE');
    const raw = rawBytes(root, join(root.path, file), Math.min(MEMORY_LIMITS.fileBytes, MEMORY_LIMITS.totalBytes - budget.bytes));
    if (!raw) return;
    budget.bytes += raw.bytes.length; records.push({ document: document(file, raw.bytes, raw.info, budget), info: raw.info });
  };
  WRITABLE.forEach(add);
  const diary = memoryDirectory(root);
  if (diary) {
    const names = [], stream = fs.opendirSync(diary.path); let count = 0;
    try { let entry; while ((entry = stream.readSync())) {
      if (++count > MEMORY_LIMITS.directoryEntries) fail('MEMORY_TOO_LARGE');
      if (diaryName(entry.name)) names.push(entry.name);
      if (names.length + records.length > MEMORY_LIMITS.documents) fail('MEMORY_TOO_LARGE');
    } } finally { stream.closeSync(); }
    names.sort().forEach(name => { directory(diary.path); add(`memory/${name}`); });
    const after = directory(diary.path);
    if (after.ino !== diary.info.ino || after.dev !== diary.info.dev) fail('MEMORY_UNSAFE');
  }
  rootCurrent(root); return { root, records, ...snapshotOf(records) };
}
export function memorySnapshot(dir) {
  try { const { files, revision } = load(dir); return { files, revision }; } catch (error) { throw fixed(error); }
}
function writable(file) {
  if (typeof file !== 'string') fail('INVALID_REQUEST');
  if (WRITABLE.includes(file)) return;
  if (file.startsWith('memory/') && diaryName(file.slice(7))) fail('MEMORY_READ_ONLY');
  fail('INVALID_REQUEST');
}
function revision(value) { if (typeof value !== 'string' || !SHA.test(value)) fail('INVALID_REQUEST'); }
function checkedText(text) {
  if (typeof text !== 'string' || !text.isWellFormed() || /[\x00-\x1f\x7f]/.test(text)) fail('INVALID_REQUEST');
  const value = text.trim(); if (!value || value.length > 4000 || Buffer.byteLength(value) > 16000) fail('INVALID_REQUEST'); return value;
}
function beforePublish(beforeChange) {
  if (typeof beforeChange !== 'function') fail('INVALID_REQUEST');
  let value;
  try { value = beforeChange(); }
  catch (error) {
    if (error instanceof MemoryError) throw error;
    if (error?.code === 'MEMORY_BUSY' && error?.status === 409) fail('MEMORY_BUSY');
    throw new MemoryError();
  }
  if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); fail('INVALID_REQUEST'); }
}
function mutate(dir, initial, operations, beforeChange, global = false) {
  if (typeof beforeChange !== 'function') fail('INVALID_REQUEST');
  const prepared = [];
  const verify = () => {
    rootCurrent(initial.root); const current = load(dir);
    if (global && current.revision !== initial.revision) fail('MEMORY_CONFLICT');
    for (const operation of operations) {
      if (current.records.find(record => record.document.file === operation.file)?.document.revision !== operation.previous?.document.revision) fail('MEMORY_CONFLICT');
    }
  };
  try {
    for (const operation of operations) {
      if (operation.bytes === null) continue;
      const path = join(initial.root.path, `.memory-${operation.file}-${process.pid}-${randomUUID()}.tmp`);
      let fd;
      try {
        rootCurrent(initial.root);
        fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        const temporary = { path, operation }; prepared.push(temporary); let offset = 0;
        while (offset < operation.bytes.length) { const count = fs.writeSync(fd, operation.bytes, offset, operation.bytes.length - offset); if (count <= 0) fail('MEMORY_UNAVAILABLE'); offset += count; }
        temporary.info = fs.fstatSync(fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    // Preflight the complete prospective view before invalidating sessions or changing visible notes.
    const prospective = initial.records.filter(record => !operations.some(operation => operation.file === record.document.file));
    for (const temporary of prepared) prospective.push({ document: document(temporary.operation.file, temporary.operation.bytes, temporary.info, { items: 0 }) });
    prospective.sort((a, b) => {
      const rank = file => WRITABLE.includes(file) ? WRITABLE.indexOf(file) : 2;
      return rank(a.document.file) - rank(b.document.file) || a.document.file.localeCompare(b.document.file);
    });
    if (prospective.reduce((bytes, record) => bytes + Buffer.byteLength(record.document.content), 0) > MEMORY_LIMITS.totalBytes) fail('MEMORY_TOO_LARGE');
    snapshotOf(prospective); verify(); beforePublish(beforeChange); verify();
    for (const operation of operations) {
      rootCurrent(initial.root);
      if (operation.bytes === null) {
        directory(join(initial.root.path, 'memory'));
        const current = rawBytes(initial.root, join(initial.root.path, operation.file), MEMORY_LIMITS.fileBytes);
        if (!current || hash(current.bytes) !== operation.previous.document.revision) fail('MEMORY_CONFLICT');
        fs.unlinkSync(join(initial.root.path, operation.file));
      } else {
        const temporary = prepared.find(value => value.operation === operation), raw = rawBytes(initial.root, temporary.path, MEMORY_LIMITS.fileBytes);
        if (!raw || raw.info.ino !== temporary.info.ino || raw.info.dev !== temporary.info.dev || hash(raw.bytes) !== hash(operation.bytes)) fail('MEMORY_UNSAFE');
        const current = rawBytes(initial.root, join(initial.root.path, operation.file), MEMORY_LIMITS.fileBytes);
        if ((current ? hash(current.bytes) : undefined) !== operation.previous?.document.revision) fail('MEMORY_CONFLICT');
        fs.renameSync(temporary.path, join(initial.root.path, operation.file)); temporary.published = true;
      }
    }
    return memorySnapshot(dir);
  } catch (error) { throw fixed(error); }
  finally {
    for (const temporary of prepared.filter(value => !value.published)) {
      try { rootCurrent(initial.root); fs.unlinkSync(temporary.path); } catch { /* Never follow changed ancestors to clean up. The operation already failed. */ }
    }
  }
}
export function editMemory(dir, input, beforeChange) {
  try {
    const value = shape(input, ['file', 'id', 'text', 'expectedRevision']); writable(value.file); revision(value.expectedRevision);
    if (typeof value.id !== 'string' || !ITEM.test(value.id)) fail('INVALID_REQUEST');
    const text = checkedText(value.text), initial = load(dir), previous = initial.records.find(record => record.document.file === value.file);
    if (!previous) fail('MEMORY_NOT_FOUND'); if (previous.document.revision !== value.expectedRevision) fail('MEMORY_CONFLICT');
    const item = previous.document.sections.flatMap(section => section.items).find(item => item.id === value.id);
    if (!item) fail('MEMORY_NOT_FOUND'); if (item.text === text) return { changed: false, files: initial.files, revision: initial.revision };
    const lines = previous.document.content.split('\n'), line = lines[item.line], suffix = line.endsWith('\r') ? '\r' : '';
    const prefix = item.line === 0 && line.startsWith('\uFEFF') ? '\uFEFF' : '', body = line.slice(prefix.length);
    const parts = /^([ \t]*[-*][ \t]+)(.*?)([ \t]*)$/.exec(suffix ? body.slice(0, -1) : body);
    lines[item.line] = prefix + parts[1] + text + parts[3] + suffix;
    const bytes = Buffer.from(lines.join('\n')); if (bytes.length > MEMORY_LIMITS.fileBytes) fail('MEMORY_TOO_LARGE');
    return { changed: true, ...mutate(dir, initial, [{ file: value.file, previous, bytes }], beforeChange) };
  } catch (error) { throw fixed(error); }
}
export function forgetMemory(dir, input, beforeChange) {
  try {
    const value = shape(input, ['file', 'id', 'expectedRevision']); writable(value.file); revision(value.expectedRevision);
    if (typeof value.id !== 'string' || !ITEM.test(value.id)) fail('INVALID_REQUEST');
    const initial = load(dir), previous = initial.records.find(record => record.document.file === value.file);
    if (!previous) fail('MEMORY_NOT_FOUND'); if (previous.document.revision !== value.expectedRevision) fail('MEMORY_CONFLICT');
    const item = previous.document.sections.flatMap(section => section.items).find(item => item.id === value.id);
    if (!item) return { removed: false, files: initial.files, revision: initial.revision };
    const lines = previous.document.content.split('\n'); lines.splice(item.line, 1);
    if (item.line === 0 && previous.document.content.startsWith('\uFEFF')) {
      if (lines.length) lines[0] = '\uFEFF' + lines[0]; else lines.push('\uFEFF');
    }
    return { removed: true, ...mutate(dir, initial, [{ file: value.file, previous, bytes: Buffer.from(lines.join('\n')) }], beforeChange) };
  } catch (error) { throw fixed(error); }
}
export function forgetAllMemory(dir, input, beforeChange) {
  try {
    const value = shape(input, ['expectedRevision', 'confirm']); revision(value.expectedRevision); if (value.confirm !== true) fail('INVALID_REQUEST');
    const initial = load(dir); if (initial.revision !== value.expectedRevision) fail('MEMORY_CONFLICT');
    const operations = WRITABLE.map(file => ({ file, previous: initial.records.find(record => record.document.file === file), bytes: Buffer.alloc(0) }))
      .filter(operation => !operation.previous || operation.previous.document.content !== '');
    for (const previous of initial.records.filter(record => record.document.readOnly)) operations.push({ file: previous.document.file, previous, bytes: null });
    return { cleared: true, ...mutate(dir, initial, operations, beforeChange, true) };
  } catch (error) { throw fixed(error); }
}
export function exportMemory(dir, { now = Date.now } = {}) {
  try {
    if (typeof now !== 'function') fail('INVALID_REQUEST'); const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) fail('INVALID_REQUEST');
    const exported = { format: 'companion-memory-v1', exportedAt: new Date(time).toISOString(), files: memorySnapshot(dir).files };
    if (Buffer.byteLength(JSON.stringify(exported)) > MEMORY_LIMITS.jsonBytes) fail('MEMORY_TOO_LARGE'); return exported;
  } catch (error) { throw fixed(error); }
}

// Fixed SOUL-only access reuses the native-file checks, independently of the memory
// allowlist. SOUL never enters snapshots, exports, diary controls or forget-all.
export function readSoul(dir) {
  try {
    const root = rootFor(dir), raw = rawBytes(root, join(root.path, 'SOUL.md'), MEMORY_LIMITS.fileBytes);
    if (!raw) fail('MEMORY_NOT_FOUND');
    return { file: 'SOUL.md', content: contentOf(raw.bytes), revision: hash(raw.bytes), modifiedAtISO: raw.info.mtime.toISOString() };
  } catch (error) { throw fixed(error); }
}
export function replaceSoul(dir, input, beforeChange) {
  let temporary;
  try {
    const value = shape(input, ['content', 'expectedRevision']); revision(value.expectedRevision);
    if (typeof value.content !== 'string' || !value.content.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.content)) fail('INVALID_REQUEST');
    const bytes = Buffer.from(value.content);
    if (bytes.length > MEMORY_LIMITS.fileBytes) fail('MEMORY_TOO_LARGE');
    const root = rootFor(dir), path = join(root.path, 'SOUL.md'), initial = readSoul(dir);
    if (initial.revision !== value.expectedRevision) fail('MEMORY_CONFLICT');
    if (initial.content === value.content) return { changed: false, ...initial };
    const verify = () => { rootCurrent(root); if (readSoul(dir).revision !== initial.revision) fail('MEMORY_CONFLICT'); };
    temporary = { root, path: join(root.path, `.soul-${process.pid}-${randomUUID()}.tmp`) };
    let fd;
    try {
      rootCurrent(root);
      fd = fs.openSync(temporary.path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      temporary.created = true;
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); temporary.info = fs.fstatSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    verify(); beforePublish(beforeChange); verify();
    const retained = rawBytes(root, temporary.path, MEMORY_LIMITS.fileBytes);
    if (!retained || retained.info.ino !== temporary.info.ino || retained.info.dev !== temporary.info.dev || hash(retained.bytes) !== hash(bytes)) fail('MEMORY_UNSAFE');
    fs.renameSync(temporary.path, path); temporary.published = true;
    return { changed: true, ...readSoul(dir) };
  } catch (error) { throw fixed(error); }
  finally {
    if (temporary?.created && !temporary.published) { try { rootCurrent(temporary.root); fs.unlinkSync(temporary.path); } catch { /* Refuse cleanup through substituted ancestors. */ } }
  }
}
