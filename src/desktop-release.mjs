// The desktop release step of the runner's merge path (#90, #91, docs/MANAGER.md). After agents_merge merged a branch,
// passed the full suite and pushed main, the runner (config.release.desktop) releases the Windows desktop app from
// exactly that merge commit, without a model:
//   1. clone origin (owner, git only), check the merge commit is on origin/<base>
//   2. gate: desktop/package.json's version must be x.y.z and higher than on the merge's first parent (the main it was
//      merged into) and higher than the version the server serves (<dataDir>/downloads/desktop.json). Otherwise nothing.
//      A first parent or a served version that is not x.y.z is not comparable: it is left out of the gate, with a note
//      (the server serves nothing for a non-x.y.z desktop.json, src/desktop-http.mjs), so it never blocks later releases.
//   3. build, in the agent sandbox: the sandbox user makes its own copy of the merge commit (a git bundle on stdin, as
//      the merge's test copy, src/agent-merge.mjs) and runs scripts/build-desktop.sh there through the same
//      cchan-sandbox-run wrapper as the tests. The merged code (the build script, npm install and its install scripts,
//      electron-builder) never runs as the owner.
//   4. the installer, its blockmap and latest.yml come out of the sandbox as bytes on stdout of `cat` run as the sandbox
//      user (the owner never opens a path the sandbox controls, so a planted symlink cannot make it read its own files),
//      into the owner's private temp dir. latest.yml must name the version and the installer's sha512.
//   5. publish: runner code (publishDesktop below), never the merged scripts/publish-desktop.sh. The installer and
//      blockmap are copied into <dataDir>/downloads; latest.yml and desktop.json, the pair clients read, are staged in a
//      new directory and swapped in together with one rename (see the feed layout below). Then the served files are
//      checked against the build (sha256 and sha512); if anything does not hold, the previous pair is swapped back in
//      one rename and the installer files this release added are removed.
// Main is never changed here.
//
// Feed layout (pair-atomic): downloads/latest.yml -> .feed/current/latest.yml and downloads/desktop.json ->
// .feed/current/desktop.json are fixed symlinks; .feed/current -> <feed id> is the one symlink that changes. Replacing
// it with rename(2) switches both files at the same instant, so a reader never sees a new latest.yml with an old
// desktop.json or the other way round, and a crash leaves either the old or the new pair. A downloads folder with
// plain files (a hand publish with scripts/publish-desktop.sh) is first converted: its current pair is copied into a
// feed directory and the plain files are replaced by the symlinks, same content, before anything new is published.
// The previous feed directory is kept (for the swap back); older ones are removed after a good publish.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { run, sandboxCopyScript } from './agent-merge.mjs';

export const DEFAULT_BUILD = Object.freeze(['bash', 'scripts/build-desktop.sh']);
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const FEED = ['latest.yml', 'desktop.json']; // what installed apps and the download page read
const FEED_DIR = '.feed';
const TAIL = 8000;
const tail = value => String(value ?? '').slice(-TAIL);
const COPY = sandboxCopyScript('cchan-release-build');

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

// The version desktop.json names now (whatever it is), or null when nothing is published.
export function servedDesktopVersion(dataDir) {
  try {
    const info = JSON.parse(readFileSync(join(dataDir, 'downloads', 'desktop.json'), 'utf8'));
    return typeof info?.version === 'string' ? info.version : null;
  } catch { return null; }
}

function hashFile(path, algorithm, encoding = 'hex') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest(encoding)));
  });
}

const versionOf = text => { try { const v = JSON.parse(text)?.version; return typeof v === 'string' ? v : null; } catch { return null; } };

// The few fields of electron-builder's latest.yml the release checks: version, path, the top-level sha512, and the
// files list (url, sha512, size). A line parser, not YAML: the file comes out of the build and is only read here.
export function parseLatestYml(text) {
  const unquote = value => value.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  const out = { version: null, path: null, sha512: null, files: [] };
  let file = null;
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^(version|path|sha512):\s*(.*)$/.exec(line))) { out[m[1]] = unquote(m[2]); file = null; continue; }
    if ((m = /^\s+-\s+url:\s*(.*)$/.exec(line))) { file = { url: unquote(m[1]), sha512: null, size: null }; out.files.push(file); continue; }
    if (file && (m = /^\s+(sha512|size):\s*(.*)$/.exec(line))) { file[m[1]] = m[1] === 'size' ? Number(unquote(m[2])) : unquote(m[2]); continue; }
    if (/^\S/.test(line)) file = null;
  }
  return out;
}

// Checks the build's latest.yml against the installer it built. Returns a problem or null.
export function checkLatestYml(text, { version, file, sha512, size }) {
  const yml = parseLatestYml(text);
  if (yml.version !== version) return `latest.yml names version ${yml.version ?? 'none'}, not ${version}.`;
  if (yml.path !== null && yml.path !== file) return `latest.yml's path is ${yml.path}, not ${file}.`;
  const entry = yml.files.find(item => item.url === file);
  if (!entry && yml.path === null) return `latest.yml does not list ${file}.`;
  const listed = [yml.sha512, entry?.sha512].filter(value => value !== null && value !== undefined);
  if (!listed.length) return `latest.yml has no sha512 for ${file}.`;
  if (listed.some(value => value !== sha512)) return `latest.yml's sha512 for ${file} does not match the built installer (${sha512}).`;
  if (entry?.size !== null && entry?.size !== undefined && entry.size !== size) return `latest.yml's size for ${file} is ${entry.size}, the installer has ${size} bytes.`;
  return null;
}

// Runs argv with stdout streamed into `outFile` (bytes, not text), at most maxBytes. Returns { ok, code, output (stderr) }.
function runToFile(argv, outFile, { cwd, env, timeout, maxBytes }) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(outFile, { mode: 0o600 });
    let bytes = 0, stderr = '', why = null, code = null, outDone = false, exited = false;
    const finish = () => { if (outDone && exited) resolve({ ok: !why && code === 0, code, output: tail(`${why ? `${why}\n` : ''}${stderr}`).trim() }); };
    const timer = setTimeout(() => { why = 'timed out'; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { if (!why) { why = `more than ${maxBytes} bytes`; child.kill('SIGKILL'); } return; }
      if (!out.write(chunk)) { child.stdout.pause(); out.once('drain', () => child.stdout.resume()); }
    });
    child.stdout.on('end', () => out.end());
    out.on('close', () => { outDone = true; finish(); });
    out.on('error', error => { why = why ?? `writing ${outFile}: ${error.message}`; outDone = true; child.kill('SIGKILL'); finish(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-TAIL); });
    child.on('error', error => { why = why ?? error.message; clearTimeout(timer); exited = true; out.end(); finish(); });
    child.on('close', exitCode => { clearTimeout(timer); code = exitCode; exited = true; finish(); });
  });
}

// ---------- The feed (runner code; see the layout above) ----------

const link = name => join(FEED_DIR, 'current', name);
const tmpName = prefix => `${prefix}.tmp-${randomBytes(6).toString('hex')}`;
function isSymlink(path) { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

// Points .feed/current at `id` with one rename.
function pointFeed(downloads, id) {
  const root = join(downloads, FEED_DIR), temp = join(root, tmpName('current'));
  symlinkSync(id, temp);
  renameSync(temp, join(root, 'current'));
}

// Makes sure latest.yml and desktop.json are the fixed symlinks into .feed/current; converts plain files (or a mix)
// by copying what is served now into a feed directory first. Returns the feed id now current.
export function ensureFeedLayout(downloads) {
  const root = join(downloads, FEED_DIR);
  mkdirSync(root, { recursive: true });
  const current = join(root, 'current');
  const linked = FEED.every(name => isSymlink(join(downloads, name)) && readlinkSync(join(downloads, name)) === link(name));
  if (linked && isSymlink(current)) {
    const id = readlinkSync(current);
    if (!id.includes('/') && statSync(join(root, id), { throwIfNoEntry: false })?.isDirectory()) return id;
  }
  // Snapshot what readers see now (following any symlinks), make it current, then put the symlinks in place: every
  // step serves the same content as before.
  const snapshot = mkdtempSync(join(root, 'served-'));
  for (const name of FEED) {
    let content = null;
    try { content = readFileSync(join(downloads, name)); } catch { /* not published */ }
    if (content !== null) writeFileSync(join(snapshot, name), content);
  }
  pointFeed(downloads, basename(snapshot));
  for (const name of FEED) {
    const temp = join(downloads, tmpName(name));
    symlinkSync(link(name), temp);
    renameSync(temp, join(downloads, name));
  }
  return basename(snapshot);
}

// Publishes a verified build into downloads. artifacts: { installer, blockmap, latest } (paths in the runner's own temp
// dir). Returns { ok: true } or { ok: false, problem }. fault(stage) is a test seam: it may throw at 'copied', 'staged',
// 'swapped' to show what a failure at that moment leaves served.
export async function publishDesktop({ downloads, version, file, artifacts, sha256, sha512, fault = () => {} }) {
  mkdirSync(downloads, { recursive: true });
  const root = join(downloads, FEED_DIR);
  const added = [];
  let previous = null, staged = null, swapped = false;
  try {
    previous = ensureFeedLayout(downloads);
    // The installer files first, each under a temp name then renamed, so the final name never holds half a file.
    for (const [name, from] of [[file, artifacts.installer], [`${file}.blockmap`, artifacts.blockmap]]) {
      const target = join(downloads, name), temp = join(downloads, tmpName(name));
      const existed = existsSync(target);
      copyFileSync(from, temp);
      renameSync(temp, target);
      if (!existed) added.push(name);
    }
    fault('copied');
    staged = mkdtempSync(join(root, `v${version}-`));
    copyFileSync(artifacts.latest, join(staged, 'latest.yml'));
    writeFileSync(join(staged, 'desktop.json'), `${JSON.stringify({ version, file })}\n`);
    fault('staged');
    pointFeed(downloads, basename(staged));
    swapped = true;
    fault('swapped');
    // Check what readers now get, through the same paths the server reads.
    let info = null;
    try { info = JSON.parse(readFileSync(join(downloads, 'desktop.json'), 'utf8')); } catch { /* checked below */ }
    if (info?.version !== version || info?.file !== file) throw new Error(`After publishing, desktop.json names ${info?.version ?? 'nothing'} (${info?.file ?? 'no file'}) instead of ${version} (${file}).`);
    const got256 = await hashFile(join(downloads, file), 'sha256').catch(() => null);
    const got512 = await hashFile(join(downloads, file), 'sha512', 'base64').catch(() => null);
    if (got256 !== sha256 || got512 !== sha512) throw new Error(`After publishing, downloads/${file} does not match the built installer (sha256 ${got256 ?? 'missing'}).`);
    const servedYml = readFileSync(join(downloads, 'latest.yml'), 'utf8');
    const ymlProblem = checkLatestYml(servedYml, { version, file, sha512: got512, size: statSync(join(downloads, file)).size });
    if (ymlProblem) throw new Error(`After publishing, the served ${ymlProblem}`);
    const blockmapSha = await hashFile(join(downloads, `${file}.blockmap`), 'sha256').catch(() => null);
    if (blockmapSha !== await hashFile(artifacts.blockmap, 'sha256')) throw new Error(`After publishing, downloads/${file}.blockmap does not match the build.`);
  } catch (error) {
    let problem = error.message;
    try {
      if (swapped) pointFeed(downloads, previous);
      if (staged) rmSync(staged, { recursive: true, force: true });
      for (const name of added) rmSync(join(downloads, name), { force: true });
    } catch (restoreError) {
      problem += `\nPutting the previous feed back failed too: ${restoreError.message}. Check ${downloads}/.feed/current (it should point at ${previous}).`;
    }
    return { ok: false, problem };
  }
  // Keep the new feed and the one before it; remove older feed directories and stray temp links.
  for (const name of readdirSync(root)) {
    if (name === 'current' || name === basename(staged) || name === previous) continue;
    try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* left behind */ }
  }
  return { ok: true };
}

// ---------- The release ----------

// origin: Git URL or path (config.merge.origin). commit: the merge commit agents_merge pushed. dataDir: the companion's
// data dir (COMPANION_DATA_DIR). sandbox: (command, { cwd, timeoutMs }) => argv, wraps a command to run in the agent
// sandbox (SandboxOps.releaseDesktop); sandboxDir: where the sandbox user makes its build copy (required with sandbox).
// Without a sandbox (tests on temp repos) the build runs directly in a separate copy with a scrubbed environment and
// `home` (default a throw-away one) as HOME.
// Returns { status: 'published' | 'skipped' | 'build_failed' | 'publish_failed' | 'error', reason?, version, previous,
// served, sha256?, sha512?, file?, notes, commit, output }.
export async function releaseDesktop({ origin, commit, base = 'main', dataDir, buildCommand = DEFAULT_BUILD, sandbox = null, sandboxDir = null,
  home = null, tmp = tmpdir(), buildTimeoutMs = 60 * 60_000, fetchTimeoutMs = 10 * 60_000, gitTimeoutMs = 120_000,
  maxArtifactBytes = 2 * 1024 ** 3, fault } = {}) {
  const base0 = { commit: commit ?? null, version: null, previous: null, served: null, notes: [] };
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return { ...base0, status: 'error', output: 'commit: the full merge commit id is needed.' };
  if (typeof dataDir !== 'string' || !dataDir) return { ...base0, status: 'error', output: 'dataDir: the companion data dir is needed (config.release.dataDir).' };
  if (!Array.isArray(buildCommand) || !buildCommand.length || !buildCommand.every(word => typeof word === 'string')) {
    return { ...base0, status: 'error', output: 'buildCommand must be a non-empty argv array.' };
  }
  if (sandbox && !(typeof sandboxDir === 'string' && isAbsolute(sandboxDir))) return { ...base0, status: 'error', output: 'sandboxDir: an absolute path is needed with sandbox.' };
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, 'cchan-release-'));
  const work = join(dir, 'work');
  const git = (args, cwd = work) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout: gitTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const out = { ...base0, notes: [] };
  const fail = (status, output, extra = {}) => ({ ...out, status, output: tail(output), ...extra });
  const inSandbox = (command, { cwd, timeout, input } = {}) => {
    const [binary, ...args] = sandbox(command, { cwd, timeoutMs: timeout });
    return run(binary, args, { env: process.env, timeout: timeout + 10_000, input });
  };
  let buildDir = null;
  try {
    let step = await git(['clone', '--quiet', '--no-checkout', '--no-tags', '--branch', base, origin, work], dir);
    if (!step.ok) return fail('error', `Could not clone origin: ${step.output}`);
    if (!(await git(['merge-base', '--is-ancestor', commit, 'HEAD'])).ok) return fail('error', `${commit.slice(0, 10)} is not on origin/${base}; nothing is released from anything but main.`);

    // The gate. Read from the commit objects; the owner never checks out or runs the merged tree.
    const now = await git(['show', `${commit}:desktop/package.json`]);
    if (!now.ok) return fail('skipped', 'No desktop/package.json on this commit.', { reason: 'no_desktop' });
    out.version = versionOf(now.stdout);
    const before = await git(['show', `${commit}^1:desktop/package.json`]);
    out.previous = before.ok ? versionOf(before.stdout) : null;
    out.served = servedDesktopVersion(dataDir);
    if (out.version === out.previous) return fail('skipped', `desktop/package.json stays at ${out.version}.`, { reason: 'no_bump' });
    if (compareVersions(out.version, '0.0.0') === null) return fail('error', `desktop/package.json's version ${JSON.stringify(out.version)} is not x.y.z.`);
    if (out.previous !== null && compareVersions(out.previous, '0.0.0') === null) {
      out.notes.push(`The version before this merge (${JSON.stringify(out.previous)}) is not x.y.z; only the served version was compared.`);
    } else if (out.previous !== null && compareVersions(out.version, out.previous) !== 1) {
      return fail('skipped', `desktop/package.json went from ${out.previous} to ${out.version}, which is not higher.`, { reason: 'not_higher' });
    }
    if (out.served !== null && compareVersions(out.served, '0.0.0') === null) {
      out.notes.push(`downloads/desktop.json named ${JSON.stringify(out.served)}, which is not x.y.z (the server served nothing); it was replaced.`);
    } else if (out.served !== null && compareVersions(out.version, out.served) !== 1) {
      return fail('skipped', `The server already serves ${out.served}, not lower than ${out.version}.`, { reason: 'not_higher' });
    }

    // The build copy: with a sandbox, made by the sandbox user in its own root from a bundle of the commit; without one,
    // a separate --no-hardlinks clone (tests).
    step = await git(['update-ref', 'refs/heads/cchan-release', commit]);
    if (!step.ok) return fail('error', `Could not prepare the build copy: ${step.output}`);
    if (sandbox) {
      const bundle = join(dir, 'release.bundle');
      step = await git(['bundle', 'create', '--quiet', bundle, 'refs/heads/cchan-release']);
      if (step.ok) step = await inSandbox(['sh', '-c', COPY, 'sh', sandboxDir, commit], { cwd: dirname(sandboxDir), timeout: gitTimeoutMs, input: bundle });
      const made = step.ok ? step.stdout.split('\n').at(-1) : '';
      if (step.ok && !(dirname(made) === sandboxDir && /^cchan-release-build-[A-Za-z0-9]{8}$/.test(basename(made)))) {
        step = { ok: false, output: `the sandbox answered ${JSON.stringify(made.slice(0, 200))}` };
      }
      if (!step.ok) return fail('error', `Could not prepare the build copy in the sandbox: ${step.output}`);
      buildDir = made;
    } else {
      buildDir = mkdtempSync(join(tmp, 'cchan-release-build-'));
      step = await git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--no-tags', work, join(buildDir, 'repo')], buildDir);
      if (step.ok) step = await git(['checkout', '--quiet', '--detach', commit], join(buildDir, 'repo'));
      if (!step.ok) return fail('error', `Could not prepare the build copy: ${step.output}`);
    }
    const copy = join(buildDir, 'repo');
    const buildHome = home ?? join(dir, 'home');
    if (!sandbox) mkdirSync(buildHome, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: buildHome, LANG: 'C.UTF-8', CI: '1', ...(process.env.NPM_CLI ? { NPM_CLI: process.env.NPM_CLI } : {}) };
    const exec = (command, timeout) => sandbox ? inSandbox(command, { cwd: copy, timeout }) : run(command[0], command.slice(1), { cwd: copy, env, timeout });

    // Build (merged code: sandboxed).
    step = await exec(buildCommand, buildTimeoutMs);
    const buildOutput = step.output;
    if (!step.ok) return fail('build_failed', `${buildCommand.join(' ')} failed${step.timedOut ? ' (timed out)' : ` (exit ${step.code})`}:\n${step.output}`);

    // The artifacts, as bytes from `cat` run where the build ran (as the sandbox user with a sandbox).
    const file = `Companion-Setup-${out.version}-x64.exe`;
    const artifacts = { installer: join(dir, 'installer'), blockmap: join(dir, 'blockmap'), latest: join(dir, 'latest.yml') };
    for (const [key, name] of [['installer', file], ['blockmap', `${file}.blockmap`], ['latest', 'latest.yml']]) {
      const cat = ['cat', '--', `desktop/dist/${name}`];
      const argv = sandbox ? sandbox(cat, { cwd: copy, timeoutMs: fetchTimeoutMs }) : cat;
      step = await runToFile(argv, artifacts[key], { cwd: sandbox ? undefined : copy, env: sandbox ? process.env : env, timeout: fetchTimeoutMs + 10_000, maxBytes: maxArtifactBytes });
      if (!step.ok) return fail('build_failed', `The build finished but desktop/dist/${name} could not be read: ${step.output || `exit ${step.code}`}\n${buildOutput}`);
    }
    const size = statSync(artifacts.installer).size;
    if (!size) return fail('build_failed', `The build finished but desktop/dist/${file} is empty.\n${buildOutput}`);
    out.file = file;
    out.sha256 = await hashFile(artifacts.installer, 'sha256');
    out.sha512 = await hashFile(artifacts.installer, 'sha512', 'base64');
    const ymlProblem = checkLatestYml(readFileSync(artifacts.latest, 'utf8'), { version: out.version, file, sha512: out.sha512, size });
    if (ymlProblem) return fail('build_failed', `The build's ${ymlProblem}\n${buildOutput}`);

    // Publish: runner code only.
    const published = await publishDesktop({ downloads: join(dataDir, 'downloads'), version: out.version, file, artifacts, sha256: out.sha256, sha512: out.sha512, fault });
    if (!published.ok) return fail('publish_failed', published.problem);
    return { ...out, status: 'published', output: tail(`${buildOutput}\nPublished ${file} (sha256 ${out.sha256}) with latest.yml and desktop.json to ${join(dataDir, 'downloads')}.`) };
  } finally {
    if (buildDir) {
      if (sandbox) await inSandbox(['rm', '-rf', '--', buildDir], { cwd: dirname(sandboxDir), timeout: 120_000 }).catch(() => {});
      else rmSync(buildDir, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
