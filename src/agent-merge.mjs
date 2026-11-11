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
// The reviewed code (the test run and the prepare step) never runs as the owner: with `sandbox` set both go through the same
// cchan-sandbox-run wrapper the agent units use (its own hardened unit, no owner keys, no agent socket). Without it (tests
// on temp repos) they run directly with a scrubbed environment (a throw-away HOME). Only git itself runs as the owner.
// They run in a separate, throw-away copy of the merge result, and the push is made from a fresh bare repository that
// holds only the merged commit, so nothing the tested code writes (a pushurl, hooks, refs) can redirect or alter the push.
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve as resolvePath } from 'node:path';

export const DEFAULT_IDENTITY = Object.freeze({ name: 'Blackoutburst', email: 'github@blackoutburst.dev' });
const TAIL = 8000;
const MISSING_DEPS = /ERR_MODULE_NOT_FOUND|Cannot find (package|module) '/;

const tail = value => String(value ?? '').slice(-TAIL);
function run(binary, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise(resolve => {
    execFile(binary, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 32 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0, timedOut: Boolean(error?.killed),
        output: tail(`${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`).trim() });
    });
  });
}

// sandbox: (command, { cwd, timeoutMs }) => argv, wraps a command to run in the agent sandbox (see SandboxOps.merge).
// origin: a Git URL or path. source: the sandbox clone holding the reviewed branch. Returns { status, ... }.
export async function mergeAccepted({ origin, source, branch, expectedHead, base = 'main', ticketNumber = null,
  identity = DEFAULT_IDENTITY, testCommand = ['node', '--test'], prepareCommand = null, sandbox = null, attempts = 3, testTimeoutMs = 30 * 60_000,
  gitTimeoutMs = 120_000, tmp = tmpdir() } = {}) {
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, 'cchan-merge-'));
  const work = join(dir, 'work'), home = join(dir, 'home');
  mkdirSync(home);
  const identityConfig = ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null'];
  const git = (args, { cwd = work, timeout = gitTimeoutMs } = {}) => run('git', [...identityConfig, ...args], { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const fail = (status, output, extra = {}) => ({ status, output: tail(output), ...extra });
  // A relative path would resolve differently in the push clone; everything else (URLs, absolute paths) is used as given.
  const originUrl = isAbsolute(String(origin ?? '')) || /^[a-z][a-z0-9+.-]*:\/\/|^[^/]+:/i.test(String(origin ?? '')) ? origin : resolvePath(String(origin ?? ''));
  let testDir = null;
  // Files the sandbox user created may not be removable by the owner until the sandbox opens them up; best effort, a
  // leftover copy holds nothing but the merge result.
  const cleanupTestDir = async path => {
    const copy = join(path, 'repo');
    if (sandbox && existsSync(copy)) {
      const [binary, ...args] = sandbox(['chmod', '-R', 'a+rwX', '.'], { cwd: copy, timeoutMs: 60_000 });
      await run(binary, args, { cwd: copy, timeout: 70_000 });
    }
    try { rmSync(path, { recursive: true, force: true }); } catch { /* left behind */ }
  };
  try {
    let step = await git(['clone', '--quiet', '--no-tags', '--branch', base, originUrl, work], { cwd: dir });
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
      step = await git(['checkout', '--quiet', '--detach', tip]);
      if (!step.ok) return fail('error', `Could not check out origin/${base} @ ${tip.slice(0, 10)}: ${step.output}`, { head, baseHead: tip });
      const message = `Merge ${branch}${ticketNumber ? ` (ticket #${ticketNumber})` : ''} into ${base}`;
      step = await git(['merge', '--no-ff', '--no-edit', '-m', message, head]);
      if (!step.ok) {
        const files = (await git(['diff', '--name-only', '--diff-filter=U'])).output;
        await git(['merge', '--abort']);
        return fail('conflict', `Merging ${branch} into ${base} @ ${tip.slice(0, 10)} conflicts${files ? ` in:\n${files}` : ''}\n\n${step.output}`, { head, baseHead: tip });
      }
      const merged = (await git(['rev-parse', 'HEAD'])).output;

      // The reviewed code runs in its own copy, never in the clone git works in: whatever it writes there (.git/config,
      // hooks, refs) stays in that copy, which is thrown away. With a sandbox it is the only directory the sandbox user can
      // reach (the owner's directory stays 0700): its parent is only traversable, the copy itself is opened up.
      // --no-hardlinks keeps the owner's object files out of it.
      if (testDir) await cleanupTestDir(testDir);
      testDir = mkdtempSync(join(tmp, 'cchan-merge-test-'));
      const copy = join(testDir, 'repo');
      step = await git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--no-tags', work, copy], { cwd: testDir });
      if (step.ok) step = await git(['checkout', '--quiet', '--detach', merged], { cwd: copy });
      if (!step.ok) return fail('error', `Could not prepare the test copy: ${step.output}`, { head, baseHead: tip });
      if (sandbox) { chmodSync(testDir, 0o711); await run('chmod', ['-R', 'a+rwX', copy], { timeout: gitTimeoutMs }); }
      const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', CI: '1' };
      const exec = (command, timeout) => {
        const argv = sandbox ? sandbox(command, { cwd: copy, timeoutMs: timeout }) : command;
        return run(argv[0], argv.slice(1), { cwd: copy, env: sandbox ? process.env : env, timeout });
      };
      if (prepareCommand) {
        step = await exec(prepareCommand, testTimeoutMs);
        if (!step.ok) return fail('error', `Preparing the test run failed (${prepareCommand.join(' ')}): ${step.output}`, { head, baseHead: tip });
      }
      step = await exec(testCommand, testTimeoutMs);
      if (!step.ok && !prepareCommand && MISSING_DEPS.test(step.output)) {
        return fail('error', `The test run could not start because dependencies are missing and no prepareCommand is configured (config.merge.prepareCommand, e.g. ["node","ops/sandbox/install-deps.mjs"]):\n${step.output}`, { head, baseHead: tip });
      }
      if (!step.ok) {
        return fail('tests_failed', `${testCommand.join(' ')} failed${step.timedOut ? ' (timed out)' : ` (exit ${step.code})`} on ${branch} merged into ${base} @ ${tip.slice(0, 10)}:\n${step.output}`, { head, baseHead: tip });
      }
      lastOutput = step.output;

      // The push comes from a fresh bare repository that only ever received the merged commit from the owner's clone, and
      // goes to the origin URL given here (not a remote name read from any config the tested code could reach). A plain
      // push: it only succeeds as a fast-forward of what we just tested against.
      const push = join(dir, `push-${attempt}`);
      step = await git(['init', '--quiet', '--bare', push], { cwd: dir });
      if (step.ok) step = await git(['update-ref', 'refs/heads/cchan-merged', merged]);
      if (step.ok) step = await git(['fetch', '--quiet', '--no-tags', work, 'refs/heads/cchan-merged:refs/heads/cchan-merged'], { cwd: push });
      if (step.ok && (await git(['rev-parse', 'refs/heads/cchan-merged'], { cwd: push })).output !== merged) step = { ok: false, output: 'the push clone does not hold the merged commit' };
      if (!step.ok) return fail('error', `Could not prepare the push: ${step.output}`, { head, baseHead: tip, mergeCommit: merged });
      step = await git(['push', '--quiet', originUrl, `${merged}:refs/heads/${base}`], { cwd: push });
      if (step.ok) return { status: 'merged', mergeCommit: merged, head, baseHead: tip, output: lastOutput };
      if (attempt === attempts || !/non-fast-forward|fetch first|rejected|stale info/i.test(step.output)) {
        return fail('error', `Pushing to origin/${base} failed: ${step.output}`, { head, baseHead: tip, mergeCommit: merged });
      }
    }
    return fail('error', 'The merge did not finish.');
  } finally {
    if (testDir) await cleanupTestDir(testDir);
    rmSync(dir, { recursive: true, force: true });
  }
}
