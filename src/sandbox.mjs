// C-chan's agent sandbox (#71, docs/SANDBOX.md). Agents C-chan launches run as the Unix user `cchan-agents`
// under /var/lib/cchan-agents, through systemd with the hardening in ops/sandbox/properties. This module manages
// their Git workspaces there:
//   repos/<repo>.git                 a bare clone of each allowed project repo (public HTTPS, no credentials)
//   worktrees/<repo>/<agent>-t<id>   one worktree per agent and ticket, on branch agent/<agent>/t<id>
// Branches stay in the bare clone after their worktree is removed, so finished work can still be reviewed.
// Everything here shells out to git with fixed argument lists; names are validated before they reach a path.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const SANDBOX_ROOT = '/var/lib/cchan-agents';
export const DEFAULT_REPOS = Object.freeze({
  'personal-agent': 'https://github.com/Blackoutburst/personal-agent.git',
  'agent-board': 'https://github.com/Blackoutburst/agent-board.git'
});

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TICKET = /^[a-z0-9]{1,40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export class SandboxError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = 'SandboxError'; this.code = code; }
}

function check(pattern, value, what) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')) throw new SandboxError('INVALID', `bad ${what}`);
  return value;
}

// The allowed repos: <root>/repos.json ({"name": "https url"}) when present, else DEFAULT_REPOS.
export function loadRepos(root = SANDBOX_ROOT) {
  const file = join(root, 'repos.json');
  if (!existsSync(file)) return { ...DEFAULT_REPOS };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SandboxError('INVALID', 'repos.json must be an object');
  for (const [name, url] of Object.entries(parsed)) {
    check(NAME, name, 'repo name');
    if (typeof url !== 'string' || !url) throw new SandboxError('INVALID', `bad url for ${name}`);
  }
  return parsed;
}

export class Sandbox {
  #root; #repos; #git;

  constructor({ root = SANDBOX_ROOT, repos = loadRepos(root), git = 'git' } = {}) {
    this.#root = root; this.#repos = repos; this.#git = git;
  }

  get root() { return this.#root; }

  #run(args, cwd = this.#root) {
    return execFileSync(this.#git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  }

  #repo(name) {
    check(NAME, name, 'repo name');
    if (!Object.hasOwn(this.#repos, name)) throw new SandboxError('UNKNOWN_REPO', name);
    return join(this.#root, 'repos', name + '.git');
  }

  workspace({ repo, agent, ticket }) {
    check(NAME, agent, 'agent name'); check(TICKET, ticket, 'ticket');
    this.#repo(repo);
    return { path: join(this.#root, 'worktrees', repo, `${agent}-t${ticket}`), branch: `agent/${agent}/t${ticket}` };
  }

  // Clone the bare repo on first use, then fetch: origin branches land in refs/remotes/origin/*, so a fetch never
  // touches the agents' own branches.
  sync(repo) {
    const dir = this.#repo(repo);
    if (!existsSync(dir)) {
      mkdirSync(join(this.#root, 'repos'), { recursive: true });
      this.#run(['clone', '--quiet', '--bare', this.#repos[repo], dir]);
      this.#run(['--git-dir', dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    }
    this.#run(['--git-dir', dir, 'fetch', '--quiet', '--prune', 'origin']);
    return dir;
  }

  // A fresh worktree for this agent and ticket, branched from origin/<base>. If the branch already exists (a resumed
  // run), the worktree checks it out again instead of starting over.
  create({ repo, agent, ticket, base = 'main' }) {
    check(BRANCH, base, 'base branch');
    const { path, branch } = this.workspace({ repo, agent, ticket });
    if (existsSync(path)) throw new SandboxError('EXISTS', path);
    const dir = this.sync(repo);
    mkdirSync(join(this.#root, 'worktrees', repo), { recursive: true });
    const exists = (() => { try { this.#run(['--git-dir', dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]); return true; } catch { return false; } })();
    if (exists) this.#run(['--git-dir', dir, 'worktree', 'add', '--quiet', path, branch]);
    else this.#run(['--git-dir', dir, 'worktree', 'add', '--quiet', '-b', branch, path, 'origin/' + base]);
    return { repo, agent, ticket, path, branch, resumed: exists };
  }

  // Remove the worktree (uncommitted changes are discarded) and prune Git's record of it. The branch is kept unless
  // deleteBranch is set.
  remove({ repo, agent, ticket, deleteBranch = false }) {
    const { path, branch } = this.workspace({ repo, agent, ticket });
    const dir = this.#repo(repo);
    if (existsSync(path)) {
      try { this.#run(['--git-dir', dir, 'worktree', 'remove', '--force', path]); }
      catch { rmSync(path, { recursive: true, force: true }); }
    }
    if (existsSync(dir)) {
      this.#run(['--git-dir', dir, 'worktree', 'prune']);
      if (deleteBranch) { try { this.#run(['--git-dir', dir, 'branch', '--quiet', '-D', branch]); } catch {} }
    }
    return { repo, agent, ticket, path, removed: !existsSync(path), branchDeleted: deleteBranch };
  }

  // Live worktrees of every cloned repo (the bare clone itself is not listed).
  list() {
    const out = [];
    for (const repo of Object.keys(this.#repos)) {
      const dir = join(this.#root, 'repos', repo + '.git');
      if (!existsSync(dir)) continue;
      let entry = null;
      for (const line of this.#run(['--git-dir', dir, 'worktree', 'list', '--porcelain']).split('\n')) {
        if (line.startsWith('worktree ')) entry = { repo, path: line.slice(9) };
        else if (line.startsWith('branch ') && entry) entry.branch = line.slice(7).replace(/^refs\/heads\//, '');
        else if (line === 'bare') entry = null;
        else if (line === '' && entry) { if (entry.branch) out.push(entry); entry = null; }
      }
      if (entry?.branch) out.push(entry);
    }
    return out;
  }
}
