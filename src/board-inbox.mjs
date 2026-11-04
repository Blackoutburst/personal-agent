// Board inbox (#55, docs/BOARD-INBOX.md): the companion's Board messages (Needs-you requests, mentions, pings to the
// owner) no longer land in the owner's main chat. Each Board thread or ticket gets its own sub-conversation, an
// ordinary conv_threads row so history, files, typing and streaming reuse Conversations. This module owns only the
// additive tables that say which conversation is which Board topic, its unread marker and whether it is archived.
//
// Rollback: nothing here alters a legacy table. A Board sub-conversation row in conv_threads carries archived_at
// from the moment it is made, so an older release (which knows nothing of these tables) shows it as a read-only
// past chat and never as the ongoing chat or in its open chat list.
import { randomUUID } from 'node:crypto';
import { stripFeelingTags } from './wardrobe.mjs';
import { previewText } from './web-push.mjs';
import { READ_ONLY_BOARD_TOOLS } from './tool-policy.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE_DAYS = 30, DISCORD_DAYS = 90, DAY_MS = 86_400_000, LIST = 200, PREVIEW = 140;
// #61b: an activity line's quote of the companion's Board post, and how early (clock slack) a post may predate its wake.
const POST_PREVIEW = 200, POST_SLACK_MS = 5000, BOARD_PREFIX = 'mcp__board__';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS board_inbox_threads(thread_id TEXT PRIMARY KEY, companion_id TEXT NOT NULL,
  board_thread_id TEXT, ticket_id TEXT, ticket_number INTEGER, title TEXT, general INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER, read_rowid INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS board_inbox_threads_board ON board_inbox_threads(companion_id, board_thread_id) WHERE board_thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS board_inbox_threads_general ON board_inbox_threads(companion_id) WHERE general=1;
CREATE INDEX IF NOT EXISTS board_inbox_threads_ticket ON board_inbox_threads(companion_id, ticket_id);
CREATE TABLE IF NOT EXISTS board_inbox_routes(companion_id TEXT NOT NULL, request_id TEXT NOT NULL, wake_id TEXT,
  board_thread_id TEXT, ticket_id TEXT, ticket_number INTEGER, title TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(companion_id, request_id));
CREATE INDEX IF NOT EXISTS board_inbox_routes_wake ON board_inbox_routes(companion_id, wake_id);
CREATE TABLE IF NOT EXISTS board_inbox_discord(companion_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(companion_id, message_id));
CREATE TABLE IF NOT EXISTS board_inbox_notes(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
  companion_id TEXT NOT NULL, wake_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, preview TEXT, url TEXT,
  since_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(companion_id, wake_id));
CREATE INDEX IF NOT EXISTS board_inbox_notes_thread ON board_inbox_notes(thread_id, seq);
`;

export class BoardInboxError extends Error {
  constructor(code, status) { super(code); this.name = 'BoardInboxError'; this.code = code; this.status = status; }
}

const cleanTitle = value => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, '') || null : null;

// Board topic fields as stored: ids must look like Board ids, the rest is optional display data.
export function topicOf(value = {}) {
  const boardThreadId = typeof value.boardThreadId === 'string' && ID.test(value.boardThreadId) ? value.boardThreadId : null;
  const ticketId = typeof value.ticketId === 'string' && ID.test(value.ticketId) ? value.ticketId : null;
  const ticketNumber = Number.isSafeInteger(value.ticketNumber) && value.ticketNumber > 0 && value.ticketNumber < 1e9 ? value.ticketNumber : null;
  return { boardThreadId, ticketId, ticketNumber, title: cleanTitle(value.title) };
}

// "#15 · Fix the login page", the Board thread's own title, or a plain fallback.
export function topicLabel(row) {
  const number = row.ticketNumber ?? row.ticket_number ?? null, title = row.title ?? null;
  if (number) return title ? `#${number} · ${title}` : `#${number}`;
  if (title) return title;
  return row.general ? 'Board' : 'Board thread';
}
// What a silent Board wake did, from the provider's tool events (names only, Claude reports them; Codex does not).
export function noteKind(tools = []) {
  const board = tools.filter(name => typeof name === 'string' && name.startsWith(BOARD_PREFIX)).map(name => name.slice(BOARD_PREFIX.length));
  if (board.includes('post_message')) return 'posted';
  if (board.includes('resolve_human_request')) return 'resolved';
  if (board.some(name => !READ_ONLY_BOARD_TOOLS.includes(name))) return 'updated';
  return tools.length ? 'read' : 'handled';
}
// The activity line itself: app text, never the companion's or the owner's words.
export function noteText(kind, name) {
  const who = cleanTitle(name)?.slice(0, 60) || 'Your companion';
  return kind === 'posted' ? `${who} answered on the Board.` : kind === 'resolved' ? `${who} answered the Board request.`
    : kind === 'updated' ? `${who} updated the Board.` : kind === 'read' ? `${who} checked this on the Board and had nothing to ask you.`
      : `${who} handled this on the Board.`;
}
// A Board link the apps may open: absolute http(s), no credentials.
export function boardUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
// Board text is shared-workspace content: one plain line, shown as text only.
function postPreview(value) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > POST_PREVIEW) text = text.slice(0, POST_PREVIEW - 1).trimEnd() + '…';
  return text.isWellFormed() ? text : text.toWellFormed();
}

const threadTitle = label => {
  let title = label.slice(0, 80);
  if (!title.isWellFormed()) title = title.slice(0, -1);
  return title.trim() || 'Board';
};

const noteMessage = row => ({ id: row.id, threadId: row.thread_id, role: 'app', text: row.text,
  ...(row.url ? { url: row.url } : {}), ...(row.preview ? { preview: row.preview } : {}) });

export class BoardInbox {
  #db; #now; #nameFor; #lookup;
  // nameFor(companionId): the companion's display name for activity lines. lookup(companionId, boardThreadId, sinceMs)
  // -> { threadUrl, post: { body, url } | null } | null (BoardCompanion.ownPost): the companion's latest post there.
  constructor({ store, now = Date.now, nameFor = () => null, lookup = null }) {
    this.#db = store.db; this.#now = now; this.#nameFor = nameFor; this.#lookup = lookup;
    this.#db.exec(SCHEMA);
    // #61b: the read marker for activity lines (a board_inbox_notes seq). Additive: older releases ignore it.
    const columns = new Set(this.#db.prepare('PRAGMA table_info(board_inbox_threads)').all().map(column => column.name));
    if (!columns.has('read_note_seq')) this.#db.exec('ALTER TABLE board_inbox_threads ADD COLUMN read_note_seq INTEGER NOT NULL DEFAULT 0');
  }

  // Before a Board wake is queued: what it is about, keyed by its scheduler request id (BoardCompanion).
  route(companionId, requestId, topic) {
    const value = topicOf(topic), now = this.#now();
    this.#db.prepare('DELETE FROM board_inbox_routes WHERE companion_id=? AND created_at<?').run(companionId, now - ROUTE_DAYS * DAY_MS);
    this.#db.prepare(`INSERT INTO board_inbox_routes(companion_id,request_id,wake_id,board_thread_id,ticket_id,ticket_number,title,created_at)
      VALUES(?,?,NULL,?,?,?,?,?) ON CONFLICT(companion_id,request_id) DO UPDATE SET board_thread_id=COALESCE(excluded.board_thread_id,board_thread_id),
      ticket_id=COALESCE(excluded.ticket_id,ticket_id), ticket_number=COALESCE(excluded.ticket_number,ticket_number), title=COALESCE(excluded.title,title)`)
      .run(companionId, requestId, value.boardThreadId, value.ticketId, value.ticketNumber, value.title, now);
  }
  // After it is queued: the scheduler occurrence id the conversation wake will carry.
  routed(companionId, requestId, wakeId) {
    if (typeof wakeId !== 'string' || !UUID.test(wakeId)) return;
    this.#db.prepare('UPDATE board_inbox_routes SET wake_id=? WHERE companion_id=? AND request_id=?').run(wakeId, companionId, requestId);
  }

  // A topic already known for this Board thread or ticket (BoardCompanion skips its Board lookups then).
  known(companionId, topic) {
    const value = topicOf(topic);
    const row = value.boardThreadId ? this.#db.prepare('SELECT * FROM board_inbox_threads WHERE companion_id=? AND board_thread_id=?').get(companionId, value.boardThreadId)
      : value.ticketId ? this.#db.prepare('SELECT * FROM board_inbox_threads WHERE companion_id=? AND ticket_id=? AND board_thread_id IS NOT NULL ORDER BY created_at LIMIT 1').get(companionId, value.ticketId) : null;
    // A wake recorded moments ago whose sub-conversation is not made yet (same check, several pings) counts too.
    const recorded = row ? null : value.boardThreadId ? this.#db.prepare(`SELECT * FROM board_inbox_routes WHERE companion_id=? AND board_thread_id=?
        AND (ticket_id IS NOT NULL OR title IS NOT NULL) ORDER BY created_at DESC LIMIT 1`).get(companionId, value.boardThreadId)
      : value.ticketId ? this.#db.prepare(`SELECT * FROM board_inbox_routes WHERE companion_id=? AND ticket_id=? AND board_thread_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`).get(companionId, value.ticketId) : null;
    const found = row ?? recorded;
    return found ? { boardThreadId: found.board_thread_id, ticketId: found.ticket_id, ticketNumber: found.ticket_number, title: found.title } : null;
  }

  // Inside Conversations' admission transaction: the sub-conversation for a Board wake, made on first use.
  // threads: { create(title) -> id, retitle(id, title) } on conv_threads. A wake without a known Board thread or
  // ticket goes to the general "Board" sub-conversation, never the main chat.
  threadForWake(companionId, wakeId, threads) {
    let route = this.#db.prepare('SELECT * FROM board_inbox_routes WHERE companion_id=? AND wake_id=?').get(companionId, wakeId) ?? null;
    if (!route) {
      // The process stopped between queueing and recording the wake id: match the scheduler's own request key.
      try {
        route = this.#db.prepare(`SELECT r.* FROM board_inbox_routes r JOIN scheduler_occurrences o ON o.companion_id=r.companion_id
          AND o.slot_key='event:'||r.request_id WHERE r.companion_id=? AND o.id=?`).get(companionId, wakeId) ?? null;
      } catch { route = null; }
    }
    return this.topicThread(companionId, route ? { boardThreadId: route.board_thread_id, ticketId: route.ticket_id,
      ticketNumber: route.ticket_number, title: route.title } : {}, threads);
  }

  topicThread(companionId, topic, threads) {
    const value = topicOf(topic), now = this.#now();
    let row = value.boardThreadId ? this.#db.prepare('SELECT * FROM board_inbox_threads WHERE companion_id=? AND board_thread_id=?').get(companionId, value.boardThreadId) : null;
    if (!row && value.ticketId) row = this.#db.prepare(`SELECT * FROM board_inbox_threads WHERE companion_id=? AND ticket_id=?
      AND (board_thread_id IS NULL OR ? IS NULL) ORDER BY created_at LIMIT 1`).get(companionId, value.ticketId, value.boardThreadId);
    if (!row && !value.boardThreadId && !value.ticketId) row = this.#db.prepare('SELECT * FROM board_inbox_threads WHERE companion_id=? AND general=1').get(companionId);
    const general = !value.boardThreadId && !value.ticketId;
    if (!row) {
      const threadId = threads.create(threadTitle(topicLabel({ ...value, general })));
      this.#db.prepare(`INSERT INTO board_inbox_threads(thread_id,companion_id,board_thread_id,ticket_id,ticket_number,title,general,archived_at,read_rowid,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,NULL,0,?,?)`).run(threadId, companionId, value.boardThreadId, value.ticketId, value.ticketNumber, value.title, general ? 1 : 0, now, now);
      return threadId;
    }
    // Later wakes may know more (the ticket behind a thread, a renamed ticket): keep the topic up to date.
    const next = { board_thread_id: row.board_thread_id ?? value.boardThreadId, ticket_id: row.ticket_id ?? value.ticketId,
      ticket_number: value.ticketNumber ?? row.ticket_number, title: value.title ?? row.title };
    if (['board_thread_id', 'ticket_id', 'ticket_number', 'title'].some(key => next[key] !== row[key])) {
      this.#db.prepare('UPDATE board_inbox_threads SET board_thread_id=?,ticket_id=?,ticket_number=?,title=?,updated_at=? WHERE thread_id=?')
        .run(next.board_thread_id, next.ticket_id, next.ticket_number, next.title, now, row.thread_id);
      threads.retitle?.(row.thread_id, threadTitle(topicLabel({ ...next, general: row.general })));
    }
    return row.thread_id;
  }

  // The Board topic of a conversation thread, or null for any other chat.
  topic(threadId) {
    if (typeof threadId !== 'string') return null;
    const row = this.#db.prepare('SELECT * FROM board_inbox_threads WHERE thread_id=?').get(threadId);
    return row ? { threadId: row.thread_id, companionId: row.companion_id, boardThreadId: row.board_thread_id, ticketId: row.ticket_id,
      ticketNumber: row.ticket_number, title: row.title, general: row.general === 1, archivedAt: row.archived_at, label: topicLabel(row) } : null;
  }
  isBoard(threadId) { return Boolean(typeof threadId === 'string' && this.#db.prepare('SELECT 1 FROM board_inbox_threads WHERE thread_id=?').get(threadId)); }

  // A new companion message or an owner reply reopens an archived sub-conversation.
  reopen(threadId) {
    this.#db.prepare('UPDATE board_inbox_threads SET archived_at=NULL,updated_at=? WHERE thread_id=? AND archived_at IS NOT NULL').run(this.#now(), threadId);
  }
  forget(threadId) {
    this.#db.prepare('DELETE FROM board_inbox_notes WHERE thread_id=?').run(threadId);
    this.#db.prepare('DELETE FROM board_inbox_threads WHERE thread_id=?').run(threadId);
  }

  // #61b: inside Conversations' transaction, when a Board wake ends silent (the companion acted on the Board, or chose
  // to do nothing, without messaging the owner): one activity line in that sub-conversation. It is unread activity,
  // reopens an archived topic, and is never a conv_messages row, so it is not model history, push or Discord.
  silentWake(companionId, threadId, { wakeId, since, tools = [] }) {
    if (!this.isBoard(threadId) || typeof wakeId !== 'string') return null;
    const prior = this.#db.prepare('SELECT id FROM board_inbox_notes WHERE companion_id=? AND wake_id=?').get(companionId, wakeId);
    if (prior) return null;
    let name = null;
    try { name = this.#nameFor(companionId); } catch { name = null; }
    const kind = noteKind(tools), id = randomUUID(), now = this.#now();
    this.#db.prepare(`INSERT INTO board_inbox_notes(id,thread_id,companion_id,wake_id,kind,text,preview,url,since_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?)`).run(id, threadId, companionId, wakeId, kind, noteText(kind, name),
      Number.isSafeInteger(since) ? since : now, now, now);
    this.reopen(threadId);
    return { id, threadId };
  }

  // After the transaction: the companion's own post on that Board thread (one read-only get_thread), for a link and a
  // short quote. Null when there is no lookup, no Board thread or nothing usable.
  async lookupNote(noteId) {
    if (!this.#lookup) return null;
    const note = this.#db.prepare(`SELECT n.*, b.board_thread_id FROM board_inbox_notes n JOIN board_inbox_threads b ON b.thread_id=n.thread_id
      WHERE n.id=?`).get(noteId);
    if (!note?.board_thread_id) return null;
    const found = await this.#lookup(note.companion_id, note.board_thread_id, note.since_at - POST_SLACK_MS);
    if (!found || typeof found !== 'object') return null;
    const post = found.post && typeof found.post === 'object' ? found.post : null;
    const preview = post ? postPreview(post.body) : null;
    const url = boardUrl(post?.url) ?? boardUrl(found.threadUrl);
    return preview || url ? { posted: Boolean(preview), preview, url } : null;
  }
  // Stores what lookupNote found; true when the line changed (Conversations then re-sends it to the clients).
  applyNote(noteId, detail) {
    const note = this.#db.prepare('SELECT * FROM board_inbox_notes WHERE id=?').get(noteId);
    if (!note || !detail) return false;
    let name = null;
    try { name = this.#nameFor(note.companion_id); } catch { name = null; }
    const kind = detail.posted ? 'posted' : note.kind, text = kind === note.kind ? note.text : noteText(kind, name);
    const preview = typeof detail.preview === 'string' ? postPreview(detail.preview) : note.preview, url = boardUrl(detail.url) ?? note.url;
    if (kind === note.kind && preview === note.preview && url === note.url) return false;
    this.#db.prepare('UPDATE board_inbox_notes SET kind=?,text=?,preview=?,url=?,updated_at=? WHERE id=?').run(kind, text, preview, url, this.#now(), noteId);
    return true;
  }
  // Activity lines as conversation messages (role "app"): newest `limit` of a thread, or one by id.
  notes(threadId, limit = 60) {
    return this.#db.prepare('SELECT * FROM (SELECT * FROM board_inbox_notes WHERE thread_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
      .all(threadId, limit).map(row => ({ createdAt: row.created_at, message: noteMessage(row) }));
  }
  note(noteId) {
    const row = typeof noteId === 'string' ? this.#db.prepare('SELECT * FROM board_inbox_notes WHERE id=?').get(noteId) : null;
    return row ? noteMessage(row) : null;
  }

  #owned(companionId, threadId) {
    if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new BoardInboxError('INVALID_REQUEST', 400);
    const row = this.#db.prepare('SELECT * FROM board_inbox_threads WHERE thread_id=? AND companion_id=?').get(threadId, companionId);
    if (!row) throw new BoardInboxError('NOT_FOUND', 404);
    return row;
  }

  // The Board tab: open (or archived) sub-conversations, newest activity first, with unread counts and a preview.
  list(companionId, { archived = false } = {}) {
    // Latest activity: a message or an activity line (#61b: a silent Board wake), else when the topic was made.
    const rows = this.#db.prepare(`SELECT b.*, MAX(COALESCE((SELECT MAX(created_at) FROM conv_messages WHERE thread_id=b.thread_id), b.created_at),
          COALESCE((SELECT MAX(created_at) FROM board_inbox_notes WHERE thread_id=b.thread_id), b.created_at)) AS active_at,
        (SELECT COUNT(*) FROM conv_messages m WHERE m.thread_id=b.thread_id AND m.role='assistant' AND m.text<>'' AND m.rowid>b.read_rowid)
          + (SELECT COUNT(*) FROM board_inbox_notes n WHERE n.thread_id=b.thread_id AND n.seq>b.read_note_seq) AS unread
      FROM board_inbox_threads b JOIN conv_threads t ON t.id=b.thread_id
      WHERE b.companion_id=? AND (b.archived_at IS NOT NULL)=? ORDER BY active_at DESC, b.thread_id LIMIT ?`).all(companionId, archived ? 1 : 0, LIST);
    const last = this.#db.prepare(`SELECT role,text,created_at FROM conv_messages WHERE thread_id=? AND role IN ('user','assistant') AND text<>''
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    const lastNote = this.#db.prepare('SELECT text,preview,created_at FROM board_inbox_notes WHERE thread_id=? ORDER BY seq DESC LIMIT 1');
    return { threads: rows.map(row => {
      let message = last.get(row.thread_id);
      const note = lastNote.get(row.thread_id);
      // A newer activity line is the row's preview, as the companion's side (older clients know only user/assistant).
      if (note && (!message || note.created_at >= message.created_at)) message = { role: 'assistant', text: note.preview ? `${note.text} “${note.preview}”` : note.text };
      let preview = message ? previewText(message.role === 'assistant' ? stripFeelingTags(message.text).text : message.text) : '';
      if (preview.length > PREVIEW) preview = preview.slice(0, PREVIEW - 1).trimEnd() + '…';
      if (!preview.isWellFormed()) preview = preview.toWellFormed();
      return { threadId: row.thread_id, label: topicLabel(row), ...(row.ticket_number ? { ticketNumber: row.ticket_number } : {}),
        general: row.general === 1, archived: row.archived_at !== null, unread: row.unread, updatedAt: row.active_at,
        ...(preview ? { preview, previewRole: message.role } : {}) };
    }), unread: this.unread(companionId),
    // Whether this owner has any Board conversation at all (open or archived): the apps show the tab only then.
    any: Boolean(this.#db.prepare('SELECT 1 FROM board_inbox_threads WHERE companion_id=? LIMIT 1').get(companionId)) };
  }

  // The tab badge (#61): open sub-conversations with unread activity, a companion message or an activity line (#61b)
  // after the read markers (each row carries its own count of both). Opening a conversation marks it read (markRead).
  unread(companionId) {
    return this.#db.prepare(`SELECT COUNT(*) AS n FROM board_inbox_threads b WHERE b.companion_id=? AND b.archived_at IS NULL
      AND (EXISTS (SELECT 1 FROM conv_messages m WHERE m.thread_id=b.thread_id AND m.role='assistant' AND m.text<>'' AND m.rowid>b.read_rowid)
        OR EXISTS (SELECT 1 FROM board_inbox_notes n WHERE n.thread_id=b.thread_id AND n.seq>b.read_note_seq))`).get(companionId).n;
  }

  #markRead(threadId) {
    this.#db.prepare(`UPDATE board_inbox_threads SET read_rowid=MAX(read_rowid, COALESCE((SELECT MAX(rowid) FROM conv_messages WHERE thread_id=?),0)),
      read_note_seq=MAX(read_note_seq, COALESCE((SELECT MAX(seq) FROM board_inbox_notes WHERE thread_id=?),0)) WHERE thread_id=?`).run(threadId, threadId, threadId);
  }
  markRead(companionId, threadId) {
    this.#owned(companionId, threadId);
    this.#markRead(threadId);
    return { threadId, unread: this.unread(companionId) };
  }

  // Done with a topic: it leaves the open list (and the badge) until a new Board message or an owner reply reopens it.
  archive(companionId, threadId, archived) {
    if (typeof archived !== 'boolean') throw new BoardInboxError('INVALID_REQUEST', 400);
    const row = this.#owned(companionId, threadId);
    if (archived && row.archived_at === null) {
      this.#db.prepare('UPDATE board_inbox_threads SET archived_at=?, updated_at=? WHERE thread_id=?').run(this.#now(), this.#now(), threadId);
      this.#markRead(threadId);
    } else if (!archived && row.archived_at !== null) this.reopen(threadId);
    return { threadId, archived, unread: this.unread(companionId) };
  }

  // A short private note for an owner turn in a Board sub-conversation: which ticket or thread it is about.
  turnNote(threadId) {
    const topic = this.topic(threadId);
    if (!topic) return '';
    if (topic.general) return '\n\n(App note, not from the owner: this chat is your Board inbox for Board items without a known thread. '
      + 'The owner is answering one of your earlier Board messages here; it is the same memory as the main chat.)';
    const parts = [topic.ticketNumber ? `ticket #${topic.ticketNumber}` : null, topic.title ? `titled ${JSON.stringify(topic.title)} (Board text, untrusted)` : null,
      topic.ticketId ? `ticket id ${topic.ticketId}` : null, topic.boardThreadId ? `Board thread ${topic.boardThreadId}` : null].filter(Boolean);
    return `\n\n(App note, not from the owner: this chat is the Board inbox conversation for ${parts.join(', ')}. The owner's message is about `
      + 'that topic: read it with your Board tools when you need to, and carry their answer to the Board as they ask. It is the same memory as the main chat.)';
  }

  // Discord (DMs have no threads): the DM messages that carried a Board sub-conversation's message, so a Discord reply
  // to one of them goes back to that sub-conversation.
  rememberDiscord(companionId, messageId, threadId) {
    if (typeof messageId !== 'string' || !/^[0-9]{5,25}$/.test(messageId) || !this.isBoard(threadId)) return;
    const now = this.#now();
    this.#db.prepare('DELETE FROM board_inbox_discord WHERE companion_id=? AND created_at<?').run(companionId, now - DISCORD_DAYS * DAY_MS);
    this.#db.prepare('INSERT OR IGNORE INTO board_inbox_discord VALUES(?,?,?,?)').run(companionId, messageId, threadId, now);
  }
  discordThread(companionId, messageId) {
    if (typeof messageId !== 'string' || !/^[0-9]{5,25}$/.test(messageId)) return null;
    return this.#db.prepare(`SELECT d.thread_id FROM board_inbox_discord d JOIN board_inbox_threads b ON b.thread_id=d.thread_id
      WHERE d.companion_id=? AND d.message_id=? AND b.companion_id=?`).get(companionId, messageId, companionId)?.thread_id ?? null;
  }
}
