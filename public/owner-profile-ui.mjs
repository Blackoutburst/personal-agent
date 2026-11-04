const PHOTO_BYTES = 192 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export async function prepareOwnerPhoto(file, { document = globalThis.document, createBitmap = globalThis.createImageBitmap } = {}) {
  if (!file || !PHOTO_TYPES.includes(file.type) || file.size > 10 * 1024 * 1024) throw Error('Choose a JPEG, PNG or WebP picture under 10 MB.');
  let bitmap;
  try { bitmap = await createBitmap(file); } catch { throw Error('That picture could not be read. Try a JPEG, PNG or WebP picture.'); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 32000 || bitmap.height > 32000) throw Error('Choose a smaller picture.');
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .65]) {
      const uri = canvas.toDataURL('image/jpeg', quality), base64 = uri.split(',')[1];
      if (uri.startsWith('data:image/jpeg;base64,') && base64?.length <= 4 * Math.ceil(PHOTO_BYTES / 3)) return { mime: 'image/jpeg', base64 };
    }
    throw Error('That picture is still too large. Choose a smaller one.');
  } finally { bitmap.close?.(); }
}
function checked(value) {
  const p = value?.profile, photo = value?.photo;
  if (!p || typeof p.id !== 'string' || !/^[a-f0-9-]{36}$/.test(p.id) || typeof p.displayName !== 'string' || !p.displayName.trim()
    || p.displayName.length > 80 || !Number.isSafeInteger(p.revision) || p.revision < 0 || !(p.photoVersion === null || /^[a-f0-9]{64}$/.test(p.photoVersion))
    || !(photo === null || photo && PHOTO_TYPES.includes(photo.mime) && typeof photo.base64 === 'string' && photo.base64.length <= 4 * Math.ceil(PHOTO_BYTES / 3)
      && /^[A-Za-z0-9+/]+={0,2}$/.test(photo.base64)) || (p.photoVersion === null) !== (photo === null)) throw Error('INVALID_RESPONSE');
  return value;
}
export function createOwnerProfileUI({ document, fetchImpl = fetch, onDenied = () => {}, preparePhoto = file => prepareOwnerPhoto(file, { document }) }) {
  const home = document.getElementById('owner-profile-home'); if (!home) return { show: async () => {}, clear() {} };
  const node = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  let epoch = 0, request = 0, selected = 0, current = null, draftPhoto, busy = false, needsReload = false;
  const form = node('form', { className: 'owner-profile-form' }), picture = node('img', { className: 'owner-profile-photo', alt: 'Your profile picture', hidden: true });
  const placeholder = node('span', { className: 'owner-profile-placeholder', textContent: 'You' });
  const label = node('label', { textContent: 'Your display name' }), input = node('input', { type: 'text', maxLength: 80, required: true, autoComplete: 'nickname' }); label.append(input);
  const picker = node('input', { type: 'file', accept: PHOTO_TYPES.join(',') }); picker.setAttribute('aria-label', 'Choose your profile picture');
  const remove = node('button', { type: 'button', className: 'text-button', textContent: 'Remove picture' });
  const save = node('button', { type: 'submit', className: 'button primary', textContent: 'Save profile', disabled: true });
  const reload = node('button', { type: 'button', className: 'button', textContent: 'Reload profile' });
  const note = node('p', { className: 'note', role: 'status', hidden: true });
  const actions = node('div', { className: 'actions' }); actions.append(save, reload);
  form.append(picture, placeholder, label, picker, remove, actions, note); home.replaceChildren(form);
  function controls() { input.disabled = picker.disabled = remove.disabled = busy || !current; save.disabled = busy || !current || needsReload; reload.disabled = busy; }
  function notice(text) { note.textContent = text; note.hidden = !text; }
  function preview(photo) {
    picture.hidden = !photo; placeholder.hidden = Boolean(photo); remove.hidden = !photo;
    if (photo) picture.src = `data:${photo.mime};base64,${photo.base64}`; else picture.removeAttribute('src');
  }
  async function api(body) {
    const response = await fetchImpl('api/owner-profile', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) { const error = Error(value.error?.code ?? 'PROFILE_UNAVAILABLE'); error.status = response.status; throw error; }
    return checked(value);
  }
  function denied(error) {
    if (error.status === 401 || error.status === 403) { clear(); onDenied(error.message); return true; } return false;
  }
  async function show() {
    const owner = epoch, token = ++request; selected++; busy = true; controls(); notice('Loading your profile…');
    try {
      const result = await api({ action: 'get' }); if (owner !== epoch || token !== request) return;
      current = result; needsReload = false; draftPhoto = undefined; input.value = result.profile.displayName; picker.value = ''; preview(result.photo); notice('');
    } catch (error) { if (owner === epoch && token === request && !denied(error)) notice('Your profile could not be loaded. Try Reload profile.'); }
    finally { if (owner === epoch && token === request) { busy = false; controls(); } }
  }
  async function pick() {
    if (busy || !current) return;
    const owner = epoch, token = ++selected, file = picker.files?.[0]; if (!file) return;
    busy = true; controls(); notice('Preparing your picture…');
    try {
      const photo = await preparePhoto(file); if (owner !== epoch || token !== selected) return;
      draftPhoto = photo; preview(photo); notice('Picture ready. Save profile to keep it.');
    } catch (error) { if (owner === epoch && token === selected) notice(error.message === 'INVALID_RESPONSE' ? 'That picture could not be read.' : error.message); }
    finally { if (owner === epoch && token === selected) { busy = false; picker.value = ''; controls(); } }
  }
  async function submit(event) {
    event.preventDefault(); if (busy || !current || needsReload || !input.value.trim()) return;
    const owner = epoch, token = ++request; busy = true; controls(); notice('Saving…');
    try {
      const result = await api({ action: 'set', displayName: input.value.trim(), expectedRevision: current.profile.revision,
        ...(draftPhoto !== undefined ? { photo: draftPhoto } : {}) });
      if (owner !== epoch || token !== request) return;
      current = result; draftPhoto = undefined; input.value = result.profile.displayName; preview(result.photo); notice('Profile saved.');
    } catch (error) {
      if (owner !== epoch || token !== request || denied(error)) return;
      needsReload = true;
      notice(error.message === 'PROFILE_CONFLICT' ? 'Your profile changed elsewhere. Your draft is still here; reload the saved profile before another edit.'
        : 'The save was not confirmed. Your draft is still here. Reload to check the saved profile before trying again.');
    } finally { if (owner === epoch && token === request) { busy = false; controls(); } }
  }
  function clear() { epoch++; request++; selected++; current = null; draftPhoto = undefined; busy = false; needsReload = false; input.value = ''; picker.value = ''; preview(null); notice(''); controls(); }
  picker.addEventListener('change', () => { void pick(); });
  remove.addEventListener('click', () => { if (busy || !current) return; selected++; draftPhoto = null; preview(null); notice('Picture removed from the draft. Save profile to keep this change.'); });
  reload.addEventListener('click', () => { if (!busy) void show(); }); form.addEventListener('submit', event => { void submit(event); });
  controls(); return { show, clear };
}
