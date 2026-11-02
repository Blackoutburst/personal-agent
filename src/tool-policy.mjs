import { isAbsolute } from 'node:path';

export const WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);
export const CLAUDE_FILE_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
export const BUILTIN_TOOLS = Object.freeze([...WEB_TOOLS, ...CLAUDE_FILE_TOOLS]);
export const READ_ONLY_BOARD_TOOLS = Object.freeze([
  'get_work', 'list_projects', 'list_tickets', 'get_ticket',
  'get_text', 'get_thread', 'list_human_requests', 'read_inbox'
]);

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Invalid ${name}`);
  }
}

function objectWithKeys(value, keys, name) {
  plainObject(value, name);
  if (Reflect.ownKeys(value).some(key => !keys.includes(key))) {
    throw new TypeError(`Invalid ${name} fields`);
  }
}

function toolList(value, name, accepts) {
  if (!Array.isArray(value)
      || Array.from(value).some(tool => typeof tool !== 'string' || !accepts(tool))
      || new Set(value).size !== value.length) {
    throw new TypeError(`Invalid ${name} list`);
  }
  return [...value];
}

function boundedString(value, name, maximum = 4096) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function absolutePath(value, name) {
  boundedString(value, name);
  if (!value || !isAbsolute(value)) throw new TypeError(`${name} must be a nonempty absolute path`);
  return value;
}

function frozenServer(server) {
  return Object.freeze({ ...server, args: Object.freeze([...server.args]),
    env: Object.freeze({ ...server.env }), allowedTools: Object.freeze([...server.allowedTools]) });
}

function frozenPolicy(tools, board, servers) {
  return Object.freeze({ tools: Object.freeze([...tools]), board: board === null ? null
    : Object.freeze({ ...board, allowedTools: Object.freeze([...board.allowedTools]) }),
    ...(servers === undefined ? {} : { mcpServers: Object.freeze(servers.map(frozenServer)) }) });
}

export function normalizeToolPolicy(value = {}, env = process.env) {
  objectWithKeys(value, ['tools', 'board'], 'tool policy');
  const tools = toolList(value.tools === undefined ? [] : value.tools,
    'built-in tools', tool => BUILTIN_TOOLS.includes(tool));
  if (value.board === undefined || value.board === null) return frozenPolicy(tools, null);
  objectWithKeys(value.board, ['configDir', 'pythonPath', 'connectPath', 'allowedTools'], 'Board policy');
  const board = value.board;
  return frozenPolicy(tools, {
    configDir: absolutePath(board.configDir, 'board.configDir'),
    pythonPath: absolutePath(board.pythonPath === undefined
      ? env.COMPANION_BOARD_PYTHON ?? '/usr/bin/python3' : board.pythonPath, 'board.pythonPath'),
    connectPath: absolutePath(board.connectPath === undefined
      ? env.COMPANION_BOARD_CONNECT : board.connectPath, 'board.connectPath'),
    allowedTools: toolList(board.allowedTools === undefined ? READ_ONLY_BOARD_TOOLS : board.allowedTools,
      'Board tools', tool => tool.length <= 200 && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(tool))
  });
}

function appServer(value) {
  objectWithKeys(value, ['name', 'command', 'args', 'env', 'allowedTools'], 'MCP server');
  const { name, args = [], env = {} } = value;
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(name)
      || name === 'board') throw new TypeError('Invalid or reserved MCP server name');
  if (!Array.isArray(args) || args.length > 128) throw new TypeError('Invalid MCP arguments');
  const argv = Array.from(args, arg => boundedString(arg, 'MCP argument'));
  plainObject(env, 'MCP environment');
  const keys = Reflect.ownKeys(env);
  if (keys.length > 128 || keys.some(key => typeof key !== 'string' || key.length > 200
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new TypeError('Invalid MCP environment keys');
  const environment = Object.fromEntries(keys.map(key => [key, boundedString(env[key], 'MCP environment value')]));
  return frozenServer({ name, command: absolutePath(value.command, 'MCP command'), args: argv, env: environment,
    allowedTools: toolList(value.allowedTools, 'MCP tools', tool => tool.length <= 200
      && /^[A-Za-z][A-Za-z0-9_-]*$/.test(tool)) });
}

// Only the application supplies appServers; JSON owner config contains tools/board.
export function mcpServersFor(owner, appServers = []) {
  plainObject(owner, 'MCP owner');
  if (!Array.isArray(appServers) || appServers.length > 32) throw new TypeError('Invalid MCP servers');
  const { board } = normalizeToolPolicy({ board: owner.board });
  const servers = board === null ? [] : [frozenServer({ name: 'board', command: board.pythonPath,
    args: [board.connectPath, '--stdio', '--client', 'other', '--config-dir', board.configDir],
    env: {}, allowedTools: board.allowedTools })];
  const seen = new Set(['board']);
  for (const value of appServers) {
    const server = appServer(value);
    if (seen.has(server.name)) throw new TypeError('Duplicate MCP server name');
    seen.add(server.name);
    servers.push(server);
  }
  return Object.freeze(servers);
}

export function narrowToolPolicy(policy, allowedTools, appServers = []) {
  const configured = normalizeToolPolicy(policy);
  const servers = mcpServersFor(configured, appServers);
  const available = new Set([...configured.tools,
    ...servers.flatMap(server => server.allowedTools.map(tool => `mcp__${server.name}__${tool}`))]);
  const requested = allowedTools === undefined ? [...available]
    : toolList(allowedTools, 'requested tools', tool => available.has(tool));
  const selected = new Set(requested);
  const narrowed = servers.map(server => ({ ...server,
    allowedTools: server.allowedTools.filter(tool => selected.has(`mcp__${server.name}__${tool}`))
  })).filter(server => server.allowedTools.length);
  const boardTools = narrowed.find(server => server.name === 'board')?.allowedTools;
  return frozenPolicy(configured.tools.filter(tool => selected.has(tool)),
    boardTools ? { ...configured.board, allowedTools: boardTools } : null, narrowed);
}
