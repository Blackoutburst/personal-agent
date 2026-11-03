import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, writeSync,
  renameSync, unlinkSync, readdirSync, constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, basename, dirname } from 'node:path';

export const FILE_LIMITS = Object.freeze({ normal: 25 * 1024 ** 2, video: 100 * 1024 ** 2,
  quota: 1024 ** 3, count: 1000, attachments: 8, pendingMs: 24 * 3600_000 });
export const FILE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEY = /^[A-Za-z0-9._-]{1,80}$/;
export class FileError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'FileError'; this.code = code; this.status = status; }
}
const refuse = (code = 'INVALID_FILE', status = 400) => { throw new FileError(code, status); };
const inside = (path, root) => { const suffix = relative(root, path); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)); };
function directory(path, root) {
  if (!inside(resolve(path), realpathSync(root))) refuse('FILE_UNAVAILABLE', 503);
  const suffix = relative(root, path);
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(realpathSync(current), root)) refuse('FILE_UNAVAILABLE', 503);
  }
  return path;
}
export function fileName(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > 200
      || /[\x00-\x1f\x7f/\\]/.test(value) || ['.', '..'].includes(value)) refuse();
  return value;
}
export function sniffMime(bytes) {
  const head = bytes.subarray(0, 4096), ascii = head.toString('latin1');
  if (head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(ascii)) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('fLaC')) return 'audio/flac';
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (head.length >= 4 && head[0] === 80 && head[1] === 75 && [[3,4],[5,6],[7,8]].some(pair => pair[0] === head[2] && pair[1] === head[3])) return 'application/zip';
  if (ascii.startsWith('OggS') && /OpusHead|vorbis/.test(ascii)) return 'audio/ogg';
  if (ascii.startsWith('ID3') || head.length >= 2 && head[0] === 255 && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (['M4A ', 'M4B '].includes(brand)) return 'audio/mp4';
    if (['isom','iso2','mp41','mp42','avc1','M4V ','qt  '].includes(brand)) return 'video/mp4';
  }
  if (head.subarray(0, 4).equals(Buffer.from([26,69,223,163])) && ascii.includes('webm')) return 'video/webm';
  return 'application/octet-stream';
}
export const inlineMime = mime => /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm)|audio\/(?:mpeg|wav|ogg|flac|mp4))$/.test(mime);

// No schema changes to the existing conversation/identity tables: old code ignores this expansion.
export class FileStore {
  constructor({ store, dataDir, workspaceFor = () => null, limits = {}, now = Date.now }) {
    this.db = store.db; this.root = realpathSync(dataDir); this.workspaceFor = workspaceFor; this.now = now;
    this.limits = { ...FILE_LIMITS, ...limits };
    for (const key of Object.keys(FILE_LIMITS)) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) throw new TypeError('Invalid file limit');
    this.directory = directory(join(this.root, 'files'), this.root);
    this.db.exec(`CREATE TABLE IF NOT EXISTS conv_files(id TEXT PRIMARY KEY, companion_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, message_id TEXT, request_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT,
      size INTEGER NOT NULL, sha256 TEXT, direction TEXT NOT NULL, caption TEXT, state TEXT NOT NULL,
      workspace_path TEXT, created_at INTEGER NOT NULL, UNIQUE(companion_id, direction, request_id));
      CREATE INDEX IF NOT EXISTS conv_files_message ON conv_files(message_id);
      CREATE INDEX IF NOT EXISTS conv_files_thread ON conv_files(thread_id);`);
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  thread(companionId, threadId) {
    if (typeof companionId !== 'string' || typeof threadId !== 'string' || !FILE_ID.test(companionId) || !FILE_ID.test(threadId)
        || !this.db.prepare('SELECT 1 FROM conv_threads WHERE id=? AND companion_id=?').get(threadId, companionId)) refuse('NOT_FOUND', 404);
  }
  path(row, partial = false) {
    if (!FILE_ID.test(row.companion_id) || !FILE_ID.test(row.id)) refuse('FILE_UNAVAILABLE', 503);
    return join(directory(join(this.directory, row.companion_id), this.root), row.id + (partial ? '.part' : ''));
  }
  dto(row) { return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256,
    direction: row.direction, url: '/api/files/' + row.id, ...(row.caption ? { caption: row.caption } : {}) }; }
  get(companionId, id) {
    if (typeof companionId !== 'string' || typeof id !== 'string' || !FILE_ID.test(companionId) || !FILE_ID.test(id)) refuse('NOT_FOUND', 404);
    const row = this.db.prepare("SELECT * FROM conv_files WHERE id=? AND companion_id=? AND state='ready'").get(id, companionId);
    if (!row) refuse('NOT_FOUND', 404);
    this.thread(companionId, row.thread_id); return row;
  }
  list(messageId) { return this.db.prepare("SELECT * FROM conv_files WHERE message_id=? AND state='ready' ORDER BY created_at,id").all(messageId).map(row => this.dto(row)); }
  workspaceRoot(companionId) {
    const workspace = this.workspaceFor(companionId)?.dir;
    if (!workspace) refuse('FILE_UNAVAILABLE', 503);
    const root = resolve(workspace);
    for (let current = root; ; current = dirname(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) refuse('FILE_PATH_REJECTED', 403);
      if (dirname(current) === current) break;
    }
    return realpathSync(root);
  }
  #reserve(companionId, { threadId, requestId, name, size, direction, caption = null }) {
    this.thread(companionId, threadId); fileName(name);
    if (typeof requestId !== 'string' || !KEY.test(requestId)) refuse();
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.video) refuse('FILE_TOO_LARGE', 413);
    if (caption !== null && (typeof caption !== 'string' || !caption.isWellFormed() || caption.length > 1000
        || Buffer.byteLength(caption) > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(caption))) refuse();
    return this.tx(() => {
      const prior = this.db.prepare('SELECT * FROM conv_files WHERE companion_id=? AND direction=? AND request_id=?').get(companionId, direction, requestId);
      if (prior) {
        if (prior.state !== 'ready' || prior.thread_id !== threadId || prior.name !== name || prior.size !== size || prior.caption !== caption) refuse('CONFLICT', 409);
        return { row: prior, replay: true };
      }
      const used = this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM conv_files WHERE companion_id=?').get(companionId);
      if (used.bytes + size > this.limits.quota || used.count >= this.limits.count) refuse('FILE_QUOTA', 413);
      const row = { id: randomUUID(), companion_id: companionId, thread_id: threadId, request_id: requestId, name, size, direction,
        caption, state: 'uploading', created_at: this.now() };
      this.db.prepare(`INSERT INTO conv_files(id,companion_id,thread_id,request_id,name,size,direction,caption,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.id, companionId, threadId, requestId, name, size, direction, caption, row.state, row.created_at);
      return { row, replay: false };
    });
  }
  async upload(companionId, input, source, { current = () => true } = {}) {
    for (const expired of this.db.prepare("SELECT * FROM conv_files WHERE state='ready' AND message_id IS NULL AND created_at<?").all(this.now() - this.limits.pendingMs)) this.#removeRow(expired);
    const { row, replay } = this.#reserve(companionId, { ...input, direction: input.direction ?? 'user' });
    const temporary = replay ? null : this.path(row, true);
    let fd = null, size = 0, prefix = Buffer.alloc(0); const hash = createHash('sha256');
    try {
      if (temporary) fd = openSync(temporary, 'wx', 0o600);
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); size += chunk.length;
        if (size > row.size || size > this.limits.video) refuse('FILE_TOO_LARGE', 413);
        if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
        hash.update(chunk);
        if (fd !== null) { let offset = 0; while (offset < chunk.length) offset += writeSync(fd, chunk, offset); }
      }
      if (size !== row.size) refuse('INVALID_FILE', 400);
      const sha256 = hash.digest('hex'), mime = sniffMime(prefix);
      if (!mime.startsWith('video/') && size > this.limits.normal) refuse('FILE_TOO_LARGE', 413);
      if (fd !== null) { closeSync(fd); fd = null; }
      this.thread(companionId, row.thread_id);
      if (!current()) refuse('FILE_TURN_ENDED', 409);
      if (replay) { if (row.sha256 !== sha256) refuse('CONFLICT', 409); return this.dto(this.get(companionId, row.id)); }
      const result = this.tx(() => {
        this.thread(companionId, row.thread_id);
        if (!current() || !this.db.prepare("SELECT 1 FROM conv_files WHERE id=? AND state='uploading'").get(row.id)) refuse('FILE_TURN_ENDED', 409);
        renameSync(temporary, this.path(row));
        this.db.prepare("UPDATE conv_files SET mime=?,sha256=?,state='ready' WHERE id=?").run(mime, sha256, row.id);
        return this.dto(this.get(companionId, row.id));
      });
      return result;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (!replay) { this.#removeRow(row); }
      throw error;
    }
  }
  bindInTransaction(companionId, threadId, messageId, ids, direction = 'user') {
    this.thread(companionId, threadId);
    if (!Array.isArray(ids) || ids.length > this.limits.attachments || new Set(ids).size !== ids.length) refuse();
    for (const id of ids) {
      const row = this.get(companionId, id);
      if (row.thread_id !== threadId || row.direction !== direction || row.message_id && row.message_id !== messageId) refuse('FILE_NOT_AVAILABLE', 409);
      this.db.prepare('UPDATE conv_files SET message_id=? WHERE id=?').run(messageId, id);
    }
  }
  #removeRow(row) {
    this.db.prepare("UPDATE conv_files SET state='deleting' WHERE id=?").run(row.id);
    if (row.workspace_path) {
      const root = this.workspaceRoot(row.companion_id), expected = join(root, 'inbox', row.thread_id);
      if (!FILE_ID.test(row.thread_id) || dirname(resolve(row.workspace_path)) !== expected || !basename(row.workspace_path).startsWith(row.id + '.')) refuse('FILE_UNAVAILABLE', 503);
      // Refuse links in ancestors before unlinking a retained inbox copy.
      directory(expected, root);
    }
    for (const path of [this.path(row), this.path(row, true), row.workspace_path].filter(Boolean)) {
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw new FileError('FILE_UNAVAILABLE', 503); }
    }
    this.db.prepare('DELETE FROM conv_files WHERE id=?').run(row.id);
  }
  removePending(companionId, id) {
    if (typeof id !== 'string' || !FILE_ID.test(id)) refuse();
    const row = this.db.prepare('SELECT * FROM conv_files WHERE id=? AND companion_id=?').get(id, companionId);
    if (!row) refuse('NOT_FOUND', 404);
    if (row.message_id || row.direction !== 'user') refuse('FILE_NOT_AVAILABLE', 409);
    this.#removeRow(row); return { removed: true };
  }
  discardUnbound(companionId, id) {
    const row = this.db.prepare('SELECT * FROM conv_files WHERE id=? AND companion_id=? AND message_id IS NULL').get(id, companionId);
    if (row) this.#removeRow(row);
  }
  deleteThread(companionId, threadId) {
    for (const row of this.db.prepare('SELECT * FROM conv_files WHERE companion_id=? AND thread_id=?').all(companionId, threadId)) this.#removeRow(row);
  }
  // Called only after this process owns the listening socket. Never recover another live process's uploads.
  recover() {
    for (const row of this.db.prepare("SELECT * FROM conv_files WHERE state<>'ready' OR (message_id IS NULL AND created_at<?)").all(this.now() - this.limits.pendingMs)) this.#removeRow(row);
    for (const owner of readdirSync(this.directory)) {
      if (!FILE_ID.test(owner)) continue;
      const dir = directory(join(this.directory, owner), this.root);
      for (const name of readdirSync(dir)) {
        const id = name.replace(/\.part$/, '');
        if (FILE_ID.test(id) && !this.db.prepare('SELECT 1 FROM conv_files WHERE id=? AND companion_id=?').get(id, owner)) unlinkSync(join(dir, name));
      }
    }
  }
  open(row) {
    const path = this.path(row), initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) refuse('FILE_UNAVAILABLE', 503);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.ino !== initial.ino || info.dev !== initial.dev || info.size !== row.size) {
      closeSync(fd); refuse('FILE_UNAVAILABLE', 503);
    }
    return fd;
  }
  incoming(companionId, messageId) {
    const rows = this.db.prepare("SELECT * FROM conv_files WHERE companion_id=? AND message_id=? AND direction='user' AND state='ready' ORDER BY created_at,id").all(companionId, messageId);
    if (!rows.length) return [];
    const root = this.workspaceRoot(companionId), inbox = directory(join(root, 'inbox'), root);
    return rows.map(row => {
      this.thread(companionId, row.thread_id);
      const dest = join(directory(join(inbox, row.thread_id), root), row.id + '.' + (row.mime === 'image/jpeg' ? 'jpg' : row.mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'bin'));
      // Replace only our generated file, never follow a retained link.
      try { const info = lstatSync(dest); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) refuse('FILE_UNAVAILABLE', 503); unlinkSync(dest); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const input = this.open(row); let output;
      try { output = openSync(dest, 'wx', 0o600); const buffer = Buffer.alloc(64 * 1024); let count; while ((count = readSync(input, buffer, 0, buffer.length, null))) { let offset = 0; while (offset < count) offset += writeSync(output, buffer, offset, count - offset); } }
      finally { closeSync(input); if (output !== undefined) closeSync(output); }
      this.db.prepare('UPDATE conv_files SET workspace_path=? WHERE id=?').run(dest, row.id);
      return { ...this.dto(row), path: dest };
    });
  }
  // Opens one regular, unlinked, non-symlinked file inside the companion's own workspace.
  #openWorkspaceFile(companionId, path) {
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f]/.test(path)) refuse();
    const root = this.workspaceRoot(companionId), selected = resolve(root, path);
    if (!inside(selected, root) || selected === root) refuse('FILE_PATH_REJECTED', 403);
    let parent = root;
    for (const part of relative(root, selected).split(sep)) {
      parent = join(parent, part); const info = lstatSync(parent);
      if (info.isSymbolicLink() || !inside(realpathSync(parent), root)) refuse('FILE_PATH_REJECTED', 403);
    }
    const before = lstatSync(selected);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) refuse('FILE_PATH_REJECTED', 403);
    const fd = openSync(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || before.ino !== info.ino || before.dev !== info.dev || !inside(realpathSync(selected), root)) { closeSync(fd); refuse('FILE_PATH_REJECTED', 403); }
    return { fd, info, name: basename(selected) };
  }

  // A workspace file's bytes, for the Board attach tool (at most maxBytes).
  readWorkspaceFile(companionId, path, maxBytes) {
    const { fd, info, name } = this.#openWorkspaceFile(companionId, path);
    try {
      if (info.size > maxBytes) refuse('FILE_TOO_LARGE', 413);
      const bytes = Buffer.alloc(info.size); let offset = 0, size;
      while (offset < bytes.length && (size = readSync(fd, bytes, offset, bytes.length - offset, null))) offset += size;
      return { name, bytes: bytes.subarray(0, offset) };
    } finally { closeSync(fd); }
  }

  async outgoing(companionId, { threadId, requestId, path, caption }, current) {
    const { fd, info, name } = this.#openWorkspaceFile(companionId, path);
    const source = async function* () { const bytes = Buffer.alloc(64 * 1024); let size; while ((size = readSync(fd, bytes, 0, bytes.length, null))) yield Buffer.from(bytes.subarray(0, size)); };
    try { return await this.upload(companionId, { threadId, requestId, name, size: info.size,
      caption: caption ?? null, direction: 'companion' }, source(), { current }); }
    finally { closeSync(fd); }
  }
}
