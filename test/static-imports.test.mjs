import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// Every module the browser loads from public/ must be in server.mjs's static allowlist, or the whole app fails to
// start (a missing import rejects companion-app.mjs). Regression test for board-ui.mjs in #55.
test('every module imported by the web app is served by the static allowlist', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const served = new Set([...server.matchAll(/\['(\/[^']+)', \['([^']+)'/g)].map(match => match[1]));
  const seen = new Set(), queue = ['companion-app.mjs'];
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/src="\.?\/?([A-Za-z0-9._-]+\.m?js)"/g)) queue.push(match[1]);
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const path = new URL('../public/' + file, import.meta.url);
    assert.ok(existsSync(path), `public/${file} exists`);
    for (const match of readFileSync(path, 'utf8').matchAll(/(?:import|from)\s*\(?\s*'\.\/([A-Za-z0-9._-]+\.mjs)'/g)) queue.push(match[1]);
  }
  for (const file of seen) assert.ok(served.has('/' + file), `/${file} is in the server.mjs static allowlist`);
});
