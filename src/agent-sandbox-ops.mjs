// The runner's OS side (#72): everything goes through the sandbox wrapper from #71 (docs/SANDBOX.md). The runner
// service runs as the owner account (it needs sudo for cchan-sandbox-run, which the companion service cannot use).
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeAccepted, DEFAULT_IDENTITY } from './agent-merge.mjs';
import { releaseDesktop } from './desktop-release.mjs';
import { deployServer, DEPLOY_CLI } from './server-deploy.mjs';

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
    // The head is the branch's own; a failing commit count (no origin/<base> ref) must not hide it.
    const commits = Number(await git('rev-list', '--count', `refs/remotes/origin/${base}..refs/heads/${branch}`).catch(() => NaN));
    return { head, commits: Number.isSafeInteger(commits) ? commits : null };
  }

  // The merge step (#85): the reviewed branch is fetched from the sandbox's bare clone, merged into origin/<base>, tested
  // and pushed to `origin` (config.merge.origin, the GitHub repository; never the bare clone's remote, which the sandbox
  // user can rewrite) with the owner's configured identity and keys. See src/agent-merge.mjs. The owner's clones go to
  // its own (private) temp dir; the sandbox user makes the test copy under <root>/merge itself, so nothing has to be
  // created there for the owner.
  async merge({ repo, branch, base, expectedHead, ticketNumber, origin = null, identity = DEFAULT_IDENTITY, testCommand, prepareCommand, nodePath = null, tmp = tmpdir() }) {
    // The node that runs the merge steps must be visible inside the sandbox: ops/sandbox/properties hides /opt, so the
    // runner's own process.execPath (under /opt) is not usable there. Default to the root-owned <root>/bin/node, which is
    // also first on the sandbox PATH. A null/empty config value must not fall back to a bare `node` (#92).
    if (typeof nodePath !== 'string' || !nodePath.trim()) nodePath = join(this.#root, 'bin', 'node');
    if (typeof origin !== 'string' || !origin.trim()) return { status: 'error', output: 'No push target: set config.merge.origin (e.g. https://github.com/Blackoutburst/personal-agent.git).' };
    const dir = join(this.#root, 'repos', repo + '.git');
    return mergeAccepted({ origin: origin.trim(), source: dir, branch, expectedHead, base, ticketNumber, identity, testCommand, prepareCommand, nodePath,
      tmp, sandboxDir: join(this.#root, 'merge'), sandbox: (command, { cwd, timeoutMs }) => [this.#sudo, '-n', WRAPPER, '--cwd', cwd,
        '--max-seconds', String(Math.ceil((timeoutMs ?? 1_800_000) / 1000)), '--', ...command] });
  }

  // The desktop release after a merge (#90): owner-side, like the push, from a fresh clone of `origin` at exactly the
  // merge commit; never from the sandbox's clone. See src/desktop-release.mjs.
  async releaseDesktop({ origin, commit, base, dataDir, buildCommand, publishCommand, home, buildTimeoutMs, publishTimeoutMs, tmp = tmpdir() }) {
    if (typeof origin !== 'string' || !origin.trim()) return { status: 'error', commit, output: 'No origin: set config.merge.origin.' };
    return releaseDesktop({ origin: origin.trim(), commit, base, dataDir, buildCommand, publishCommand, home, buildTimeoutMs, publishTimeoutMs, tmp });
  }

  // The server deploy after a merge (#100): owner-side, through the existing release tool. See src/server-deploy.mjs.
  async deployServer(options) {
    if (typeof options?.origin !== 'string' || !options.origin.trim()) return { status: 'error', commit: options?.commit ?? null, output: 'No origin: set config.merge.origin.' };
    return deployServer({ ...options, origin: options.origin.trim() });
  }

  // Hand the runner's own restart to the guard (ops/deploy/runner-guard.mjs) in its own transient unit, through the one
  // fixed sudo command line allowed for it. Returns once systemd accepted the unit; the guard then restarts this runner.
  async startRunnerGuard({ deployCli = DEPLOY_CLI } = {}) {
    await run(this.#exec, this.#sudo, ['-n', deployCli, 'guard-runner']);
    return { started: true };
  }
}
