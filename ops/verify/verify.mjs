#!/usr/bin/env node
// Verification tool for agents (#78): run the REAL companion web app in a headless browser, operate it and leave
// evidence (screenshots, page state, console errors, a hashed manifest). "Compiles" and "tests pass" are not proof
// that a change works; this is. See docs/VERIFICATION.md.
//
//   verify.mjs setup                       install playwright-core and a headless Chromium (once per host/sandbox)
//   verify.mjs map [--json|--markdown]     the feature map
//   verify.mjs shot <feature>... [--out DIR] [--viewport WxH]
//   verify.mjs run <steps.json> [--out DIR] [--viewport WxH] [--no-setup]
//   verify.mjs check-map [--out DIR]       visit every mapped feature and check it really shows
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
export const MAP_FILE = join(HERE, 'feature-map.json');
// Tool install: node_modules for ops/verify/package.json and the browser binaries, outside any worktree.
export const VERIFY_HOME = process.env.VERIFY_HOME || '/var/lib/cchan-agents/verify';
const ACTIONS = new Set(['goto', 'click', 'fill', 'press', 'wait', 'expect', 'state', 'screenshot']);

export const loadMap = (file = MAP_FILE) => JSON.parse(readFileSync(file, 'utf8'));

export function featureMarkdown(map = loadMap()) {
  const rows = map.features.map(f => `| \`${f.id}\` | ${f.title} | \`#${f.hash}\` | ${f.reach} | \`${f.ready}\` |`);
  return ['# Feature map', '', 'Generated from `ops/verify/feature-map.json` by `node ops/verify/verify.mjs map --markdown`. Do not edit by hand.', '',
    map.note, '', `**First run:** ${map.setup.why} The tool runs the \`${map.setup.id}\` setup (${map.setup.title}) before any feature.`, '',
    '| Id | Screen | Hash | How to reach it | Visible when |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}

// A steps file is an array of {do: goto|click|fill|press|wait|expect|state|screenshot, ...}. Returns the list of problems.
export function validateSteps(steps, map = loadMap()) {
  const problems = [];
  if (!Array.isArray(steps) || !steps.length) return ['steps must be a non-empty array'];
  const ids = new Set(map.features.map(f => f.id));
  steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!s || !ACTIONS.has(s.do)) return problems.push(`${at}: "do" must be one of ${[...ACTIONS].join(', ')}`);
    if (s.do === 'goto' && !(s.feature ? ids.has(s.feature) : typeof s.hash === 'string')) problems.push(`${at}: goto needs a known "feature" or a "hash"`);
    if (['click', 'fill'].includes(s.do) && !(s.selector || s.text)) problems.push(`${at}: ${s.do} needs "selector" or "text"`);
    if (s.do === 'fill' && typeof s.value !== 'string') problems.push(`${at}: fill needs a string "value"`);
    if (s.do === 'press' && typeof s.key !== 'string') problems.push(`${at}: press needs a "key"`);
    if (s.do === 'expect' && !s.selector && s.url === undefined) problems.push(`${at}: expect needs "selector" or "url"`);
    if (s.do === 'screenshot' && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(s.name ?? '')) problems.push(`${at}: screenshot needs a "name" of lowercase letters, digits and dashes`);
  });
  return problems;
}

function playwright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(VERIFY_HOME, 'pw');
  try { return createRequire(join(VERIFY_HOME, 'package.json'))('playwright-core'); }
  catch { throw new Error(`playwright-core not found in ${VERIFY_HOME}; run: node ops/verify/verify.mjs setup`); }
}

function setup() {
  mkdirSync(VERIFY_HOME, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(VERIFY_HOME, f), readFileSync(join(HERE, f)));
  // The sandbox's node ships without npm's own modules on the default path; Debian's copy lives here.
  const env = { ...process.env, NODE_PATH: [process.env.NODE_PATH, '/usr/share/nodejs'].filter(Boolean).join(':'), PLAYWRIGHT_BROWSERS_PATH: join(VERIFY_HOME, 'pw') };
  let r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: VERIFY_HOME, env, stdio: 'inherit' });
  if (r.status) throw new Error('npm ci failed');
  r = spawnSync(process.execPath, [join(VERIFY_HOME, 'node_modules/playwright-core/cli.js'), 'install', 'chromium-headless-shell'], { cwd: VERIFY_HOME, env, stdio: 'inherit' });
  if (r.status) throw new Error('browser download failed');
  console.log(JSON.stringify({ ok: true, home: VERIFY_HOME }));
}

// The real server, in account mode with one synthetic owner (no real account service, no credentials, no runtime:
// the model is not called). Data lives in a throwaway directory.
async function startApp() {
  const { startServer } = await import(join(ROOT, 'server.mjs'));
  const dataDir = mkdtempSync(join(tmpdir(), 'verify-app-'));
  const principal = { issuer: 'https://synthetic.invalid', subject: 'verify-owner' };
  const app = await startServer({ dataDir, port: 0, mode: 'account', pilotSubjects: [principal], validateAccount: async () => principal });
  return { app, close: async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';

// Runs steps against the real app. Returns the evidence record; never throws on a failed expectation.
export async function runSteps(steps, { out, viewport = { width: 420, height: 860 }, setup = true, map = loadMap() } = {}) {
  const problems = validateSteps(steps, map);
  if (problems.length) throw new Error('Invalid steps:\n' + problems.join('\n'));
  mkdirSync(out, { recursive: true });
  const { chromium } = playwright();
  const { app, close } = await startApp();
  const browser = await chromium.launch({ headless: true });
  const record = { tool: 'ops/verify/verify.mjs', startedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', '.', ...(out.startsWith(ROOT + '/') ? [`:(exclude)${out.slice(ROOT.length + 1)}`] : [])) !== '',
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'), viewport, steps: [], screenshots: [], consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
  try {
    const context = await browser.newContext({ viewport });
    await context.setExtraHTTPHeaders({ Cookie: '__Secure-blackout_session=' + 'v'.repeat(43) });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') record.consoleErrors.push(m.text()); });
    page.on('pageerror', e => record.pageErrors.push(String(e.message ?? e)));
    page.on('response', r => { if (r.status() >= 400) record.failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    const base = app.url.replace(/\/$/, '') + '/';
    const view = () => page.evaluate(() => document.getElementById('app')?.dataset.view ?? null);
    const loc = s => s.selector ? page.locator(s.selector).first() : page.getByText(s.text, { exact: false }).first();
    const timeout = 8000;
    let shots = 0;
    const exec = async (s, label) => {
      const entry = { do: s.do, ...(label ? { phase: label } : {}), ...s };
      const hash = s.feature ? map.features.find(f => f.id === s.feature).hash : s.hash;
      try {
        if (s.do === 'goto') {
          await page.goto(base + (hash ? '#' + hash : '')); if (hash) await page.evaluate(() => dispatchEvent(new HashChangeEvent('hashchange')));
          const ready = s.feature ? map.features.find(f => f.id === s.feature).ready : null;
          if (ready) await page.locator(ready).first().waitFor({ state: 'visible', timeout });
          else await page.waitForFunction(() => document.getElementById('app')?.dataset.view !== 'loading', null, { timeout });
        } else if (s.do === 'click') await loc(s).click({ timeout });
        else if (s.do === 'fill') await loc(s).fill(s.value, { timeout });
        else if (s.do === 'press') await page.keyboard.press(s.key);
        else if (s.do === 'wait') { if (s.selector) await page.locator(s.selector).first().waitFor({ state: 'visible', timeout: s.timeout ?? timeout }); else await page.waitForTimeout(Math.min(s.ms ?? 500, 5000)); }
        else if (s.do === 'expect') {
          if (s.url !== undefined) { const u = page.url(); if (!u.includes(s.url)) throw new Error(`url ${u} does not contain ${s.url}`); }
          if (s.selector) {
            const el = page.locator(s.selector).first();
            if (s.visible === false) await el.waitFor({ state: 'hidden', timeout }); else await el.waitFor({ state: 'visible', timeout });
            if (s.text !== undefined) { const t = (await el.innerText()).trim(); if (!t.includes(s.text)) throw new Error(`"${s.selector}" text ${JSON.stringify(t.slice(0, 120))} does not contain ${JSON.stringify(s.text)}`); }
          }
        } else if (s.do === 'state') {
          entry.result = { view: await view(), url: page.url().replace(base, '/'), title: await page.title(),
            ...(s.selector ? { selector: s.selector, text: (await page.locator(s.selector).first().innerText({ timeout }).catch(() => null)), count: await page.locator(s.selector).count() } : { text: (await page.locator('main').innerText().catch(() => '')).slice(0, 1500) }) };
        } else if (s.do === 'screenshot') {
          const file = join(out, `${String(++shots).padStart(2, '0')}-${s.name}.png`);
          await page.screenshot({ path: file, fullPage: s.fullPage === true });
          record.screenshots.push({ name: s.name, file, view: await view(), url: page.url().replace(base, '/'), sha256: sha(file) });
        }
        entry.ok = true;
      } catch (error) { entry.ok = false; entry.error = String(error.message ?? error).split('\n')[0]; record.ok = false; }
      record.steps.push(entry);
      return entry.ok;
    };
    if (setup) for (const s of map.setup.steps) if (!await exec(s, 'setup')) break;
    if (record.ok) for (const s of steps) if (!await exec(s) && s.continueOnError !== true) break;
    if (!record.ok) { const file = join(out, 'failure.png'); await page.screenshot({ path: file }).catch(() => {}); if (existsSync(file)) record.screenshots.push({ name: 'failure', file, sha256: sha(file) }); }
  } finally { await browser.close(); await close(); }
  record.finishedAt = new Date().toISOString();
  for (const s of record.screenshots) s.file = s.file.startsWith(out) ? s.file.slice(out.length + 1) : s.file;
  writeFileSync(join(out, 'evidence.json'), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(join(out, 'EVIDENCE.md'), evidenceMarkdown(record));
  return record;
}

export function evidenceMarkdown(r) {
  const lines = [`# Runtime evidence: ${r.ok ? 'PASS' : 'FAIL'}`, '',
    `- Commit \`${r.commit.slice(0, 12)}\` on \`${r.branch}\`${r.dirty ? ' (uncommitted changes present when run)' : ''}`,
    `- Ran the real server (account mode, synthetic owner) in headless Chromium, viewport ${r.viewport.width}x${r.viewport.height}`,
    `- ${r.startedAt} to ${r.finishedAt}`,
    `- Console errors: ${r.consoleErrors.length}, page errors: ${r.pageErrors.length}, failed requests (HTTP >= 400): ${r.failedRequests.length}`, '', '## Steps', ''];
  r.steps.forEach((s, i) => {
    const what = [s.feature && `feature ${s.feature}`, s.hash !== undefined && s.feature === undefined && `#${s.hash}`, s.selector, s.text && `text "${s.text}"`, s.value && `value "${s.value}"`, s.name, s.key].filter(Boolean).join(' ');
    lines.push(`${i + 1}. ${s.ok ? 'ok' : 'FAILED'} ${s.phase ? '[' + s.phase + '] ' : ''}${s.do} ${what}${s.error ? ` : ${s.error}` : ''}`);
    if (s.result) lines.push('   ```json', '   ' + JSON.stringify(s.result).slice(0, 600), '   ```');
  });
  lines.push('', '## Screenshots', '', ...r.screenshots.map(s => `- \`${s.file}\` (view \`${s.view ?? '?'}\`, ${s.url ?? ''}) sha256 \`${s.sha256.slice(0, 16)}\``));
  for (const [title, list] of [['Console errors', r.consoleErrors], ['Page errors', r.pageErrors], ['Failed requests', r.failedRequests]]) if (list.length) lines.push('', `## ${title}`, '', ...list.map(x => `- ${x}`));
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--viewport') { const m = /^(\d{2,4})x(\d{2,4})$/.exec(argv[++i] ?? ''); if (!m) throw new Error('--viewport WxH'); opts.viewport = { width: +m[1], height: +m[2] }; }
    else if (a === '--no-setup') opts.setup = false;
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
  return opts;
}

async function main(argv) {
  const [cmd, ...rest] = argv, o = parseArgs(rest);
  const out = o.out ?? resolve('verify-evidence', new Date().toISOString().replace(/[:.]/g, '-'));
  const finish = record => { console.log(JSON.stringify({ ok: record.ok, out, screenshots: record.screenshots.map(s => s.file), consoleErrors: record.consoleErrors.length, pageErrors: record.pageErrors.length, failedRequests: record.failedRequests, failed: record.steps.filter(s => !s.ok).map(s => s.error) }, null, 2)); process.exitCode = record.ok ? 0 : 1; };
  if (cmd === 'setup') return setup();
  if (cmd === 'map') { const map = loadMap(); return console.log(o.json ? JSON.stringify(map, null, 2) : featureMarkdown(map)); }
  if (cmd === 'shot') {
    if (!o._.length) throw new Error('usage: verify.mjs shot <feature>...');
    return finish(await runSteps(o._.flatMap(id => [{ do: 'goto', feature: id }, { do: 'screenshot', name: id }]), { out, viewport: o.viewport, setup: o.setup }));
  }
  if (cmd === 'run') {
    if (!o._[0]) throw new Error('usage: verify.mjs run <steps.json>');
    return finish(await runSteps(JSON.parse(readFileSync(o._[0], 'utf8')), { out, viewport: o.viewport, setup: o.setup }));
  }
  if (cmd === 'check-map') {
    return finish(await runSteps(loadMap().features.flatMap(f => [{ do: 'goto', feature: f.id }, { do: 'screenshot', name: f.id }]), { out, viewport: o.viewport }));
  }
  console.error('usage: verify.mjs setup | map [--json] | shot <feature>... | run <steps.json> | check-map   (options: --out DIR --viewport WxH --no-setup)');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 2; });
