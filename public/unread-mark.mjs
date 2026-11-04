// Unread mark for the web tab (#59 follow-up, docs/PUSH.md): a new companion message that arrives while the tab is
// hidden or unfocused, or in a conversation that is not on screen, puts a red dot on the favicon, "(•) " in front of
// the title and, where supported, the installed app's badge. It clears when the owner views that conversation (tab
// visible and focused on it). Event driven only: arrivals come from the app's onDataArrived hook, clearing is checked
// on visibilitychange, focus and view changes. No timers, nothing animates; the dot is one static image.
export const TITLE_MARK = '(•) ';

// The title with the mark, or without it (an old mark is never doubled).
export function markTitle(title, marked) {
  const base = String(title ?? '').startsWith(TITLE_MARK) ? String(title).slice(TITLE_MARK.length) : String(title ?? '');
  return marked ? TITLE_MARK + base : base;
}

// Where the dot goes on a size×size icon: top right, a fifth of the icon wide, with a white ring.
export function dotGeometry(size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  return { x: size - radius - Math.max(1, Math.round(size * 0.02)), y: radius + Math.max(1, Math.round(size * 0.02)), radius, ring: Math.max(1, Math.round(size * 0.06)) };
}

// The default drawing: the original icon on a canvas plus the dot, as a data URL. Null if it cannot be drawn.
export function canvasDot({ doc = globalThis.document, Image = globalThis.Image, size = 64 } = {}) {
  return href => new Promise(resolve => {
    if (!doc?.createElement || typeof Image !== 'function') return resolve(null);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = doc.createElement('canvas'); canvas.width = size; canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, size, size);
        const { x, y, radius, ring } = dotGeometry(size);
        context.beginPath(); context.arc(x, y, radius + ring, 0, Math.PI * 2); context.fillStyle = '#ffffff'; context.fill();
        context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fillStyle = '#e5322d'; context.fill();
        resolve(canvas.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    image.onerror = () => resolve(null);
    image.src = href;
  });
}

// seeing(source, detail): whether that conversation is on screen in a visible, focused tab. baseTitle(): the title
// without the mark. draw(href): a data URL of the icon with the dot (canvasDot by default).
export function createUnreadMark({ doc = globalThis.document, win = globalThis.window, nav = globalThis.navigator,
  seeing = () => false, baseTitle = () => doc?.title ?? '', draw = canvasDot({ doc }) } = {}) {
  const pending = new Set();
  const link = doc?.querySelector?.('link[rel="icon"]') ?? null;
  const original = link?.getAttribute('href') ?? null;
  let dotted = null, drawing = null, shown = false;
  const marked = () => pending.size > 0;
  const looking = (source, detail) => { try { return Boolean(seeing(source, detail)); } catch { return false; } };

  async function icon() {
    if (!link || original === null) return;
    if (!marked()) { if (link.getAttribute('href') !== original) link.setAttribute('href', original); return; }
    if (!dotted) {
      drawing ??= Promise.resolve().then(() => draw(original)).catch(() => null);
      const url = await drawing; drawing = null;
      if (!url) return;
      dotted = url;
    }
    // Cleared while the dot was being drawn: nothing to show.
    if (marked() && link.getAttribute('href') !== dotted) link.setAttribute('href', dotted);
  }
  function badge(on) {
    try {
      if (on && typeof nav?.setAppBadge === 'function') nav.setAppBadge().catch?.(() => {});
      else if (!on && typeof nav?.clearAppBadge === 'function') nav.clearAppBadge().catch?.(() => {});
    } catch { /* not supported here */ }
  }
  function render() {
    const on = marked();
    const title = markTitle(baseTitle(), on);
    if (doc && doc.title !== title) doc.title = title;
    if (on !== shown) { shown = on; badge(on); }
    void icon();
  }
  // A new companion message ({source, detail} from onDataArrived): marked unless its conversation is being looked at.
  function arrived({ source, detail = null } = {}) {
    if (looking(source, detail)) return;
    pending.add(source + ':' + (detail ?? ''));
    render();
  }
  // Something on screen changed: drop the marks of the conversations now being looked at.
  function check() {
    if (!pending.size) return;
    let changed = false;
    for (const key of pending) {
      const at = key.indexOf(':'), source = key.slice(0, at), detail = key.slice(at + 1) || null;
      if (looking(source, detail)) { pending.delete(key); changed = true; }
    }
    if (changed) render();
  }
  function clear() { if (!pending.size) return; pending.clear(); render(); }
  doc?.addEventListener?.('visibilitychange', check);
  win?.addEventListener?.('focus', check);
  return { arrived, check, clear, title: base => markTitle(base, marked()), get marked() { return marked(); }, get count() { return pending.size; } };
}
