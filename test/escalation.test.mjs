import test from 'node:test';
import assert from 'node:assert/strict';
import { hardLimit, needsYouBatchPrompt, escalationQuestion, AGENT_HARD_LIMITS } from '../src/escalation.mjs';

test('each hard limit is recognised (#74)', () => {
  const cases = { deployment: 'Deploy the site to production', spending: 'Upgrade the plan, it costs $20', deletion: 'Delete the old database',
    credentials: 'Rotate the API key', security: 'Disable the sandbox for this test' };
  for (const [id, text] of Object.entries(cases)) assert.equal(hardLimit(text)?.id, id, text);
});

test('ordinary work is not a hard limit', () => {
  for (const text of ['Fix the flaky test in board-inbox', 'Keep the change small and add tests', 'Rename the helper', '',
    'Delete the old test and the unused helper', 'Count the tokens of each reply', 'Use the design tokens from the theme', 'Delete stale cache entries in memory']) assert.equal(hardLimit(text), null, text);
  assert.equal(hardLimit(null), null);
  for (const text of ['Delete the user accounts', 'delete all backups', 'Store the GitHub token in the config', 'force-push main'])
    assert.notEqual(hardLimit(text), null, text);
  assert.equal(hardLimit({ a: 1 }), null);
});

test('the escalation question names the limit and gives clear choices', () => {
  const q = escalationQuestion(hardLimit('deploy it'), 'coder-1 was asked to: deploy it');
  assert.match(q, /deployment is a hard limit/);
  assert.match(q, /Choices: yes/);
});

test('a batch prompt is one message with numbered items, flags hard limits and carries ids only', () => {
  const prompt = needsYouBatchPrompt([{ id: 'r1', ticket_id: 't1', ticket_number: 12 }, { id: 'r2', ticket_id: 't2', ticket_number: null, hard: 'deployment' }]);
  assert.match(prompt, /2 Board "Needs you" requests/);
  assert.match(prompt, /1\. request r1 on #12/);
  assert.match(prompt, /2\. request r2 on ticket t2 \(HARD LIMIT: deployment/);
  assert.match(prompt, /ONE short message/);
  assert.match(prompt, /resolve_human_request/);
  assert.match(AGENT_HARD_LIMITS, /BLOCKED/);
});
