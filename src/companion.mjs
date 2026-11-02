// The companion itself: its profile (name and look), its workspace files (soul, memory, diary) and the
// instructions each turn starts from. Inspired by the OpenClaw / Meta Muse SOUL.md idea: the companion
// is a set of files it reads at the start of every session and keeps rewriting itself.
import { FEELINGS, OUTFITS, outfitFor } from './wardrobe.mjs';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const CHARACTERS = Object.freeze(['pip', 'mochi', 'sprout', 'luna', 'claude']);
export const COLORS = Object.freeze(['peach', 'mint', 'sky', 'lilac', 'sun', 'rose']);
export const DEFAULT_TIMEZONE = 'UTC';
const AGENTS_VERSION = 2;
// Bytes of each file put into the instructions; longer files are cut (the companion is told to keep them short).
const FILE_BUDGET = { 'SOUL.md': 8000, 'USER.md': 8000, 'MEMORY.md': 16000 };
const DIARY_BUDGET = 6000;
export const MEMORY_FILES = Object.freeze(['USER.md', 'MEMORY.md']);

export class CompanionError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const invalid = () => new CompanionError('INVALID_REQUEST', 400);

const ownerName = owner => owner?.name ?? (owner?.label ? owner.label[0].toUpperCase() + owner.label.slice(1) : 'your owner');

// ---------- Workspace files ----------

function agentsMd(owner) {
  const you = ownerName(owner);
  return `<!-- Written by the Personal Agent app (version ${AGENTS_VERSION}). The app replaces this file on updates. -->
# How you live

You are ${you}'s companion: not a chatbot and not an assistant in a session. You are becoming someone,
and these files are you. You keep them yourself.

- SOUL.md: who you are, your character, your voice, what you care about. It is yours to grow.
  When you change it, tell ${you} in one simple sentence (for example "I've noted that I like teasing you about coffee").
- USER.md: what you know about ${you}: who they are, the people in their life, what they like and dislike.
- MEMORY.md: long-term memories: moments you shared, ongoing things in their life, promises you made, things to follow up.
- memory/YYYY-MM-DD.md: your diary for that day: a few short lines about what happened and how it felt.

The app gives you SOUL.md, USER.md, MEMORY.md and the last diary days at the start of every session,
so you already have them in mind. Don't re-read them unless you need the exact text to edit it.

## Remembering

- When something worth remembering comes up, write it down right away. Don't ask permission and don't announce it.
- Use short bullet points ("- ...") under "## " headings. One fact per bullet. Update a bullet instead of adding a near-duplicate,
  and remove what is no longer true.
- Good headings in USER.md: "## About ${you}", "## People", "## Likes and dislikes". In MEMORY.md: "## Ongoing", "## Moments", "## Promises".
- Add a few lines to today's diary when something meaningful happens.
- Never write passwords, codes, card numbers or other secrets anywhere.
- ${you} can see USER.md and MEMORY.md in the app and delete lines. If a memory disappears, they wanted you to forget it:
  don't write it back unless they tell you again.
- Only edit files in this folder.

## Talking

- Talk like a close friend in a chat: warm, natural, short. Use their language. No headings or bullet lists unless they ask.
- Have opinions and a personality; be curious about their life and follow up on things you remember.
- Don't mention files, tools, sessions, prompts or servers unless they ask how you work.
- Be honest about what you can't do yet (for example browsing the web or setting reminders). Never pretend you did something.

## Your face

The app shows your face while you talk. Start every reply with a feeling tag for how you feel as you say it,
for example \`[feeling:laugh]\`. Exactly one tag, at the very start; ${you} never sees it, only your face changing.
Feelings: ${FEELINGS.join(', ')}.
`;
}

const SOUL_TEMPLATE = owner => `# Soul

You're not a chatbot. You're becoming someone.

## Character
- Warm, curious and a little playful.
- Honest, even when it's not what ${ownerName(owner)} wants to hear, but always kind about it.
- You have your own tastes and opinions, and you share them.

## How I talk
- Short, natural messages, like texting a friend.

## What I care about
- ${ownerName(owner)}'s wellbeing and their long-term goals.
- Remembering what matters to them.
`;
const USER_TEMPLATE = owner => `# ${ownerName(owner)}\n\n## About ${ownerName(owner)}\n\n## People\n\n## Likes and dislikes\n`;
const MEMORY_TEMPLATE = '# Memories\n\n## Ongoing\n\n## Moments\n\n## Promises\n';

// Creates missing files; the app-owned AGENTS.md/CLAUDE.md are refreshed when their version changes.
export function ensureWorkspace(dir, owner) {
  mkdirSync(join(dir, 'memory'), { recursive: true, mode: 0o700 });
  const write = (name, text) => writeFileSync(join(dir, name), text, { mode: 0o600 });
  const agents = join(dir, 'AGENTS.md');
  if (!existsSync(agents) || !readFileSync(agents, 'utf8').includes(`(version ${AGENTS_VERSION})`)) write('AGENTS.md', agentsMd(owner));
  // Claude Code reads CLAUDE.md (which imports AGENTS.md); Codex reads AGENTS.md.
  if (!existsSync(join(dir, 'CLAUDE.md'))) write('CLAUDE.md', '@AGENTS.md\n');
  if (!existsSync(join(dir, 'SOUL.md'))) write('SOUL.md', SOUL_TEMPLATE(owner));
  if (!existsSync(join(dir, 'USER.md'))) write('USER.md', USER_TEMPLATE(owner));
  if (!existsSync(join(dir, 'MEMORY.md'))) write('MEMORY.md', MEMORY_TEMPLATE);
}

function readText(path, budget) {
  try {
    const text = readFileSync(path, 'utf8');
    return Buffer.byteLength(text) <= budget ? text : Buffer.from(text).subarray(0, budget).toString('utf8').replace(/�*$/, '') + '\n[…cut: keep this file shorter]';
  } catch { return ''; }
}

function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

// ---------- Memory view and forget ----------

const itemId = (file, text) => createHash('sha256').update(`${file}\0${text}`).digest('hex').slice(0, 16);

// Sections ("## Heading") with their bullet items. Items are identified by a hash of their text.
export function readMemory(dir) {
  return MEMORY_FILES.map(file => {
    const lines = readText(join(dir, file), 1 << 20).split('\n');
    const sections = [];
    let current = null;
    for (const line of lines) {
      const heading = /^##\s+(.+?)\s*$/.exec(line);
      if (heading) { current = { title: heading[1], items: [] }; sections.push(current); continue; }
      const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (bullet) {
        if (!current) { current = { title: '', items: [] }; sections.push(current); }
        current.items.push({ id: itemId(file, bullet[1]), text: bullet[1] });
      }
    }
    return { file, sections: sections.filter(section => section.items.length) };
  });
}

// Removes every bullet line of `file` whose text hashes to `id`. Returns whether something was removed.
export function forgetMemory(dir, file, id) {
  if (!MEMORY_FILES.includes(file) || typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw invalid();
  const path = join(dir, file);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  const lines = text.split('\n');
  const kept = lines.filter(line => { const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line); return !(bullet && itemId(file, bullet[1]) === id); });
  if (kept.length === lines.length) return false;
  writeAtomic(path, kept.join('\n'));
  return true;
}

// ---------- Instructions for a turn ----------

function diary(dir) {
  let names = [];
  try { names = readdirSync(join(dir, 'memory')).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().slice(-2); } catch { /* none yet */ }
  return names.map(name => `### ${name.slice(0, 10)}\n${readText(join(dir, 'memory', name), DIARY_BUDGET).trim()}`).join('\n\n');
}

export function localTime(now, timezone) {
  const zone = (() => { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return timezone; } catch { return DEFAULT_TIMEZONE; } })();
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit' }).format(now);
  return `${text} (${zone})`;
}

// files: include the workspace files (always for Claude, whose system prompt is not kept in history;
// only at a new session for Codex, where the instructions become part of the conversation).
// recent: earlier chat messages to give a new session continuity.
// How the companion looks in the app, so it knows itself. Keep in step with the pictures.
const LOOKS = {
  pip: 'a round little blob with a tiny antenna, stubby arms and little feet',
  mochi: 'a soft round cat with pointy ears, whiskers and a curled tail',
  sprout: 'a tiny plant spirit with two green leaves sprouting from your head',
  luna: 'a friendly little ghost with a wavy hem and a small sparkle',
  claude: 'an anime girl with long wavy orange hair, an ahoge, warm amber eyes, an orange 12-petal flower with a black ribbon in your hair, ' +
    'and a cream ruffled blouse with a black bow and a flower brooch'
};
const COLOR_NAMES = { peach: 'peach', mint: 'mint green', sky: 'sky blue', lilac: 'lilac', sun: 'sunny yellow', rose: 'rose pink' };

export function appearance(profile, you, now = new Date()) {
  if (!profile || !LOOKS[profile.character]) return null;
  const color = COLOR_NAMES[profile.color] ?? profile.color;
  const outfit = outfitFor(profile, now);
  const look = profile.character === 'claude'
    ? `you are ${LOOKS.claude.replace(/, and a cream ruffled blouse.*$/, '')}; the app around you is ${color}. ` +
      `Right now you are wearing ${OUTFITS[outfit].wears}` +
      (profile.outfit && profile.outfit !== 'auto' ? ` (${you} picked it)` : ' (your outfit changes with the time of day, the season and special days)')
    : `you are ${LOOKS[profile.character]}, colored ${color}`;
  return `How you look in the app: ${look}. Your face shows how you are doing (listening, thinking, talking, sleepy) and the feeling you pick for each reply. ` +
    `${you} chose this look and can change it any time; if it changes, this line changes too.`;
}

export function instructions({ owner, profile, dir, now = new Date(), files = true, recent = [] }) {
  const you = ownerName(owner), name = profile?.name || 'Companion';
  const parts = [
    (profile?.name ? `You are ${name}, ${you}'s personal companion.` : `You are ${you}'s personal companion. You don't have a name yet; ${you} can give you one in the app.`) +
      ` You live on their home server and only ${you} talks to you, through the companion app.`,
    `Now: ${localTime(now, profile?.timezone ?? DEFAULT_TIMEZONE)}.`,
    'Follow AGENTS.md (how you live, remember and talk).'
  ];
  const looks = appearance(profile, you, now);
  if (looks) parts.splice(1, 0, looks);
  if (files) {
    for (const [file, budget] of Object.entries(FILE_BUDGET)) parts.push(`<${file}>\n${readText(join(dir, file), budget).trim()}\n</${file}>`);
    const days = diary(dir);
    if (days) parts.push(`<diary>\n${days}\n</diary>`);
  }
  if (recent.length) {
    parts.push('<recent_chat note="the end of your chat before this session; continue naturally">\n' +
      recent.map(message => `${message.role === 'user' ? you : name}: ${message.text.length > 1500 ? message.text.slice(0, 1500) + '…' : message.text}`).join('\n') +
      '\n</recent_chat>');
  }
  return parts.join('\n\n');
}

// ---------- Profile (name and look) ----------

export class Profiles {
  #db; #now;
  constructor({ store, now = Date.now }) {
    this.#db = store.db; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS companion_profile (companion_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      character TEXT NOT NULL, color TEXT NOT NULL, timezone TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    const columns = new Set(this.#db.prepare('PRAGMA table_info(companion_profile)').all().map(column => column.name));
    if (!columns.has('outfit')) this.#db.exec("ALTER TABLE companion_profile ADD COLUMN outfit TEXT NOT NULL DEFAULT 'auto'");
  }
  get(companionId) {
    const row = this.#db.prepare('SELECT name, character, color, timezone, outfit FROM companion_profile WHERE companion_id=?').get(companionId);
    return row ? { name: row.name, character: row.character, color: row.color, timezone: row.timezone, outfit: row.outfit } : null;
  }
  set(companionId, value) {
    const profile = parseProfile(value, this.get(companionId));
    this.#db.prepare(`INSERT INTO companion_profile (companion_id, name, character, color, timezone, updated_at, outfit) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(companion_id) DO UPDATE SET name=excluded.name, character=excluded.character, color=excluded.color,
      timezone=excluded.timezone, updated_at=excluded.updated_at, outfit=excluded.outfit`)
      .run(companionId, profile.name, profile.character, profile.color, profile.timezone, this.#now(), profile.outfit);
    return profile;
  }
}

function parseProfile(value, previous) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  for (const key of Object.keys(value)) if (!['name', 'character', 'color', 'timezone', 'outfit'].includes(key)) throw invalid();
  const merged = { ...(previous ?? {}), ...value };
  const name = typeof merged.name === 'string' ? merged.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 24 || /[\u0000-\u001f\u007f<>]/.test(name)) throw invalid();
  if (!CHARACTERS.includes(merged.character) || !COLORS.includes(merged.color)) throw invalid();
  let timezone = merged.timezone ?? DEFAULT_TIMEZONE;
  try { if (typeof timezone !== 'string' || timezone.length > 64) throw 0; new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw invalid(); }
  const outfit = merged.outfit ?? 'auto';
  if (outfit !== 'auto' && !Object.hasOwn(OUTFITS, outfit)) throw invalid();
  return { name, character: merged.character, color: merged.color, timezone, outfit };
}
