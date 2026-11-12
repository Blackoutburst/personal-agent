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
// With a sandbox, the sandbox user makes that copy itself, under `sandboxDir` (inside its own root, which the owner can
// only read): the merged commit goes in as a git bundle on stdin. The owner never writes into a directory the sandbox
// controls, and needs no directory there of its own; the owner's clones stay in `tmp` (the runner's private /tmp).
import { execFile } from 'node:child_process';
import { createReadStream, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, isAbsolute, resolve as resolvePath } from 'node:path';

export const DEFAULT_IDENTITY = Object.freeze({ name: 'Blackoutburst', email: 'github@blackoutburst.dev' });
const TAIL = 8000;
const MISSING_DEPS = /ERR_MODULE_NOT_FOUND|Cannot find (package|module) '/;

const tail = value => String(value ?? '').slice(-TAIL);
// input: a file fed to the command's stdin. The result keeps stdout on its own too (stdout), for commands that answer.
function run(binary, args, { cwd, env, timeout = 120_000, input = null } = {}) {
  return new Promise(resolve => {
    const child = execFile(binary, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 32 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0, timedOut: Boolean(error?.killed),
        stdout: String(stdout ?? '').trim(), output: tail(`${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`).trim() });
    });
    child.stdin.on('error', () => {}); // the command may exit without reading it all; its exit status says what happened
    if (input) createReadStream(input).on('error', () => child.stdin.end()).pipe(child.stdin);
    else child.stdin.end();
  });
}

// Run by the sandbox user (through `sandbox`): make a fresh test copy under $1 from the bundle on stdin, check out $2,
// print the copy's directory. Everything it creates belongs to the sandbox user.
const SANDBOX_COPY = [
  'set -eu',
  'mkdir -p "$1"',
  'd=$(mktemp -d "$1/cchan-merge-test-XXXXXXXX")',
  'cat > "$d/merged.bundle"',
  'git clone --quiet --no-checkout "$d/merged.bundle" "$d/repo" >&2',
  'git -C "$d/repo" checkout --quiet --detach "$2" >&2',
  'rm -f "$d/merged.bundle"',
  'printf "%s\\n" "$d"'
].join('; ');

// Early check (#92): the node that will run the steps (in the sandbox, as the sandbox user) must start and be at least the
// repo's package.json engines.node minimum (">=X"). Returns a readable refusal, or null.
async function checkNode(exec) {
  // One call, plain CommonJS so even a very old node can run it: prints "<version> <engines.node>" from ./package.json.
  const probe = "var r='';try{r=require('./package.json').engines.node||''}catch(e){};console.log(process.version+' '+r)";
  const res = await exec(['node', '-e', probe], 60_000);
  const out = String(res.output ?? '').trim();
  const [found, ...rest] = out.split('\n').pop().split(' ');
  if (!res.ok || !/^v\d+\.\d+\.\d+/.test(found ?? '')) return `The node for the merge steps could not be run (${tail(out, 300) || 'no output'}). Set config.merge.nodePath to a node binary the sandbox user can execute.`;
  const range = rest.join(' ');
  const min = /(?:^|\s)>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!min) return null;
  const have = found.slice(1).split('.').map(Number), need = [min[1], min[2] ?? 0, min[3] ?? 0].map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return null;
    if (have[i] < need[i]) return `The node for the merge steps is too old: found ${found}, the repository needs ${range} (package.json engines). Point config.merge.nodePath at a newer node (default: <sandbox root>/bin/node).`;
  }
  return null;
}

// sandbox: (command, { cwd, timeoutMs }) => argv, wraps a command to run in the agent sandbox in cwd (see SandboxOps.merge).
// origin: a Git URL or path. source: the sandbox clone holding the reviewed branch. Returns { status, ... }.
// sandboxDir: where the sandbox user makes its test copies (required with sandbox; under the sandbox root).
export async function mergeAccepted({ origin, source, branch, expectedHead, base = 'main', ticketNumber = null,
  identity = DEFAULT_IDENTITY, testCommand = ['node', '--test'], prepareCommand = null, nodePath = null, sandbox = null, sandboxDir = null, attempts = 3,
  testTimeoutMs = 30 * 60_000, gitTimeoutMs = 120_000, tmp = tmpdir() } = {}) {
  if (sandbox && !(typeof sandboxDir === 'string' && isAbsolute(sandboxDir))) return { status: 'error', output: 'sandboxDir: an absolute path is needed with sandbox.' };
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
  const inSandbox = (command, { cwd, timeout, input } = {}) => {
    const [binary, ...args] = sandbox(command, { cwd, timeoutMs: timeout });
    // No local cwd: the wrapper changes into cwd as the sandbox user (the owner may not be able to enter it).
    return run(binary, args, { env: process.env, timeout: timeout + 10_000, input });
  };
  // The sandbox's copy is removed by the sandbox (it owns it); the direct one by us. Best effort: a leftover copy holds
  // nothing but the merge result.
  const cleanupTestDir = async path => {
    if (sandbox) await inSandbox(['rm', '-rf', '--', path], { cwd: dirname(sandboxDir), timeout: 60_000 });
    else try { rmSync(path, { recursive: true, force: true }); } catch { /* left behind */ }
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
      // hooks, refs) stays in that copy, which is thrown away. With a sandbox the sandbox user makes the copy in its own
      // root from a bundle of the merged commit (the owner's directory stays 0700 and is never opened up); without one it
      // is a --no-hardlinks clone next to ours.
      if (testDir) await cleanupTestDir(testDir);
      testDir = null;
      step = await git(['update-ref', 'refs/heads/cchan-merged', merged]);
      if (!step.ok) return fail('error', `Could not prepare the test copy: ${step.output}`, { head, baseHead: tip });
      if (sandbox) {
        const bundle = join(dir, `merged-${attempt}.bundle`);
        step = await git(['bundle', 'create', '--quiet', bundle, 'refs/heads/cchan-merged']);
        if (step.ok) step = await inSandbox(['sh', '-c', SANDBOX_COPY, 'sh', sandboxDir, merged], { cwd: dirname(sandboxDir), timeout: gitTimeoutMs, input: bundle });
        const made = step.ok ? step.stdout.split('\n').at(-1) : '';
        if (step.ok && !(dirname(made) === sandboxDir && /^cchan-merge-test-[A-Za-z0-9]{8}$/.test(basename(made)))) {
          step = { ok: false, output: `the sandbox answered ${JSON.stringify(made.slice(0, 200))}` };
        }
        if (!step.ok) return fail('error', `Could not prepare the test copy in the sandbox: ${step.output}`, { head, baseHead: tip });
        testDir = made;
      } else {
        testDir = mkdtempSync(join(tmp, 'cchan-merge-test-'));
        const copy = join(testDir, 'repo');
        step = await git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--no-tags', work, copy], { cwd: testDir });
        if (step.ok) step = await git(['checkout', '--quiet', '--detach', merged], { cwd: copy });
        if (!step.ok) return fail('error', `Could not prepare the test copy: ${step.output}`, { head, baseHead: tip });
      }
      const copy = join(testDir, 'repo');
      const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', CI: '1' };
      // The runner's own node runs the steps (#92), not whatever `node` comes first on the sandbox PATH (an old system node
      // there broke the prepare step). Only a leading bare `node` is replaced, by an explicit argv word: it needs no PATH in
      // the sandbox, only to be executable by the sandbox user.
      const withNode = command => nodePath && command[0] === 'node' ? [nodePath, ...command.slice(1)] : command;
      const exec = (command, timeout) => {
        command = withNode(command);
        return sandbox ? inSandbox(command, { cwd: copy, timeout }) : run(command[0], command.slice(1), { cwd: copy, env, timeout });
      };
      if (prepareCommand?.[0] === 'node' || testCommand[0] === 'node') {
        const refused = await checkNode(exec);
        if (refused) return fail('error', refused, { head, baseHead: tip });
      }
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
