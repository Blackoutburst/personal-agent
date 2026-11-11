import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, SandboxError, loadRepos, DEFAULT_REPOS } from '../src/sandbox.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'sandbox-71-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin');
  execFileSync('git', ['init', '--quiet', '-b', 'main', origin]);
  git(origin, 'config', 'user.email', 't@example.com'); git(origin, 'config', 'user.name', 'T');
  writeFileSync(join(origin, 'README'), 'one\n'); git(origin, 'add', '.'); git(origin, 'commit', '--quiet', '-m', 'one');
  const root = join(base, 'root');
  return { origin, root, sandbox: new Sandbox({ root, repos: { demo: origin } }) };
}

test('each agent and ticket gets its own worktree on its own branch, removed on cleanup (#71)', t => {
  const { origin, root, sandbox } = fixture(t);
  const a = sandbox.create({ repo: 'demo', agent: 'coder-1', ticket: '72' });
  const b = sandbox.create({ repo: 'demo', agent: 'coder-2', ticket: '72' });
  assert.equal(a.path, join(root, 'worktrees', 'demo', 'coder-1-t72'));
  assert.equal(a.branch, 'agent/coder-1/t72'); assert.equal(a.resumed, false);
  assert.notEqual(a.path, b.path);
  assert.equal(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/coder-1/t72');
  assert.equal(git(a.path, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
  assert.deepEqual(sandbox.list().map(w => w.branch).sort(), ['agent/coder-1/t72', 'agent/coder-2/t72']);
  assert.throws(() => sandbox.create({ repo: 'demo', agent: 'coder-1', ticket: '72' }), e => e.code === 'EXISTS');

  // Work committed in the worktree survives its removal on the branch, and a later run resumes it.
  writeFileSync(join(a.path, 'work.txt'), 'done\n');
  git(a.path, 'add', '.'); git(a.path, '-c', 'user.email=a@x', '-c', 'user.name=A', 'commit', '--quiet', '-m', 'work');
  const head = git(a.path, 'rev-parse', 'HEAD');
  writeFileSync(join(a.path, 'scratch.txt'), 'uncommitted\n');
  const removed = sandbox.remove({ repo: 'demo', agent: 'coder-1', ticket: '72' });
  assert.equal(removed.removed, true); assert.equal(existsSync(a.path), false);
  assert.deepEqual(sandbox.list().map(w => w.branch), ['agent/coder-2/t72']);
  const again = sandbox.create({ repo: 'demo', agent: 'coder-1', ticket: '72' });
  assert.equal(again.resumed, true); assert.equal(git(again.path, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(again.path, 'scratch.txt')), false);

  // deleteBranch drops the branch too; removing an absent worktree is harmless.
  sandbox.remove({ repo: 'demo', agent: 'coder-1', ticket: '72', deleteBranch: true });
  assert.throws(() => git(join(root, 'repos', 'demo.git'), 'rev-parse', '--verify', 'refs/heads/agent/coder-1/t72'));
  assert.equal(sandbox.remove({ repo: 'demo', agent: 'coder-1', ticket: '72' }).removed, true);
});

test('a fetch brings new origin commits for new worktrees and never touches agent branches (#71)', t => {
  const { origin, sandbox } = fixture(t);
  const first = sandbox.create({ repo: 'demo', agent: 'coder-1', ticket: '1' });
  const before = git(first.path, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'README'), 'two\n'); git(origin, 'commit', '--quiet', '-am', 'two');
  const second = sandbox.create({ repo: 'demo', agent: 'coder-1', ticket: '2' });
  assert.equal(git(second.path, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
  assert.equal(git(first.path, 'rev-parse', 'HEAD'), before);
  git(origin, 'checkout', '--quiet', '-b', 'feature');
  const third = sandbox.create({ repo: 'demo', agent: 'coder-1', ticket: '3', base: 'feature' });
  assert.equal(git(third.path, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'feature'));
});

test('names are validated before they reach a path, and only allowed repos are used (#71)', t => {
  const { sandbox } = fixture(t);
  for (const bad of [{ agent: '../x' }, { agent: 'A' }, { agent: '' }, { ticket: '1/2' }, { ticket: '..' }, { repo: 'other' }, { repo: '../demo' }]) {
    assert.throws(() => sandbox.create({ repo: 'demo', agent: 'coder', ticket: '1', ...bad }), SandboxError, JSON.stringify(bad));
  }
  assert.throws(() => sandbox.create({ repo: 'demo', agent: 'coder', ticket: '1', base: '--upload-pack=x' }), e => e.code === 'INVALID');
  assert.throws(() => sandbox.create({ repo: 'demo', agent: 'coder', ticket: '1', base: 'a/../b' }), e => e.code === 'INVALID');
});

test('the repo allowlist comes from repos.json in the sandbox root, else the defaults (#71)', t => {
  const { root } = fixture(t);
  assert.deepEqual(loadRepos(root), { ...DEFAULT_REPOS });
  execFileSync('mkdir', ['-p', root]);
  writeFileSync(join(root, 'repos.json'), JSON.stringify({ demo: 'https://example.com/demo.git' }));
  assert.deepEqual(loadRepos(root), { demo: 'https://example.com/demo.git' });
  writeFileSync(join(root, 'repos.json'), JSON.stringify({ '../x': 'u' }));
  assert.throws(() => loadRepos(root), SandboxError);
});
