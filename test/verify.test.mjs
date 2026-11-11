import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMap, featureMarkdown, validateSteps, runSteps, VERIFY_HOME } from '../ops/verify/verify.mjs';

const map = loadMap();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const router = readFileSync(new URL('../public/companion-app.mjs', import.meta.url), 'utf8');

test('#78: the feature map lists real screens, files and routes', () => {
  assert.ok(map.features.length >= 8);
  assert.equal(new Set(map.features.map(f => f.id)).size, map.features.length, 'unique ids');
  for (const f of map.features) {
    for (const key of ['id', 'title', 'hash', 'ready', 'reach']) assert.equal(typeof f[key], 'string', `${f.id}.${key}`);
    for (const file of f.source) assert.ok(existsSync(new URL('../' + file, import.meta.url)), `${f.id}: ${file} exists`);
    // The view the entry waits for exists in the page.
    const view = /#(view-[a-z-]+)/.exec(f.ready)?.[1]; assert.ok(view && html.includes(`id="${view}"`), `${f.id}: ${view} is in index.html`);
    const top = f.hash.split('/')[0];
    assert.ok(['chat', 'calendar', 'me', 'group', 'studio'].includes(top) && router.includes(top === 'me' ? "'me/" : top), `${f.id}: router knows #${f.hash}`);
  }
  for (const s of map.setup.steps) assert.ok(s.do);
});

test('#78: docs/FEATURE-MAP.md is generated from the map and is current', () => {
  assert.equal(readFileSync(new URL('../docs/FEATURE-MAP.md', import.meta.url), 'utf8').trimEnd(), featureMarkdown(map).trimEnd(),
    'run: node ops/verify/verify.mjs map --markdown > docs/FEATURE-MAP.md');
});

test('#78: steps are validated before a browser starts', () => {
  assert.deepEqual(validateSteps([{ do: 'goto', feature: 'chat' }, { do: 'screenshot', name: 'chat' }, { do: 'fill', selector: '#input', value: 'hi' }]), []);
  const bad = validateSteps([{ do: 'goto', feature: 'nope' }, { do: 'dance' }, { do: 'screenshot', name: '../x' }, { do: 'fill', selector: 'a' }]);
  assert.equal(bad.length, 4);
  assert.deepEqual(validateSteps([]), ['steps must be a non-empty array']);
});

test('#78: the real app is driven in a browser and evidence is written', { skip: !existsSync(join(VERIFY_HOME, 'node_modules/playwright-core')) && 'run: node ops/verify/verify.mjs setup' }, async t => {
  const out = mkdtempSync(join(tmpdir(), 'verify-test-')); t.after(() => rmSync(out, { recursive: true, force: true }));
  const record = await runSteps([{ do: 'goto', feature: 'calendar' }, { do: 'expect', selector: '#view-calendar h1', text: 'Calendar' }, { do: 'screenshot', name: 'calendar' },
    { do: 'goto', feature: 'chat' }, { do: 'fill', selector: '#input', value: 'hello' }, { do: 'expect', selector: '#send:not([disabled])' }, { do: 'state', selector: '#input' }], { out });
  assert.equal(record.ok, true, JSON.stringify(record.steps.filter(s => !s.ok)));
  assert.equal(record.screenshots.length, 1);
  assert.match(record.screenshots[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(join(out, '01-calendar.png')) && existsSync(join(out, 'evidence.json')) && existsSync(join(out, 'EVIDENCE.md')));
  assert.equal(record.pageErrors.length, 0);
  // A wrong expectation is reported as a failure, with a failure screenshot, not a pass.
  const bad = await runSteps([{ do: 'goto', feature: 'chat' }, { do: 'expect', selector: '#view-chat h1', text: 'No such text', visible: true }], { out: join(out, 'bad') });
  assert.equal(bad.ok, false);
  assert.ok(existsSync(join(out, 'bad', 'failure.png')));
});
