import test from 'node:test';
import assert from 'node:assert/strict';
import { isDesktopBrowser, cardText, showDesktopCard } from '../public/desktop-card.mjs';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
test('the Windows app card is for desktop browsers only', () => {
  assert.ok(isDesktopBrowser(WIN));
  assert.ok(isDesktopBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1'));
  assert.ok(isDesktopBrowser('Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0'));
  for (const ua of ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile Safari/537.36', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_0) Safari/604.1', WIN + ' Companion/0.1.0 Electron/45.3.0', '', undefined]) assert.equal(isDesktopBrowser(ua), false, String(ua));
});
test('the card shows the version when the server offers a build, and stays hidden otherwise', async () => {
  assert.equal(cardText({ version: '0.2.0', size: 2097152 }), 'Download for Windows (0.2.0 · 2.0 MB)');
  assert.equal(cardText({}), null);
  const make = () => ({ card: { hidden: true }, button: { textContent: '' } });
  const reply = (ok, body) => async () => ({ ok, json: async () => body });
  let ui = make();
  assert.equal(await showDesktopCard({ ...ui, userAgent: WIN, fetchImpl: reply(true, { version: '0.2.0', size: 1048576 }) }), true);
  assert.equal(ui.card.hidden, false); assert.equal(ui.button.textContent, 'Download for Windows (0.2.0 · 1.0 MB)');
  ui = make(); ui.card.hidden = false;
  assert.equal(await showDesktopCard({ ...ui, userAgent: WIN, fetchImpl: reply(false, null) }), false); assert.equal(ui.card.hidden, true);
  ui = make();
  let called = false;
  assert.equal(await showDesktopCard({ ...ui, userAgent: 'iPhone', fetchImpl: async () => { called = true; } }), false);
  assert.equal(called, false); assert.equal(ui.card.hidden, true);
  ui = make();
  assert.equal(await showDesktopCard({ ...ui, userAgent: WIN, fetchImpl: reply(true, { version: '0.2.0' }), isCurrent: () => false }), false); assert.equal(ui.card.hidden, true);
});
