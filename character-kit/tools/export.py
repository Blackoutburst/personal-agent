#!/usr/bin/env python3
"""Exports a finished character folder in the apps' format: outfits (whole pictures), faces (patches drawn over
any outfit) and front layers (hat brims or bangs drawn over the face), all 512px WebP.

  export.py <character dir> <out dir>
Writes <out dir>/<id>/{faces,outfits,fronts}/*.webp (id from character.json) and copies character.json next to
them. Send that folder (zipped) to whoever runs your companion server: see HANDBOOK.md, "Adding it to the app"."""
import json, os, shutil, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import art

root, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
info = json.load(open(os.path.join(root, 'character.json')))
target = os.path.join(out, info['id'])

def save(im, kind, name):
    os.makedirs(os.path.join(target, kind), exist_ok=True)
    im.resize((512, 512), Image.LANCZOS).save(os.path.join(target, kind, name + '.webp'), quality=88, method=4)

faces = [k for k, *_ in art.APP[1:]] + [k for k, _ in art.FEELINGS]
missing = [k for k in faces if not os.path.exists(art.face_file(root, k))] + \
          [k for _, items in art.OUTFITS for k, _ in items if not os.path.exists(art.outfit_file(root, k))]
if missing: sys.exit('missing pictures: ' + ', '.join(missing))
for key in faces: save(art.patch(root, art.face_file(root, key)), 'faces', key)
empty = 0
for _, items in art.OUTFITS:
    for key, _ in items:
        src = art.outfit_file(root, key)
        save(Image.open(src).convert('RGBA'), 'outfits', key)
        if key == 'base': continue
        layer = art.front(root, src)
        if layer is None: layer = Image.new('RGBA', Image.open(src).size, (0, 0, 0, 0)); empty += 1
        save(layer, 'fronts', key)
shutil.copy(os.path.join(root, 'character.json'), target)
print(target, len(faces), 'faces;', empty, 'outfits need no front layer')
