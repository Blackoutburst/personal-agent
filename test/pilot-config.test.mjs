import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync, symlinkSync, linkSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPilotSubjects, parsePilotSubjects } from '../src/pilot-config.mjs';

const issuer = 'https://blackoutburst.com';
const principal = { issuer, subject: 'synthetic-owner-one' };
const config = JSON.stringify({ principals: [principal] });
const posix = process.platform !== 'win32';
const rejected = error => {
  assert.equal(error.code, 'PILOT_CONFIG_UNAVAILABLE');
  assert.equal(error.message, 'Private pilot configuration is unavailable or invalid.');
  assert.equal(error.cause, undefined);
  return true;
};

function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'personal-agent-pilot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'checkout');
  const parent = join(directory, 'private');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(parent, { mode: 0o700 });
  const file = join(parent, 'pilot.json');
  writeFileSync(file, config, { mode: 0o600 });
  return { directory, source, parent, file };
}

test('pilot schema accepts one or two exact opaque principals without normalization', () => {
  assert.deepEqual(parsePilotSubjects(config), [principal]);
  const second = { issuer, subject: 'Synthetic-Owner-One' };
  assert.deepEqual(parsePilotSubjects(JSON.stringify({ principals: [principal, second] })), [principal, second]);
  assert.deepEqual(parsePilotSubjects(config + ' '.repeat(16 * 1024 - Buffer.byteLength(config))), [principal]);
});

test('pilot schema rejects extra fields, duplicates, invalid tuples and UTF-8 bounds with closed errors', () => {
  const invalid = [null, [], {}, { principals: [] }, { principals: [principal], extra: true },
    { principals: [principal, principal] }, { principals: [principal, { issuer, subject: 'two' }, { issuer, subject: 'three' }] },
    { principals: [null] }, { principals: [[]] }, { principals: [{ ...principal, displayName: 'private marker' }] },
    { principals: [{ subject: 'one' }] }, { principals: [{ issuer, subject: '' }] },
    { principals: [{ issuer, subject: 1 }] }, { principals: [{ issuer: issuer + '/', subject: 'one' }] },
    { principals: [{ issuer: 'https://other.invalid', subject: 'one' }] },
    { principals: [{ issuer, subject: '\ud800' }] }, { principals: [{ issuer, subject: 'é'.repeat(1025) }] }];
  for (const value of invalid) assert.throws(() => parsePilotSubjects(JSON.stringify(value)), rejected);
  for (const text of ['not JSON private marker', undefined, config + ' '.repeat(16 * 1024)]) {
    assert.throws(() => parsePilotSubjects(text), rejected);
  }
});

test('Windows rejects real configuration before inspecting a file or ACL', { skip: posix }, t => {
  const f = fixture(t);
  assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
  assert.throws(() => loadPilotSubjects('Z:\\unavailable-private-marker.json', f.source), rejected);
});

test('POSIX loader reads only a private external file and accepts the exact size bound', { skip: !posix }, t => {
  const f = fixture(t);
  assert.deepEqual(loadPilotSubjects(f.file, f.source), [principal]);
  writeFileSync(f.file, config + ' '.repeat(16 * 1024 - Buffer.byteLength(config)));
  assert.deepEqual(loadPilotSubjects(f.file, f.source), [principal]);
});

test('POSIX loader rejects missing, relative, in-checkout, non-file and oversized paths', { skip: !posix }, t => {
  const f = fixture(t);
  const inSource = join(f.source, 'private-marker.json');
  writeFileSync(inSource, config, { mode: 0o600 });
  for (const path of [undefined, 'relative-private-marker.json', join(f.parent, 'missing'), f.parent, inSource]) {
    assert.throws(() => loadPilotSubjects(path, f.source), rejected);
  }
  assert.throws(() => loadPilotSubjects(f.file, join(f.directory, 'missing-source')), rejected);
  writeFileSync(f.file, config + ' '.repeat(16 * 1024));
  assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
});

test('POSIX loader rejects file/ancestor symlinks and hard links', { skip: !posix }, t => {
  const f = fixture(t);
  const fileLink = join(f.parent, 'file-link');
  symlinkSync(f.file, fileLink);
  assert.throws(() => loadPilotSubjects(fileLink, f.source), rejected);
  const directoryLink = join(f.directory, 'directory-link');
  symlinkSync(f.parent, directoryLink, 'dir');
  assert.throws(() => loadPilotSubjects(join(directoryLink, 'pilot.json'), f.source), rejected);
  const hardLink = join(f.parent, 'hard-link');
  linkSync(f.file, hardLink);
  assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
  assert.throws(() => loadPilotSubjects(hardLink, f.source), rejected);
});

test('POSIX loader requires exact private file and immediate-directory permissions', { skip: !posix }, t => {
  const f = fixture(t);
  for (const mode of [0o400, 0o640, 0o644, 0o1600]) {
    chmodSync(f.file, mode);
    assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
  }
  chmodSync(f.file, 0o600);
  chmodSync(f.parent, 0o755);
  assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
  chmodSync(f.parent, 0o700);
  assert.deepEqual(loadPilotSubjects(f.file, f.source), [principal]);
});

test('POSIX ancestors may be readable but cannot be writable by other users without root sticky protection', { skip: !posix }, t => {
  const f = fixture(t);
  chmodSync(f.directory, 0o755);
  assert.deepEqual(loadPilotSubjects(f.file, f.source), [principal]);
  chmodSync(f.directory, 0o777);
  assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
  if (process.getuid() === 0) {
    chmodSync(f.directory, 0o1777);
    assert.deepEqual(loadPilotSubjects(f.file, f.source), [principal]);
  } else {
    chmodSync(f.directory, 0o1777);
    assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
  }
  chmodSync(f.directory, 0o700);
});

test('POSIX loader rejects a foreign-owned file', { skip: !posix || process.getuid?.() !== 0 }, t => {
  const f = fixture(t);
  chownSync(f.file, 1, 1);
  try { assert.throws(() => loadPilotSubjects(f.file, f.source), rejected); }
  finally { chownSync(f.file, 0, 0); }
});

test('POSIX loader rejects malformed UTF-8 instead of accepting replacement characters', { skip: !posix }, t => {
  const f = fixture(t);
  const prefix = Buffer.from('{"principals":[{"issuer":"https://blackoutburst.com","subject":"');
  writeFileSync(f.file, Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}')]));
  assert.throws(() => loadPilotSubjects(f.file, f.source), rejected);
});
