#!/usr/bin/env python3
"""Speech to text with NVIDIA Nemotron 3.5 ASR (nvidia/nemotron-3.5-asr-streaming-0.6b), docs/RUNTIME.md.

asr.py <model dir> — a long-lived worker. Each stdin line is {"id", "wav", "language"?} (a 16 kHz mono WAV the app made
with ffmpeg; language a locale such as "fr-FR", default "auto"). Each answer is one stdout line {"id", "text", "language"}
or {"id", "error"}. The model loads once, on the GPU when there is one (falling back to the CPU if it runs out of
memory), and the app stops the worker when it has been idle for a while. Long audio is cut at quiet points into
pieces of at most ~40 s, transcribed in order and joined. Prints nothing else on stdout.
"""
import json, re, sys, os

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForRNNT, AutoProcessor  # noqa: E402
from transformers.audio_utils import load_audio  # noqa: E402

MODEL_DIR = sys.argv[1]
PIECE_S, SEARCH_S = 40, 6
TAG = re.compile(r'\s*<([a-z]{2}(?:-[A-Z]{2})?)>\s*')

processor = AutoProcessor.from_pretrained(MODEL_DIR)
model = AutoModelForRNNT.from_pretrained(MODEL_DIR).eval()
device = 'cuda' if torch.cuda.is_available() else 'cpu'
try:
    model.to(device)
except Exception:  # noqa: BLE001 - no room on the GPU: the CPU is fast enough for messages
    device = 'cpu'; model.to(device)
RATE = processor.feature_extractor.sampling_rate


def pieces(audio):
    """Cuts long audio at the quietest 100 ms window in the last SEARCH_S seconds before each PIECE_S boundary."""
    out, start, total = [], 0, len(audio)
    while total - start > PIECE_S * RATE:
        end = start + PIECE_S * RATE
        window = audio[end - SEARCH_S * RATE:end]
        step = RATE // 10
        energy = [float(np.mean(window[i:i + step] ** 2)) for i in range(0, len(window) - step, step)]
        cut = end - SEARCH_S * RATE + int(np.argmin(energy)) * step + step // 2
        out.append(audio[start:cut]); start = cut
    out.append(audio[start:])
    return [piece for piece in out if len(piece) >= RATE // 5]


def transcribe(piece, language):
    global device, model
    inputs = processor(piece, sampling_rate=RATE, language=language, return_tensors='pt')
    try:
        with torch.inference_mode():
            result = model.generate(**inputs.to(device))
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache(); device = 'cpu'; model.to(device)
        with torch.inference_mode():
            result = model.generate(**inputs.to(device))
    raw = processor.batch_decode(result.sequences, skip_special_tokens=False)[0]
    found = TAG.findall(raw)
    text = processor.batch_decode(result.sequences, skip_special_tokens=True)[0]
    return TAG.sub(' ', text).strip(), (found[-1] if found else None)


for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        language = request.get('language') or 'auto'
        if not re.fullmatch(r'auto|[a-z]{2}(-[A-Z]{2})?', language):
            raise ValueError('language')
        audio = load_audio(request['wav'], sampling_rate=RATE)
        texts, detected = [], None
        for piece in pieces(np.asarray(audio, dtype=np.float32)):
            text, tag = transcribe(piece, language)
            if text: texts.append(text)
            detected = detected or tag
        answer = {'id': request.get('id'), 'text': ' '.join(texts)[:20000], 'language': detected or (None if language == 'auto' else language)}
    except Exception as error:  # noqa: BLE001 - one bad file never stops the worker
        answer = {'id': request.get('id'), 'error': type(error).__name__}
    sys.stdout.write(json.dumps(answer) + '\n'); sys.stdout.flush()
