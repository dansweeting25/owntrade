# python3 -I imgdiff.py <shotsDir> : compare *-new.png with *-live.png, print % of differing pixels
import sys, os
from PIL import Image, ImageChops
d = sys.argv[1]
for f in sorted(os.listdir(d)):
    if not f.endswith('-new.png'): continue
    g = f.replace('-new.png', '-live.png')
    if not os.path.exists(os.path.join(d, g)): continue
    a = Image.open(os.path.join(d, f)).convert('RGB'); b = Image.open(os.path.join(d, g)).convert('RGB')
    if a.size != b.size:
        print(f'{f[:-8]:40s} SIZE {a.size} vs {b.size}'); continue
    diff = ImageChops.difference(a, b).convert('L').point(lambda v: 255 if v > 24 else 0)
    n = sum(diff.histogram()[255:]); pct = 100 * n / (a.size[0] * a.size[1])
    bbox = diff.getbbox()
    print(f'{f[:-8]:40s} {pct:6.3f}% differ  bbox={bbox}')
    if pct > 0.05: diff.save(os.path.join(d, f[:-8] + '-diff.png'))
