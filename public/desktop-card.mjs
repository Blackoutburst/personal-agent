// Settings › "Windows app" card (#84, docs/DESKTOP.md): shown only in a desktop browser, never on a phone, a tablet or
// inside the Electron app itself (which has its own update banner), and only when the server has a build to offer.
export function isDesktopBrowser(userAgent) {
  const ua = String(userAgent ?? '');
  return /Windows|Macintosh|X11|Linux/.test(ua) && !/Android|iPhone|iPad|iPod|Mobile|Electron\//.test(ua);
}

export function cardText(release) {
  if (!release || typeof release.version !== 'string' || !release.version) return null;
  const megabytes = release.size ? ` · ${(release.size / 1048576).toFixed(1)} MB` : '';
  return `Download for Windows (${release.version}${megabytes})`;
}

// Fetches the version once per view of Settings; returns whether the card should show (and fills it in).
export async function showDesktopCard({ fetchImpl = globalThis.fetch, card, button, userAgent = globalThis.navigator?.userAgent, isCurrent = () => true }) {
  card.hidden = true;
  if (!isDesktopBrowser(userAgent)) return false;
  try {
    const response = await fetchImpl('api/desktop', { cache: 'no-store' });
    const release = response.ok ? await response.json() : null;
    const text = cardText(release);
    if (!isCurrent() || !text) return false;
    button.textContent = text;
    card.hidden = false;
    return true;
  } catch { return false; }
}
