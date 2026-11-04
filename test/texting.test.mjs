import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';
import { RunnerError } from '../src/runner.mjs';
import { quietWindow, withoutSilence, maybeSilent } from '../src/texting.mjs';
import { finishedBubbles } from '../public/bubbles.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('the wait after a text is shorter when it looks finished and longer for a fragment or a lone file', () => {
  const base = 1000;
  assert.equal(quietWindow('Yes the message sli', { base }), 1000);
  assert.equal(quietWindow('Split', { base }), 2000);
  assert.equal(quietWindow('need to check because', { base }), 2000);
  assert.equal(quietWindow('mais genre,', { base }), 2000);
  assert.equal(quietWindow('Is koko cheating in that game?', { base }), 500);
  assert.equal(quietWindow('That was a really good game.', { base }), 500);
  assert.equal(quietWindow('gg 😂', { base }), 500);
  assert.equal(quietWindow('', { base, files: 1 }), 2000);
  assert.equal(quietWindow('I just got home from work and it was long', { base }), 1000);
});

test('NO_REPLY is never shown, even while it is being written', () => {
  assert.equal(withoutSilence('NO_REPLY'), '');
  assert.equal(withoutSilence('lol\n\nNO_REPLY'), 'lol');
  assert.equal(withoutSilence('no reply needed'), 'no reply needed');
  assert.ok(maybeSilent('NO_') && maybeSilent('NO_REPLY') && !maybeSilent('No way') && !maybeSilent(''));
  assert.equal(finishedBubbles('one\n\ntw'), 'one');
});

// A runner that records each turn and lets the test drive it.
function fixture(t, { gatherMs = 40, texting = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'texting-')), store = new BootstrapStore(dir, ROOT), owner = randomUUID();
  const turns = [], settled = [];
  const runner = { turn: (_id, input) => new Promise((resolve, reject) => {
    const turn = { input, prompt: input.prompt, resolve, aborted: false, emit: event => input.onEvent(event) };
    input.signal?.addEventListener('abort', () => { turn.aborted = true; reject(new RunnerError('CANCELLED')); }, { once: true });
    turns.push(turn);
  }) };
  const conversations = new Conversations({ store, runner, flushMs: 1, gatherMs, texting, systemPrompt: () => 'persona', onSettled: event => settled.push(event) });
  t.after(async () => { for (const turn of turns) turn.resolve({ text: 'late' }); await conversations.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const f = {
    store, conversations, owner, turns, settled,
    thread: null,
    async open() { f.thread = (await conversations.handle(owner, { action: 'createThread', requestId: 'thread-1', title: 'Chat' })).thread.id; },
    send: text => conversations.handle(owner, { action: 'submit', requestId: `req-${++n}`, threadId: f.thread, text }),
    typing: active => conversations.handle(owner, { action: 'typing', threadId: f.thread, active }),
    states: () => store.db.prepare('SELECT state FROM conv_turns WHERE thread_id=? ORDER BY rowid').all(f.thread).map(row => row.state),
    replies: () => store.db.prepare("SELECT text FROM conv_messages WHERE thread_id=? AND role='assistant' ORDER BY created_at, rowid").all(f.thread).map(row => row.text),
    async until(check, label) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(10); } assert.fail('timed out: ' + label); }
  };
  return f;
}

test('while the owner is typing, the reply waits; when they stop, it answers everything at once', async t => {
  const f = fixture(t); await f.open();
  await f.send('ok so');
  await f.typing(true);
  await sleep(200); // far past the fragment wait (80 ms)
  assert.equal(f.turns.length, 0, 'still waiting while they type');
  await f.send('we changed how replies work');
  await f.typing(false);
  await f.until(() => f.turns.length === 1, 'reply starts');
  assert.match(f.turns[0].prompt, /^ok so\nwe changed how replies work/);
  assert.match(f.turns[0].prompt, /2 texts they sent in a row/);
  assert.deepEqual(f.states(), ['merged', 'running']);
  await assert.rejects(() => f.conversations.handle(f.owner, { action: 'typing', threadId: f.thread, active: 'yes' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => f.conversations.handle(randomUUID(), { action: 'typing', threadId: f.thread, active: true }), { code: 'NOT_FOUND' });
});

test('a text sent before anything of the reply was shown restarts it with every text; the draft never appears', async t => {
  const f = fixture(t); await f.open();
  await f.send('Yes the message sli');
  await f.until(() => f.turns.length === 1, 'first draft starts');
  f.turns[0].emit({ type: 'delta', text: 'lol the split got you mid-word' }); // no finished bubble yet
  await sleep(20);
  assert.deepEqual(f.replies(), [], 'a half written bubble is never shown');
  await f.send('Split');
  await f.send('And overall shorter messages from you');
  await f.until(() => f.turns.length === 2, 'restarted');
  assert.equal(f.turns[0].aborted, true);
  assert.match(f.turns[1].prompt, /^Yes the message sli\nSplit\nAnd overall shorter messages from you/);
  assert.match(f.turns[1].prompt, /3 texts they sent in a row/);
  f.turns[1].resolve({ text: 'lol yeah\n\nshorter it is' });
  await f.until(() => f.states().at(-1) === 'complete', 'answered');
  assert.deepEqual(f.states(), ['merged', 'merged', 'complete']);
  assert.deepEqual(f.replies(), ['lol yeah\n\nshorter it is']);
  assert.deepEqual(f.settled.map(event => event.state), ['merged', 'merged', 'complete']);
});

test('finished bubbles show while the reply is written; after one is shown, a new text waits and is a follow-up', async t => {
  const f = fixture(t); await f.open();
  await f.send('how was the game?');
  await f.until(() => f.turns.length === 1, 'reply starts');
  f.turns[0].emit({ type: 'delta', text: 'we won\n\nbarely th' });
  await f.until(() => f.replies()[0] === 'we won', 'first bubble shown');
  await f.send('nice');
  await sleep(100);
  assert.equal(f.turns[0].aborted, false, 'a reply already seen is never restarted');
  f.turns[0].resolve({ text: 'we won\n\nbarely though' });
  await f.until(() => f.turns.length === 2, 'follow-up starts');
  assert.deepEqual(f.replies(), ['we won\n\nbarely though']);
  assert.match(f.turns[1].prompt, /^nice/);
  assert.match(f.turns[1].prompt, /add only what is new/);
  f.turns[1].resolve({ text: 'NO_REPLY' });
  await f.until(() => f.states().at(-1) === 'complete', 'silent follow-up done');
  assert.deepEqual(f.replies(), ['we won\n\nbarely though'], 'NO_REPLY sends nothing');
  assert.deepEqual(f.settled.at(-1), { companionId: f.owner, threadId: f.thread, requestId: 'req-2', state: 'complete', text: '', proactive: false });
});

test('a reply that started acting (a tool call) is never restarted, so no action runs twice', async t => {
  const f = fixture(t); await f.open();
  await f.send('add dinner with mum on friday');
  await f.until(() => f.turns.length === 1, 'reply starts');
  f.turns[0].emit({ type: 'acting' });
  await f.send('at 8');
  await sleep(100);
  assert.equal(f.turns[0].aborted, false);
  assert.equal(f.turns.length, 1);
  f.turns[0].resolve({ text: 'added for friday' });
  await f.until(() => f.turns.length === 2, 'the new text gets its own turn after');
  assert.match(f.turns[1].prompt, /^at 8/);
});

test('without texting, replies stream as before and a running reply is never restarted', async t => {
  const f = fixture(t, { gatherMs: 0, texting: false }); await f.open();
  await f.send('hello');
  await f.until(() => f.turns.length === 1, 'reply starts');
  f.turns[0].emit({ type: 'delta', text: 'hel' });
  await f.until(() => f.replies()[0] === 'hel', 'partial text streams');
  await f.send('there');
  await sleep(50);
  assert.equal(f.turns[0].aborted, false);
  assert.doesNotMatch(f.turns[0].prompt, /App note/);
});
