// Service worker for the installed web app (docs/PUSH.md): push notifications, and the last loaded app shell when the
// server can't be reached. The network always wins, so a deploy is picked up on the next load. The API is never cached.
const SHELL = 'companion-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)
      || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        event.waitUntil(caches.open(SHELL).then(cache => cache.put(request, copy)));
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' })
        ?? (request.mode === 'navigate' ? await caches.match(self.registration.scope) : undefined);
      if (cached) return cached;
      throw error;
    }
  })());
});

// The payload is {type, threadId, messageId, title, body}, encrypted by the server for this browser only.
self.addEventListener('push', event => event.waitUntil((async () => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* shown as a plain new message */ }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const subscription = await self.registration.pushManager.getSubscription();
  // Skip it while the app is open and in front. Safari may revoke a subscription whose pushes show nothing, so on Apple's
  // push service it is still shown; opening the app clears it.
  const apple = /(^|\.)push\.apple\.com$/.test(new URL(subscription?.endpoint ?? 'https://invalid/').hostname);
  if (!apple && windows.some(client => client.visibilityState === 'visible' && client.focused)) return;
  await self.registration.showNotification(String(data.title || 'Your companion').slice(0, 60), {
    body: String(data.body || 'New message').slice(0, 200), tag: data.messageId ? `message-${data.messageId}` : undefined,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { threadId: data.threadId ?? null } });
})()));

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL('./#chat', self.registration.scope).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => client.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); if ('navigate' in open && !open.url.endsWith('#chat')) await open.navigate(target).catch(() => {}); return; }
    await self.clients.openWindow(target);
  })());
});

// The browser rotated the subscription: tell the app's next load to save the new one.
self.addEventListener('pushsubscriptionchange', event => event.waitUntil((async () => {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'push-resubscribe' });
})()));
