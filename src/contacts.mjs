import { createHash } from 'node:crypto';

export const CONTACT_LIMITS = Object.freeze({ contacts: 32, textChars: 4000, textBytes: 16000, perHour: 20 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const ERRORS = {
  INVALID_REQUEST: [400, 'Check the contact request.'],
  CONTACT_NOT_FOUND: [404, 'That contact is unavailable.'],
  CONTACT_OFF: [409, 'Both owners must turn this contact on before a message can be sent. Nothing was queued.'],
  CONTACT_CHANGED: [409, 'Contact settings changed. Start a new owner reply before sending. Nothing was queued.'],
  CONTACT_CONFLICT: [409, 'Contact settings changed. Reload before trying again.'],
  CONTACT_TURN_ENDED: [409, 'This owner reply ended. Nothing was queued.'],
  CONTACT_RATE_LIMIT: [429, 'This contact reached its hourly message limit. Nothing was queued.'],
  CONTACT_UNAVAILABLE: [503, 'Contacts are unavailable right now.']
};
export class ContactError extends Error {
  constructor(code = 'CONTACT_UNAVAILABLE') { const key = Object.hasOwn(ERRORS, code) ? code : 'CONTACT_UNAVAILABLE'; super(ERRORS[key][1]); this.code = key; this.status = ERRORS[key][0]; }
}
const fail = code => { throw new ContactError(code); };
const fixed = error => error instanceof ContactError ? error : new ContactError();
const hash = value => createHash('sha256').update(value).digest('hex');
function id(value) { if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) fail('INVALID_REQUEST'); }
function requestId(value) { if (typeof value !== 'string' || value.length > 80 || REQUEST.exec(value)?.[0] !== value) fail('INVALID_REQUEST'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST');
  const fields = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(fields);
  if (own.length !== keys.length || own.some(k => !keys.includes(k) || !fields[k].enumerable || !Object.hasOwn(fields[k], 'value'))) fail('INVALID_REQUEST');
}
function text(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > CONTACT_LIMITS.textChars || Buffer.byteLength(value) > CONTACT_LIMITS.textBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('INVALID_REQUEST');
}
function label(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value !== value.trim() || value.length > 80 || Buffer.byteLength(value) > 320 || /[\x00-\x1f\x7f]/.test(value)) fail('CONTACT_UNAVAILABLE');
}

// The directory comes only from trusted configured/provisioned owners. Public
// owner HTTP can change toggles, never send, select a sender or select a runtime.
export class Contacts {
  #db; #directory; #deliver; #now;
  constructor({ store, directory, deliver, now = Date.now }) {
    this.#db = store.db; this.#directory = directory; this.#deliver = deliver; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS companion_contacts (
      owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY(owner_id,contact_id));
      CREATE TABLE IF NOT EXISTS companion_contact_receipts (
      sender_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, pair_key TEXT NOT NULL,
      message_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(sender_id,request_id));
      CREATE INDEX IF NOT EXISTS companion_contact_rate ON companion_contact_receipts(pair_key,sent_at);`);
  }
  #owners() {
    const owners = this.#directory();
    if (!Array.isArray(owners) || owners.length > CONTACT_LIMITS.contacts + 1) fail('CONTACT_UNAVAILABLE');
    const ids = new Set(); for (const owner of owners) { id(owner.id); label(owner.name); label(owner.ownerLabel); if (ids.has(owner.id)) fail('CONTACT_UNAVAILABLE'); ids.add(owner.id); }
    return owners;
  }
  #preference(owner, contact) {
    const row=this.#db.prepare('SELECT enabled,version FROM companion_contacts WHERE owner_id=? AND contact_id=?').get(owner,contact) ?? { enabled:0,version:0 };
    if(![0,1].includes(row.enabled)||!Number.isSafeInteger(row.version)||row.version<0) fail('CONTACT_UNAVAILABLE'); return row;
  }
  #pair(owner, contact) {
    id(owner); id(contact); const owners = this.#owners(), sender = owners.find(o => o.id === owner), recipient = owners.find(o => o.id === contact);
    if (!sender || !recipient || owner === contact) fail('CONTACT_NOT_FOUND');
    return { sender, recipient, own: this.#preference(owner,contact), other: this.#preference(contact,owner) };
  }
  snapshot(owner) {
    try {
      id(owner); const owners = this.#owners(); if (!owners.some(o=>o.id===owner)) return { contacts: [] };
      return { contacts: owners.filter(o=>o.id!==owner).sort((a,b)=>a.id.localeCompare(b.id)).map(o=>{
        const own=this.#preference(owner,o.id), other=this.#preference(o.id,owner);
        return { id:o.id,name:o.name,ownerLabel:o.ownerLabel,enabled:Boolean(own.enabled),peerEnabled:Boolean(other.enabled),revision:own.version };
      }) };
    } catch(error) { throw fixed(error); }
  }
  set(owner, input) {
    try {
      exact(input,['id','enabled','expectedRevision']); if (typeof input.enabled!=='boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0 || input.expectedRevision===Number.MAX_SAFE_INTEGER) fail('INVALID_REQUEST');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const pair=this.#pair(owner,input.id); if(pair.own.version!==input.expectedRevision) fail('CONTACT_CONFLICT');
        if(Boolean(pair.own.enabled)!==input.enabled) this.#db.prepare(`INSERT INTO companion_contacts VALUES(?,?,?,?) ON CONFLICT(owner_id,contact_id)
          DO UPDATE SET enabled=excluded.enabled,version=excluded.version`).run(owner,input.id,Number(input.enabled),pair.own.version+1);
        this.#db.exec('COMMIT');
      } catch(error) { this.#db.exec('ROLLBACK'); throw error; }
      return this.snapshot(owner);
    } catch(error) { throw fixed(error); }
  }
  forTurn(owner) {
    try { return this.snapshot(owner).contacts.filter(c=>c.enabled&&c.peerEnabled).map(c=>({...c,peerRevision:this.#preference(c.id,owner).version})); }
    catch(error) { throw fixed(error); }
  }
  // Called only through the app-owned active normal-turn token. No wake or
  // browser route can obtain one. Semantic owner intent follows AGENTS, not an
  // invented consent flag supplied by a model or a remembered preference.
  send(owner, input, turn) {
    try {
      exact(input,['requestId','to','text']); requestId(input.requestId); id(input.to); text(input.text);
      if(!turn || typeof turn.current!=='function' || !turn.current()) fail('CONTACT_TURN_ENDED');
      id(turn.threadId); requestId(turn.requestId);
      const permitted=turn.contacts?.find(c=>c.id===input.to); if(!permitted) fail('CONTACT_OFF');
      const scoped=hash(JSON.stringify([turn.threadId,turn.requestId,input.requestId]));
      const fingerprint=hash(JSON.stringify([input.to,input.text]));
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        if(!turn.current()) fail('CONTACT_TURN_ENDED'); const pair=this.#pair(owner,input.to);
        if(!pair.own.enabled||!pair.other.enabled) fail('CONTACT_OFF');
        if(pair.own.version!==permitted.revision||pair.other.version!==permitted.peerRevision) fail('CONTACT_CHANGED');
        const prior=this.#db.prepare('SELECT * FROM companion_contact_receipts WHERE sender_id=? AND request_id=?').get(owner,scoped);
        if(prior) {
          if(prior.fingerprint!==fingerprint) fail('CONTACT_CONFLICT'); this.#db.exec('COMMIT');
          return { sent:true,to:input.to,requestId:input.requestId,messageId:prior.message_id,duplicate:true };
        }
        const now=this.#now(); if(!Number.isSafeInteger(now)||now<0||now>8640000000000000) fail('CONTACT_UNAVAILABLE');
        const key=[owner,input.to].sort().join(':');
        if(this.#db.prepare('SELECT COUNT(*) AS n FROM companion_contact_receipts WHERE pair_key=? AND sent_at>?').get(key,now-3600000).n>=CONTACT_LIMITS.perHour) fail('CONTACT_RATE_LIMIT');
        if(!turn.current()) fail('CONTACT_TURN_ENDED');
        const deliver=(...args)=>{
          const result=this.#deliver(...args);
          if(result&&typeof result.then==='function') {Promise.resolve(result).catch(()=>{});fail('CONTACT_UNAVAILABLE');}
          id(result?.messageId); return result;
        };
        const sentAtISO=new Date(now).toISOString(), sent=deliver(owner,turn.threadId,input.text,{direction:'sent',companionId:input.to,name:pair.recipient.name,ownerLabel:pair.recipient.ownerLabel,sentAtISO});
        deliver(input.to,null,input.text,{direction:'received',companionId:owner,name:pair.sender.name,ownerLabel:pair.sender.ownerLabel,sentAtISO});
        this.#db.prepare('INSERT INTO companion_contact_receipts VALUES(?,?,?,?,?,?)').run(owner,scoped,fingerprint,key,sent.messageId,now);
        this.#db.exec('COMMIT'); return { sent:true,to:input.to,requestId:input.requestId,messageId:sent.messageId,duplicate:false };
      } catch(error) { this.#db.exec('ROLLBACK'); throw error; }
    } catch(error) { throw fixed(error); }
  }
}
