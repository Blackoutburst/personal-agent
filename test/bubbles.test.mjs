import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBubbles, MAX_BUBBLES } from '../public/bubbles.mjs';

test('a blank line starts a new bubble; single line breaks stay in one bubble', () => {
  assert.deepEqual(splitBubbles('idk\nits become the norm\n\nso\n\n\n nobody cares ig '), ['idk\nits become the norm', 'so', 'nobody cares ig']);
  assert.deepEqual(splitBubbles('lol'), ['lol']);
  assert.deepEqual(splitBubbles('  \n\n '), []);
  assert.deepEqual(splitBubbles(undefined), []);
  assert.deepEqual(splitBubbles('a\r\n\r\nb'), ['a', 'b']);
});

test('code blocks, and lists or tables split by blank lines, stay in one bubble', () => {
  assert.deepEqual(splitBubbles('try this:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nthen reload'),
    ['try this:', '```js\nconst a = 1;\n\nconst b = 2;\n```', 'then reload']);
  assert.deepEqual(splitBubbles('options:\n\n1. tea\n\n2. coffee\n\n- milk\n\nup to you'), ['options:', '1. tea\n\n2. coffee\n\n- milk', 'up to you']);
  assert.deepEqual(splitBubbles('| a | b |\n|---|---|\n\n| 1 | 2 |'), ['| a | b |\n|---|---|\n\n| 1 | 2 |']);
});

test('past the limit the rest stays in the last bubble', () => {
  const parts = splitBubbles(Array.from({ length: 12 }, (_, i) => `m${i}`).join('\n\n'));
  assert.equal(parts.length, MAX_BUBBLES);
  assert.equal(parts.at(-1), 'm7\n\nm8\n\nm9\n\nm10\n\nm11');
});
