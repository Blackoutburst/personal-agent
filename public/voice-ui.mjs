// Voice messages in the web app: the mic in the composer (shown instead of Send while the box is empty, like Discord),
// the recording bar, and the voice message player in the chat. The companion reads a transcript made on the server.
export const VOICE_MAX_MS = 5 * 60_000;

// The recording format this browser can make: Opus in WebM (Chrome, Firefox, Android) or AAC in MP4 (Safari, iPhone).
export function voiceFormat(Recorder = globalThis.MediaRecorder) {
  if (!Recorder) return null;
  for (const [mime, ext] of [['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']]) {
    if (Recorder.isTypeSupported?.(mime)) return { mime, ext };
  }
  return { mime: '', ext: 'webm' };
}

export const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// bar: the recording bar element with .voice-time, .voice-cancel and .voice-send inside.
// onStart/onStop: the composer switches between the text box and the bar. onRecorded(file, durationMs): send it.
// onProblem(text): a short note (no microphone, permission refused).
export function createVoiceRecorder({ bar, onStart = () => {}, onStop = () => {}, onRecorded, onProblem = () => {},
  media = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder, now = () => Date.now() }) {
  const time = bar.querySelector('.voice-time');
  let recorder = null, stream = null, chunks = [], started = 0, ticker = null, keep = false, limit = null;
  const supported = () => Boolean(media?.getUserMedia && Recorder);
  const release = () => {
    clearInterval(ticker); clearTimeout(limit); ticker = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null; recorder = null;
    bar.hidden = true; onStop();
  };
  async function start() {
    if (recorder) return;
    if (!supported()) { onProblem('Voice messages need a browser with microphone recording.'); return; }
    const format = voiceFormat(Recorder);
    try { stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { onProblem('Allow the microphone for this site to record a voice message.'); return; }
    chunks = []; keep = false; started = now();
    try { recorder = new Recorder(stream, format.mime ? { mimeType: format.mime, audioBitsPerSecond: 48000 } : undefined); }
    catch { release(); onProblem('This browser could not start recording.'); return; }
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onstop = () => {
      const duration = now() - started, type = recorder?.mimeType || format.mime || 'audio/webm';
      const ext = /mp4|aac|m4a/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      const parts = chunks; chunks = [];
      release();
      if (!keep) return;
      if (duration < 500 || !parts.length) { onProblem('That was too short to send.'); return; }
      onRecorded(new File(parts, `Voice message.${ext}`, { type: type.split(';')[0] }), duration);
    };
    recorder.start(1000);
    bar.hidden = false; onStart();
    const tick = () => { time.textContent = clock(now() - started); };
    tick(); ticker = setInterval(tick, 250);
    limit = setTimeout(() => finish(true), VOICE_MAX_MS);
  }
  function finish(send) {
    if (!recorder) return;
    keep = send;
    try { recorder.state !== 'inactive' ? recorder.stop() : recorder.onstop(); } catch { release(); }
  }
  bar.querySelector('.voice-cancel').addEventListener('click', () => finish(false));
  bar.querySelector('.voice-send').addEventListener('click', () => finish(true));
  return Object.freeze({ start, cancel: () => finish(false), send: () => finish(true), recording: () => Boolean(recorder), supported });
}

// A voice message in the chat: play/pause, a progress bar you can tap to seek, the length, and the transcript on demand.
// src: the playable AAC version (/api/files/<id>/voice).
export function voiceView(document, file, src) {
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
  const total = file.voice?.durationMs ?? 0;
  const audio = el('audio', { preload: 'none', src });
  const play = el('button', { type: 'button', className: 'voice-play', ariaLabel: 'Play voice message', textContent: '▶' });
  const fill = el('span', { className: 'voice-fill' });
  const track = el('span', { className: 'voice-track' }, fill);
  const length = el('span', { className: 'voice-length', textContent: clock(total) });
  const row = el('div', { className: 'voice-message' }, play, track, length, audio);
  const box = el('div', { className: 'voice-box' }, row);
  const duration = () => Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : total;
  const show = () => {
    const at = audio.currentTime * 1000;
    fill.style.width = `${Math.min(100, duration() ? at / duration() * 100 : 0)}%`;
    length.textContent = audio.paused && !at ? clock(total) : clock(at);
  };
  play.addEventListener('click', () => {
    if (audio.paused) {
      for (const other of document.querySelectorAll('.voice-message audio')) if (other !== audio) other.pause();
      audio.play().catch(() => { length.textContent = 'Can’t play'; });
    } else audio.pause();
  });
  audio.addEventListener('play', () => { play.textContent = '❚❚'; play.ariaLabel = 'Pause voice message'; });
  audio.addEventListener('pause', () => { play.textContent = '▶'; play.ariaLabel = 'Play voice message'; show(); });
  audio.addEventListener('ended', () => { audio.currentTime = 0; show(); });
  audio.addEventListener('timeupdate', show);
  track.addEventListener('click', event => {
    const box = track.getBoundingClientRect(), ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)));
    if (duration()) { audio.currentTime = ratio * duration() / 1000; show(); }
  });
  if (file.voice?.transcript) {
    const text = el('p', { className: 'voice-transcript', hidden: true, textContent: file.voice.transcript });
    const toggle = el('button', { type: 'button', className: 'text-button voice-toggle', textContent: 'Transcript' });
    toggle.addEventListener('click', () => { text.hidden = !text.hidden; toggle.textContent = text.hidden ? 'Transcript' : 'Hide transcript'; });
    box.append(toggle, text);
  }
  return box;
}
