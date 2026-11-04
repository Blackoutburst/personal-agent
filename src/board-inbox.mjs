// Board inbox (#55, docs/BOARD-INBOX.md): the companion's Board messages (Needs-you requests, mentions, pings to the
// owner) no longer land in the owner's main chat. Each Board thread or ticket gets its own sub-conversation, an
// ordinary conv_threads row so history, files, typing and streaming reuse Conversations. This module owns only the
// additive tables that say which conversation is which Board topic, its unread marker and whether it is archived.
//
// Rollback: nothing here alters a legacy table. A Board sub-conversation row in conv_threads carries archived_at
// from the moment it is made, so an older release (which knows nothing of these tables) shows it as a read-only
// past chat and never as the ongoing chat or in its open chat list.
import { stripFeelingTags } from './wardrobe.mjs';
import { previewText } from './web-push.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE_DAYS = 30, DISCORD_DAYS = 90, DAY_MS = 86_400_000, LIST = 200, PREVIEW = 140;

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
const threadTitle = label => {
  let title = label.slice(0, 80);
  if (!title.isWellFormed()) title = title.slice(0, -1);
  return title.trim() || 'Board';
};

export class BoardInbox {
  #db; #now;
  constructor({ store, now = Date.now }) {
    this.#db = store.db; this.#now = now;
    this.#db.exec(SCHEMA);
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
  forget(threadId) { this.#db.prepare('DELETE FROM board_inbox_threads WHERE thread_id=?').run(threadId); }

  #owned(companionId, threadId) {
    if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new BoardInboxError('INVALID_REQUEST', 400);
    const row = this.#db.prepare('SELECT * FROM board_inbox_threads WHERE thread_id=? AND companion_id=?').get(threadId, companionId);
    if (!row) throw new BoardInboxError('NOT_FOUND', 404);
    return row;
  }

  // The Board tab: open (or archived) sub-conversations, newest activity first, with unread counts and a preview.
  list(companionId, { archived = false } = {}) {
    const rows = this.#db.prepare(`SELECT b.*, COALESCE((SELECT MAX(created_at) FROM conv_messages WHERE thread_id=b.thread_id), b.created_at) AS active_at,
        (SELECT COUNT(*) FROM conv_messages m WHERE m.thread_id=b.thread_id AND m.role='assistant' AND m.text<>'' AND m.rowid>b.read_rowid) AS unread
      FROM board_inbox_threads b JOIN conv_threads t ON t.id=b.thread_id
      WHERE b.companion_id=? AND (b.archived_at IS NOT NULL)=? ORDER BY active_at DESC, b.thread_id LIMIT ?`).all(companionId, archived ? 1 : 0, LIST);
    const last = this.#db.prepare(`SELECT role,text FROM conv_messages WHERE thread_id=? AND role IN ('user','assistant') AND text<>''
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    return { threads: rows.map(row => {
      const message = last.get(row.thread_id);
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

  // The tab badge (#61): open sub-conversations with at least one unread companion message (each row carries its own
  // message count). Opening a conversation marks it read (markRead), so it leaves the badge.
  unread(companionId) {
    return this.#db.prepare(`SELECT COUNT(*) AS n FROM board_inbox_threads b WHERE b.companion_id=? AND b.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM conv_messages m WHERE m.thread_id=b.thread_id AND m.role='assistant' AND m.text<>'' AND m.rowid>b.read_rowid)`).get(companionId).n;
  }

  markRead(companionId, threadId) {
    this.#owned(companionId, threadId);
    this.#db.prepare(`UPDATE board_inbox_threads SET read_rowid=MAX(read_rowid, COALESCE((SELECT MAX(rowid) FROM conv_messages WHERE thread_id=?),0))
      WHERE thread_id=? AND companion_id=?`).run(threadId, threadId, companionId);
    return { threadId, unread: this.unread(companionId) };
  }

  // Done with a topic: it leaves the open list (and the badge) until a new Board message or an owner reply reopens it.
  archive(companionId, threadId, archived) {
    if (typeof archived !== 'boolean') throw new BoardInboxError('INVALID_REQUEST', 400);
    const row = this.#owned(companionId, threadId);
    if (archived && row.archived_at === null) {
      this.#db.prepare(`UPDATE board_inbox_threads SET archived_at=?, updated_at=?, read_rowid=MAX(read_rowid, COALESCE((SELECT MAX(rowid) FROM conv_messages WHERE thread_id=?),0))
        WHERE thread_id=?`).run(this.#now(), this.#now(), threadId, threadId);
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
