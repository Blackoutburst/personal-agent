// #94 rework: the per-project check for Board writes on C-chan's unattended wakes (proactive, heartbeat, follow-up,
// contact). The Board session bridge (src/board-session-bridge.mjs, --gate) calls gateBoardWrite for every Board tool
// call that is not a read. The target project is resolved here from the ticket, thread, request or message the call
// names, through the Board's own read tools, never taken from the call alone. The whole argument tree is walked (exact
// schemas below, nested update_ticket.changes, unknown id keys): every id must resolve to the same single project.
// The approval itself is asked from the companion app with the turn's unattended scheduler token (agents op
// boardGate -> the runner's standing approvals). Anything unknown is refused.
import { READ_ONLY_BOARD_TOOLS } from './tool-policy.mjs';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const str = value => typeof value === 'string' && ID.test(value) ? value : null;

export const isBoardRead = tool => READ_ONLY_BOARD_TOOLS.includes(tool);

export class BoardGateRefusal extends Error {}
const refuse = message => { throw new BoardGateRefusal(message); };

// MCP tools/call result -> plain value (the same unwrapping as BoardClient).
export function toolValue(result) {
  if (!object(result) || result.isError) return null;
  const structured = result.structuredContent;
  if (object(structured)) {
    const keys = Object.keys(structured);
    return keys.length === 1 && keys[0] === 'result' ? structured.result : structured;
  }
  const text = Array.isArray(result.content) ? result.content.find(item => item?.type === 'text')?.text : null;
  try { return typeof text === 'string' ? JSON.parse(text) : null; } catch { return null; }
}

// read(tool, args) -> the Board's answer (plain value) or throws. Returns the project id of each target.
async function ticketProject(read, ticketId) {
  const answer = await lookup(read, 'get_ticket', { ticket_id: ticketId, view: 'full' }, `Ticket ${ticketId}`);
  const ticket = object(answer?.ticket) ? answer.ticket : answer;
  const project = str(ticket?.project_id) ?? str(ticket?.projectId);
  if (!project || (ticket.id !== undefined && ticket.id !== ticketId)) refuse(`Ticket ${ticketId} could not be found on the Board.`);
  return project;
}

async function threadProject(read, threadId) {
  const answer = await lookup(read, 'get_thread', { thread_id: threadId, limit: 1, view: 'full' }, `Thread ${threadId}`);
  const thread = object(answer?.thread) ? answer.thread : null;
  if (!thread) refuse(`Thread ${threadId} could not be found on the Board.`);
  const ticket = object(thread.ticket) ? thread.ticket : null;
  const ticketId = str(ticket?.id) ?? str(thread.ticket_id);
  // The ticket is the authority when the thread names one; a thread without a ticket must name its project.
  if (ticketId) return ticketProject(read, ticketId);
  const project = str(thread.project_id) ?? str(thread.projectId);
  if (!project) refuse(`Thread ${threadId} belongs to no project ticket; that is not approved work.`);
  return project;
}

async function requestProject(read, requestId) {
  const answer = await lookup(read, 'list_human_requests', { view: 'full' }, `Request ${requestId}`);
  const requests = Array.isArray(answer) ? answer : Array.isArray(answer?.items) ? answer.items : Array.isArray(answer?.requests) ? answer.requests : [];
  const request = requests.find(item => object(item) && item.id === requestId);
  if (!request) refuse(`Request ${requestId} could not be found on the Board.`);
  const ticketId = str(request.ticket_id);
  if (ticketId) return ticketProject(read, ticketId);
  const project = str(request.project_id);
  if (!project) refuse(`Request ${requestId} names no ticket or project.`);
  return project;
}

async function messageProject(read, messageId) {
  const answer = await lookup(read, 'get_message', { message_id: messageId }, `Message ${messageId}`);
  const message = object(answer?.message) ? answer.message : answer;
  const threadId = str(message?.thread_id);
  if (!threadId) refuse(`Message ${messageId} could not be found on the Board.`);
  return threadProject(read, threadId);
}

// A failed or refused Board read means the target is unknown to this owner's Board view.
const lookup = async (read, tool, args, what) => {
  try { return await read(tool, args); } catch { refuse(`${what} could not be found on the Board.`); }
};

// The exact Board schemas of the write tools C-chan uses on her wakes. Each field has a kind: an id the gate resolves
// on the Board ('ticket', 'tickets', 'thread', 'message', 'request', 'project'), a plain value ('value', which must not
// be an object or array), or a free-form tree ('tree', walked like any other field). The first-listed id is required.
export const BOARD_WRITE_SCHEMAS = Object.freeze({
  release_managed_agent_claim: { required: 'ticket_id', fields: { ticket_id: 'ticket', expected_version: 'value',
    idempotency_key: 'value', reason: 'value', recovery_evidence: 'tree' } },
  update_ticket: { required: 'ticket_id', fields: { ticket_id: 'ticket', expected_version: 'value', changes: 'tree' } },
  post_message: { required: 'thread_id', fields: { thread_id: 'thread', body: 'value', idempotency_key: 'value', reply_to: 'message' } },
  create_ticket: { required: 'project_id', fields: { project_id: 'project', title: 'value', idempotency_key: 'value', depends_on: 'tickets' } },
  resolve_human_request: { required: 'request_id', fields: { request_id: 'request', answer: 'value' } }
});

// Any key anywhere in the arguments that names a Board object, in snake or camel case: `id`, `*_id(s)`, and the
// relation words below. Its value must resolve on the Board to the call's one approved project, or the call is refused.
const snake = key => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const RELATION = /(^|_)(ids?|depends?|depends_on|dependencies|dependency|blocks|blocked_by|blockers?|parents?|children|child|duplicates?|duplicate_of|related|relates_to|links?|reply_to|replies_to|assignees?|owners?|project|ticket|thread|message|request)$/;
const isIdKey = key => RELATION.test(snake(key));
// Which Board object an id key names (by its words); anything else is looked up as a ticket and refused if it is not one.
function kindOfKey(key) {
  const name = snake(key);
  if (/project/.test(name)) return 'project';
  if (/thread/.test(name)) return 'thread';
  if (/request/.test(name)) return 'request';
  if (/message|reply/.test(name)) return 'message';
  return 'ticket';
}

const MAX_DEPTH = 12, MAX_NODES = 2000, MAX_TARGETS = 50;

// Every project this call would touch. Throws BoardGateRefusal when a target is malformed, unknown, or missing, and
// when the call (top level or nested, e.g. update_ticket.changes.project_id or .depends_on) names more than one project.
export async function boardWriteTargets(tool, args, read) {
  if (!object(args)) refuse('The Board call has no arguments to check.');
  const targets = [];
  let nodes = 0;
  const resolverFor = kind => ({ project: id => Promise.resolve(id), ticket: id => ticketProject(read, id), tickets: id => ticketProject(read, id),
    thread: id => threadProject(read, id), message: id => messageProject(read, id), request: id => requestProject(read, id) })[kind];
  // Under an id key every string leaf is an id: in a list, or in an object (whose own id keys name their kind, and
  // whose other strings count as ids of the outer kind, so a reference cannot hide under a key the gate does not know).
  const addIds = (path, kind, value, depth = 1) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) refuse('The Board call\'s arguments are too large or too deep to check.');
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) { value.forEach((item, i) => addIds(`${path}[${i}]`, kind, item, depth + 1)); return; }
    if (object(value)) {
      for (const [key, child] of Object.entries(value)) addIds(`${path}.${key}`, isIdKey(key) ? kindOfKey(key) : kind, child, depth + 1);
      return;
    }
    const id = str(value);
    if (!id) refuse(`The Board call's ${path} is not a valid id.`);
    if (targets.length >= MAX_TARGETS) refuse('The Board call names too many targets to check.');
    targets.push({ path, kind, id });
  };
  // Walk a value that is not itself an id: any id key inside it is a target.
  const walk = (path, value, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) refuse('The Board call\'s arguments are too large or too deep to check.');
    if (Array.isArray(value)) { value.forEach((item, i) => walk(`${path}[${i}]`, item, depth + 1)); return; }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const where = path ? `${path}.${key}` : key;
      if (child === undefined || child === null) continue;
      if (isIdKey(key)) addIds(where, kindOfKey(key), child);
      else walk(where, child, depth + 1);
    }
  };
  const schema = Object.hasOwn(BOARD_WRITE_SCHEMAS, tool) ? BOARD_WRITE_SCHEMAS[tool] : null;
  if (schema && (args[schema.required] === undefined || args[schema.required] === null)) refuse(`${tool} needs ${schema.required}.`);
  for (const [key, value] of Object.entries(args)) {
    if (key === 'session_id' || value === undefined || value === null) continue; // session_id is the bridge's own, always replaced.
    const kind = schema && Object.hasOwn(schema.fields, key) ? schema.fields[key] : null;
    if (kind === 'value') { if (typeof value === 'object') refuse(`The Board call's ${key} must be a plain value.`); }
    else if (kind === 'tree') walk(key, value, 1);
    else if (kind) addIds(key, kind, value);
    // A field outside the schema (or any field of another write tool): an id key is resolved by its name, the rest walked.
    else if (isIdKey(key)) addIds(key, kindOfKey(key), value);
    else walk(key, value, 1);
  }
  if (!targets.length) refuse(`${tool} names no ticket, thread, request or project, so it cannot be checked against your approved projects.`);
  const projects = new Set();
  for (const { path, kind, id } of targets) {
    projects.add(await resolverFor(kind)(id));
    if (projects.size > 1) refuse(`The Board call's ${path} (${id}) is not in the same project as the rest of the call (${[...projects].join(', ')}); a wake may only write within one approved project.`);
  }
  return [...projects];
}

// -> { ok: true, projects } or { ok: false, reason }. approved(projectId) -> boolean (or a promise of one).
export async function gateBoardWrite({ tool, args, read, approved }) {
  if (typeof tool !== 'string' || !tool) return { ok: false, reason: 'Invalid Board call.' };
  if (isBoardRead(tool)) return { ok: true, projects: [] };
  try {
    const projects = await boardWriteTargets(tool, args, read);
    for (const project of projects) {
      let yes = false;
      try { yes = (await approved(project)) === true; } catch { yes = false; }
      if (!yes) refuse(`Project ${project} has no active standing approval from your owner (agents_manager), so this wake may not write there. Suggest it to your owner instead.`);
    }
    return { ok: true, projects };
  } catch (error) {
    const why = error instanceof BoardGateRefusal ? error.message : 'The Board target could not be checked.';
    return { ok: false, reason: `Refused on your own wake: ${why}` };
  }
}

// The app side of approved(): POST the companion's scheduler endpoint with the turn's (unattended) token.
export async function askApproval({ url, token, projectId, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (typeof url !== 'string' || !url || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !str(projectId)) return false;
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'agents', input: { op: 'boardGate', projectId } }) });
  if (response.status !== 200) return false;
  const body = await response.json().catch(() => null);
  return body?.approved === true && body?.projectId === projectId;
}
