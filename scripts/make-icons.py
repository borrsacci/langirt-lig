# Android uygulama ikonu ve açılış ekranı üretir (langırt masası, yukarıdan)
import os
from PIL import Image, ImageDraw

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
PITCH = (10, 42, 33); FELT = (22, 68, 51); CHROME = (169, 186, 179); BLUE = (59, 130, 246); RED = (239, 68, 68); BRASS = (242, 193, 78)

def table(size, pad_ratio):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    p = int(S * pad_ratio)
    w = S - 2 * p
    x0, y0, x1, y1 = p, p + int(w * 0.14), S - p, S - p - int(w * 0.14)
    r = int(w * 0.1)
    d.rounded_rectangle([x0, y0, x1, y1], r, fill=FELT, outline=CHROME, width=max(2, int(w * 0.035)))
    cx = S // 2
    d.line([cx, y0, cx, y1], fill=CHROME, width=max(2, int(w * 0.025)))
    gh = int((y1 - y0) * 0.32)
    gy = (y0 + y1) // 2
    gw = int(w * 0.06)
    d.rounded_rectangle([x0 - gw // 2, gy - gh // 2, x0 + gw // 2, gy + gh // 2], gw // 2, fill=BLUE)
    d.rounded_rectangle([x1 - gw // 2, gy - gh // 2, x1 + gw // 2, gy + gh // 2], gw // 2, fill=RED)
    br = int(w * 0.085)
    d.ellipse([cx - br, gy - br, cx + br, gy + br], fill=BRASS)
    return im.resize((size, size), Image.LANCZOS)

def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path)

dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for d, k in dens.items():
    # klasik ikon (48dp): zemin rengi + masa
    n = int(48 * k)
    bg = Image.new('RGBA', (n, n), PITCH + (255,))
    sq = Image.new('L', (n * 4, n * 4), 0)
    ImageDraw.Draw(sq).rounded_rectangle([0, 0, n * 4 - 1, n * 4 - 1], int(n * 4 * 0.22), fill=255)
    icon = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), sq.resize((n, n), Image.LANCZOS))
    icon.alpha_composite(table(n, 0.16))
    save(icon, f'{RES}/mipmap-{d}/ic_launcher.png')
    circ = Image.new('L', (n * 4, n * 4), 0)
    ImageDraw.Draw(circ).ellipse([0, 0, n * 4 - 1, n * 4 - 1], fill=255)
    rnd = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    rnd.paste(bg, (0, 0), circ.resize((n, n), Image.LANCZOS))
    rnd.alpha_composite(table(n, 0.2))
    save(rnd, f'{RES}/mipmap-{d}/ic_launcher_round.png')
    # uyarlanabilir ikon ön planı (108dp, güvenli alan ortadaki 66dp)
    f = int(108 * k)
    save(table(f, 0.27), f'{RES}/mipmap-{d}/ic_launcher_foreground.png')

# açılış ekranı: zemin rengi + ortada masa
for folder in os.listdir(RES):
    if folder.startswith('drawable'):
        p = f'{RES}/{folder}/splash.png'
        if os.path.exists(p):
            w, h = Image.open(p).size
            sp = Image.new('RGBA', (w, h), PITCH + (255,))
            t = table(int(min(w, h) * 0.42), 0.05)
            sp.alpha_composite(t, ((w - t.width) // 2, (h - t.height) // 2))
            sp.convert('RGB').save(p)

with open(f'{RES}/values/ic_launcher_background.xml', 'w') as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0A2A21</color>\n</resources>\n')
print('ok')
