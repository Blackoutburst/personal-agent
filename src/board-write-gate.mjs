// #94 rework: the per-project check for Board writes on C-chan's unattended wakes (proactive, heartbeat, follow-up,
// contact). The Board session bridge (src/board-session-bridge.mjs, --gate) calls gateBoardWrite for every Board tool
// call that is not a read. The target project is resolved here from the ticket, thread, request or message the call
// names, through the Board's own read tools, never taken from the call alone. Every argument is checked against the exact
// schemas below, including update_ticket.changes; any other tool or key is refused. Every id must resolve to the same
// single project.
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

// The exact Board schemas of the write tools C-chan uses on her wakes (#94 round 5: fail closed). A write tool that is
// not listed here (delete_ticket, release_ticket, update_companion_profile, ...) is refused, and so is any key a schema
// does not list, at the top level or inside update_ticket.changes. Each field has a kind:
//   'ticket' | 'tickets' | 'thread' | 'message' | 'request' | 'project'  an id (or, for 'tickets', a list of ids) the
//            gate resolves on the Board; every one must land in the call's single approved project;
//   'value'  a string, number or boolean (never an object or array);
//   'text'   a value or a list of values (labels, acceptance criteria, skills);
//   'refs'   a list of well-formed ids that are not Board tickets/threads (attachments), checked for shape only;
//   'changes' the update_ticket change set, checked against TICKET_CHANGES.
// The required field is the call's main id.
export const TICKET_CHANGES = Object.freeze({
  acceptance_criteria: 'text', assignee_agent_id: 'value', assignee_owner_id: 'value', attachment_ids: 'refs',
  blocked_reason: 'value', depends_on: 'tickets', description: 'value', evidence: 'text', labels: 'text', outcome: 'value',
  priority: 'value', progress: 'value', recheck_after_seconds: 'value', release_claim: 'value', required_skills: 'text',
  resolution: 'value', resource: 'text', status: 'value', title: 'value', unblock_owner: 'value'
});

export const BOARD_WRITE_SCHEMAS = Object.freeze({
  release_managed_agent_claim: { required: 'ticket_id', fields: { ticket_id: 'ticket', expected_version: 'value',
    idempotency_key: 'value', reason: 'value', recovery_evidence: 'value', view: 'value' } },
  update_ticket: { required: 'ticket_id', fields: { ticket_id: 'ticket', expected_version: 'value', changes: 'changes' } },
  post_message: { required: 'thread_id', fields: { thread_id: 'thread', body: 'value', idempotency_key: 'value', reply_to: 'message',
    attachment_ids: 'refs' } },
  create_ticket: { required: 'project_id', fields: { project_id: 'project', title: 'value', description: 'value',
    acceptance_criteria: 'text', idempotency_key: 'value', depends_on: 'tickets', priority: 'value', labels: 'text',
    required_skills: 'text', attachment_ids: 'refs' } },
  resolve_human_request: { required: 'request_id', fields: { request_id: 'request', answer: 'value' } }
});

const MAX_TARGETS = 50, MAX_LIST = 200;
const plain = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const RESOLVED = new Set(['ticket', 'tickets', 'thread', 'message', 'request', 'project']);

// Every project this call would touch. Throws BoardGateRefusal when the tool or a key is not in the exact schemas, a
// field has the wrong shape, a target is malformed, unknown or missing, or the call names more than one project.
export async function boardWriteTargets(tool, args, read) {
  if (!object(args)) refuse('The Board call has no arguments to check.');
  const schema = Object.hasOwn(BOARD_WRITE_SCHEMAS, tool) ? BOARD_WRITE_SCHEMAS[tool] : null;
  if (!schema) refuse(`${tool} is not a Board write this gate knows, so it is not allowed on your own wake.`);
  if (args[schema.required] === undefined || args[schema.required] === null) refuse(`${tool} needs ${schema.required}.`);
  const targets = [];
  const target = (path, kind, value) => {
    const id = str(value);
    if (!id) refuse(`The Board call's ${path} is not a valid id.`);
    if (targets.length >= MAX_TARGETS) refuse('The Board call names too many targets to check.');
    targets.push({ path, kind, id });
  };
  const list = (path, value) => {
    if (!Array.isArray(value)) refuse(`The Board call's ${path} must be a list.`);
    if (value.length > MAX_LIST) refuse(`The Board call's ${path} is too long to check.`);
    return value;
  };
  const check = (path, kind, value) => {
    if (value === undefined || value === null) return;
    if (kind === 'value') { if (!plain(value)) refuse(`The Board call's ${path} must be a plain value.`); return; }
    if (kind === 'text') {
      if (Array.isArray(value)) list(path, value).forEach((item, i) => { if (!plain(item)) refuse(`The Board call's ${path}[${i}] must be a plain value.`); });
      else if (!plain(value)) refuse(`The Board call's ${path} must be a plain value or a list of them.`);
      return;
    }
    if (kind === 'refs') { list(path, value).forEach((item, i) => { if (!str(item)) refuse(`The Board call's ${path}[${i}] is not a valid id.`); }); return; }
    if (kind === 'tickets') {
      if (Array.isArray(value)) list(path, value).forEach((item, i) => target(`${path}[${i}]`, 'ticket', item));
      else target(path, 'ticket', value);
      return;
    }
    if (kind === 'changes') {
      if (!object(value)) refuse(`The Board call's ${path} must be an object.`);
      for (const [key, child] of Object.entries(value)) {
        if (!Object.hasOwn(TICKET_CHANGES, key)) refuse(`The Board call's ${path}.${key} is not a ticket field this gate allows.`);
        check(`${path}.${key}`, TICKET_CHANGES[key], child);
      }
      return;
    }
    if (RESOLVED.has(kind)) { target(path, kind, value); return; }
    refuse(`The Board call's ${path} could not be checked.`);
  };
  for (const [key, value] of Object.entries(args)) {
    if (key === 'session_id') continue; // the bridge's own field, always replaced with the bound session.
    if (!Object.hasOwn(schema.fields, key)) refuse(`The Board call's ${key} is not a ${tool} field this gate allows.`);
    check(key, schema.fields[key], value);
  }
  if (!targets.length) refuse(`${tool} names no ticket, thread, request or project, so it cannot be checked against your approved projects.`);
  const resolve = { project: id => Promise.resolve(id), ticket: id => ticketProject(read, id), thread: id => threadProject(read, id),
    message: id => messageProject(read, id), request: id => requestProject(read, id) };
  const projects = new Set();
  for (const { path, kind, id } of targets) {
    projects.add(await resolve[kind](id));
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
