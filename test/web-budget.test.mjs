import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';
import { WebBudget } from '../src/web-budget.mjs';
import { narrowToolPolicy } from '../src/tool-policy.mjs';
import { parseLine as claudeLine } from '../src/providers/claude.mjs';
import { parseLine as codexLine } from '../src/providers/codex.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const reply = text => ({ text: JSON.stringify({ action: 'message', text }), sessionId: 'native-session' });

test('provider streams report tool calls by name only, so web use can be counted', () => {
  assert.deepEqual(claudeLine(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Looking it up' }, { type: 'tool_use', name: 'WebSearch', input: { query: 'PRIVATE-QUERY' } }] } })),
  [{ type: 'tool', name: 'WebSearch' }]);
  assert.deepEqual(codexLine(JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'PRIVATE-QUERY' } })), [{ type: 'tool', name: 'WebSearch' }]);
  // A search starting only says the companion is acting (no double count); text items are not acting.
  assert.deepEqual(codexLine(JSON.stringify({ type: 'item.started', item: { type: 'web_search' } })), [{ type: 'acting' }]);
  assert.deepEqual(codexLine(JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } })), []);
  assert.deepEqual(claudeLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } } })), [{ type: 'acting' }]);
});

test('owner chat turns use web tools until the daily allowance is spent, then run without them and say so', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'web-budget-')), store = new BootstrapStore(dir, ROOT);
  let now = Date.UTC(2026, 10, 3, 12), calls = [];
  const budget = new WebBudget({ store, now: () => now, daily: 3 });
  const conv = new Conversations({ store, now: () => now, flushMs: 1, webBudget: budget, systemPrompt: () => 'persona',
    runner: { turn: async (companionId, turn) => {
      const policy = narrowToolPolicy({ tools: ['WebSearch', 'WebFetch', 'Read'], board: null }, undefined, [], turn.toolFilter);
      calls.push({ tools: policy.tools, prompt: turn.prompt });
      if (policy.tools.includes('WebSearch')) { turn.onEvent({ type: 'tool', name: 'WebSearch' }); turn.onEvent({ type: 'tool', name: 'WebFetch' }); turn.onEvent({ type: 'tool', name: 'Read' }); }
      return reply('Here is what I found: [source](https://example.com/news).');
    } } });
  t.after(async () => { await conv.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const A = randomUUID(), B = randomUUID(), thread = conv.ongoingThread(A);
  const send = async (owner, threadId, text) => { await conv.handle(owner, { action: 'submit', requestId: 'r-' + randomUUID(), threadId, text }); await conv.idle(); now += 1000; };

  await send(A, thread, 'Any Qwen4 news?');
  assert.deepEqual(calls[0].tools, ['WebSearch', 'WebFetch', 'Read']); assert.equal(budget.used(A), 2, 'Only web tool calls count');
  await send(A, thread, 'And today?');
  assert.equal(budget.used(A), 4); assert.equal(budget.available(A), false);
  await send(A, thread, 'One more?');
  assert.deepEqual(calls[2].tools, ['Read'], 'Web tools are off once the allowance is spent');
  assert.match(calls[2].prompt, /web search allowance for today is used up/);
  assert.ok(!calls[1].prompt.includes('allowance'));

  await send(B, conv.ongoingThread(B), 'Weather news?');
  assert.ok(calls[3].tools.includes('WebSearch'), 'Each owner has their own allowance');
  now += 86_400_000;
  await send(A, thread, 'New day?');
  assert.ok(calls[4].tools.includes('WebSearch'), 'The allowance resets the next day');
});
