// #59 (docs/PUSH.md): this tab tells the server how present the owner is, so pushes to their other devices wait.
// - active: visible, focused, input in the last 2 minutes. Reported every 20 s with the companion conversation on
//   screen, which then counts as seen (a held push for it is dropped).
// - open: signed in and open, but hidden, unfocused or idle. Reported every 30 s (a hidden tab's timers are throttled
//   to about once a minute; the server keeps an open tab for 150 s). Pushes are held 90 s, then delivered unless an
//   active client showed the message.
// - closed: the page is going away (pagehide) or signed out. Told at once with keepalive.
// Going from active to open or closed is also told at once with keepalive, so it still goes out while the page hides.
export const INPUT_MS = 120_000, BEAT_MS = 20_000, OPEN_BEAT_MS = 30_000, CHECK_MS = 10_000;
// No 'scroll': the chat scrolls itself when a message arrives, which is not the owner using it.
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

// api(body): the app's api/companion call. threadOnScreen(): the conversation shown right now, or null.
// signedIn(): whether there is an owner to report for (signed out: closed).
export function createActiveClient({ api, threadOnScreen = () => null, signedIn = () => true, doc = globalThis.document, win = globalThis.window,
  now = () => Date.now(), keepalive = null, client = globalThis.crypto.randomUUID() } = {}) {
  // reported: the state the server was last told (null: nothing, or closed). blurred: the window lost focus.
  let lastInput = now(), reported = null, reportedThread = null, lastSent = 0, timer = null, off = false, sending = null, blurred = false, gone = false;
  const focused = () => !blurred && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
  const active = () => doc.visibilityState === 'visible' && focused() && now() - lastInput < INPUT_MS;
  const desired = () => off || gone || !safe(signedIn) ? 'closed' : active() ? 'active' : 'open';
  const thread = () => { try { return threadOnScreen() ?? null; } catch { return null; } };
  const body = (state, threadId) => ({ action: 'clientActive', client, state, active: state === 'active', ...(threadId ? { threadId } : {}) });

  // Input timeout: the owner walked away, so the conversation on screen does not count as seen.
  const timedOut = () => now() - lastInput >= INPUT_MS;
  async function send(state, threadId) {
    reported = state; reportedThread = threadId; lastSent = now();
    try { await (sending = api(body(state, threadId))); }
    catch (error) { if (error?.status === 400) { off = true; reported = null; stopTimer(); } /* an older server: stop asking */ }
    finally { sending = null; }
  }
  async function beat() {
    if (desired() !== 'active') return update();
    await send('active', thread());
  }
  // Leaving the active state (or closing): told with keepalive so it still goes out while the page is being hidden or closed.
  function leave(state) {
    stopTimer();
    const seen = reported === 'active' && !timedOut() ? reportedThread ?? thread() : null;
    reported = state === 'closed' ? null : state; reportedThread = null; lastSent = now();
    const message = body(state, seen);
    if (keepalive) { keepalive(message); return; }
    try {
      fetch('api/companion', { method: 'POST', credentials: 'same-origin', keepalive: true, cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(message) }).catch(() => {});
    } catch { /* best effort: the server forgets the tab on its own */ }
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startTimer() { if (!timer) timer = setInterval(() => void beat(), BEAT_MS); }

  // Re-checks the state: a change (became active, other conversation on screen, went open or closed) is reported at once.
  function update() {
    if (off) return;
    const next = desired();
    if (next === 'active') {
      startTimer();
      if (reported !== 'active' || thread() !== reportedThread) void send('active', thread());
      return;
    }
    if (reported === 'active' || (next === 'closed' && reported)) return leave(next);
    stopTimer();
    if (next === 'open' && !reported && !sending) void send('open', null);
  }
  function input() {
    lastInput = now();
    if (reported !== 'active' && !sending) update();
  }
  for (const name of INPUTS) win.addEventListener(name, input, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', update);
  win.addEventListener('focus', () => { blurred = false; lastInput = now(); update(); });
  win.addEventListener('blur', () => { blurred = true; update(); });
  win.addEventListener('pagehide', () => { gone = true; update(); });
  // Back from the back/forward cache: open again.
  win.addEventListener('pageshow', event => { if (event?.persisted) { gone = false; update(); } });
  // The one slow check (the open beat adds no timer of its own): ends the active state after INPUT_MS without input,
  // and repeats the open report every OPEN_BEAT_MS. Hidden tabs run it about once a minute; the server allows for that.
  setInterval(() => {
    if (off) return;
    if (reported === 'active' && !active()) return update();
    if (sending || desired() !== 'open') return;
    if (!reported || now() - lastSent >= OPEN_BEAT_MS) void send('open', null);
  }, CHECK_MS);
  update();
  return { update, get reported() { return reported; } };
}
function safe(check) { try { return Boolean(check()); } catch { return false; } }
