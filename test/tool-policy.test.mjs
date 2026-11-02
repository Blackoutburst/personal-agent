import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_TOOLS, CLAUDE_FILE_TOOLS, BUILTIN_TOOLS, READ_ONLY_BOARD_TOOLS,
  normalizeToolPolicy, mcpServersFor, narrowToolPolicy
} from '../src/tool-policy.mjs';

const board = (label = 'a') => ({ configDir: `/owners/${label}/board`, connectPath: '/opt/board/connect.py' });
const app = (name = 'notes') => ({ name, command: '/usr/bin/node', args: ['/opt/tools/notes.mjs'],
  env: { OWNER: name }, allowedTools: ['lookup_note', 'saveNote'] });
const configured = () => normalizeToolPolicy({ tools: ['Read', 'WebSearch', 'WebFetch'], board: board() }, {});

test('pure normalization keeps explicit opt-in and separate frozen web/file constants', () => {
  assert.deepEqual(WEB_TOOLS, ['WebSearch', 'WebFetch']);
  assert.deepEqual(CLAUDE_FILE_TOOLS, ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
  assert.deepEqual(BUILTIN_TOOLS, [...WEB_TOOLS, ...CLAUDE_FILE_TOOLS]);
  assert.deepEqual(READ_ONLY_BOARD_TOOLS, ['get_work', 'list_projects', 'list_tickets', 'get_ticket',
    'get_text', 'get_thread', 'list_human_requests', 'read_inbox']);
  for (const list of [WEB_TOOLS, CLAUDE_FILE_TOOLS, BUILTIN_TOOLS, READ_ONLY_BOARD_TOOLS]) {
    assert.ok(Object.isFrozen(list));
  }
  const empty = normalizeToolPolicy();
  assert.deepEqual(empty, { tools: [], board: null });
  assert.ok(Object.isFrozen(empty) && Object.isFrozen(empty.tools));
  assert.deepEqual(normalizeToolPolicy({ tools: CLAUDE_FILE_TOOLS }).tools, CLAUDE_FILE_TOOLS);
  const policy = normalizeToolPolicy({ board: board() }, {});
  assert.deepEqual(policy.tools, []);
  assert.deepEqual(policy.board.allowedTools, READ_ONLY_BOARD_TOOLS);
  assert.equal(policy.board.pythonPath, '/usr/bin/python3');
});

test('Board executable references prefer explicit paths to environment defaults', () => {
  const env = { COMPANION_BOARD_PYTHON: '/usr/bin/python3.10', COMPANION_BOARD_CONNECT: '/owner/connect.py' };
  const inherited = normalizeToolPolicy({ board: { configDir: '/owner/config' } }, env);
  assert.equal(inherited.board.pythonPath, env.COMPANION_BOARD_PYTHON);
  assert.equal(inherited.board.connectPath, env.COMPANION_BOARD_CONNECT);
  const explicit = normalizeToolPolicy({ board: { ...board(), pythonPath: '/custom/python' } }, env);
  assert.equal(explicit.board.pythonPath, '/custom/python');
  assert.equal(explicit.board.connectPath, '/opt/board/connect.py');
  assert.throws(() => normalizeToolPolicy({ board: { configDir: '/owner/config' } }, {}), /board.connectPath/);
});

test('malformed policy, unsupported tools and unknown nested fields are refused', () => {
  for (const value of [null, [], new Date(), 'WebSearch', { token: 'do-not-copy' }, { tools: null },
    { tools: 'Read' }, { tools: ['Bash'] }, { tools: ['Read', 'Read'] }, { tools: [true] },
    { tools: ['Read(*)'] }, { tools: Array(1) }, { board: [] }, { board: true },
    { board: { ...board(), token: 'secret' } }, { board: { ...board(), configFile: '/other/config' } },
    { board: { ...board(), headers: {} } }, { mcpServers: [app()] }]) {
    assert.throws(() => normalizeToolPolicy(value, {}), TypeError);
  }
  assert.throws(() => normalizeToolPolicy({ [Symbol('hidden')]: true }), TypeError);
});

test('all Board paths are absolute, nonempty, NUL-free and UTF8-byte bounded', () => {
  for (const key of ['configDir', 'pythonPath', 'connectPath']) {
    for (const value of ['', 'relative/file', '../elsewhere', '/a\0b', null, false, {},
      '/' + 'x'.repeat(4096), '/' + '😀'.repeat(1024)]) {
      assert.throws(() => normalizeToolPolicy({ board: { ...board(), [key]: value } }, {}), TypeError);
    }
  }
  assert.throws(() => normalizeToolPolicy({ board: { connectPath: '/opt/connect.py' } }, {}), /board.configDir/);
  assert.throws(() => normalizeToolPolicy({ board: board() }, { COMPANION_BOARD_PYTHON: 'relative/python' }), /board.pythonPath/);
});

test('Board list remains exact and extensible through trusted owner configuration', () => {
  const allowedTools = ['get_work', 'post_message', 'create_ticket'];
  assert.deepEqual(normalizeToolPolicy({ board: { ...board(), allowedTools } }, {}).board.allowedTools, allowedTools);
  for (const list of [null, 'get_work', ['get_work', 'get_work'], ['*'], ['get_*'], ['mcp__board__get_work'],
    ['get_work(*)'], ['get work'], ['get_Work'], ['_get_work'], ['get_work_'], ['get\0work'],
    ['x'.repeat(201)], [42], Array(1)]) {
    assert.throws(() => normalizeToolPolicy({ board: { ...board(), allowedTools: list } }, {}), TypeError);
  }
  assert.deepEqual(normalizeToolPolicy({ board: { ...board(), allowedTools: [] } }, {}).board.allowedTools, []);
});

test('owner policies retain separate immutable copies of input arrays and paths', () => {
  const aInput = { tools: ['Read'], board: { ...board('a'), allowedTools: ['get_work'] } };
  const bInput = { tools: ['WebFetch'], board: { ...board('b'), allowedTools: ['get_ticket'] } };
  const a = normalizeToolPolicy(aInput, {}), b = normalizeToolPolicy(bInput, {});
  aInput.tools.push('Write'); aInput.board.allowedTools.push('post_message'); aInput.board.configDir = '/owners/b/board';
  assert.deepEqual(a.tools, ['Read']);
  assert.deepEqual(a.board.allowedTools, ['get_work']);
  assert.equal(a.board.configDir, '/owners/a/board');
  assert.deepEqual(b.tools, ['WebFetch']);
  assert.equal(b.board.configDir, '/owners/b/board');
  for (const policy of [a, b]) {
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.tools)
      && Object.isFrozen(policy.board) && Object.isFrozen(policy.board.allowedTools));
    assert.throws(() => policy.tools.push('Write'), TypeError);
    assert.throws(() => { policy.board.configDir = '/other'; }, TypeError);
    assert.throws(() => policy.board.allowedTools.push('post_message'), TypeError);
  }
});

test('MCP composition includes only owner Board and supplied application descriptors', () => {
  assert.deepEqual(mcpServersFor({ subject: 'a', tools: ['Read'] }), []);
  const owner = { subject: 'a', board: { ...board(), pythonPath: '/custom/python', allowedTools: ['get_ticket'] } };
  const extra = app('owner-tools');
  assert.deepEqual(mcpServersFor(owner, [extra]), [
    { name: 'board', command: '/custom/python',
      args: ['/opt/board/connect.py', '--stdio', '--client', 'other', '--config-dir', '/owners/a/board'],
      env: {}, allowedTools: ['get_ticket'] }, extra
  ]);
  assert.deepEqual(mcpServersFor({}, [{ name: 'later', command: '/usr/bin/python3', allowedTools: [] }]),
    [{ name: 'later', command: '/usr/bin/python3', args: [], env: {}, allowedTools: [] }]);
});

test('MCP names cannot collide with Board or alter namespace/configuration syntax', () => {
  for (const name of ['board', 'Board', '', '.', 'notes.remote', 'notes__remote', 'notes*', 'notes(*)',
    '../notes', 'notes ', '-notes', 'notes-', 'a'.repeat(65), null]) {
    assert.throws(() => mcpServersFor({}, [{ ...app(), name }]), TypeError);
  }
  assert.throws(() => mcpServersFor({}, [app(), app()]), /Duplicate/);
  assert.throws(() => mcpServersFor({ board: board() }, [{ ...app(), name: 'board' }]), TypeError);
  assert.throws(() => mcpServersFor({}, Array(1)), TypeError);
  assert.throws(() => mcpServersFor({}, Array.from({ length: 33 }, (_, i) => app(`a${i}`))), TypeError);
});

test('app descriptors require exact explicit tools and reject malformed or unknown transport fields', () => {
  const { allowedTools: omitted, ...withoutTools } = app();
  for (const value of [null, [], new Date(), withoutTools, { ...app(), token: 'secret' },
    { ...app(), url: 'https://unexpected.invalid' }, { ...app(), transport: 'http' },
    { ...app(), command: 'node' }, { ...app(), command: '' }, { ...app(), command: '/a\0b' },
    { ...app(), command: '/' + 'x'.repeat(4096) }, { ...app(), args: 'shell text' },
    { ...app(), args: [false] }, { ...app(), args: Array(1) }, { ...app(), args: ['a\0b'] },
    { ...app(), args: ['x'.repeat(4097)] }, { ...app(), args: Array(129).fill('') },
    { ...app(), env: [] }, { ...app(), env: { OWNER: false } }, { ...app(), env: { OWNER: 'a\0b' } },
    { ...app(), env: { OWNER: 'x'.repeat(4097) } }, { ...app(), env: { 'BAD.KEY': 'a' } },
    { ...app(), env: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`A${i}`, ''])) },
    { ...app(), [Symbol('hidden')]: true }]) {
    assert.throws(() => mcpServersFor({}, [value]), TypeError);
  }
  for (const allowedTools of [null, 'lookup_note', ['lookup_note', 'lookup_note'], ['*'], ['lookup_*'],
    ['lookup_note(*)'], ['lookup.note'], ['lookup note'], ['lookup\0note'], ['x'.repeat(201)], [false], Array(1)]) {
    assert.throws(() => mcpServersFor({}, [{ ...app(), allowedTools }]), TypeError);
  }
  assert.throws(() => mcpServersFor({}, 'not-a-list'), TypeError);
});

test('application argv/env are literal strings, deeply snapshotted separately for each owner', () => {
  const source = app();
  source.args.push('literal $HOME; $(never-run)', 'line one\nline two', '');
  const a = mcpServersFor({ board: board('a') }, [source]);
  const b = mcpServersFor({ board: board('b') }, [source]);
  source.command = '/changed'; source.args[0] = '/changed'; source.env.OWNER = 'other'; source.allowedTools.push('erase');
  assert.equal(a[1].command, '/usr/bin/node');
  assert.deepEqual(a[1].args, ['/opt/tools/notes.mjs', 'literal $HOME; $(never-run)', 'line one\nline two', '']);
  assert.deepEqual(a[1].env, { OWNER: 'notes' });
  assert.deepEqual(a[1].allowedTools, ['lookup_note', 'saveNote']);
  assert.equal(a[0].args.at(-1), '/owners/a/board');
  assert.equal(b[0].args.at(-1), '/owners/b/board');
  assert.notEqual(a[1], b[1]); assert.notEqual(a[1].args, b[1].args); assert.notEqual(a[1].env, b[1].env);
  for (const list of [a, b]) {
    assert.ok(Object.isFrozen(list));
    for (const server of list) {
      assert.ok(Object.isFrozen(server) && Object.isFrozen(server.args)
        && Object.isFrozen(server.env) && Object.isFrozen(server.allowedTools));
      assert.throws(() => server.args.push('changed'), TypeError);
      assert.throws(() => { server.env.OWNER = 'changed'; }, TypeError);
    }
  }
});

test('omitted narrowing inherits; [] disables native tools and all MCP transports', () => {
  const policy = configured(), extra = app();
  const inherited = narrowToolPolicy(policy, undefined, [extra]);
  assert.deepEqual(inherited.tools, policy.tools);
  assert.deepEqual(inherited.board, policy.board);
  assert.deepEqual(inherited.mcpServers, mcpServersFor(policy, [extra]));
  assert.deepEqual(narrowToolPolicy(policy, [], [extra]), { tools: [], board: null, mcpServers: [] });
  assert.deepEqual(narrowToolPolicy({}, undefined, [{ ...app(), allowedTools: [] }]),
    { tools: [], board: null, mcpServers: [] });
  assert.equal(narrowToolPolicy({ board: { ...board(), allowedTools: [] } }).board, null);
});

test('exact narrowing filters individual tools and omits unselected servers', () => {
  const policy = configured(), extra = app();
  const narrowed = narrowToolPolicy(policy, ['mcp__notes__saveNote', 'mcp__board__get_ticket', 'Read'], [extra]);
  assert.deepEqual(narrowed.tools, ['Read']);
  assert.deepEqual(narrowed.board, { ...policy.board, allowedTools: ['get_ticket'] });
  assert.deepEqual(narrowed.mcpServers.map(server => [server.name, server.allowedTools]),
    [['board', ['get_ticket']], ['notes', ['saveNote']]]);
  assert.deepEqual(narrowToolPolicy(policy, ['mcp__notes__lookup_note'], [extra]).tools, []);
  assert.equal(narrowToolPolicy(policy, ['mcp__notes__lookup_note'], [extra]).board, null);
  assert.deepEqual(narrowToolPolicy(policy, ['Read'], [extra]), { tools: ['Read'], board: null, mcpServers: [] });
});

test('narrowing rejects expansion, foreign names, wildcard expressions and caller paths', () => {
  const policy = configured();
  for (const requested of [null, {}, 'Read', [false], Array(1), ['Read', 'Read'], ['Bash'], ['Write'],
    ['Read(*)'], ['mcp__board__*'], ['mcp__board__post_message'], ['mcp__other__get_work'],
    ['mcp__notes__erase'], ['mcp__notes__lookup_note(*)'], ['mcp__notes__*'], ['mcp__notes'],
    ['lookup_note'], ['/other/config'], [{ command: '/other/config' }]]) {
    assert.throws(() => narrowToolPolicy(policy, requested, [app()]), TypeError);
  }
  const writes = normalizeToolPolicy({ board: { ...board(), allowedTools: ['post_message'] } }, {});
  assert.deepEqual(narrowToolPolicy(writes, ['mcp__board__post_message']).board.allowedTools, ['post_message']);
});

test('effective queued policy cannot change with later owner or app input mutation', () => {
  const policy = { tools: ['Read', 'Write'], board: { ...board(), allowedTools: ['get_work'] } }, extra = app();
  const result = narrowToolPolicy(policy, ['Write', 'mcp__notes__lookup_note'], [extra]);
  policy.tools.length = 0; policy.board.configDir = '/other'; extra.args.length = 0; extra.env.OWNER = 'other';
  extra.allowedTools.push('erase');
  assert.deepEqual(result.tools, ['Write']);
  assert.equal(result.board, null);
  assert.deepEqual(result.mcpServers, [{ ...app(), allowedTools: ['lookup_note'] }]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.tools) && Object.isFrozen(result.mcpServers));
  assert.throws(() => result.mcpServers[0].allowedTools.push('erase'), TypeError);
});
