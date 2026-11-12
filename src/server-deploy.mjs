// The server deploy step of the runner's merge path (#100, docs/MANAGER.md). After agents_merge merged a branch, passed
// the full suite and pushed main, the runner (owner-side, config.deploy.server) deploys exactly that merge commit to the
// server with the existing release tool (ops/release.mjs, docs/OPERATIONS.md), without a model:
//   1. fetch origin's main into a runner-owned bare mirror (the release tool archives from it); the commit must be on main
//   2. diff the deployed release (<releaseRoot>/current) against the commit and decide what to restart:
//      - only docs/tests/desktop/android/build scripts changed: nothing is deployed
//      - anything else: `ops/release.mjs release <commit>` (backup, switch current, restart the companion, health check;
//        on a failed health check the tool itself puts the previous release back and checks it again)
//      - code the runner loads (runner-service.mjs and its imports) changed too: the runner is restarted last, by a guard
//        in its own transient systemd unit (ops/deploy/runner-guard.mjs) so the restart survives the runner exiting
//   3. before stopping the companion, wait (bounded) until no owner turn is running (<dataDir>/companion-activity.json)
// Privilege: the runner gets no general sudo. Service control goes through the root-owned /usr/local/sbin/cchan-deploy
// (ops/deploy/cchan-deploy), which takes one fixed verb and runs only systemctl/systemd-run with fixed unit names; the
// sudoers rule allows exactly those four command lines. No merged code runs as root.
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { run } from './agent-merge.mjs';

export const DEPLOY_CLI = '/usr/local/sbin/cchan-deploy';
export const SYSTEMCTL_HELPER = '/usr/local/lib/cchan-deploy/systemctl-deploy';
export const COMPANION_UNIT = 'personal-agent-account.service';
export const RUNNER_UNIT = 'cchan-agent-runner.service';
export const RUNNER_ENTRY = 'ops/agent-runner/runner-service.mjs';
const SHA = /^[0-9a-f]{40}$/;
const TAIL = 8000;
const tail = value => String(value ?? '').slice(-TAIL);

// Paths whose change never needs the server: nothing there is loaded by the companion or the runner.
const NO_DEPLOY = [/^docs\//, /^test\//, /^desktop\//, /^android\//, /^scripts\//, /^character-kit\//, /^ops\/verify\//,
  /^\.github\//, /^[^/]+\.md$/, /^\.gitignore$/, /^\.gitattributes$/];
// Shared by both services: dependencies.
const BOTH = new Set(['package.json', 'package-lock.json']);

// The files the runner process loads: runner-service.mjs and everything it imports, followed through relative imports
// and the service's join(ROOT, 'src', 'x.mjs') dynamic imports. read(path) -> text or null (the file at the commit).
export async function runnerFiles(read, entry = RUNNER_ENTRY) {
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const text = await read(path);
    if (typeof text !== 'string') continue;
    seen.add(path);
    const dir = posix.dirname(path), found = [];
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) found.push(posix.normalize(posix.join(dir, match[1])));
    // join(ROOT, 'src', 'agent-runner.mjs') where ROOT is the repository root (runner-service.mjs).
    for (const match of text.matchAll(/join\(\s*ROOT\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g)) {
      const parts = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(part => part[1]);
      if (/\.(mjs|js|json)$/.test(parts.at(-1) ?? '')) found.push(posix.normalize(parts.join('/')));
    }
    for (const next of found) if (!next.startsWith('..') && /\.(mjs|js|json)$/.test(next) && !seen.has(next)) queue.push(next);
  }
  return seen;
}

// What a change set needs. paths: changed files (null = unknown, e.g. no deployed release yet: everything).
// runnerSet: runnerFiles() at the commit. reinstall: ops/deploy/ changed, the root-installed copies are now behind.
export function planDeploy(paths, runnerSet = new Set()) {
  if (paths === null) return { deploy: true, companion: true, runner: true, reinstall: false, paths: null };
  const relevant = paths.filter(path => !NO_DEPLOY.some(pattern => pattern.test(path)));
  return { deploy: relevant.length > 0, companion: relevant.length > 0,
    runner: relevant.some(path => BOTH.has(path) || runnerSet.has(path)),
    reinstall: paths.some(path => path.startsWith('ops/deploy/')), paths: paths.slice(0, 200) };
}

// The full commit a release link (<root>/current, <root>/previous) points at, or null. Only releases/<full-sha> counts.
export function releaseLink(releaseRoot, name) {
  try {
    const target = resolve(releaseRoot, readlinkSync(join(releaseRoot, name)));
    return dirname(target) === join(resolve(releaseRoot), 'releases') && SHA.test(basename(target)) ? basename(target) : null;
  } catch { return null; }
}

// The companion writes { busy, pid, at } to <dataDir>/companion-activity.json whenever an owner turn starts or ends
// (server.mjs). Idle: no file, busy 0, or the writer is gone (a stale file after a crash).
export function companionIdle(file, { alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } } } = {}) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { return true; }
  if (!value || !Number.isSafeInteger(value.busy) || value.busy <= 0) return true;
  return !(Number.isSafeInteger(value.pid) && value.pid > 0 && alive(value.pid));
}

// The companion's side of it: onActivity for CompanionRunner. Write errors are ignored (a missing file reads as idle).
export function activityWriter(file, { pid = process.pid, now = Date.now } = {}) {
  return busy => { try { writeJson(file, { busy, pid, at: now() }); } catch { /* best effort */ } };
}

// Poll check() until it is true or timeoutMs passed. Returns { ok, waitedMs }.
export async function waitUntil(check, { timeoutMs, intervalMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const start = now();
  for (;;) {
    if (await check()) return { ok: true, waitedMs: now() - start };
    if (now() - start >= timeoutMs) return { ok: false, waitedMs: now() - start };
    await sleep(intervalMs);
  }
}

// Shared files between the runner and the guard (both the owner account): deploy.json is written by the runner when it
// hands over to the guard and then only by the guard; deploy-ack.json only by the restarted runner.
export function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
export const ackFile = stateFile => join(dirname(stateFile), 'deploy-ack.json');
export function clearDeployState(stateFile) { rmSync(stateFile, { force: true }); rmSync(ackFile(stateFile), { force: true }); }

// The release tool's error code from its stderr ({"error":"HEALTH",...}), or null.
function releaseError(output) {
  for (const line of String(output ?? '').split('\n').reverse()) {
    try { const value = JSON.parse(line); if (typeof value?.error === 'string') return value.error; } catch { /* not JSON */ }
  }
  return null;
}

// commit: the merge commit agents_merge pushed. origin: config.merge.origin. repo: the runner's bare mirror (created on
// first use). releaseRoot: ~/personal-agent. releaseTool: ops/release.mjs of the code the runner runs (not the commit's).
// systemctl: COMPANION_SYSTEMCTL for the tool (the root-installed helper -> sudo -n cchan-deploy stop|start-companion).
// Returns { status: 'deployed' | 'skipped' | 'rolled_back' | 'recovery_failed' | 'failed' | 'error', reason?, commit,
// previous, plan, idle: { ok, waitedMs }, release?, output }.
export async function deployServer({ origin, commit, base = 'main', repo, releaseRoot, dataDir, releaseTool, systemctl = SYSTEMCTL_HELPER,
  healthUrl = null, node = process.execPath, activityFile = dataDir ? join(dataDir, 'companion-activity.json') : null,
  idleWaitMs = 5 * 60_000, idleIntervalMs = 2000, releaseTimeoutMs = 20 * 60_000, gitTimeoutMs = 120_000,
  sleep, now = Date.now, idle = companionIdle, exec = run } = {}) {
  const out = { commit: commit ?? null, previous: null, plan: null, idle: null };
  const fail = (status, output, extra = {}) => ({ ...out, status, output: tail(output), ...extra });
  if (typeof commit !== 'string' || !SHA.test(commit)) return fail('error', 'commit: the full merge commit id is needed.');
  for (const [name, value] of Object.entries({ origin, repo, releaseRoot, dataDir, releaseTool })) {
    if (typeof value !== 'string' || !value.trim()) return fail('error', `${name} is not set (config.deploy / config.merge.origin).`);
  }
  const git = args => exec('git', ['-c', 'core.hooksPath=/dev/null', `--git-dir=${repo}`, ...args], { timeout: gitTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  // 1. The mirror, and the commit on main.
  if (!existsSync(join(repo, 'HEAD'))) {
    mkdirSync(dirname(repo), { recursive: true, mode: 0o700 });
    const cloned = await exec('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--bare', '--quiet', '--no-tags', origin, repo], { timeout: gitTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (!cloned.ok) return fail('error', `Could not clone origin into ${repo}: ${cloned.output}`);
  }
  const fetched = await git(['fetch', '--quiet', '--no-tags', origin, `+refs/heads/${base}:refs/heads/${base}`]);
  if (!fetched.ok) return fail('error', `Could not fetch origin/${base}: ${fetched.output}`);
  if (!(await git(['merge-base', '--is-ancestor', commit, `refs/heads/${base}`])).ok) {
    return fail('error', `${commit.slice(0, 10)} is not on origin/${base}; only main is deployed.`);
  }

  // 2. What changed since the deployed release.
  out.previous = releaseLink(releaseRoot, 'current');
  if (out.previous === commit) return fail('skipped', `${commit.slice(0, 10)} is already the deployed release.`, { reason: 'already_deployed' });
  let paths = null;
  if (out.previous) {
    const diff = await git(['diff', '--name-only', '--no-renames', out.previous, commit]);
    if (diff.ok) paths = diff.stdout.split('\n').filter(Boolean);
  }
  const read = async path => { const shown = await git(['show', `${commit}:${path}`]); return shown.ok ? shown.stdout : null; };
  out.plan = planDeploy(paths, await runnerFiles(read));
  if (!out.plan.deploy) return fail('skipped', 'Only docs, tests or client builds changed; nothing on the server.', { reason: 'nothing_to_deploy' });

  // 3. Wait for an idle companion, bounded. After the bound the release goes ahead; stopping marks a running reply
  // INTERRUPTED (the unit's TimeoutStopSec), as a manual release would.
  out.idle = activityFile
    ? await waitUntil(() => idle(activityFile), { timeoutMs: idleWaitMs, intervalMs: idleIntervalMs, ...(sleep ? { sleep } : {}), now })
    : { ok: true, waitedMs: 0 };

  // 4. The release tool: backup, switch, restart the companion, health check, and its own recovery on failure.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? dirname(releaseRoot), LANG: 'C.UTF-8',
    COMPANION_RELEASE_ROOT: releaseRoot, COMPANION_RELEASE_REPO: repo, COMPANION_DATA_DIR: dataDir, COMPANION_SYSTEMCTL: systemctl,
    ...(healthUrl ? { COMPANION_HEALTH_URL: healthUrl } : {}) };
  const step = await exec(node, [releaseTool, 'release', commit], { env, timeout: releaseTimeoutMs });
  if (step.ok) {
    let receipt = null;
    try { receipt = JSON.parse(step.stdout.split('\n').at(-1)); } catch { /* checked below */ }
    if (receipt?.current !== commit) return fail('failed', `The release tool finished but current is ${receipt?.current ?? 'unknown'}, not ${commit.slice(0, 10)}:\n${step.output}`);
    return { ...out, status: 'deployed', release: { current: receipt.current, previous: receipt.previous ?? null, backup: receipt.backup ?? null }, output: tail(step.output) };
  }
  const code = releaseError(step.output);
  if (code === 'HEALTH') return fail('rolled_back', `The companion failed its health check on ${commit.slice(0, 10)}; the release tool put ${out.previous?.slice(0, 10) ?? 'the previous release'} back.\n${step.output}`, { errorCode: code });
  if (code === 'RECOVERY') return fail('recovery_failed', `The health check failed and putting the previous release back failed too: the companion may be down.\n${step.output}`, { errorCode: code });
  return fail('failed', `The release tool refused or failed (${code ?? (step.timedOut ? 'timed out' : `exit ${step.code}`)}); the previous release is kept.\n${step.output}`, { errorCode: code });
}
