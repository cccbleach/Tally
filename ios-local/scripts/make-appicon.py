#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 ios-local 生成正式 AppIcon（1024x1024，无 alpha，符合 App Store 要求）。

设计：蓝绿渐变底 + 白色账本卡片（收入/支出条目线）+ 金色硬币（¥）。
纯几何绘制，不依赖任何外部素材；输出为 RGB（不含透明通道），因为
App Store 明确拒绝带 alpha 的图标。
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math
import os
import sys

SIZE = 1024
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "AppIcon.png"
)

img = Image.new("RGB", (SIZE, SIZE), (10, 60, 130))
px = img.load()

# ---- 背景：对角渐变（深品牌蓝 -> 青绿）----
top = (11, 78, 190)      # #0B4EBE
bottom = (16, 180, 168)  # #10B4A8
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    for x in range(SIZE):
        # 轻微横向提亮，形成从左下到右上的光泽
        k = 0.10 * (1 - y / SIZE) * (x / SIZE)
        px[x, y] = (min(255, int(r + 255 * k)), min(255, int(g + 255 * k)), min(255, int(b + 255 * k)))

# 顶部柔光（径向），让图标不至于太平
glow = Image.new("L", (SIZE, SIZE), 0)
gd = ImageDraw.Draw(glow)
gd.ellipse([-260, -420, 900, 380], fill=70)
glow = glow.filter(ImageFilter.GaussianBlur(160))
img = Image.composite(Image.new("RGB", (SIZE, SIZE), (255, 255, 255)), img, glow)

d = ImageDraw.Draw(img, "RGBA")

# ---- 账本卡片 ----
card = (150, 200, 760, 880)
d.rounded_rectangle(card, radius=68, fill=(255, 255, 255, 255))
# 卡片左侧装订条（像账本的书脊）
d.rounded_rectangle((150, 200, 232, 880), radius=68, fill=(226, 236, 250, 255))
d.rectangle((196, 200, 232, 880), fill=(226, 236, 250, 255))

def bar(y, x0, x1, color, h=34):
    d.rounded_rectangle((x0, y, x1, y + h), radius=h // 2, fill=color)

# 表头（品牌色条目）
bar(292, 300, 700, (11, 78, 190, 255), h=40)
# 条目：支出（暖色）与收入（绿色）
bar(410, 300, 640, (238, 122, 92, 255))
bar(520, 300, 580, (34, 178, 128, 255))
bar(630, 300, 660, (206, 214, 226, 255))
bar(740, 300, 540, (206, 214, 226, 255))

# ---- 金色硬币（叠加在右下角）----
cx, cy, R = 752, 752, 196
d.ellipse((cx - R - 14, cy - R - 14, cx + R + 14, cy + R + 14), fill=(255, 255, 255, 255))
d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=(247, 178, 32, 255))
d.ellipse((cx - R + 26, cy - R + 26, cx + R - 26, cy + R - 26), outline=(214, 141, 12, 255), width=14)

# ¥ 字形（用系统字体，找不到就用几何线条兜底）
font = None
for path in [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNSText.ttf",
    "/Library/Fonts/SFNS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]:
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, 250)
            break
        except Exception:
            font = None
if font is not None:
    try:
        glyph = chr(0xA5)  # ¥
        box = d.textbbox((0, 0), glyph, font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        d.text((cx - w / 2 - box[0], cy - h / 2 - box[1]), glyph, font=font, fill=(255, 255, 255, 255))
    except Exception:
        font = None
if font is None:
    # 几何兜底：画一个 ¥（Y + 两横）
    d.line((cx - 80, cy - 96, cx, cy - 6), width=30, fill=(255, 255, 255, 255))
    d.line((cx + 80, cy - 96, cx, cy - 6), width=30, fill=(255, 255, 255, 255))
    d.line((cx, cy - 6, cx, cy + 100), width=30, fill=(255, 255, 255, 255))
    d.line((cx - 74, cy + 16, cx + 74, cy + 16), width=24, fill=(255, 255, 255, 255))
    d.line((cx - 74, cy + 56, cx + 74, cy + 56), width=24, fill=(255, 255, 255, 255))

img = img.convert("RGB")  # 明确去掉 alpha：App Store 拒绝带透明通道的图标
img.save(OUT, "PNG", optimize=True)
print("已生成", OUT, img.size, img.mode)
