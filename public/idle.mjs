// Idle performance (#60, docs/CONVERSATION-UI.md): an open but idle tab should cost next to nothing, so a video in
// another tab keeps all its frames. Three pieces, all pure or with injected timers so they can be tested:
// - idleDelay: how long to wait before the next read. Fast right after something happened (the owner used the page,
//   a message arrived), then backing off 5 s → 15 s → 30 s while nothing happens.
// - createActivity: when the owner last used the page; input, focus and coming back to the tab "wake" it.
// - createMotion: the companion's idle animation (breathing) runs for a little while after something happens and
//   then rests (paused animations produce no frames); a blink is a single attribute flip every few seconds.

// quietMs: time since the owner last used the page or the conversation last changed. fast: the delay while active.
export const IDLE_STEPS = Object.freeze([[20_000, null], [60_000, 5_000], [180_000, 15_000]]);
export const IDLE_MAX_MS = 30_000;
export function idleDelay(quietMs, fast = 2_000) {
  const quiet = Number.isFinite(quietMs) && quietMs > 0 ? quietMs : 0;
  for (const [until, delay] of IDLE_STEPS) if (quiet < until) return Math.max(fast, delay ?? fast);
  return Math.max(fast, IDLE_MAX_MS);
}

// No 'scroll' or 'pointermove': only deliberate use of the page counts (like #59's active client).
export const ACTIVITY_INPUTS = Object.freeze(['pointerdown', 'keydown', 'wheel', 'touchstart']);

// onWake(listener): called after input, focus or the tab becoming visible again (at most once per WAKE_GAP_MS for input).
export function createActivity({ doc = globalThis.document, win = globalThis.window, now = () => Date.now() } = {}) {
  let last = now(), lastWake = 0;
  const listeners = new Set();
  const visible = () => doc?.visibilityState !== 'hidden';
  const focused = () => typeof doc?.hasFocus !== 'function' || doc.hasFocus();
  function wake(reason) {
    last = now();
    if (reason === 'input' && last - lastWake < 1_000) return;
    lastWake = last;
    for (const listener of listeners) { try { listener(reason); } catch { /* one view cannot stop the others */ } }
  }
  for (const name of ACTIVITY_INPUTS) win?.addEventListener?.(name, () => wake('input'), { capture: true, passive: true });
  win?.addEventListener?.('focus', () => wake('focus'));
  doc?.addEventListener?.('visibilitychange', () => { if (visible()) wake('visible'); });
  return {
    touch() { last = now(); },
    quietMs: () => Math.max(0, now() - last),
    visible, focused,
    onWake(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

// The companion's motion. busy(): a reply is running (thinking/talking faces keep moving). Sets on the root element
// data-motion="awake" while it may move and data-blink while blinking; the CSS pauses every character animation otherwise.
export const AWAKE_MS = 12_000, BLINK_MS = 160;
export function createMotion({ root = globalThis.document?.documentElement, win = globalThis.window, activity, busy = () => false,
  setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis), random = Math.random,
  reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) } = {}) {
  let restTimer = null, blinkTimer = null, awake = false;
  const set = (name, on) => { if (!root) return; if (on) { if (!(name in root.dataset)) root.dataset[name] = name === 'motion' ? 'awake' : ''; } else if (name in root.dataset) delete root.dataset[name]; };
  function rest() {
    clearTimer(restTimer); restTimer = null;
    if (busy() && activity.visible()) { restTimer = setTimer(rest, AWAKE_MS); return; }
    awake = false; set('motion', false);
  }
  // Something happened: move for a while, then rest. Hidden tabs never move.
  function wake() {
    if (!activity.visible() || reducedMotion()) { rest(); return; }
    awake = true; set('motion', true);
    clearTimer(restTimer); restTimer = setTimer(rest, AWAKE_MS);
    scheduleBlink();
  }
  function scheduleBlink() {
    if (blinkTimer || !activity.visible() || reducedMotion()) return;
    blinkTimer = setTimer(() => {
      blinkTimer = null;
      if (!activity.visible()) return;
      set('blink', true);
      setTimer(() => { set('blink', false); scheduleBlink(); }, BLINK_MS);
    }, 3_500 + Math.floor(random() * 4_000));
  }
  activity.onWake(reason => wake(reason));
  // Leaving the window: rest at once unless a reply is running. Hidden: nothing is drawn anyway; the blink loop stops.
  win?.addEventListener?.('blur', () => { if (!busy()) rest(); });
  wake();
  return {
    wake, rest,
    // A reply started or a mood changed: keep moving while it runs.
    update() { if (busy() && !awake) wake(); },
    get awake() { return awake; }
  };
}
