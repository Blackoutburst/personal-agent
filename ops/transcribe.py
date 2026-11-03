#!/usr/bin/env python3
"""Speech to text for X videos (#46): transcribe.py <model dir> <16 kHz mono wav> prints {"language", "text"} as JSON.
Uses faster-whisper on the CPU (int8); the model folder is downloaded once (docs/RUNTIME.md)."""
import json, sys
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[1], device='cpu', compute_type='int8', cpu_threads=4)
segments, info = model.transcribe(sys.argv[2], beam_size=1, vad_filter=True)
text = ' '.join(segment.text.strip() for segment in segments).strip()
print(json.dumps({'language': info.language, 'text': text[:20000]}))
