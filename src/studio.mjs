// Private, read-only Studio mailbox view. No mail scan, send, suppression or handling operations here.
import { companionIdFor } from './runtime-config.mjs';

const DAY = 86_400_000;
const EVENTS = `WITH events AS (
 SELECT s.company,s.to_addr AS address,s.subject,s.created_at AS at,'sent' AS direction,s.request_id AS id,
   s.kind,s.state,0 AS automatic,0 AS opted_out,NULL AS handled_at,a.text
 FROM mail_sent s LEFT JOIN mail_archive a ON a.companion_id=s.companion_id AND a.direction='sent' AND a.id=s.request_id
 WHERE s.companion_id=?
 UNION ALL
 SELECT a.company,m.from_addr,m.subject,COALESCE(m.sent_at,m.received_at),'received',m.id,
   NULL,'received',m.auto_reply,m.opt_out,m.handled_at,a.text
 FROM mail_messages m JOIN mail_archive a ON a.companion_id=m.companion_id AND a.direction='received' AND a.id=m.id
 WHERE m.companion_id=? AND a.company IS NOT NULL
)`;
export class StudioError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export class Studio {
  constructor({ store, owners, now = Date.now }) { this.store = store; this.owners = owners; this.now = now; }
  scope(viewerId) {
    const viewer = this.owners.find(owner => companionIdFor(this.store, owner) === viewerId);
    const source = viewer && this.owners.find(owner => owner.mail?.studioViewers.includes(viewer.label));
    const id = source && companionIdFor(this.store, source);
    if (!id) throw new StudioError('STUDIO_FORBIDDEN', 403);
    return { id, config: source.mail };
  }
  list(viewerId) {
    const { id, config } = this.scope(viewerId), db = this.store.db;
    const rows = db.prepare(EVENTS + ` SELECT company,MAX(at) AS last_at,
      MIN(CASE WHEN direction='sent' AND kind='first' AND state!='failed' THEN at END) AS first_at,
      MAX(CASE WHEN direction='sent' AND state!='failed' THEN at END) AS last_sent,
      MAX(CASE WHEN direction='received' AND automatic=0 THEN at END) AS last_reply,
      SUM(direction='sent' AND state='sent') AS sent,SUM(direction='received') AS received,
      SUM(state='pending') AS uncertain,SUM(state='failed') AS failed,
      COALESCE(SUM(kind='follow_up' AND state!='failed'),0) AS follow_ups
      FROM events GROUP BY company ORDER BY last_at DESC,company LIMIT 201`).all(id, id);
    const suppressions = new Set(db.prepare('SELECT entry FROM mail_suppressed WHERE companion_id=?').all(id).map(row => row.entry));
    const today = db.prepare(`SELECT COUNT(*) AS n FROM mail_sent WHERE companion_id=? AND state!='failed' AND created_at>?`).get(id, this.now() - DAY).n;
    const contacts = rows.slice(0, 200).map(row => {
      const addresses = db.prepare(EVENTS + ' SELECT DISTINCT address FROM events WHERE company=? ORDER BY address').all(id, id, row.company)
        .map(item => ({ address: item.address, optedOut: suppressions.has(item.address) || suppressions.has(row.company) }));
      const optedOut = suppressions.has(row.company) || addresses.some(item => item.optedOut);
      const eligibleAt = row.last_sent === null ? null : row.last_sent + 3 * DAY;
      const replied = row.last_reply !== null && (row.first_at === null || row.last_reply >= row.first_at);
      const followUp = optedOut ? 'opted_out' : row.uncertain ? 'uncertain' : replied ? 'replied' : row.first_at === null ? 'not_contacted'
        : row.follow_ups >= config.limits.followUps ? 'used' : eligibleAt > this.now() ? 'waiting' : today >= config.limits.perDay ? 'daily_limit' : 'eligible';
      return { company: row.company, addresses, lastAt: new Date(row.last_at).toISOString(), sent: row.sent, received: row.received,
        failed: row.failed, uncertain: row.uncertain, replied, optedOut, followUps: row.follow_ups, followUp,
        eligibleAt: ['waiting', 'daily_limit', 'eligible'].includes(followUp) ? new Date(eligibleAt).toISOString() : null };
    });
    const missingReceived = db.prepare(`SELECT COUNT(*) AS n FROM mail_messages m LEFT JOIN mail_archive a
      ON a.companion_id=m.companion_id AND a.direction='received' AND a.id=m.id WHERE m.companion_id=? AND a.id IS NULL`).get(id).n;
    const missingSent = db.prepare(`SELECT COUNT(*) AS n FROM mail_sent s LEFT JOIN mail_archive a
      ON a.companion_id=s.companion_id AND a.direction='sent' AND a.id=s.request_id WHERE s.companion_id=? AND a.id IS NULL`).get(id).n;
    return { address: config.address, contacts, limited: rows.length > 200, sentLast24h: today, perDay: config.limits.perDay,
      provenance: { missingReceived, missingSent, text: 'Historique du connecteur Studio. Les anciens envois peuvent ne conserver que leurs métadonnées. Les réponses sont ajoutées par le traitement mail habituel ; cette vue ne relève pas la boîte.' } };
  }
  detail(viewerId, company, offset = 0) {
    const { id } = this.scope(viewerId);
    if (typeof company !== 'string' || !company || company.length > 254 || /[\s\u0000-\u001f]/u.test(company)
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new StudioError('INVALID_REQUEST');
    const rows = this.store.db.prepare(EVENTS + ' SELECT * FROM events WHERE company=? ORDER BY at DESC,direction,id LIMIT 51 OFFSET ?').all(id, id, company, offset);
    if (!rows.length && offset === 0) throw new StudioError('STUDIO_NOT_FOUND', 404);
    const messages = rows.slice(0, 50).reverse().map(row => ({ id: row.id, direction: row.direction, address: row.address,
      subject: row.subject, at: new Date(row.at).toISOString(), kind: row.kind, state: row.state,
      automatic: Boolean(row.automatic), optedOut: Boolean(row.opted_out), handled: row.handled_at !== null,
      text: row.text ?? null }));
    return { company, messages, nextOffset: rows.length > 50 ? offset + 50 : null };
  }
}
export function createStudioHttp({ access, studio }) {
  return async request => {
    const parsed = await access.read(request, 2048);
    if (parsed.failure) return parsed.failure;
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    try {
      const value = parsed.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('INVALID_REQUEST');
      const only = keys => Object.keys(value).every(key => keys.includes(key));
      const id = admitted.companionId;
      if (value.action === 'access' && only(['action'])) { studio.scope(id); return { status: 200, body: { allowed: true } }; }
      if (value.action === 'list' && only(['action'])) return { status: 200, body: studio.list(id) };
      if (value.action === 'detail' && only(['action', 'company', 'offset'])) return { status: 200, body: studio.detail(id, value.company, value.offset) };
      throw new StudioError('INVALID_REQUEST');
    } catch (error) {
      return { status: error instanceof StudioError ? error.status : 503, body: { error: {
        code: error instanceof StudioError ? error.code : 'STUDIO_UNAVAILABLE', message: 'La vue Studio n’est pas disponible pour cette demande.' } } };
    }
  };
}
