"""Иконки приложения из картинки логотипа -> app/icons/.

Запуск: python -I make_icons.py путь\\к\\logo.png
Логотип вырезается по своим границам (всё светлее фона) и ставится по центру квадрата
с полями: обычные иконки — логотип ~72% стороны, maskable (Android) — ~58%, чтобы не обрезался.
"""
import os
import sys

from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

src = Image.open(sys.argv[1]).convert("RGB")
bg = src.getpixel((5, 5))
x0, y0, x1, y1 = src.convert("L").point(lambda v: 255 if v > 40 else 0).getbbox()
cx, cy, side = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0)


def icon(size, fill):
    half = side / fill / 2
    box = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
    canvas = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), bg)
    canvas.paste(src.crop((max(box[0], 0), max(box[1], 0), min(box[2], src.width), min(box[3], src.height))),
                 (max(-box[0], 0), max(-box[1], 0)))
    return canvas.resize((size, size), Image.LANCZOS)


icon(192, 0.72).save(os.path.join(OUT, "tb-icon-192.png"))
icon(512, 0.58).save(os.path.join(OUT, "tb-icon-512.png"))  # и обычная, и maskable
icon(180, 0.72).save(os.path.join(OUT, "tb-apple-touch-icon.png"))
icon(64, 0.86).save(os.path.join(OUT, "tb-logo-64.png"))  # значок в шапке
print("ok, фон", bg, "границы", (x0, y0, x1, y1))
