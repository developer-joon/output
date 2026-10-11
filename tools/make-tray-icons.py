#!/usr/bin/env python3
"""
메뉴바 아이콘 만들기 (2026-10-04). 앱 아이콘(build/icon.png)의 두 화살표 모양을 상태색으로 칠한 PNG.
nativeImage는 SVG를 읽지 못해 PNG 파일(1x 18px + @2x 36px)로 둔다. 색을 바꾸면 이 스크립트를 다시 돌린다.

  python3 tools/make-tray-icons.py
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'electron', 'assets')
# electron/main.mjs TONE_HEX와 같은 색
COLORS = {'red': '#c0392b', 'gray': '#9a968d', 'amber': '#d9a21b', 'teal': '#1f9e96', 'green': '#3e9b5a'}

# 앱 아이콘 1024 좌표계의 두 화살표 (가운데를 향해 모이는 모양)
STROKES = [
    [(495, 315), (495, 508)], [(320, 488), (512, 488)], [(372, 367), (495, 490)],   # 왼쪽 위 화살표
    [(532, 700), (532, 508)], [(708, 527), (512, 527)], [(655, 650), (532, 527)],   # 오른쪽 아래 화살표
]
BOX = (320, 315, 708, 700)   # 화살표가 차지하는 영역
LINE = 52                    # 1024 기준 선 굵기 (메뉴바에서 보이게 앱 아이콘보다 조금 굵게)


def render(size, color, ss=8):
    big = size * ss
    pad = big * 0.08
    scale = (big - 2 * pad) / max(BOX[2] - BOX[0], BOX[3] - BOX[1])
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    tx = lambda p: (pad + (p[0] - BOX[0]) * scale, pad + (p[1] - BOX[1]) * scale)
    w = max(1, round(LINE * scale))
    for a, b in STROKES:
        d.line([tx(a), tx(b)], fill=color, width=w)
        r = w / 2
        for p in (tx(a), tx(b)):   # 끝을 둥글게 — 작게 줄였을 때 끊겨 보이지 않게
            d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)
    return img.resize((size, size), Image.LANCZOS)


for name, hexc in COLORS.items():
    render(18, hexc).save(os.path.join(OUT, f'tray-{name}.png'))
    render(36, hexc).save(os.path.join(OUT, f'tray-{name}@2x.png'))
print('ok', len(COLORS) * 2, 'files')
