#!/usr/bin/env node
// The runner guard (#100, docs/MANAGER.md "Server deploy after a merge"). Installed root-owned as
// /usr/local/lib/cchan-deploy/runner-guard.mjs and started by `sudo -n cchan-deploy guard-runner` in its own transient
// systemd unit (cchan-deploy-guard) as the owner account, never as root. Being outside the runner's unit, it survives
// the runner exiting, which is the point: the runner hands its own restart over to it.
//
// Self-contained on purpose (no imports from the repository): it is the fixed, reviewed copy, not merged code.
//   1. read <stateFile> (written by the runner): { status: 'pending', phase: 'runner_restart', commit, previous, releaseRoot, repo, dataDir }
//   2. sudo -n cchan-deploy restart-runner
//   3. healthy = the new runner process acknowledged the deploy (deploy-ack.json: its commit and pid, written once it
//      listens), the unit is active with that MainPID, and still is after a settle time
//   4. healthy: status 'deployed'. Not healthy: roll back with the previous release's own release tool
//      (`release.mjs rollback`: switches current back, restarts and health-checks the companion), then restart the
//      runner again so it runs the previous code; status 'rolled_back' (or 'rollback_failed').
// The (new or restored) runner reads the final status on startup and reports it (Manager line, ticket thread).
import { readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEPLOY_CLI = '/usr/local/sbin/cchan-deploy';
export const SYSTEMCTL_HELPER = '/usr/local/lib/cchan-deploy/systemctl-deploy';
const SHA = /^[0-9a-f]{40}$/;
const UNIT = 'cchan-agent-runner.service';

function exec(binary, args, { env, timeout = 120_000 } = {}) {
  return new Promise(done => execFile(binary, args, { env, timeout, encoding: 'utf8', maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
    done({ ok: !error, stdout: String(stdout ?? '').trim(), output: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(-8000) })));
}
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
const link = (root, name) => {
  try { const target = resolve(root, readlinkSync(join(root, name))); return dirname(target) === join(resolve(root), 'releases') && SHA.test(basename(target)) ? basename(target) : null; }
  catch { return null; }
};

// stateFile: the runner's deploy.json. sudo/systemctl/node: binaries. exec, sleep, now: injected in tests (a fake systemd).
export async function guardRunner({ stateFile, sudo = '/usr/bin/sudo', systemctl = '/usr/bin/systemctl', node = process.execPath,
  deployCli = DEPLOY_CLI, systemctlHelper = SYSTEMCTL_HELPER, graceMs = 3000, startTimeoutMs = 90_000, settleMs = 20_000, pollMs = 1000,
  run = exec, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, pid = process.pid } = {}) {
  const state = readJson(stateFile);
  if (!state || state.status !== 'pending' || state.phase !== 'runner_restart' || !SHA.test(state.commit ?? '')) return { status: 'nothing' };
  const ack = join(dirname(stateFile), 'deploy-ack.json');
  const save = changes => { Object.assign(state, changes, { updatedAt: now() }); writeJson(stateFile, state); return state; };
  save({ guard: { pid, startedAt: now() } });
  const show = async () => {
    const r = await run(systemctl, ['show', UNIT, '-p', 'ActiveState', '-p', 'MainPID']);
    const values = Object.fromEntries(r.stdout.split('\n').map(line => line.split('=')).filter(pair => pair.length === 2));
    return { active: values.ActiveState === 'active', pid: Number(values.MainPID) || 0 };
  };
  const restart = () => run(sudo, ['-n', deployCli, 'restart-runner']);

  await sleep(graceMs); // let the runner finish writing its report before it is stopped
  const restarted = await restart();
  if (!restarted.ok) {
    // The old runner is still running the old code; the companion is deployed. It sees this status and reports.
    return save({ status: 'runner_restart_failed', endedAt: now(), output: restarted.output });
  }
  let healthy = false, why = 'The new runner did not acknowledge the deploy in time.';
  const until = now() + startTimeoutMs;
  while (now() < until) {
    const up = readJson(ack), unit = await show();
    if (up?.commit === state.commit && unit.active && unit.pid === up.pid) {
      await sleep(settleMs);
      const again = await show();
      if (again.active && again.pid === up.pid) healthy = true;
      else why = `The new runner (pid ${up.pid}) did not stay up (now ${again.active ? `pid ${again.pid}` : 'inactive'}).`;
      break;
    }
    await sleep(pollMs);
  }
  if (healthy) return save({ status: 'deployed', runner: 'healthy', endedAt: now() });

  // Roll back to the previous release with that release's own tool (the owner account, not root).
  save({ status: 'rolling_back', reason: why });
  let status = 'rolled_back', output = '';
  const current = link(state.releaseRoot, 'current'), previous = link(state.releaseRoot, 'previous');
  if (!SHA.test(state.previous ?? '') || current !== state.commit || previous !== state.previous) {
    status = 'rollback_failed';
    output = `The release links changed (current ${current ?? 'none'}, previous ${previous ?? 'none'}); nothing was rolled back.`;
  } else {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/home/ubuntu', LANG: 'C.UTF-8',
      COMPANION_RELEASE_ROOT: state.releaseRoot, COMPANION_RELEASE_REPO: state.repo, COMPANION_DATA_DIR: state.dataDir, COMPANION_SYSTEMCTL: systemctlHelper };
    const r = await run(node, [join(state.releaseRoot, 'releases', state.previous, 'ops', 'release.mjs'), 'rollback'], { env, timeout: 20 * 60_000 });
    output = r.output;
    if (!r.ok) status = 'rollback_failed';
  }
  save({ status, endedAt: now(), output: output.slice(-8000) });
  const again = await restart(); // the runner now starts from the previous code (or retries the same one if nothing moved)
  return save({ runnerRestart: again.ok ? 'requested' : 'failed', ...(again.ok ? {} : { output: `${output}\nRestarting the runner failed: ${again.output}`.slice(-8000) }) });
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const home = process.env.HOME ?? '/home/ubuntu';
  // CCHAN_GUARD_TEST (tests only, a fake systemd): { sudo, systemctl, deployCli, systemctlHelper, graceMs, settleMs, pollMs,
  // startTimeoutMs }. This process runs as the owner account either way; the overrides grant nothing.
  let test = {};
  try { test = process.env.CCHAN_GUARD_TEST ? JSON.parse(process.env.CCHAN_GUARD_TEST) : {}; } catch { test = {}; }
  const pick = Object.fromEntries(['sudo', 'systemctl', 'deployCli', 'systemctlHelper', 'graceMs', 'settleMs', 'pollMs', 'startTimeoutMs']
    .filter(key => test[key] !== undefined).map(key => [key, test[key]]));
  guardRunner({ stateFile: process.env.CCHAN_DEPLOY_STATE ?? join(home, 'personal-agent-data', 'agent-runner', 'deploy.json'), ...pick })
    .then(result => { process.stdout.write(`${JSON.stringify({ status: result.status })}\n`); })
    .catch(error => { process.stderr.write(`runner guard failed: ${error.message}\n`); process.exitCode = 1; });
}
