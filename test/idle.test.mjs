import test from 'node:test';
import assert from 'node:assert/strict';
import { idleDelay, IDLE_MAX_MS, createActivity, createMotion, AWAKE_MS, BLINK_MS } from '../public/idle.mjs';
import { createGroupUI } from '../public/group-ui.mjs';

// Fake timers: run(ms) advances the clock and fires what is due, in order.
function clock() {
  let at = 0, id = 0; const timers = new Map();
  return {
    now: () => at,
    setTimer(run, ms) { timers.set(++id, { run, due: at + ms, ms }); return id; },
    clearTimer(key) { timers.delete(key); },
    pending: () => [...timers.values()].map(timer => timer.ms),
    async run(ms) {
      const end = at + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        timers.delete(next[0]); at = next[1].due; await next[1].run();
        for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
      }
      at = end;
    }
  };
}
function target() {
  const listeners = new Map();
  return { listeners, addEventListener(name, run) { listeners.set(name, [...(listeners.get(name) ?? []), run]); },
    fire(name) { for (const run of listeners.get(name) ?? []) run(); } };
}

test('idle reads back off from fast to 5 s, 15 s and at most 30 s, and never go below the fast delay', () => {
  assert.equal(idleDelay(0), 2000);
  assert.equal(idleDelay(19_999), 2000);
  assert.equal(idleDelay(20_000), 5000);
  assert.equal(idleDelay(59_999), 5000);
  assert.equal(idleDelay(60_000), 15_000);
  assert.equal(idleDelay(180_000), IDLE_MAX_MS);
  assert.equal(idleDelay(24 * 3600_000), 30_000);
  assert.equal(idleDelay(0, 1500), 1500);
  assert.equal(idleDelay(NaN), 2000);
  assert.equal(idleDelay(-5), 2000);
  // Over a quiet 10 minutes the open chat reads 40 times instead of 200 (every 3 s before #60), then twice a minute.
  let quiet = 0, reads = 0;
  while (quiet < 600_000) { quiet += idleDelay(quiet); reads++; }
  assert.equal(reads, 40);
});

test('activity: input, focus and coming back wake listeners; quiet time counts from the last use', () => {
  let at = 1000;
  const doc = Object.assign(target(), { visibilityState: 'visible', hasFocus: () => true }), win = target();
  const activity = createActivity({ doc, win, now: () => at });
  const woken = []; activity.onWake(reason => woken.push(reason));
  at = 31_000; assert.equal(activity.quietMs(), 30_000);
  win.fire('keydown'); assert.equal(activity.quietMs(), 0); assert.deepEqual(woken, ['input']);
  at += 200; win.fire('pointerdown'); assert.deepEqual(woken, ['input'], 'input wakes at most once a second');
  at += 5000; win.fire('focus'); doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
  doc.visibilityState = 'visible'; doc.fire('visibilitychange');
  assert.deepEqual(woken, ['input', 'focus', 'visible']);
  assert.ok(!win.listeners.has('scroll') && !win.listeners.has('pointermove'));
});

test('motion: awake after something happens, rests after a while, blinks by attribute, and stays still when hidden', async () => {
  const time = clock(), root = { dataset: {} }, win = target();
  let visible = true, busy = false, reduced = false, wake;
  const activity = { visible: () => visible, onWake(run) { wake = run; } };
  const motion = createMotion({ root, win, activity, busy: () => busy, setTimer: time.setTimer, clearTimer: time.clearTimer, random: () => 0, reducedMotion: () => reduced });
  assert.equal(root.dataset.motion, 'awake');
  let blinks = 0;
  for (let ms = 0; ms < AWAKE_MS; ms += 100) { await time.run(100); if ('blink' in root.dataset) blinks++; }
  assert.equal(root.dataset.motion, undefined, 'rests after AWAKE_MS');
  assert.ok(blinks >= 3 * Math.floor(BLINK_MS / 100), 'blinks while awake');
  // Resting: still blinks (a single attribute flip), but nothing loops.
  let seen = 0;
  for (let ms = 0; ms < 8_000; ms += 50) { await time.run(50); if ('blink' in root.dataset) seen++; }
  assert.ok(seen >= 2 && seen <= 2 * Math.ceil(BLINK_MS / 50), `blinked for ${seen * 50} ms`); assert.equal(root.dataset.motion, undefined);
  // A reply running keeps her moving past AWAKE_MS.
  busy = true; motion.update(); assert.equal(root.dataset.motion, 'awake');
  await time.run(AWAKE_MS * 3); assert.equal(root.dataset.motion, 'awake');
  busy = false; await time.run(AWAKE_MS); assert.equal(root.dataset.motion, undefined);
  // Leaving the window rests at once.
  wake('focus'); assert.equal(root.dataset.motion, 'awake'); win.fire('blur'); assert.equal(root.dataset.motion, undefined);
  // Hidden: no wake, and the blink loop stops.
  visible = false; wake('input'); assert.equal(root.dataset.motion, undefined);
  await time.run(20_000); assert.deepEqual(time.pending(), []);
  // Reduced motion: never awake, never blinks.
  visible = true; reduced = true; wake('visible'); assert.equal(root.dataset.motion, undefined); await time.run(20_000); assert.ok(!('blink' in root.dataset));
});

test('an open group backs off while nothing happens, speeds up on new messages and input, and reads once a minute when hidden', async () => {
  const time = clock(), GROUP = '0b5c9a52-3f0e-4c41-9a3b-1f2e3d4c5b6a';
  const document = { visibilityState: 'visible', getElementById: () => null, createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {} }), createTextNode: text => text };
  let quiet = 10 ** 9, wake = null, seq = 1;
  const activity = { quietMs: () => quiet, onWake(run) { wake = run; } };
  const calls = [], arrivals = [];
  const call = async body => {
    calls.push({ action: body.action, at: time.now() });
    const me = { id: 'o1', kind: 'owner', name: 'Me', you: true };
    if (body.action === 'snapshot') return { group: { name: 'G', members: [me], notify: 'all' }, messages: [{ id: 'm1', seq: 1, authorId: 'o1', text: 'hi', createdAt: 0 }], cursor: 1 };
    if (body.action === 'events') return { messages: body.cursor < seq ? [{ id: 'm' + seq, seq, authorId: 'o1', text: 'new', createdAt: 0 }] : [], cursor: seq, hasMore: false };
    return { unread: 0 };
  };
  const ui = createGroupUI({ document, call, activity, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, onNewData: id => arrivals.push(id), navigate() {} });
  await ui.open(GROUP);
  const reads = () => calls.filter(item => item.action === 'events').map(item => item.at);
  await time.run(600_000);
  const quietReads = reads().length;
  assert.ok(quietReads <= 45, `${quietReads} reads in 10 quiet minutes (400 at the old fixed 1.5 s)`);
  assert.equal(time.pending()[0], 30_000);
  // A new message: the next reads are fast again and the arrival hook fires once.
  seq = 2; while (!arrivals.length) await time.run(100);
  assert.deepEqual(arrivals, [GROUP]);
  assert.equal(time.pending()[0], 1500);
  // Input while backed off brings the next read forward.
  await time.run(400_000); assert.equal(time.pending()[0], 30_000);
  quiet = 0; wake('input'); assert.equal(time.pending()[0], 1500);
  // Hidden: once a minute, still reading.
  quiet = 10 ** 9; document.visibilityState = 'hidden'; const before = reads().length;
  await time.run(180_000); assert.equal(reads().length - before, 3); assert.equal(time.pending()[0], 60_000);
  ui.close(); assert.deepEqual(time.pending(), []);
});
