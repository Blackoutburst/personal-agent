import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { OwnerProfiles, OwnerProfileError, OWNER_PHOTO_BYTES, createOwnerProfileHttp } from '../src/owner-profile.mjs';
import { startServer } from '../server.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6x8AAAAASUVORK5CYII=' };
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'owner-profile-'))), data = join(dir, 'data');
  let store = new BootstrapStore(data, ROOT), profiles = new OwnerProfiles({ store, nameFor: id => id === A ? 'Alice' : 'Bob' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get profiles() { return profiles; }, get store() { return store; },
    restart() { store.close(); store = new BootstrapStore(data, ROOT); profiles = new OwnerProfiles({ store, nameFor: () => 'Fallback' }); } };
}
test('display identity and photo persist separately from companion identity and survive restart', t => {
  const f = fixture(t); assert.equal(f.profiles.snapshot(A).profile.displayName, 'Alice');
  const saved = f.profiles.set(A, { displayName: 'Alice publique', photo: PNG, expectedRevision: 0 });
  assert.equal(saved.profile.revision, 1); assert.match(saved.profile.photoVersion, /^[a-f0-9]{64}$/); assert.deepEqual(saved.photo, PNG);
  f.restart(); assert.deepEqual(f.profiles.snapshot(A), saved);
  assert.deepEqual(f.profiles.publicProfile(A), saved.profile);
  assert.equal(f.profiles.snapshot(B).profile.revision, 0);
  assert.throws(() => f.profiles.readPhoto(B, A), error => error instanceof OwnerProfileError && error.status === 404);
});
test('CAS refuses duplicate/stale saves; omitted photo preserves it and removal clears only its owner', t => {
  const f = fixture(t); f.profiles.set(A, { displayName: 'Alice', photo: PNG, expectedRevision: 0 });
  const next = f.profiles.set(A, { displayName: 'Alice 2', expectedRevision: 1 }); assert.deepEqual(next.photo, PNG);
  assert.throws(() => f.profiles.set(A, { displayName: 'Stale', photo: null, expectedRevision: 1 }), /PROFILE_CONFLICT/);
  assert.deepEqual(f.profiles.snapshot(A), next);
  f.profiles.set(B, { displayName: 'Bob', photo: PNG, expectedRevision: 0 });
  assert.equal(f.profiles.set(A, { displayName: 'Alice 2', photo: null, expectedRevision: 2 }).photo, null);
  assert.deepEqual(f.profiles.snapshot(B).photo, PNG);
});
test('photo sharing uses an explicit membership boundary independent of editable profile fields', t => {
  const f = fixture(t); f.profiles.set(A, { displayName: 'Alice', photo: PNG, expectedRevision: 0 });
  let member = true;
  const shared = new OwnerProfiles({ store: f.store, canReadPhoto: (viewer, owner) => viewer === owner || member && viewer === B && owner === A });
  assert.deepEqual(shared.readPhoto(B, A), PNG); member = false;
  assert.throws(() => shared.readPhoto(B, A), /PROFILE_NOT_FOUND/);
  assert.throws(() => f.profiles.set(B, { displayName: 'Bob', expectedRevision: 0, canReadPhoto: true }), /INVALID_PROFILE/);
});
test('invalid names, cross-owner selectors, SVG, MIME lies, oversized and malformed base64 never modify retained identity', t => {
  const f = fixture(t); const before = f.profiles.snapshot(A);
  for (const change of [{ displayName: '<img src=x>' }, { displayName: '\ud800' }, { displayName: 'x'.repeat(81) }, { ownerId: B }, { companionId: B },
    { photo: { mime: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') } }, { photo: { ...PNG, mime: 'image/jpeg' } },
    { photo: { ...PNG, base64: PNG.base64 + '\n' } }, { photo: { ...PNG, base64: Buffer.alloc(OWNER_PHOTO_BYTES + 1).toString('base64') } }]) {
    assert.throws(() => f.profiles.set(A, { displayName: 'Alice', expectedRevision: 0, ...change })); assert.deepEqual(f.profiles.snapshot(A), before);
  }
  assert.throws(() => f.profiles.set('foreign', { displayName: 'Invalid ID', expectedRevision: 0 }));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM owner_profiles').get().n, 0);
});
test('HTTP facade binds all writes to the admitted owner and preserves transport authorization failures', async t => {
  const f = fixture(t); let body = { action: 'set', displayName: 'Bob public', expectedRevision: 0 }, denied = false;
  const http = createOwnerProfileHttp({ profiles: f.profiles, access: { read: async () => ({ value: body }), authorize: async () => denied ? { failure: { status: 401, body: { error: { code: 'AUTHENTICATION_REQUIRED' } } } } : { companionId: B } } });
  assert.equal((await http({})).status, 200); assert.equal(f.profiles.snapshot(A).profile.revision, 0);
  body = { action: 'set', displayName: 'Hijack', expectedRevision: 1, ownerId: A }; assert.equal((await http({})).status, 400);
  body = { action: 'photo', ownerId: A }; assert.equal((await http({})).status, 404);
  denied = true; body = { action: 'get' }; assert.equal((await http({})).status, 401);
});
test('real account route revalidates each owner session, rejects anonymous/origin/foreign writes and preserves the companion profile', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'owner-profile-http-'))), issuer = 'https://synthetic.invalid';
  const tokens = ['A'.repeat(43), 'B'.repeat(43)]; let valid = true;
  const app = await startServer({ dataDir: join(dir, 'data'), port: 0, mode: 'account',
    pilotSubjects: [{ issuer, subject: 'a' }, { issuer, subject: 'b' }],
    validateAccount: async value => valid && tokens.includes(value) ? { issuer, subject: value === tokens[0] ? 'a' : 'b' } : null,
    discordOptions: { connect: false }, boardOptions: { poll: false } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (body, token = tokens[0], origin = app.url, path = '/api/owner-profile') => {
    const r = await fetch(app.url + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Cookie: '__Secure-blackout_session=' + token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const a = (await call({ action: 'get' })).body.profile, b = (await call({ action: 'get' }, tokens[1])).body.profile;
  assert.notEqual(a.id, b.id);
  assert.equal((await call({ action: 'set', displayName: 'Alice public', photo: PNG, expectedRevision: 0 })).status, 200);
  assert.equal((await call({ action: 'get' }, tokens[1])).body.profile.revision, 0);
  assert.equal((await call({ action: 'photo', ownerId: a.id }, tokens[1])).status, 404);
  assert.equal((await call({ action: 'set', displayName: 'Foreign', expectedRevision: 0, companionId: a.id }, tokens[1])).status, 400);
  assert.equal((await call({ action: 'get' }, null)).status, 401);
  assert.equal((await call({ action: 'get' }, tokens[0], 'https://foreign.invalid')).status, 403);
  assert.equal((await call({ action: 'get' }, tokens[0], app.url, '/api/companion')).body.profile, null);
  valid = false; assert.equal((await call({ action: 'get' })).status, 401);
});
