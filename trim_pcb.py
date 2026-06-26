"""
trim_pcb.py — auto-crop PCB screenshots to their board bbox.
Samples the top-left corner pixel as background, thresholds the diff,
finds the bounding box, adds padding, saves as <name>-trim.png.
"""

from PIL import Image, ImageChops
import os

TOLERANCE = 28   # raise if board edge gets clipped; lower if bg leaks in
PADDING   = 12   # px to keep around the detected bbox

def trim(input_path, suffix="-trim"):
    img = Image.open(input_path).convert("RGB")
    w, h = img.size

    bg_color = img.getpixel((0, 0))
    bg = Image.new("RGB", img.size, bg_color)

    diff      = ImageChops.difference(img, bg)
    diff_gray = diff.convert("L")
    # pixels with channel diff > TOLERANCE become white; rest black
    diff_thr  = diff_gray.point(lambda p: 255 if p > TOLERANCE else 0)

    bbox = diff_thr.getbbox()
    if bbox is None:
        print(f"  WARNING: nothing found above tolerance for {os.path.basename(input_path)}")
        return None

    left, top, right, bottom = bbox
    left   = max(0, left   - PADDING)
    top    = max(0, top    - PADDING)
    right  = min(w, right  + PADDING)
    bottom = min(h, bottom + PADDING)

    cropped = img.crop((left, top, right, bottom))

    base, ext  = os.path.splitext(input_path)
    output     = base + suffix + ext
    cropped.save(output)

    print(f"  {os.path.basename(input_path)}")
    print(f"    original : {w} x {h}")
    print(f"    trimmed  : {cropped.width} x {cropped.height}")
    print(f"    saved    : {output}")
    print()
    return output

base = r"C:\Users\chris\projects\chrispsparrow.github.io\assets\AVIONICS PCB FILES"

images = [
    os.path.join(base, "Screenshot 2026-06-15 111956.png"),  # 3D render (lavender bg)
    os.path.join(base, "Screenshot 2026-06-15 112054.png"),  # copper view (dark bg)
]

print(f"TOLERANCE={TOLERANCE}  PADDING={PADDING}\n")
for p in images:
    trim(p)
