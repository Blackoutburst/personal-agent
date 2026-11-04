#!/usr/bin/env python3
"""Companion character art, for any character folder laid out like claude-chan (base.png, the six app faces,
expr/*.png, outfit/*.png).

  art.py face <dir>              find eyes and mouth from the expression edits, write face.json
  art.py check <dir>             report outfits whose face drifted from base (eye remnants, extra brows) and haze
  art.py gallery <dir> <Title>   build <dir>/gallery: every picture, faces over outfits, on a checkerboard

Faces are patches (eyes, brows, cheeks, mouth) drawn over any outfit; outfits keep the base face. Where an outfit
puts something in front of the face (a brim, other bangs), a front layer is drawn over the patch."""
import html, json, os, shutil, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facefind

APP = [('base', 'Idle', 'Resting face; the outfit pictures use it'), ('blink', 'Blink', 'Shown for a moment every few seconds'),
       ('talk', 'Talking', 'Alternates with idle while she writes'), ('listening', 'Listening', 'While you type'),
       ('thinking', 'Thinking', 'Before the reply starts'), ('happy', 'Happy', 'Right after a reply'), ('sleepy', 'Sleepy', 'At night, when idle')]
FEELINGS = [('laugh', 'Laughing'), ('wink', 'Wink'), ('surprised', 'Surprised'), ('sad', 'Sad'), ('worried', 'Worried'),
            ('teary-smile', 'Moved'), ('embarrassed', 'Embarrassed'), ('pout', 'Pouting'), ('proud', 'Proud'), ('excited', 'Excited'),
            ('confused', 'Confused'), ('determined', 'Determined'), ('tender', 'Tender'), ('love', 'Adoring'), ('focused', 'Focused')]
OUTFITS = [
    ('Everyday', [('base', 'Signature outfit'), ('cozy-home', 'Cozy at home')]),
    ('Day and night', [('pajamas', 'Pajamas')]),
    ('Weather', [('rain', 'Rain'), ('sunny', 'Sunny and hot'), ('snow', 'Snow'), ('windy', 'Windy and cool')]),
    ('Seasons', [('spring', 'Spring'), ('summer', 'Summer'), ('autumn', 'Autumn'), ('winter', 'Winter')]),
    ('Special days', [('halloween', 'Halloween'), ('christmas', 'Christmas'), ('party', "New Year's Eve"), ('new-year', 'New Year'),
                      ('lunar-new-year', 'Lunar New Year'), ('valentine', "Valentine's Day"), ('easter', 'Easter'),
                      ('summer-festival', 'Summer festival'), ('birthday', 'Birthday')]),
]

def face(root):
    path = os.path.join(root, 'face.json')
    if not os.path.exists(path): json.dump(facefind.find(root), open(path, 'w'), indent=1)
    return json.load(open(path))

def regions(root):
    f = face(root); d = f['eyeDistance']; (lx, ly), (rx, ry), (mx, my) = f['left'], f['right'], f['mouth']
    eyes = [((lx, ly + .1 * d), (.42 * d, .36 * d)), ((rx, ry + .1 * d), (.42 * d, .36 * d))]
    brows = [((lx, ly - .38 * d), (.5 * d, .26 * d)), ((rx, ry - .38 * d), (.5 * d, .26 * d))]
    oval = (((lx + rx) / 2, ((ly + ry) / 2 + my) / 2), (.92 * d, .63 * d))
    mouth = ((mx, my), (.36 * d, .2 * d))
    return eyes, brows, oval, mouth

def ellipse(draw, center, radii, fill=255):
    (cx, cy), (ex, ey) = center, radii; draw.ellipse((cx - ex, cy - ey, cx + ex, cy + ey), fill=fill)

def mask(root, size):
    eyes, brows, oval, _ = regions(root)
    m = Image.new('L', size, 0); ellipse(ImageDraw.Draw(m), *oval); m = m.filter(ImageFilter.GaussianBlur(22))
    sharp = Image.new('L', size, 0)
    for e in eyes + brows: ellipse(ImageDraw.Draw(sharp), *e)  # eyes and brows fully covered: no remnants
    return Image.fromarray(np.maximum(np.asarray(m), np.asarray(sharp.filter(ImageFilter.GaussianBlur(4)))))

def patch(root, src):
    im = Image.open(src).convert('RGBA')
    im.putalpha(Image.fromarray(np.minimum(np.asarray(im.getchannel('A')), np.asarray(mask(root, im.size))).astype('uint8')))
    return im

def front(root, outfit):
    o = Image.open(outfit).convert('RGBA'); b = np.asarray(Image.open(os.path.join(root, 'base.png')).convert('RGBA')).astype(int)
    diff = (np.abs(np.asarray(o).astype(int) - b).sum(-1) > 90).astype('uint8') * 255
    m = Image.fromarray(diff).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(1.5))
    alpha = np.minimum(np.asarray(m), (np.asarray(mask(root, o.size)) > 0) * 255).astype('uint8')
    eyes, _, _, mouth = regions(root); keep = Image.new('L', o.size, 255)
    for e in eyes + [mouth]: ellipse(ImageDraw.Draw(keep), *e, fill=0)
    alpha = np.minimum(alpha, np.asarray(keep.filter(ImageFilter.GaussianBlur(3)))).astype('uint8')
    if (alpha > 128).sum() < 400: return None
    o.putalpha(Image.fromarray(np.minimum(alpha, np.asarray(o.getchannel('A')))))
    return o

def compose(root, outfit, face_src):
    canvas = Image.open(outfit).convert('RGBA'); canvas.alpha_composite(patch(root, face_src))
    layer = front(root, outfit)
    if layer is not None: canvas.alpha_composite(layer)
    return canvas

def face_file(root, key):
    top = os.path.join(root, key + '.png')
    return top if os.path.exists(top) else os.path.join(root, 'expr', key + '.png')

def outfit_file(root, key):
    return os.path.join(root, 'base.png') if key == 'base' else os.path.join(root, 'outfit', key + '.png')

def haze(path):
    """Share of faint, semi-transparent pixels away from the character: a soft halo or blurry background."""
    a = Image.open(path).convert('RGBA').getchannel('A')
    body = np.asarray(a.point(lambda v: 255 if v > 200 else 0).filter(ImageFilter.MaxFilter(25))) > 0
    faint = (np.asarray(a) > 4) & (np.asarray(a) < 200) & ~body
    return faint.sum() / faint.size

def check(root):
    eyes, brows, _, mouth = regions(root)
    b = np.asarray(Image.open(os.path.join(root, 'base.png')).convert('RGBA')).astype(int); size = (b.shape[1], b.shape[0])
    zone = Image.new('L', size, 0)
    for e in eyes + brows + [mouth]: ellipse(ImageDraw.Draw(zone), *e)
    zone = np.asarray(zone) > 0
    report = []
    for _, items in OUTFITS:
        for key, _ in items:
            path = outfit_file(root, key)
            if not os.path.exists(path): report.append((key, 'missing', None, None)); continue
            o = np.asarray(Image.open(path).convert('RGBA')).astype(int)
            drift = float((np.abs(o - b).sum(-1)[zone] > 90).mean())
            report.append((key, 'ok' if drift < .25 else 'face drift', round(drift, 3), round(haze(path) * 100, 2)))
    for key in [k for k, *_ in APP[1:]] + [k for k, _ in FEELINGS]:
        path = face_file(root, key)
        report.append((key, 'face ok' if os.path.exists(path) else 'missing', None, round(haze(path) * 100, 2) if os.path.exists(path) else None))
    return report

def gallery(root, title):
    out = os.path.join(root, 'gallery'); shutil.rmtree(out, ignore_errors=True); os.makedirs(os.path.join(out, 'img'))
    def save(im, name):
        im.resize((512, 512), Image.LANCZOS).save(os.path.join(out, 'img', name + '.webp'), quality=86, method=4); return 'img/' + name + '.webp'
    def card(img, label, note=''):
        pic = f'<img src="{img}" alt="{html.escape(label)}" loading="lazy">' if img else '<div class="soon">Missing</div>'
        return f'<figure>{pic}<figcaption><b>{html.escape(label)}</b>{f"<span>{html.escape(note)}</span>" if note else ""}</figcaption></figure>'
    sections, done, total = [], 0, 0
    cards = []
    for key, label, note in APP:
        src = os.path.join(root, key + '.png'); total += 1
        if os.path.exists(src):
            done += 1; im = Image.open(src).convert('RGBA') if key == 'base' else compose(root, os.path.join(root, 'base.png'), src)
            cards.append(card(save(im, 'face-' + key), label, note))
        else: cards.append(card(None, label, note))
    sections.append(('In the app', 'Each face is drawn over the base picture exactly as the app does.', cards))
    cards = []
    for key, label in FEELINGS:
        src = os.path.join(root, 'expr', key + '.png'); total += 1
        if os.path.exists(src): done += 1; cards.append(card(save(compose(root, os.path.join(root, 'base.png'), src), 'face-' + key), label))
        else: cards.append(card(None, label))
    sections.append(('Feelings', '', cards))
    for group, items in OUTFITS:
        cards = []
        for key, label in items:
            src = outfit_file(root, key); total += 1
            if os.path.exists(src): done += 1; cards.append(card(save(Image.open(src).convert('RGBA'), 'outfit-' + key), label))
            else: cards.append(card(None, label))
        sections.append((f'Outfits · {group}', '', cards))
    cards = []
    for _, items in OUTFITS:
        for key, label in items:
            if key == 'base' or not os.path.exists(outfit_file(root, key)): continue
            for face_key, face_label in [('happy', 'eyes closed'), ('surprised', 'eyes wide')]:
                if os.path.exists(face_file(root, face_key)):
                    cards.append(card(save(compose(root, outfit_file(root, key), face_file(root, face_key)), f'mix-{face_key}-{key}'), label, face_label))
    sections.append(('Faces over outfits', 'What the app shows: check for leftover eyes, doubled eyebrows, and hair through hats.', cards))
    body = '\n'.join(f'<section><h2>{html.escape(t)}</h2>{f"<p>{html.escape(d)}</p>" if d else ""}<div class="grid">{"".join(c)}</div></section>' for t, d, c in sections)
    page = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} gallery</title>
<style>
:root {{ --bg:#FFF6EE; --bg2:#FDEFF3; --card:#fff; --ink:#3A2E39; --soft:#8A7A86; --line:#F1E4E0; color-scheme: light dark; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#231B22; --bg2:#2C2029; --card:#362A33; --ink:#F6ECEF; --soft:#B8A7B2; --line:#4A3C47; }} }}
* {{ box-sizing: border-box; }}
body {{ margin:0; font-family: ui-rounded, "SF Pro Rounded", Nunito, system-ui, sans-serif; color:var(--ink); background:linear-gradient(180deg,var(--bg),var(--bg2)) fixed; }}
main {{ max-width:1100px; margin:0 auto; padding:28px 18px 60px; }}
h1 {{ margin:0 0 4px; font-size:30px; }} .lead {{ color:var(--soft); margin:0 0 6px; }}
.progress {{ display:inline-block; margin-top:6px; padding:4px 12px; border-radius:999px; background:var(--card); border:1px solid var(--line); color:var(--soft); font-size:14px; }}
.bg {{ margin-left:8px; font:inherit; font-size:14px; padding:4px 12px; border-radius:999px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }}
section {{ margin-top:34px; }} h2 {{ font-size:21px; margin:0 0 4px; }} section p {{ color:var(--soft); margin:0 0 12px; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:14px; }}
figure {{ margin:0; background:var(--card); border-radius:22px; padding:10px 10px 12px; border:1px solid var(--line); }}
figure img {{ width:100%; aspect-ratio:1; display:block; border-radius:14px; cursor:zoom-in;
  background: repeating-conic-gradient(#d9d4dc 0 25%, #f4f1f5 0 50%) 0 0/24px 24px; }}
body.dark figure img {{ background: repeating-conic-gradient(#2a2430 0 25%, #3a3340 0 50%) 0 0/24px 24px; }}
.soon {{ aspect-ratio:1; display:grid; place-items:center; border-radius:14px; border:2px dashed var(--line); color:var(--soft); font-size:14px; }}
figcaption {{ margin-top:8px; display:flex; flex-direction:column; gap:2px; }} figcaption span {{ color:var(--soft); font-size:13px; }}
dialog {{ border:0; padding:0; background:transparent; }} dialog img {{ max-width:92vw; max-height:92vh; border-radius:18px;
  background: repeating-conic-gradient(#d9d4dc 0 25%, #f4f1f5 0 50%) 0 0/32px 32px; }} dialog::backdrop {{ background:rgba(0,0,0,.6); }}
</style></head><body><main>
<h1>{html.escape(title)}</h1>
<p class="lead">Every face and outfit, shown on a checkerboard so a hazy or blurry background is visible. Tap a picture to see it large.</p>
<span class="progress">{done} of {total} pictures ready</span><button class="bg" type="button" onclick="document.body.classList.toggle('dark')">Dark checkerboard</button>
{body}
</main><dialog id="big" onclick="this.close()"><img alt=""></dialog>
<script>document.querySelectorAll('figure img').forEach(i=>i.addEventListener('click',()=>{{const d=document.getElementById('big');d.querySelector('img').src=i.src;d.showModal();}}));</script>
</body></html>'''
    open(os.path.join(out, 'index.html'), 'w').write(page)
    return done, total

if __name__ == '__main__':
    command, root = sys.argv[1], os.path.abspath(sys.argv[2])
    if command == 'face': json.dump(facefind.find(root), open(os.path.join(root, 'face.json'), 'w'), indent=1); print(open(os.path.join(root, 'face.json')).read())
    elif command == 'check':
        for row in check(root): print(*row)
    elif command == 'gallery': print(gallery(root, sys.argv[3]))
