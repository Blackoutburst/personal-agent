#!/usr/bin/env python3
"""Finds a character's eyes and mouth from where her expression edits differ from base.png
(eyes and mouth change in nearly every edit; hair edges only flicker). Writes face.json."""
import glob, json, os, sys
import numpy as np
from PIL import Image, ImageFilter

def faces(root):
    return [os.path.join(root, n + '.png') for n in ['blink', 'talk', 'listening', 'thinking', 'happy', 'sleepy']] + sorted(glob.glob(os.path.join(root, 'expr', '*.png')))

def find(root):
    base = np.asarray(Image.open(os.path.join(root, 'base.png')).convert('RGBA')).astype(int)
    files = [f for f in faces(root) if os.path.exists(f)]
    count = sum(((np.abs(np.asarray(Image.open(f).convert('RGBA')).astype(int) - base).sum(-1)) > 90).astype(np.int32) for f in files)
    heat = Image.fromarray((count * 255 // len(files)).astype('uint8'))
    solid = np.asarray(heat.point(lambda v: 255 if v > 90 else 0).filter(ImageFilter.MinFilter(9)))  # thin hair edges vanish
    h, w = solid.shape
    ys, xs = np.where(solid > 0)
    keep = (ys > h * .2) & (ys < h * .75) & (xs > w * .2) & (xs < w * .8)
    pts = np.stack([xs[keep], ys[keep]], 1).astype(float)
    # Three clusters: left eye, right eye, mouth (below and between the eyes).
    cy = np.median(pts[:, 1]); top = pts[pts[:, 1] <= cy + 40]
    cx = np.median(top[:, 0])
    left, right = top[top[:, 0] < cx], top[top[:, 0] >= cx]
    for _ in range(10):
        le, re = left.mean(0), right.mean(0)
        both = np.concatenate([left, right]); d = np.linalg.norm(le - re)
        near = both[np.minimum(np.linalg.norm(both - le, axis=1), np.linalg.norm(both - re, axis=1)) < d * .45]
        left, right = near[near[:, 0] < (le[0] + re[0]) / 2], near[near[:, 0] >= (le[0] + re[0]) / 2]
    le, re = left.mean(0), right.mean(0); d = float(np.linalg.norm(le - re))
    # The mouth changes in fewer edits than the eyes: look for it with a lower bar, between and below the eyes.
    soft = np.asarray(heat.point(lambda v: 255 if v > 50 else 0).filter(ImageFilter.MinFilter(5)))
    sy, sx = np.where(soft > 0); mid = (le[0] + re[0]) / 2
    sel = (sy > max(le[1], re[1]) + d * .25) & (sy < max(le[1], re[1]) + d * .8) & (np.abs(sx - mid) < d * .3)
    below = np.stack([sx[sel], sy[sel]], 1).astype(float)
    mouth = below.mean(0) if len(below) else np.array([(le[0] + re[0]) / 2, le[1] + d * .42])
    return {'left': [round(le[0]), round(le[1])], 'right': [round(re[0]), round(re[1])], 'mouth': [round(mouth[0]), round(mouth[1])], 'eyeDistance': round(d)}

if __name__ == '__main__':
    root = sys.argv[1]; value = find(root)
    if len(sys.argv) > 2 and sys.argv[2] == '--write': json.dump(value, open(os.path.join(root, 'face.json'), 'w'), indent=1)
    print(json.dumps(value))
