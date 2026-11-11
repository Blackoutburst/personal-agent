// The merge step of C-chan's agent runner (#85, docs/AGENT-RUNNER.md). After C-chan accepted a branch on an independent
// reviewer's approval (agents_decide kind accept), the runner lands it on main itself, without a model and without a
// second worker:
//   1. clone origin, fetch the reviewed branch from the sandbox clone, and refuse if its head is not the reviewed head
//   2. merge the branch into the current origin/<base> (no fast-forward: one merge commit) and stop on a conflict
//   3. run the full suite (`node --test`) on that merge result and stop if it fails
//   4. push the merge commit to origin as a plain fast-forward (never forced); if main moved meanwhile, start again
// The result says what happened; on 'conflict' and 'tests_failed' nothing was pushed. Releasing the server (restart,
// rollout) is not part of this: it stays with the owner.
// Git runs with the identity and the keys already configured for the owner on this server: nothing new is created here.
// Tests run with a scrubbed environment (a throw-away HOME, no agent socket), so reviewed code does not see ssh keys.
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_IDENTITY = Object.freeze({ name: 'Blackoutburst', email: 'github@blackoutburst.dev' });
const TAIL = 8000;

const tail = value => String(value ?? '').slice(-TAIL);
function run(binary, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise(resolve => {
    execFile(binary, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 32 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0, timedOut: Boolean(error?.killed),
        output: tail(`${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`).trim() });
    });
  });
}

// origin: a Git URL or path. source: the sandbox clone holding the reviewed branch. Returns { status, ... }.
export async function mergeAccepted({ origin, source, branch, expectedHead, base = 'main', ticketNumber = null,
  identity = DEFAULT_IDENTITY, testCommand = ['node', '--test'], prepareCommand = null, attempts = 3, testTimeoutMs = 30 * 60_000,
  gitTimeoutMs = 120_000, tmp = tmpdir() } = {}) {
  const dir = mkdtempSync(join(tmp, 'cchan-merge-'));
  const work = join(dir, 'work'), home = join(dir, 'home');
  mkdirSync(home);
  const identityConfig = ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null'];
  const git = (args, { cwd = work, timeout = gitTimeoutMs } = {}) => run('git', [...identityConfig, ...args], { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const fail = (status, output, extra = {}) => ({ status, output: tail(output), ...extra });
  try {
    let step = await git(['clone', '--quiet', '--no-tags', '--branch', base, origin, work], { cwd: dir });
    if (!step.ok) return fail('error', `Could not clone origin: ${step.output}`);
    step = await git(['-c', `safe.directory=${source}`, 'fetch', '--quiet', '--no-tags', `--upload-pack=git -c safe.directory=${source} upload-pack`,
      source, `refs/heads/${branch}:refs/heads/candidate`]);
    if (!step.ok) return fail('error', `Could not fetch ${branch}: ${step.output}`);
    const head = (await git(['rev-parse', 'refs/heads/candidate'])).output;
    if (head !== expectedHead) return fail('moved', `${branch} is at ${head.slice(0, 10)}, but the reviewed head is ${String(expectedHead).slice(0, 10)}. Review the current work first.`, { head });

    let lastOutput = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      step = await git(['fetch', '--quiet', '--no-tags', 'origin', base]);
      if (!step.ok) return fail('error', `Could not fetch origin/${base}: ${step.output}`);
      const tip = (await git(['rev-parse', `refs/remotes/origin/${base}`])).output;
      if ((await git(['merge-base', '--is-ancestor', head, tip])).ok) {
        return { status: 'already_merged', mergeCommit: tip, head, output: `${branch} @ ${head.slice(0, 10)} is already part of ${base}.` };
      }
      await git(['checkout', '--quiet', '--detach', tip]);
      const message = `Merge ${branch}${ticketNumber ? ` (ticket #${ticketNumber})` : ''} into ${base}`;
      step = await git(['merge', '--no-ff', '--no-edit', '-m', message, head]);
      if (!step.ok) {
        const files = (await git(['diff', '--name-only', '--diff-filter=U'])).output;
        await git(['merge', '--abort']);
        return fail('conflict', `Merging ${branch} into ${base} @ ${tip.slice(0, 10)} conflicts${files ? ` in:\n${files}` : ''}\n\n${step.output}`, { head, baseHead: tip });
      }
      const merged = (await git(['rev-parse', 'HEAD'])).output;

      const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', CI: '1' };
      if (prepareCommand) {
        step = await run(prepareCommand[0], prepareCommand.slice(1), { cwd: work, env, timeout: testTimeoutMs });
        if (!step.ok) return fail('error', `Preparing the test run failed (${prepareCommand.join(' ')}): ${step.output}`, { head, baseHead: tip });
      }
      step = await run(testCommand[0], testCommand.slice(1), { cwd: work, env, timeout: testTimeoutMs });
      if (!step.ok) {
        return fail('tests_failed', `${testCommand.join(' ')} failed${step.timedOut ? ' (timed out)' : ` (exit ${step.code})`} on ${branch} merged into ${base} @ ${tip.slice(0, 10)}:\n${step.output}`, { head, baseHead: tip });
      }
      lastOutput = step.output;

      // A plain push: it only succeeds as a fast-forward of what we just tested against.
      step = await git(['push', '--quiet', 'origin', `${merged}:refs/heads/${base}`]);
      if (step.ok) return { status: 'merged', mergeCommit: merged, head, baseHead: tip, output: lastOutput };
      if (attempt === attempts || !/non-fast-forward|fetch first|rejected|stale info/i.test(step.output)) {
        return fail('error', `Pushing to origin/${base} failed: ${step.output}`, { head, baseHead: tip, mergeCommit: merged });
      }
    }
    return fail('error', 'The merge did not finish.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
