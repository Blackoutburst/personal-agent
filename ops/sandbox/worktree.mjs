// CLI over src/sandbox.mjs (#71, docs/SANDBOX.md). Runs inside the sandbox, as cchan-agents:
//   cchan-sandbox-run -- node worktree.mjs <sync|create|remove|list> [--repo R] [--agent A] [--ticket T] [--base B] [--delete-branch]
// Prints one JSON object. Exit 0 on success, 2 on a refused or failed request.
import { parseArgs } from 'node:util';
import { Sandbox, SandboxError } from '../../src/sandbox.mjs';

const { positionals: [command], values } = parseArgs({ allowPositionals: true, options: {
  repo: { type: 'string' }, agent: { type: 'string' }, ticket: { type: 'string' }, base: { type: 'string' },
  root: { type: 'string' }, 'delete-branch': { type: 'boolean' } } });

try {
  const sandbox = new Sandbox(values.root ? { root: values.root } : {});
  const target = { repo: values.repo, agent: values.agent, ticket: values.ticket };
  const result = command === 'sync' ? { repo: values.repo, dir: sandbox.sync(values.repo) }
    : command === 'create' ? sandbox.create({ ...target, ...(values.base ? { base: values.base } : {}) })
    : command === 'remove' ? sandbox.remove({ ...target, deleteBranch: Boolean(values['delete-branch']) })
    : command === 'list' ? { worktrees: sandbox.list() }
    : (() => { throw new SandboxError('INVALID', 'command must be sync, create, remove or list'); })();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? 'FAILED', error: error instanceof SandboxError ? error.message : 'git failed' }));
  process.exitCode = 2;
}
