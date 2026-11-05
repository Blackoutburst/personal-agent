import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWorkspace } from '../src/companion.mjs';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { Conversations } from '../src/conversations.mjs';
import { startServer } from '../server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ISSUER = 'https://synthetic.invalid';
const STALE = '<!-- Written by the Personal Agent app (version 5). -->\n# Previous app instructions\n';
const OWNER = { issuer: ISSUER, subject: 'synthetic-upgrade-alice', label: 'alice', provider: 'codex' };
const MEMORY = {
  'SOUL.md': '# Soul\n\n- My chosen voice, with café and 🌙.\n',
  'USER.md': '# User\n\n## Preferences\n- PRIVATE-USER-CANARY\n',
  'MEMORY.md': '# Memories\n\n## Promises\n- PRIVATE-MEMORY-CANARY\n',
  'memory/2026-11-02.md': '- PRIVATE-DIARY-CANARY\n',
  'board-followthrough.json': '{"ticket":"synthetic-ticket","cursor":"private-cursor-canary","pending":["synthetic-message"]}\n'
};
function temporary(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'companion-instruction-upgrade-')));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function writeMemory(dir) {
  mkdirSync(join(dir, 'memory'), { recursive: true });
  for (const [file, text] of Object.entries(MEMORY)) writeFileSync(join(dir, file), text);
}
function assertMemory(dir) {
  for (const [file, text] of Object.entries(MEMORY)) assert.deepEqual(readFileSync(join(dir, file)), Buffer.from(text), file);
}

test('AGENTS refresh reports one change while preserving private workspace and Board follow-through notes byte for byte', t => {
  const dir = temporary(t);
  ensureWorkspace(dir, OWNER); writeMemory(dir); writeFileSync(join(dir, 'AGENTS.md'), STALE);
  assert.equal(ensureWorkspace(dir, OWNER), true);
  const upgraded = readFileSync(join(dir, 'AGENTS.md'));
  assert.match(upgraded.toString('utf8'), /\(version 29\)/);
  assert.doesNotMatch(upgraded.toString('utf8'), /\(version 5\)/);
  assert.match(upgraded.toString('utf8'), /send_file.*stable requestId/);
  assertMemory(dir);
  assert.equal(ensureWorkspace(dir, OWNER), false);
  assert.deepEqual(readFileSync(join(dir, 'AGENTS.md')), upgraded);
  assertMemory(dir);
});

test('a failed pre-change callback preserves the old marker for retry and only runs before a real upgrade', t => {
  const dir = temporary(t);
  ensureWorkspace(dir, OWNER); writeMemory(dir); writeFileSync(join(dir, 'AGENTS.md'), STALE);
  const failure = new Error('Synthetic session reset failed'); let calls = 0;
  assert.throws(() => ensureWorkspace(dir, OWNER, { beforeInstructionsChange() {
    calls++; assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), STALE); throw failure;
  } }), error => error === failure);
  assert.equal(calls, 1); assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), STALE); assertMemory(dir);
  assert.equal(ensureWorkspace(dir, OWNER, { beforeInstructionsChange() {
    calls++; assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), STALE); assertMemory(dir);
  } }), true);
  assert.equal(calls, 2); assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /\(version 29\)/); assertMemory(dir);
  const upgraded = readFileSync(join(dir, 'AGENTS.md'));
  assert.equal(ensureWorkspace(dir, OWNER, { beforeInstructionsChange() { calls++; throw failure; } }), false);
  assert.equal(calls, 2); assert.deepEqual(readFileSync(join(dir, 'AGENTS.md')), upgraded); assertMemory(dir);
});

test('account startup leaves a failed contender untouched, upgrades only the stale owner and preserves current sessions', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'companion-startup-upgrade-')));
  const dataDir = join(dir, 'data'), runtimeDir = join(dir, 'runtimes'), runtimeFile = join(dir, 'owners.json');
  const owners = [OWNER, { issuer: ISSUER, subject: 'synthetic-upgrade-bob', label: 'bob', provider: 'claude' }];
  const ids = {}, threads = {}, apps = []; let launches = 0;
  t.after(async () => {
    for (const app of apps) if (app.server.listening) await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(runtimeFile, JSON.stringify({ owners }));
  const workspace = label => join(runtimeDir, label, 'workspace');
  const seed = new BootstrapStore(dataDir, ROOT), conversations = new Conversations({ store: seed });
  try {
    for (const owner of owners) {
      ids[owner.label] = seed.getOrInsert('companion-identity-v1', principalKey({ issuer: owner.issuer, subject: owner.subject }), { companionId: randomUUID() }).companionId;
      threads[owner.label] = [];
      for (let index = 0; index < 2; index++) {
        const result = await conversations.handle(ids[owner.label], { action: 'createThread', requestId: 'seed-' + index, title: owner.label + ' chat ' + index });
        threads[owner.label].push(result.thread.id);
      }
      seed.db.prepare('UPDATE conv_threads SET provider_session=?,session_turns=?,session_at=? WHERE companion_id=?')
        .run('old-native-' + owner.label, 7, 1000, ids[owner.label]);
      ensureWorkspace(workspace(owner.label), owner); writeMemory(workspace(owner.label));
    }
  } finally { await conversations.shutdown(); seed.close(); }
  const bobInstructions = readFileSync(join(workspace('bob'), 'AGENTS.md'));
  const open = async (port = 0) => {
    const app = await startServer({ dataDir, mode: 'account', port, runtimeFile, runtimeDir,
      pilotSubjects: owners.map(({ issuer, subject }) => ({ issuer, subject })), validateAccount: async () => null,
      runnerOptions: { spawnImpl() { launches++; throw new Error('No provider may launch during an instruction upgrade test'); } },
      discordOptions: { connect: false } });
    apps.push(app); return app;
  };
  const rows = (app, label) => app.store.db.prepare('SELECT id,provider_session,session_turns,session_at FROM conv_threads WHERE companion_id=? ORDER BY id').all(ids[label]);
  const bound = await open();
  writeFileSync(join(workspace('alice'), 'AGENTS.md'), STALE);
  const beforeConflict = Object.fromEntries(owners.map(owner => [owner.label, rows(bound, owner.label)]));
  await assert.rejects(open(bound.server.address().port), error => error.code === 'EADDRINUSE');
  assert.equal(bound.server.listening, true); assert.equal(readFileSync(join(workspace('alice'), 'AGENTS.md'), 'utf8'), STALE);
  assert.deepEqual(readFileSync(join(workspace('bob'), 'AGENTS.md')), bobInstructions);
  for (const owner of owners) {
    assert.deepEqual(rows(bound, owner.label), beforeConflict[owner.label]); assertMemory(workspace(owner.label));
  }
  await bound.close();
  const app = await open();
  for (const row of rows(app, 'alice')) {
    assert.ok(threads.alice.includes(row.id)); assert.equal(row.provider_session, null); assert.equal(row.session_turns, 0);
    assert.equal(row.session_at, 1000);
  }
  for (const row of rows(app, 'bob')) {
    assert.ok(threads.bob.includes(row.id)); assert.equal(row.provider_session, 'old-native-bob'); assert.equal(row.session_turns, 7);
    assert.equal(row.session_at, 1000);
  }
  assert.equal(rows(app, 'alice').length, 2); assert.equal(rows(app, 'bob').length, 2);
  assert.match(readFileSync(join(workspace('alice'), 'AGENTS.md'), 'utf8'), /\(version 29\)/);
  assert.deepEqual(readFileSync(join(workspace('bob'), 'AGENTS.md')), bobInstructions);
  for (const owner of owners) assertMemory(workspace(owner.label));
  for (const owner of owners) app.store.db.prepare('UPDATE conv_threads SET provider_session=?,session_turns=? WHERE companion_id=?')
    .run('fresh-native-' + owner.label, owner.label === 'alice' ? 3 : 9, ids[owner.label]);
  await app.close();
  const reopened = await open();
  for (const owner of owners) {
    const current = rows(reopened, owner.label); assert.equal(current.length, 2);
    for (const row of current) {
      assert.equal(row.provider_session, 'fresh-native-' + owner.label);
      assert.equal(row.session_turns, owner.label === 'alice' ? 3 : 9);
    }
    assertMemory(workspace(owner.label));
  }
  assert.equal(launches, 0);
});
