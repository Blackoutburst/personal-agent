// The human's explicitly shared identity, separate from the companion's look and private workspace.
import { createHash } from 'node:crypto';
import { sniffMime } from './files.mjs';
export const OWNER_PHOTO_BYTES = 192 * 1024;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class OwnerProfileError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function name(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f<>]/u.test(value)) throw new OwnerProfileError('INVALID_PROFILE');
  return value.trim();
}
function photo(value) {
  if (value === null) return null;
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'mime') || !Object.hasOwn(value, 'base64')
    || !['image/jpeg', 'image/png', 'image/webp'].includes(value.mime) || typeof value.base64 !== 'string'
    || value.base64.length > 4 * Math.ceil(OWNER_PHOTO_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) throw new OwnerProfileError('INVALID_PHOTO');
  const bytes = Buffer.from(value.base64, 'base64');
  if (!bytes.length || bytes.length > OWNER_PHOTO_BYTES || bytes.toString('base64') !== value.base64 || sniffMime(bytes) !== value.mime) throw new OwnerProfileError('INVALID_PHOTO');
  return { mime: value.mime, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}
export class OwnerProfiles {
  constructor({ store, nameFor = () => 'You', canReadPhoto = (viewer, owner) => viewer === owner }) {
    this.db = store.db; this.nameFor = nameFor; this.canReadPhoto = canReadPhoto;
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner_profiles(companion_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,
      revision INTEGER NOT NULL,photo_mime TEXT,photo_bytes BLOB,photo_hash TEXT)`);
  }
  publicProfile(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new OwnerProfileError('INVALID_PROFILE');
    const row = this.db.prepare('SELECT display_name,revision,photo_hash FROM owner_profiles WHERE companion_id=?').get(id);
    return { id, displayName: row?.display_name ?? name(this.nameFor(id)), revision: row?.revision ?? 0, photoVersion: row?.photo_hash ?? null };
  }
  readPhoto(viewer, owner) {
    if (typeof owner !== 'string' || !ID.test(owner) || !this.canReadPhoto(viewer, owner)) throw new OwnerProfileError('PROFILE_NOT_FOUND', 404);
    const row = this.db.prepare('SELECT photo_mime,photo_bytes FROM owner_profiles WHERE companion_id=?').get(owner);
    return row?.photo_bytes ? { mime: row.photo_mime, base64: Buffer.from(row.photo_bytes).toString('base64') } : null;
  }
  snapshot(id) { return { profile: this.publicProfile(id), photo: this.readPhoto(id, id) }; }
  set(id, input) {
    if (typeof id !== 'string' || !ID.test(id)) throw new OwnerProfileError('INVALID_PROFILE');
    if (!object(input) || Object.keys(input).some(key => !['displayName', 'expectedRevision', 'photo'].includes(key))
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new OwnerProfileError('INVALID_PROFILE');
    const displayName = name(input.displayName), picture = Object.hasOwn(input, 'photo') ? photo(input.photo) : undefined;
    // One CAS transaction also covers the first edit, so duplicate/lost acknowledgements cannot overwrite a newer edit.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.db.prepare('SELECT * FROM owner_profiles WHERE companion_id=?').get(id);
      if ((before?.revision ?? 0) !== input.expectedRevision) throw new OwnerProfileError('PROFILE_CONFLICT', 409);
      const next = picture === undefined ? { mime: before?.photo_mime ?? null, bytes: before?.photo_bytes ?? null, hash: before?.photo_hash ?? null }
        : picture ?? { mime: null, bytes: null, hash: null };
      this.db.prepare(`INSERT INTO owner_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(companion_id) DO UPDATE SET
        display_name=excluded.display_name,revision=excluded.revision,photo_mime=excluded.photo_mime,
        photo_bytes=excluded.photo_bytes,photo_hash=excluded.photo_hash`)
        .run(id, displayName, input.expectedRevision + 1, next.mime, next.bytes, next.hash);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.snapshot(id);
  }
}
export function createOwnerProfileHttp({ access, profiles }) {
  return async request => {
    const parsed = await access.read(request, OWNER_PHOTO_BYTES * 4 / 3 + 2048);
    if (parsed.failure) return parsed.failure;
    const admitted = await access.authorize(request); if (admitted.failure) return admitted.failure;
    try {
      const value = parsed.value, id = admitted.companionId;
      if (!object(value)) throw new OwnerProfileError('INVALID_PROFILE');
      if (value.action === 'get' && Object.keys(value).length === 1) return { status: 200, body: profiles.snapshot(id) };
      if (value.action === 'photo' && Object.keys(value).length === 2 && Object.hasOwn(value, 'ownerId')) return { status: 200, body: { photo: profiles.readPhoto(id, value.ownerId) } };
      if (value.action === 'set') { const { action, ...change } = value; return { status: 200, body: profiles.set(id, change) }; }
      throw new OwnerProfileError('INVALID_PROFILE');
    } catch (error) {
      return { status: error instanceof OwnerProfileError ? error.status : 503, body: { error: {
        code: error instanceof OwnerProfileError ? error.code : 'PROFILE_UNAVAILABLE',
        message: error.code === 'PROFILE_CONFLICT' ? 'Your profile changed. Reload it before saving.' : 'Your profile could not be loaded or saved.' } } };
    }
  };
}
