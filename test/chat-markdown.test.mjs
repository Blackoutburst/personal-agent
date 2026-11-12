import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../public/group-ui.mjs';

// #95: 1:1 chat bubbles showed literal backticks (web and desktop alike) because companion-app.mjs had its own
// bold/italic/links-only renderer; only group chat used renderMarkdown.
const source = readFileSync(new URL('../public/companion-app.mjs', import.meta.url), 'utf8');

test('1:1 chat bubbles render through the shared markdown renderer', () => {
  assert.match(source, /import \{[^}]*renderMarkdown[^}]*\} from '\.\/group-ui\.mjs'/);
  assert.match(source, /function textWithLinks\(container, text\) \{ container\.replaceChildren\(\.\.\.renderMarkdown\(document, text\)\); \}/);
  assert.doesNotMatch(source, /function linkify\(/, 'no second, reduced renderer');
});

class El {
  constructor(tag) { this.tag = tag; this.children = []; }
  append(...c) { this.children.push(...c); }
  set textContent(v) { this.children = [String(v)]; }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
}
const doc = { createElement: tag => new El(tag), createTextNode: t => t };
const find = (n, tag) => typeof n === 'string' ? [] : [n, ...n.children.flatMap(c => find(c, tag))].filter(x => x.tag === tag);

test('inline code, code blocks, bold/italic and external links render', () => {
  const blocks = renderMarkdown(doc, 'use `npm test` and **bold** *it* [x](https://example.com)\n```\nlet a = `b`;\n```');
  const all = { tag: 'root', children: blocks };
  assert.deepEqual(find(all, 'code').map(c => c.textContent), ['npm test', 'let a = `b`;']);
  assert.equal(find(all, 'pre').length, 1);
  assert.equal(find(all, 'strong')[0].textContent, 'bold');
  assert.equal(find(all, 'em')[0].textContent, 'it');
  const link = find(all, 'a')[0];
  assert.equal(link.href, 'https://example.com/'); assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
});
