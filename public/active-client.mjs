// #59 (docs/PUSH.md): while this tab is in active use (visible, focused, input in the last 2 minutes) it tells the
// server every 20 s, with the companion conversation on screen. The server then holds pushes to the owner's other
// devices for a short while and drops them if this tab showed the message. Losing focus, hiding or closing the tab
// reports inactive at once (keepalive); a tab that just stops reporting stops counting after 50 s on the server.
export const INPUT_MS = 120_000, BEAT_MS = 20_000;
// No 'scroll': the chat scrolls itself when a message arrives, which is not the owner using it.
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

// api(body): the app's api/companion call. threadOnScreen(): the conversation shown right now, or null.
export function createActiveClient({ api, threadOnScreen = () => null, doc = globalThis.document, win = globalThis.window,
  now = () => Date.now(), keepalive = null, client = globalThis.crypto.randomUUID() } = {}) {
  let lastInput = now(), reported = false, reportedThread = null, timer = null, off = false, sending = null;
  const active = () => !off && doc.visibilityState === 'visible' && (typeof doc.hasFocus !== 'function' || doc.hasFocus()) && now() - lastInput < INPUT_MS;
  const thread = () => { try { return threadOnScreen() ?? null; } catch { return null; } };
  const body = (state, threadId) => ({ action: 'clientActive', client, active: state, ...(threadId ? { threadId } : {}) });

  // Input timeout: the owner walked away, so the conversation on screen does not count as seen.
  const timedOut = () => now() - lastInput >= INPUT_MS;
  async function beat() {
    if (!active()) return idle(!timedOut());
    const threadId = thread();
    reported = true; reportedThread = threadId;
    try { await (sending = api(body(true, threadId))); }
    catch (error) { if (error?.status === 400) { off = true; reported = false; stopTimer(); } /* an older server: stop asking */ }
    finally { sending = null; }
  }
  // Inactive now: told with keepalive so it still goes out while the page is being hidden or closed.
  function idle(seen = true) {
    stopTimer();
    if (!reported) return;
    reported = false;
    const message = body(false, seen ? reportedThread ?? thread() : null);
    reportedThread = null;
    if (keepalive) { keepalive(message); return; }
    try {
      fetch('api/companion', { method: 'POST', credentials: 'same-origin', keepalive: true, cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(message) }).catch(() => {});
    } catch { /* best effort: the server forgets the tab on its own */ }
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startTimer() { if (!timer) timer = setInterval(() => void beat(), BEAT_MS); }

  // Re-checks the state: a change (became active, other conversation on screen, went inactive) is reported at once.
  function update() {
    if (off) return;
    if (!active()) return idle(!timedOut());
    startTimer();
    if (!reported || thread() !== reportedThread) void beat();
  }
  function input() {
    lastInput = now();
    if (!reported && !sending) update();
  }
  for (const name of INPUTS) win.addEventListener(name, input, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', update);
  win.addEventListener('focus', () => { lastInput = now(); update(); });
  win.addEventListener('blur', () => idle());
  win.addEventListener('pagehide', () => idle());
  // The idle check: no input for INPUT_MS while still visible ends the active state.
  setInterval(() => { if (reported && !active()) idle(!timedOut()); }, 10_000);
  update();
  return { update, get reported() { return reported; } };
}
