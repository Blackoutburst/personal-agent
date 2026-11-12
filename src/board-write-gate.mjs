// #94 rework: the per-project check for Board writes on C-chan's unattended wakes (proactive, heartbeat, follow-up,
// contact). The Board session bridge (src/board-session-bridge.mjs, --gate) calls gateBoardWrite for every Board tool
// call that is not a read. The target project is resolved here from the ticket, thread, request or message the call
// names, through the Board's own read tools, never taken from the call alone; a project_id in the call counts only as
// one more target that must itself be approved. The approval itself is asked from the companion app with the turn's
// unattended scheduler token (agents op boardGate -> the runner's standing approvals). Anything unknown is refused.
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

const listOf = value => Array.isArray(value) ? value : [value];

// Every project this call would touch. Throws BoardGateRefusal when a target is malformed, unknown, or missing.
export async function boardWriteTargets(tool, args, read) {
  if (!object(args)) refuse('The Board call has no arguments to check.');
  const jobs = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    let resolver = null;
    if (key === 'project_id') resolver = id => Promise.resolve(id);
    else if (key === 'thread_id') resolver = id => threadProject(read, id);
    else if (key === 'request_id') resolver = id => requestProject(read, id);
    else if (key === 'message_id' || key === 'reply_to') resolver = id => messageProject(read, id);
    else if (/(^|_)ticket_ids?$/.test(key)) resolver = id => ticketProject(read, id);
    if (!resolver) continue;
    for (const item of listOf(value)) {
      const id = str(item);
      if (!id) refuse(`The Board call's ${key} is not a valid id.`);
      jobs.push(resolver(id));
    }
  }
  if (!jobs.length) refuse(`${tool} names no ticket, thread, request or project, so it cannot be checked against your approved projects.`);
  const projects = [];
  for (const job of jobs) projects.push(await job);
  return [...new Set(projects)];
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
