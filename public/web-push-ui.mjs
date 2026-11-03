// Notifications for the installed web app (docs/PUSH.md), in Me › Settings. On iPhone, Web Push only works once the
// app is added to the Home Screen and opened from there, so Safari gets that hint instead of the switches.
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const b64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Opening the app clears its notifications.
  const clear = () => { if (document.visibilityState === 'visible') navigator.serviceWorker.ready
    .then(registration => registration.getNotifications()).then(list => list.forEach(item => item.close())).catch(() => {}); };
  document.addEventListener('visibilitychange', clear); clear();
}

export function createWebPushUI({ document, api }) {
  const $ = id => document.getElementById(id);
  const box = $('web-push'), text = $('web-push-text'), enabled = $('web-push-enabled'), preview = $('web-push-preview'), status = $('web-push-status');
  let busy = false, epoch = 0;

  const setControls = (on, showPreview, visible = true) => {
    enabled.closest('label').hidden = !visible; preview.closest('label').hidden = !visible || !on;
    enabled.checked = on; preview.checked = showPreview; enabled.disabled = preview.disabled = busy;
  };
  const current = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();
  const save = async subscription => {
    const json = subscription.toJSON();
    return api({ action: 'webPushSubscribe', endpoint: subscription.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, preview: preview.checked });
  };

  // keep: leave the last result ("Notifications are on…", or an error) showing.
  async function show({ keep = false } = {}) {
    const mine = ++epoch;
    box.hidden = false; if (!keep) status.textContent = '';
    if (!supported()) {
      text.textContent = ios() && !standalone()
        ? 'To get notifications on iPhone, add this app to your Home Screen: tap Share, then “Add to Home Screen”, and open it from there.'
        : 'This browser can’t show notifications.';
      return setControls(false, true, false);
    }
    if (Notification.permission === 'denied') {
      text.textContent = 'Notifications are blocked for this app. Allow them in the system or browser settings, then come back.';
      return setControls(false, true, false);
    }
    text.textContent = 'Get a notification when your companion messages you, including reminders and watches.';
    setControls(enabled.checked, preview.checked);
    try {
      const subscription = await current();
      const state = subscription ? await api({ action: 'webPushStatus', endpoint: subscription.endpoint }) : { subscribed: false };
      if (mine !== epoch) return;
      setControls(Boolean(state.subscribed) && Notification.permission === 'granted', state.preview ?? true);
    } catch { if (mine === epoch) status.textContent = 'Notification settings could not be loaded.'; }
  }

  async function turnOn() {
    // Asked first, straight from the tap: Safari only shows the prompt for a user gesture.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { status.textContent = 'Notifications were not allowed.'; return; }
    const { publicKey } = await api({ action: 'webPushKey' });
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && b64(subscription.options?.applicationServerKey ?? new ArrayBuffer(0)) !== publicKey) { await subscription.unsubscribe(); subscription = null; }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await save(subscription);
    status.textContent = 'Notifications are on for this device.';
  }

  async function turnOff() {
    const subscription = await current();
    if (subscription) { await api({ action: 'webPushUnsubscribe', endpoint: subscription.endpoint }); await subscription.unsubscribe().catch(() => {}); }
    status.textContent = 'Notifications are off for this device.';
  }

  async function run(task) {
    if (busy) return;
    busy = true; enabled.disabled = preview.disabled = true; status.textContent = '';
    try { await task(); } catch { status.textContent = 'That didn’t work. Check the connection and try again.'; }
    busy = false; await show({ keep: true });
  }

  enabled.addEventListener('change', () => run(enabled.checked ? turnOn : turnOff));
  preview.addEventListener('change', () => run(async () => { const subscription = await current(); if (subscription) await save(subscription); }));
  // The browser replaced the subscription: save the new one if notifications were allowed.
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type !== 'push-resubscribe' || Notification.permission !== 'granted') return;
    void run(turnOn);
  });
  return { show: () => show(), hide: () => { box.hidden = true; epoch++; } };
}
