#!/usr/bin/env python3
"""Builds public/character-kit.zip (the character handbook on the Look page) from character-kit/.

  build-character-kit.py           write the zip
  build-character-kit.py --check   exit 1 if the committed zip differs from character-kit/ (run by the tests)
The zip is reproducible: sorted entries, fixed timestamps, no caches."""
import io, os, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE, TARGET, PREFIX = os.path.join(ROOT, 'character-kit'), os.path.join(ROOT, 'public', 'character-kit.zip'), 'companion-character-kit/'

def build():
    files = sorted(os.path.relpath(os.path.join(d, f), SOURCE) for d, dirs, names in os.walk(SOURCE)
                   for f in names if '__pycache__' not in d and not f.endswith('.pyc'))
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            info = zipfile.ZipInfo(PREFIX + rel.replace(os.sep, '/'), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if rel.endswith('.png') else zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if rel.endswith('.py') else 0o644) << 16
            z.writestr(info, open(os.path.join(SOURCE, rel), 'rb').read())
    return out.getvalue()

data = build()
if '--check' in sys.argv:
    same = os.path.exists(TARGET) and open(TARGET, 'rb').read() == data
    print('character-kit.zip', 'up to date' if same else 'is stale: run ops/build-character-kit.py')
    sys.exit(0 if same else 1)
open(TARGET, 'wb').write(data)
print(TARGET, len(data), 'bytes')
