// Splits a companion reply into chat bubbles, the way people send several short messages instead of one long one.
// A blank line starts a new bubble. A code block, or a list or table that runs on across blank lines, stays together.
// Shared by the web app and the Discord bridge; the Android app has the same rule (Bubbles.kt).
export const MAX_BUBBLES = 8;

const LISTY = /^\s*(?:[-*+•]\s|\d{1,3}[.)]\s|\|)/;

export function splitBubbles(text, max = MAX_BUBBLES) {
  if (typeof text !== 'string') return [];
  const parts = [];
  let current = [], fenced = false;
  const flush = () => {
    const chunk = current.join('\n').trim(); current = [];
    if (!chunk) return;
    const previous = parts.at(-1);
    // A list or table split by blank lines is still one message.
    if (previous !== undefined && LISTY.test(chunk) && LISTY.test(previous.split('\n').at(-1))) parts[parts.length - 1] = previous + '\n\n' + chunk;
    else parts.push(chunk);
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  // Past the limit, the rest stays in the last bubble rather than flooding the chat.
  if (parts.length > max) parts.splice(max - 1, parts.length, parts.slice(max - 1).join('\n\n'));
  return parts;
}

// While a reply is still being written: the part made of finished bubbles, i.e. everything before the last blank
// line that is not inside a code block. The bubble being written stays hidden until it is done, like a person
// who sends one text and then types the next.
export function finishedBubbles(text) {
  if (typeof text !== 'string') return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fenced = false, offset = 0, cut = 0, seenText = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) { if (seenText) cut = offset; }
    else seenText = true;
    offset += line.length + 1;
  }
  return text.replace(/\r\n?/g, '\n').slice(0, cut).trim();
}
