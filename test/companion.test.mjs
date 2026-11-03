import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspace, readMemory, forgetMemory, instructions, appearance, Profiles, localTime } from '../src/companion.mjs';
import { BootstrapStore } from '../src/store.mjs';

const OWNER = { label: 'blackout', provider: 'claude' };
function dir(t) { const d = mkdtempSync(join(tmpdir(), 'companion-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('the workspace starts from templates and keeps what the companion wrote', t => {
  const d = dir(t);
  ensureWorkspace(d, OWNER);
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) assert.ok(existsSync(join(d, file)), file);
  assert.ok(existsSync(join(d, 'memory')));
  assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(readFileSync(join(d, 'SOUL.md'), 'utf8'), /You're not a chatbot\. You're becoming someone\./);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /Blackout's companion/);
  writeFileSync(join(d, 'SOUL.md'), '# Soul\n\n- I love puns.\n');
  writeFileSync(join(d, 'AGENTS.md'), 'stale (version 0)');
  ensureWorkspace(d, OWNER);
  assert.equal(readFileSync(join(d, 'SOUL.md'), 'utf8'), '# Soul\n\n- I love puns.\n');
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /How you live/);
});

test('memory is shown by section and a forgotten line is removed from the file only', t => {
  const d = dir(t);
  ensureWorkspace(d, OWNER);
  writeFileSync(join(d, 'USER.md'), '# Blackout\n\n## About Blackout\n- Lives in Lyon\n- Drinks too much coffee\n\n## People\n- Sister: Emma\n');
  writeFileSync(join(d, 'MEMORY.md'), '# Memories\n\n## Ongoing\n\n## Moments\n* Finished the board v2 together\n');
  const [user, memory] = readMemory(d);
  assert.equal(user.file, 'USER.md');
  assert.deepEqual(user.sections.map(s => [s.title, s.items.map(i => i.text)]), [['About Blackout', ['Lives in Lyon', 'Drinks too much coffee']], ['People', ['Sister: Emma']]]);
  assert.deepEqual(memory.sections.map(s => s.title), ['Moments']); // empty sections are hidden
  const coffee = user.sections[0].items[1];
  assert.equal(forgetMemory(d, 'USER.md', coffee.id), true);
  assert.equal(readFileSync(join(d, 'USER.md'), 'utf8'), '# Blackout\n\n## About Blackout\n- Lives in Lyon\n\n## People\n- Sister: Emma\n');
  assert.equal(forgetMemory(d, 'USER.md', coffee.id), false);
  for (const [file, id] of [['SOUL.md', coffee.id], ['../x', coffee.id], ['USER.md', 'nope']]) assert.throws(() => forgetMemory(d, file, id), { code: 'INVALID_REQUEST' });
});

test('instructions carry the files, the time, the name and recent chat', t => {
  const d = dir(t);
  ensureWorkspace(d, OWNER);
  writeFileSync(join(d, 'USER.md'), '## About Blackout\n- Lives in Lyon\n');
  mkdirSync(join(d, 'memory'), { recursive: true });
  for (const day of ['2026-10-30', '2026-11-01', '2026-11-02']) writeFileSync(join(d, 'memory', `${day}.md`), `- diary ${day}\n`);
  const now = new Date('2026-11-02T13:00:00Z');
  const full = instructions({ owner: OWNER, profile: { name: 'Nova', timezone: 'Europe/Paris' }, dir: d, now,
    recent: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello you' }] });
  assert.match(full, /^You are Nova, Blackout's personal companion\./);
  assert.match(full, /Monday 2 November 2026 at 14:00 \(Europe\/Paris\)|Monday, 2 November 2026 at 14:00 \(Europe\/Paris\)|Monday 2 November 2026, 14:00 \(Europe\/Paris\)/);
  assert.match(full, /<USER\.md>\n## About Blackout\n- Lives in Lyon\n<\/USER\.md>/);
  assert.match(full, /You're becoming someone/);
  assert.ok(full.includes('diary 2026-11-01') && full.includes('diary 2026-11-02') && !full.includes('diary 2026-10-30'));
  assert.match(full, /Blackout: hi\nNova: hello you/);
  const short = instructions({ owner: OWNER, profile: null, dir: d, now, files: false });
  assert.match(short, /don't have a name yet/);
  assert.ok(!short.includes('<USER.md>') && !short.includes('<recent_chat'));
  assert.match(localTime(now, 'Not/AZone'), /\(UTC\)$/);
});

test('profiles validate name, character, color and timezone', t => {
  const d = dir(t), store = new BootstrapStore(join(d, 'data'), process.cwd());
  t.after(() => store.close());
  const profiles = new Profiles({ store, now: () => 1 });
  assert.equal(profiles.get('c1'), null);
  assert.deepEqual(profiles.set('c1', { name: '  Nova   Star ', character: 'mochi', color: 'mint', timezone: 'Europe/Paris' }),
    { name: 'Nova Star', character: 'mochi', color: 'mint', timezone: 'Europe/Paris', outfit: 'auto' });
  assert.deepEqual(profiles.set('c1', { color: 'sky' }).color, 'sky');
  assert.equal(profiles.set('c1', { character: 'claude', outfit: 'halloween' }).outfit, 'halloween');
  assert.equal(profiles.get('c1').outfit, 'halloween');
  assert.throws(() => profiles.set('c1', { outfit: 'tuxedo' }));
  profiles.set('c1', { character: 'mochi', outfit: 'auto' });
  assert.equal(profiles.get('c1').name, 'Nova Star');
  for (const bad of [{ name: '' }, { name: 'x'.repeat(25) }, { name: '<b>' }, { character: 'dragon' }, { color: 'black' },
    { timezone: 'Mars/Base' }, { admin: true }, null, []]) assert.throws(() => profiles.set('c1', bad), { code: 'INVALID_REQUEST' });
  assert.throws(() => profiles.set('c2', { name: 'Solo' }), { code: 'INVALID_REQUEST' }); // a first profile needs a look
  assert.equal(profiles.get('c2'), null);
});

test('the companion knows how it looks, and the line follows its look', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-look-'));
  try {
    const owner = { name: 'Blackout' };
    ensureWorkspace(dir, owner);
    const cat = instructions({ owner, dir, profile: { name: 'Miso', character: 'mochi', color: 'mint', timezone: 'UTC' } });
    assert.match(cat, /How you look in the app: you are a soft round cat .*colored mint green\./);
    const girl = instructions({ owner, dir, profile: { name: 'Claude', character: 'claude', color: 'peach', timezone: 'UTC' } });
    assert.match(girl, /anime girl with long wavy orange hair/);
    assert.match(girl, /the app around you is peach/);
    assert.match(girl, /Right now you are wearing .*changes with the time of day/);
    const witch = instructions({ owner, dir, now: new Date('2026-10-31T12:00:00Z'), profile: { name: 'Claude', character: 'claude', color: 'peach', timezone: 'UTC' } });
    assert.match(witch, /wearing a cute witch outfit/);
    const pinned = instructions({ owner, dir, profile: { name: 'Claude', character: 'claude', color: 'peach', timezone: 'UTC', outfit: 'rain' } });
    assert.match(pinned, /yellow raincoat.*\(Blackout picked it\)/);
    assert.doesNotMatch(cat, /wearing/);
    assert.doesNotMatch(girl, /soft round cat/);
    assert.equal(appearance(null, 'Blackout'), null);
    assert.doesNotMatch(instructions({ owner, dir, profile: null }), /How you look/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude companions get AGENTS.md and their folder in the prompt; Codex reads AGENTS.md itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-prompt-'));
  try {
    const claude = { label: 'blackout', provider: 'claude' }, codex = { label: 'screamer', provider: 'codex' };
    ensureWorkspace(dir, claude);
    const prompt = instructions({ owner: claude, dir, profile: null });
    assert.match(prompt, /<AGENTS\.md>\n# How you live/);
    assert.match(prompt, /## Talking[\s\S]*Never sound like a service/);
    assert.ok(prompt.includes(`Your own folder is ${dir}.`));
    assert.doesNotMatch(prompt, /<!-- Written by/);
    assert.doesNotMatch(instructions({ owner: codex, dir, profile: null }), /<AGENTS\.md>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the drawn characters describe their own look and outfits, and every picture is shipped', async () => {
  const look = appearance;
  const july = new Date('2026-07-01T12:00:00Z');
  const astra = look({ character: 'astra', color: 'lilac', outfit: 'base' }, 'Your owner', july);
  assert.match(astra, /dragon horns/); assert.match(astra, /qipao top with lavender trims \(Your owner picked it\)/);
  assert.match(look({ character: 'gemini', color: 'sky', outfit: 'pajamas' }, 'Your owner', july), /pajamas in your colors/);
  assert.doesNotMatch(look({ character: 'deepseek', color: 'sky', outfit: 'pajamas' }, 'Your owner', july), /orange/);
  assert.match(look({ character: 'claude', color: 'peach', outfit: 'pajamas' }, 'Your owner', july), /pastel orange pajamas/);
  const { OUTFITS: outfits } = await import('../public/companion-character.mjs');
  for (const id of ['claude', 'astra', 'gemini', 'deepseek']) for (const root of ['public', 'android/app/src/main/assets']) {
    for (const [outfit] of outfits) {
      assert.ok(existsSync(new URL(`../${root}/characters/${id}/outfits/${outfit}.webp`, import.meta.url)), `${root} ${id} ${outfit}`);
      if (outfit !== 'base') assert.ok(existsSync(new URL(`../${root}/characters/${id}/fronts/${outfit}.webp`, import.meta.url)));
    }
    for (const face of ['blink', 'talk', 'listening', 'thinking', 'happy', 'sleepy', 'love', 'pout'])
      assert.ok(existsSync(new URL(`../${root}/characters/${id}/faces/${face}.webp`, import.meta.url)), `${root} ${id} ${face}`);
  }
});
