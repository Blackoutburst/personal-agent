// Texting like a person: how long the companion waits for the owner to finish a burst of short texts,
// and the notes that tell it how its turn came about. Pure functions; Conversations applies them.

// The companion's whole reply when nothing needs saying. Never shown or sent.
export const NO_REPLY = 'NO_REPLY';

// How long after this message to wait for another one, when the owner is not (or no longer) typing.
// base is the normal wait. A message that looks finished gets a shorter one; a fragment ("Yes the message sli",
// "and", "so…") or a file on its own, which is usually followed by text, gets a longer one.
const TRAILING = /(?:[,:;…]|\.\.|\b(?:and|but|or|so|because|cause|like|then|if|when|et|mais|ou|donc|car|parce|genre|puis|si|quand))$/i;
export function quietWindow(text, { files = 0, base = 3500 } = {}) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return files ? base * 2 : base;
  const words = value.split(/\s+/).length;
  if (TRAILING.test(value)) return base * 2;
  if (words <= 3 && !/[?!.)]$/u.test(value) && !/\p{Extended_Pictographic}$/u.test(value)) return base * 2;
  if (/[?!]$/.test(value) || (/[.)]$/.test(value) && words >= 4) || /\p{Extended_Pictographic}$/u.test(value)) return Math.round(base * 0.5);
  return base;
}

// A reply that is only NO_REPLY (after any feeling tag) sends nothing. A trailing NO_REPLY line is dropped.
export function withoutSilence(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/(?:^|\n)\s*NO_REPLY\s*$/, '').trimEnd();
}
// While streaming: could this still turn out to be NO_REPLY? Then nothing is shown yet.
export const maybeSilent = text => { const value = text.trim(); return value.length > 0 && (NO_REPLY.startsWith(value) || value.startsWith(NO_REPLY)); };

export const BURST_NOTE = count => `\n\n(App note, not from the owner: these are ${count} texts they sent in a row, oldest first. ` +
  'Read them all and answer once, like a friend reading a burst of texts, not one by one.)';
export const FOLLOW_UP_NOTE = '\n\n(App note, not from the owner: they sent this while you were still replying or right after your last reply, ' +
  'so they may not have read it yet. Don\'t repeat or re-acknowledge what you already said; add only what is new. ' +
  `If nothing needs saying, your whole reply is ${NO_REPLY}.)`;
