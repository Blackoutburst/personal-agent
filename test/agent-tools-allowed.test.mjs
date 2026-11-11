import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #73: the roster tools were added to scheduler-mcp but not to the companion's allowedTools, so the runtime refused them.
test('every agents_* tool the scheduler MCP defines is in the companion allowedTools list', () => {
  const mcp = readFileSync(new URL('../src/scheduler-mcp.mjs', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const defined = new Set([...mcp.matchAll(/['"](agents_[a-z_]+)['"]/g)].map(m => m[1]));
  const block = server.slice(server.indexOf('agentOwners.includes(owner.label) ?'), server.indexOf("] : [])] }];"));
  const allowed = new Set([...block.matchAll(/'(agents_[a-z_]+)'/g)].map(m => m[1]));
  assert.ok(defined.size >= 9, `found ${[...defined]}`);
  assert.deepEqual([...defined].filter(name => !allowed.has(name)), []);
});
