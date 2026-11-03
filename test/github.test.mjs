import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GitHub, githubOperation, parseExpiry } from '../src/github.mjs';
import { Connectors } from '../src/connectors.mjs';

const TOKEN_A = 'github_pat_' + 'A'.repeat(70), TOKEN_B = 'github_pat_' + 'B'.repeat(70);
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'github-')), db = new DatabaseSync(':memory:');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { now: Date.UTC(2026, 10, 3, 12), calls: [], created: [] };
  f.fetch = async (url, options) => {
    const path = url.replace('https://api.github.com', ''), auth = options.headers.Authorization;
    f.calls.push({ method: options.method, path, auth });
    const who = auth === 'Bearer ' + TOKEN_A ? 'alice' : auth === 'Bearer ' + TOKEN_B ? 'bob' : null;
    if (!who) return json(401, { message: 'Bad credentials' });
    if (path === '/user') return json(200, { login: who, name: who.toUpperCase() },
      who === 'alice' ? { 'github-authentication-token-expiration': '2026-11-08 12:00:00 UTC' } : {});
    if (path.startsWith('/user/repos') && options.method === 'GET') return json(200, [{ full_name: `${who}/site`, private: true, html_url: `https://github.com/${who}/site`, default_branch: 'main', updated_at: 'x' }]);
    if (path === '/user/repos' && options.method === 'POST') {
      const body = JSON.parse(options.body); f.created.push(body);
      return json(201, { full_name: `${who}/${body.name}`, private: body.private, html_url: `https://github.com/${who}/${body.name}`, default_branch: 'main' });
    }
    if (path.startsWith('/repos/alice/site/pulls?')) return json(200, [
      { number: 7, title: 'Calendar (#44)', state: 'closed', merged_at: '2026-11-03T10:00:00Z', head: { ref: 'calendar' }, html_url: 'u7' },
      { number: 8, title: 'GitHub connector', state: 'open', merged_at: null, head: { ref: 'gh-45' }, html_url: 'u8' }]);
    if (path === '/repos/alice/site/pulls/7') return json(200, { number: 7, title: 'Calendar (#44)', state: 'closed', merged: true,
      merged_at: '2026-11-03T10:00:00Z', head: { ref: 'calendar', sha: 'abc' }, base: { ref: 'main' }, html_url: 'u7' });
    if (path.startsWith('/repos/alice/site/commits/abc/check-runs')) return json(200, { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }] });
    return json(404, { message: 'Not Found' });
  };
  f.keyFile = join(dir, 'secrets', 'connector.key');
  f.github = new GitHub({ store: { db }, keyFile: f.keyFile, fetchImpl: f.fetch, now: () => f.now });
  f.connectors = new Connectors({ store: { db }, github: () => f.github });
  f.db = db; f.A = randomUUID(); f.B = randomUUID();
  return f;
}

test('parses GitHub token expiry headers', () => {
  assert.equal(new Date(parseExpiry('2026-12-03 14:00:00 UTC')).toISOString(), '2026-12-03T14:00:00.000Z');
  assert.equal(new Date(parseExpiry('2026-12-03 14:00:00 +0100')).toISOString(), '2026-12-03T13:00:00.000Z');
  assert.equal(parseExpiry(null), null); assert.equal(parseExpiry('soon'), null);
});

test('each owner links their own token; it is stored encrypted and never returned', async t => {
  const f = fixture(t);
  await assert.rejects(f.github.link(f.A, 'ghp_' + 'x'.repeat(36)), error => error.code === 'INVALID_TOKEN', 'Only fine-grained tokens');
  await assert.rejects(f.github.link(f.A, 'github_pat_' + 'Z'.repeat(70)), error => error.code === 'INVALID_TOKEN');
  const status = await f.github.link(f.A, '  ' + TOKEN_A + '\n');
  assert.deepEqual({ ...status }, { linked: true, login: 'alice', name: 'ALICE', repos: 1, expiresAt: '2026-11-08T12:00:00.000Z', expiring: true, problem: null });
  await f.github.link(f.B, TOKEN_B);
  assert.equal(statSync(f.keyFile).mode & 0o777, 0o600);
  const rows = f.db.prepare('SELECT companion_id, token_enc FROM connector_github').all();
  assert.equal(rows.length, 2);
  for (const row of rows) { assert.ok(row.token_enc.startsWith('v1:')); assert.ok(!row.token_enc.includes('github_pat_')); }
  const dump = JSON.stringify(f.connectors.list(f.A)) + JSON.stringify(f.github.status(f.A)) + readFileSync(f.keyFile, 'utf8');
  assert.ok(!dump.includes(TOKEN_A) && !dump.includes('AAAAAAAAAA'), 'The token never comes back');
  // Each owner's calls use that owner's token only; a row copied to another owner cannot be decrypted.
  f.calls.length = 0;
  assert.equal((await f.github.listRepos(f.B)).repos[0].fullName, 'bob/site');
  assert.ok(f.calls.every(call => call.auth === 'Bearer ' + TOKEN_B));
  const C = randomUUID();
  f.db.prepare("INSERT INTO connector_github SELECT ?, token_enc, login, name, expires_at, repos, problem, linked_at, updated_at FROM connector_github WHERE companion_id=?").run(C, f.A);
  await assert.rejects(f.github.listRepos(C), error => error.code === 'GITHUB_UNAVAILABLE');
  const github = f.connectors.list(f.A).connectors.find(item => item.id === 'github');
  assert.equal(github.state, 'expiring'); assert.match(github.detail, /@alice · 1 repository visible · token expires 8 Nov 2026/);
  assert.deepEqual(github.actions, ['replace', 'disconnect']);
  f.github.unlink(f.A);
  assert.equal(f.connectors.list(f.A).connectors.find(item => item.id === 'github').state, 'not_connected');
  assert.equal(f.github.linked(f.B), true);
});

test('read tools answer PR questions; repo creation is private by default, confirmed, replayable and nothing destructive exists', async t => {
  const f = fixture(t);
  assert.equal((await githubOperation(f.github, f.A, { op: 'listRepos' })).body.error.code, 'GITHUB_NOT_CONNECTED');
  await f.github.link(f.A, TOKEN_A);
  const pulls = await githubOperation(f.github, f.A, { op: 'pulls', repo: 'alice/site', query: '#44' });
  assert.deepEqual(pulls.body.pulls.map(pull => [pull.number, pull.merged]), [[7, true]]);
  const pull = (await githubOperation(f.github, f.A, { op: 'pull', repo: 'alice/site', number: 7 })).body;
  assert.equal(pull.merged, true); assert.deepEqual(pull.checks, { success: 1, in_progress: 1 });
  assert.equal((await githubOperation(f.github, f.A, { op: 'repo', repo: '../x' })).status, 400);
  assert.equal((await githubOperation(f.github, f.A, { op: 'deleteRepo', repo: 'alice/site' })).status, 400);
  assert.equal((await githubOperation(f.github, f.A, { op: 'createRepo', requestId: 'r1', name: 'notes' })).status, 400, 'Visibility must be stated');
  const input = { op: 'createRepo', requestId: 'r1', name: 'notes', description: 'My notes', private: true, gitignoreTemplate: 'Node' };
  const created = await githubOperation(f.github, f.A, input);
  assert.deepEqual(created.body, { fullName: 'alice/notes', private: true, url: 'https://github.com/alice/notes', defaultBranch: 'main' });
  assert.equal((await githubOperation(f.github, f.A, input)).body.replayed, true);
  assert.equal(f.created.length, 1, 'An exact retry does not create twice');
  assert.equal((await githubOperation(f.github, f.A, { ...input, name: 'other' })).body.error.code, 'CONFLICT');
  assert.deepEqual(f.created[0], { name: 'notes', private: true, auto_init: true, description: 'My notes', gitignore_template: 'Node' });
  assert.ok(f.calls.every(call => call.method === 'GET' || (call.method === 'POST' && call.path === '/user/repos')));
});

test('a rejected or expiring token shows in Connectors and produces one expiry notice', async t => {
  const f = fixture(t);
  await f.github.link(f.A, TOKEN_A);
  const notice = f.github.expiryNotice(f.A);
  assert.match(notice.prompt, /expires in about 5 days/); assert.match(notice.requestId, /^gh-expiry-[a-f0-9]{24}$/);
  assert.equal(f.github.expiryNotice(f.A).requestId, notice.requestId, 'Same key for the same token: queued once');
  f.now = Date.UTC(2026, 10, 9);
  assert.equal(f.github.expiryNotice(f.A), null);
  assert.match(f.connectors.list(f.A).connectors.find(item => item.id === 'github').detail, /expired on 8 Nov 2026/);
  assert.equal((await githubOperation(f.github, f.A, { op: 'listRepos' })).body.error.code, 'GITHUB_TOKEN_EXPIRED');
  await f.github.link(f.B, TOKEN_B);
  f.db.prepare("UPDATE connector_github SET token_enc=? WHERE companion_id=?").run(f.db.prepare('SELECT token_enc FROM connector_github WHERE companion_id=?').get(f.B).token_enc, f.B);
  const original = f.fetch; f.github = new GitHub({ store: { db: f.db }, keyFile: f.keyFile, now: () => f.now, fetchImpl: async () => json(401, {}) });
  assert.equal((await githubOperation(f.github, f.B, { op: 'listRepos' })).body.error.code, 'GITHUB_TOKEN_REJECTED');
  assert.equal(f.github.status(f.B).problem, 'REJECTED'); void original;
});

test('GitHub tools are hidden from turns until that owner connects, and repo creation is never in a wake', async t => {
  const f = fixture(t);
  const filter = f.connectors.toolFilter(f.A);
  assert.equal(filter('mcp__scheduler__github_list_repos'), false); assert.equal(filter('mcp__scheduler__list_calendar'), true);
  await f.github.link(f.A, TOKEN_A);
  const after = f.connectors.toolFilter(f.A);
  assert.ok(after === null || after('mcp__scheduler__github_list_repos'));
  assert.equal(f.connectors.toolFilter(f.B)('mcp__scheduler__github_repo'), false, 'The other owner is unaffected');
});
