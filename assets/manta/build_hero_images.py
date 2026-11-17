# Makes the ground station page's hero images from the original renders.
#
#   python build_hero_images.py [folder with the originals] [output folder]
#
# Both folders default to this script's own folder. The originals are read and
# never changed:
#   gs-wide-omnis.jpg, gs-wide-starter.jpg, gs-wide-yagis.jpg      3840 x 2160
#   ground-station-omnis.jpg, ...-starter.jpg, ...-yagis.jpg       900 x 1380
# It writes, for the wide set at 2560 and 1920 wide and the tall set at 900:
#   gs-wide-bg-<w>.webp, gs-tall-bg.webp      the whole starter render (the still background)
#   gs-wide-<frame>-<w>.webp, gs-tall-<frame>.webp
#       one render's hardware only. Everything that's the same in all three
#       renders is transparent, so the background never fades and can't shimmer.
# Every file uses the same WebP settings (quality 82, method 6, lossless alpha).
# Needs Pillow and numpy.
import os
import sys
import numpy as np
from PIL import Image, ImageChops, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else HERE
OUT = sys.argv[2] if len(sys.argv) > 2 else HERE
FRAMES = ['omnis', 'starter', 'yagis']
WEBP = dict(quality=82, method=6)


def dilate(mask, px):
    """Grow a 0/255 mask by px pixels with repeated 3 x 3 max filters."""
    for _ in range(px):
        mask = mask.filter(ImageFilter.MaxFilter(3))
    return mask


def change_mask(ims, threshold):
    """255 wherever any two renders differ by more than threshold."""
    m = None
    for i in range(len(ims)):
        for j in range(i + 1, len(ims)):
            d = ImageChops.difference(ims[i], ims[j]).convert('L')
            m = d if m is None else ImageChops.lighter(m, d)
    return m.point(lambda v: 255 if v > threshold else 0)


def alpha_for(changed, grow, feather):
    """Solid over the changed pixels plus `grow` px, then a soft edge `feather` px
    wide. The renders match inside the soft edge, so it only hides compression seams."""
    core = dilate(changed, grow)
    soft = dilate(core, feather).filter(ImageFilter.GaussianBlur(feather / 2))
    return ImageChops.lighter(core, soft)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, 'WEBP', **WEBP)
    print(f'  {name:28s} {os.path.getsize(path) // 1024:4d} KB')


def build(set_name, ims, changed, grow, feather, suffix):
    alpha = alpha_for(changed, grow, feather)
    save(ims[FRAMES.index('starter')], f'gs-{set_name}-bg{suffix}.webp')
    for name, im in zip(FRAMES, ims):
        rgba = im.copy()
        rgba.putalpha(alpha)
        save(rgba, f'gs-{set_name}-{name}{suffix}.webp')
    check(set_name, suffix, ims, alpha)


def check(set_name, suffix, ims, alpha):
    """Put each saved frame over the saved background and make sure that, where
    the frames are transparent, all three show exactly the same pixels."""
    bg = np.asarray(Image.open(os.path.join(OUT, f'gs-{set_name}-bg{suffix}.webp')).convert('RGB'), dtype=np.float32)
    clear = np.asarray(alpha) == 0
    shown = []
    for name in FRAMES:
        o = np.asarray(Image.open(os.path.join(OUT, f'gs-{set_name}-{name}{suffix}.webp')).convert('RGBA'), dtype=np.float32)
        a = o[..., 3:4] / 255.0
        shown.append(o[..., :3] * a + bg * (1 - a))
    moved = sum(int((np.abs(shown[i] - shown[j]).max(axis=2)[clear] > 0).sum())
                for i in range(3) for j in range(i + 1, 3))
    print(f'  check: background pixels that change between frames: {moved}')


wide = [Image.open(os.path.join(SRC, f'gs-wide-{n}.jpg')).convert('RGB') for n in FRAMES]
for w in (2560, 1920):
    h = round(2160 * w / 3840)
    ims = [im.resize((w, h), Image.LANCZOS) for im in wide]
    k = w / 2560
    print(f'wide {w} x {h}')
    # The wide renders are pixel-identical away from the hardware
    build('wide', ims, change_mask(ims, 0), round(6 * k), round(10 * k), f'-{w}')

tall = [Image.open(os.path.join(SRC, f'ground-station-{n}.jpg')).convert('RGB') for n in FRAMES]
print('tall 900 x 1380')
# The tall renders carry JPEG noise of up to 13 levels everywhere. Take the
# strong changes, plus the weaker antenna edges that touch them.
strong = change_mask(tall, 12)
edges = ImageChops.multiply(change_mask(tall, 4), dilate(strong, 4))
build('tall', tall, ImageChops.lighter(strong, edges), 3, 6, '')
