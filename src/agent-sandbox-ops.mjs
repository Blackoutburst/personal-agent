// The runner's OS side (#72): everything goes through the sandbox wrapper from #71 (docs/SANDBOX.md). The runner
// service runs as the owner account (it needs sudo for cchan-sandbox-run, which the companion service cannot use).
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { mergeAccepted, DEFAULT_IDENTITY } from './agent-merge.mjs';

export const WRAPPER = '/usr/local/sbin/cchan-sandbox-run';
export const SANDBOX_NODE = '/var/lib/cchan-agents/bin/node';
export const WORKTREE_CLI = '/usr/local/lib/cchan-sandbox/ops/sandbox/worktree.mjs';
export const SANDBOX_ROOT = '/var/lib/cchan-agents';
const UNIT = /^cchan-agent-[a-z0-9-]{1,60}$/;

function run(execImpl, binary, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execImpl(binary, args, { encoding: 'utf8', timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}

export class SandboxOps {
  #exec; #spawn; #sudo; #root;
  constructor({ execImpl = execFile, spawnImpl = nodeSpawn, sudo = '/usr/bin/sudo', root = SANDBOX_ROOT } = {}) {
    this.#exec = execImpl; this.#spawn = spawnImpl; this.#sudo = sudo; this.#root = root;
  }

  async #worktree(args) {
    let out;
    try { out = await run(this.#exec, this.#sudo, ['-n', WRAPPER, '--', SANDBOX_NODE, WORKTREE_CLI, ...args]); }
    catch (error) {
      let detail = null;
      try { detail = JSON.parse(error.stdout || '{}'); } catch { /* not JSON */ }
      throw Object.assign(new Error(detail?.error ?? 'The sandbox worktree command failed.'), { code: detail?.code ?? 'SANDBOX_ERROR' });
    }
    return JSON.parse(out);
  }

  createWorktree({ repo, agent, ticket, base = 'main' }) {
    return this.#worktree(['create', '--repo', repo, '--agent', agent, '--ticket', ticket, '--base', base]);
  }

  removeWorktree({ repo, agent, ticket }) {
    return this.#worktree(['remove', '--repo', repo, '--agent', agent, '--ticket', ticket]);
  }

  // Put another agent's branch into a worktree for review (#73): the worktree's own branch is reset to it, as the
  // sandbox user. Returns the reviewed head.
  async checkout({ worktree, ref }) {
    if (typeof worktree !== 'string' || !worktree.startsWith(this.#root + '/worktrees/') || worktree.includes('..')) throw new Error('bad worktree');
    if (!/^agent\/[a-z0-9][a-z0-9-]{0,39}\/t\d{1,9}$/.test(ref)) throw new Error('bad branch');
    const git = (...args) => run(this.#exec, this.#sudo, ['-n', WRAPPER, '--cwd', worktree, '--', '/usr/bin/git', ...args], { timeout: 60_000 });
    await git('reset', '--quiet', '--hard', 'refs/heads/' + ref);
    return { head: (await git('rev-parse', 'HEAD')).trim() };
  }

  // One headless agent as its own transient unit in cchan-agents.slice. stdin/stdout pass through the wrapper.
  spawn({ unit, cwd, maxSeconds, spec }) {
    if (!UNIT.test(unit)) throw new Error('bad unit name');
    const env = Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = env.length ? ['/usr/bin/env', ...env, spec.binary, ...spec.args] : [spec.binary, ...spec.args];
    return this.#spawn(this.#sudo, ['-n', WRAPPER, '--unit', unit, '--cwd', cwd, '--max-seconds', String(maxSeconds), '--', ...command],
      { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async unitActive(unit) {
    if (!UNIT.test(unit)) throw new Error('bad unit name');
    try {
      const state = (await run(this.#exec, '/usr/bin/systemctl', ['is-active', unit + '.service'], { timeout: 10_000 })).trim();
      return ['active', 'activating', 'deactivating', 'reloading'].includes(state);
    } catch (error) {
      // is-active exits non-zero for inactive/failed/unknown units: the unit is gone.
      const state = String(error.stdout ?? '').trim();
      if (['inactive', 'failed', 'unknown', ''].includes(state)) return false;
      throw error;
    }
  }

  async stopUnit(unit) {
    if (!UNIT.test(unit)) throw new Error('bad unit name');
    await run(this.#exec, this.#sudo, ['-n', '/usr/bin/systemctl', 'stop', unit + '.service'], { timeout: 60_000 }).catch(() => {});
  }

  // The finished branch, read from the bare clone (the owner account is in the cchan-agents group).
  async branchInfo({ repo, branch, base }) {
    const dir = join(this.#root, 'repos', repo + '.git');
    const git = (...args) => run(this.#exec, 'git', ['-c', `safe.directory=${dir}`, '--git-dir', dir, ...args], { timeout: 30_000 }).then(out => out.trim());
    const head = await git('rev-parse', '--verify', 'refs/heads/' + branch);
    const commits = Number(await git('rev-list', '--count', `refs/remotes/origin/${base}..refs/heads/${branch}`));
    return { head, commits: Number.isSafeInteger(commits) ? commits : null };
  }

  // The merge step (#85): the reviewed branch is fetched from the sandbox's bare clone, merged into origin/<base>, tested
  // and pushed to origin (the remote of that clone) with the owner's configured identity and keys. See src/agent-merge.mjs.
  async merge({ repo, branch, base, expectedHead, ticketNumber, origin = null, identity = DEFAULT_IDENTITY, testCommand, prepareCommand }) {
    const dir = join(this.#root, 'repos', repo + '.git');
    let url = origin;
    if (!url) {
      try { url = (await run(this.#exec, 'git', ['-c', `safe.directory=${dir}`, '--git-dir', dir, 'remote', 'get-url', 'origin'], { timeout: 15_000 })).trim(); }
      catch { return { status: 'error', output: `The sandbox clone of ${repo} has no origin remote.` }; }
    }
    return mergeAccepted({ origin: url, source: dir, branch, expectedHead, base, ticketNumber, identity, testCommand, prepareCommand });
  }
}
