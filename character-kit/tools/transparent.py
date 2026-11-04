#!/usr/bin/env python3
"""Makes a flat #00FF00 green background transparent (for image tools that can't output transparency).

  transparent.py <picture.png> [more.png …]    rewrites each file in place; prints the share of pixels removed
Only needed when a picture came back on green. Check the result in the gallery: a green fringe or halo means
the picture should be generated again rather than cleaned by hand."""
import sys
import numpy as np
from PIL import Image, ImageFilter

for path in sys.argv[1:]:
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(int)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    green = (g > 150) & (g - np.maximum(r, b) > 80)
    alpha = Image.fromarray(np.where(green, 0, 255).astype('uint8')).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = Image.fromarray(rgb.astype('uint8')).convert('RGBA')
    # Soften green spill on the remaining edge pixels.
    px = np.asarray(out).copy(); edge = (np.asarray(alpha) > 0) & (np.asarray(alpha) < 255)
    px[..., 1] = np.where(edge, np.minimum(px[..., 1], np.maximum(px[..., 0], px[..., 2])), px[..., 1])
    out = Image.fromarray(px); out.putalpha(alpha); out.save(path)
    print(path, f'{green.mean() * 100:.1f}% background removed')
