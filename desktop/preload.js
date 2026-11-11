'use strict';
// Sandboxed preload: watches the page's own arrival announcement (companion-app.mjs sets
// <html data-companion-arrival> and fires 'companion-arrival') and forwards only that small payload to the main process.
const { ipcRenderer } = require('electron');
document.addEventListener('companion-arrival', () => {
  try { ipcRenderer.send('companion:arrival', document.documentElement.dataset.companionArrival || ''); } catch {}
}, true);
