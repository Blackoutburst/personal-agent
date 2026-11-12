// The desktop release step of the runner's merge path (#90, docs/MANAGER.md). After agents_merge merged a branch, passed
// the full suite and pushed main, the runner (owner-side, the same account as the push; config.release.desktop) releases
// the Windows desktop app from exactly that merge commit, without a model:
//   1. clone origin, check the merge commit is on origin/<base>, check it out detached
//   2. gate: desktop/package.json's version must be higher than on the merge's first parent (the main it was merged
//      into) and higher than the version the server serves (<dataDir>/downloads/desktop.json). Otherwise: nothing.
//   3. build: scripts/build-desktop.sh in that clone (a scrubbed environment: PATH, a runner-owned HOME, no agent socket)
//   4. publish: scripts/publish-desktop.sh into <dataDir>/downloads (installed apps update from there, #89)
//   5. check the server now serves that version with the built installer's sha256
// A failed build touches nothing that is served. A failed publish (or a check that does not hold) puts latest.yml and
// desktop.json back as they were and removes the installer files it added, so the previous version stays served.
// Main is never changed here.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './agent-merge.mjs';

export const DEFAULT_BUILD = Object.freeze(['bash', 'scripts/build-desktop.sh']);
export const DEFAULT_PUBLISH = Object.freeze(['bash', 'scripts/publish-desktop.sh']);
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const FEED = ['latest.yml', 'desktop.json']; // what installed apps and the download page read
const TAIL = 8000;
const tail = value => String(value ?? '').slice(-TAIL);

// Plain x.y.z versions (what desktop/package.json uses). Returns -1/0/1, or null when either one is not x.y.z.
export function compareVersions(a, b) {
  const pa = VERSION.exec(String(a ?? '')), pb = VERSION.exec(String(b ?? ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// The version the server serves now (what installed apps compare against), or null when nothing is published.
export function servedDesktopVersion(dataDir) {
  try {
    const info = JSON.parse(readFileSync(join(dataDir, 'downloads', 'desktop.json'), 'utf8'));
    return typeof info?.version === 'string' ? info.version : null;
  } catch { return null; }
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

const versionOf = text => { try { const v = JSON.parse(text)?.version; return typeof v === 'string' ? v : null; } catch { return null; } };

// origin: Git URL or path (config.merge.origin). commit: the merge commit agents_merge pushed. dataDir: the companion's
// data dir (COMPANION_DATA_DIR). home: HOME for the build (npm/Electron caches); default a throw-away one.
// Returns { status: 'published' | 'skipped' | 'build_failed' | 'publish_failed' | 'error', reason?, version, previous,
// served, sha256?, file?, commit, output }.
export async function releaseDesktop({ origin, commit, base = 'main', dataDir, buildCommand = DEFAULT_BUILD, publishCommand = DEFAULT_PUBLISH,
  home = null, tmp = tmpdir(), buildTimeoutMs = 60 * 60_000, publishTimeoutMs = 10 * 60_000, gitTimeoutMs = 120_000 } = {}) {
  const base0 = { commit: commit ?? null, version: null, previous: null, served: null };
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return { ...base0, status: 'error', output: 'commit: the full merge commit id is needed.' };
  if (typeof dataDir !== 'string' || !dataDir) return { ...base0, status: 'error', output: 'dataDir: the companion data dir is needed (config.release.dataDir).' };
  if (!Array.isArray(buildCommand) || !buildCommand.length || !Array.isArray(publishCommand) || !publishCommand.length) {
    return { ...base0, status: 'error', output: 'buildCommand and publishCommand must be non-empty argv arrays.' };
  }
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, 'cchan-release-'));
  const work = join(dir, 'work');
  const git = (args, cwd = work) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout: gitTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const out = { ...base0 };
  const fail = (status, output, extra = {}) => ({ ...out, status, output: tail(output), ...extra });
  try {
    let step = await git(['clone', '--quiet', '--no-checkout', '--no-tags', '--branch', base, origin, work], dir);
    if (!step.ok) return fail('error', `Could not clone origin: ${step.output}`);
    if (!(await git(['merge-base', '--is-ancestor', commit, 'HEAD'])).ok) return fail('error', `${commit.slice(0, 10)} is not on origin/${base}; nothing is released from anything but main.`);
    step = await git(['checkout', '--quiet', '--detach', commit]);
    if (step.ok && (await git(['rev-parse', 'HEAD'])).output !== commit) step = { ok: false, output: 'HEAD is not the merge commit' };
    if (!step.ok) return fail('error', `Could not check out ${commit.slice(0, 10)}: ${step.output}`);

    // The gate. Read from the commit objects, not the working tree.
    const now = await git(['show', `${commit}:desktop/package.json`]);
    if (!now.ok) return fail('skipped', 'No desktop/package.json on this commit.', { reason: 'no_desktop' });
    out.version = versionOf(now.stdout);
    const before = await git(['show', `${commit}^1:desktop/package.json`]);
    out.previous = before.ok ? versionOf(before.stdout) : null;
    out.served = servedDesktopVersion(dataDir);
    if (out.version === out.previous) return fail('skipped', `desktop/package.json stays at ${out.version}.`, { reason: 'no_bump' });
    if (compareVersions(out.version, '0.0.0') === null) return fail('error', `desktop/package.json's version ${JSON.stringify(out.version)} is not x.y.z.`);
    if (out.previous !== null && compareVersions(out.version, out.previous) !== 1) {
      return fail('skipped', `desktop/package.json went from ${out.previous} to ${out.version}, which is not higher.`, { reason: 'not_higher' });
    }
    if (out.served !== null && compareVersions(out.version, out.served) !== 1) {
      return fail('skipped', `The server already serves ${out.served}, not lower than ${out.version}.`, { reason: 'not_higher' });
    }

    // Build, in the clone of exactly that commit. A scrubbed environment: no owner tokens or agent sockets from ours.
    const buildHome = home ?? join(dir, 'home');
    mkdirSync(buildHome, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: buildHome, LANG: 'C.UTF-8', CI: '1', ...(process.env.NPM_CLI ? { NPM_CLI: process.env.NPM_CLI } : {}) };
    step = await run(buildCommand[0], buildCommand.slice(1), { cwd: work, env, timeout: buildTimeoutMs });
    const buildOutput = step.output;
    if (!step.ok) return fail('build_failed', `${buildCommand.join(' ')} failed${step.timedOut ? ' (timed out)' : ` (exit ${step.code})`}:\n${step.output}`);
    const file = `Companion-Setup-${out.version}-x64.exe`;
    const built = join(work, 'desktop', 'dist', file);
    if (!existsSync(built)) return fail('build_failed', `The build finished but desktop/dist/${file} is missing:\n${buildOutput}`);
    const sha256 = await sha256File(built);
    out.sha256 = sha256; out.file = file;

    // Publish. Keep what is served now so a failure can put it back.
    const downloads = join(dataDir, 'downloads');
    mkdirSync(downloads, { recursive: true });
    const saved = Object.fromEntries(FEED.map(name => [name, existsSync(join(downloads, name)) ? readFileSync(join(downloads, name)) : null]));
    const added = [file, `${file}.blockmap`].filter(name => !existsSync(join(downloads, name)));
    const restore = () => {
      for (const [name, content] of Object.entries(saved)) {
        const target = join(downloads, name);
        if (content === null) rmSync(target, { force: true });
        else { writeFileSync(`${target}.restore`, content); renameSync(`${target}.restore`, target); }
      }
      for (const name of added) rmSync(join(downloads, name), { force: true });
    };
    step = await run(publishCommand[0], publishCommand.slice(1), { cwd: work, env: { ...env, COMPANION_DATA_DIR: dataDir }, timeout: publishTimeoutMs });
    let problem = step.ok ? null : `${publishCommand.join(' ')} failed${step.timedOut ? ' (timed out)' : ` (exit ${step.code})`}:\n${step.output}`;
    if (!problem) {
      const served = servedDesktopVersion(dataDir);
      let servedSha = null;
      try { servedSha = await sha256File(join(downloads, file)); } catch { /* checked below */ }
      if (served !== out.version) problem = `After publishing, the server serves ${served ?? 'nothing'} instead of ${out.version}.`;
      else if (servedSha !== sha256) problem = `After publishing, downloads/${file} does not match the built installer (sha256 ${servedSha ?? 'missing'}).`;
    }
    if (problem) {
      try { restore(); } catch (error) { problem += `\nPutting the previous feed back failed too: ${error.message}. Check ${downloads}/desktop.json and latest.yml.`; }
      return fail('publish_failed', problem);
    }
    return { ...out, status: 'published', output: tail(`${buildOutput}\n${step.output}`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
