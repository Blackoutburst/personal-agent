// #110: what public/conversation-client.mjs accepts, enforced where text is written AND where it is emitted (old rows can
// predate a rule). Strips control characters the client rejects, repairs lone surrogates, and cuts to the character and byte
// limits without splitting a surrogate pair. Never throws; a value that is not a string becomes ''.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export function clientText(value, chars, bytes) {
  let text = typeof value === 'string' ? value.toWellFormed().replace(CONTROL, '') : '';
  if (text.length > chars) text = text.slice(0, chars);
  if (Buffer.byteLength(text) > bytes) {
    let low = 0, high = text.length;
    while (low < high) { const mid = (low + high + 1) >> 1; if (Buffer.byteLength(text.slice(0, mid)) <= bytes) low = mid; else high = mid - 1; }
    text = text.slice(0, low);
  }
  if (!text.isWellFormed()) text = text.slice(0, -1); // a cut that fell between the halves of a surrogate pair
  return text;
}
