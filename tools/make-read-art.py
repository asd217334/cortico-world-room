"""生成「阅读角」占位素材（外观未定，先用最简单的像素风占位）。

输出：
  src/img/furn-read-off.png  灯灭、书合上
  src/img/furn-read-on.png   灯亮、书摊开

做法：128×128 逻辑像素里画形状，再按 NEAREST 放大到 512×512，
      硬边、无抗锯齿，和 furn-tv-*.png 的像素风站在一起不违和。
以后定了正式外观，直接替换这两张同名图即可，world.ts / scene-host 不用改。

用法：
  python tools/make-read-art.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

W = H = 128          # 逻辑像素
SCALE = 4            # 放大倍数 → 512×512
OUT_DIR = Path(__file__).resolve().parent.parent / 'src' / 'img'

# 与电视同一个深色系，舞台上是透明精灵
CHAIR = (60, 69, 96, 255)
CHAIR_EDGE = (38, 44, 63, 255)
CUSHION = (76, 87, 115, 255)
LEG = (34, 40, 56, 255)
POLE = (110, 118, 136, 255)
BASE = (43, 49, 66, 255)
SHADE_OFF = (107, 107, 120, 255)
SHADE_ON = (242, 198, 112, 255)
BOOK_COVER = (150, 82, 82, 255)
PAGE = (244, 241, 228, 255)


def draw(lit: bool) -> Image.Image:
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    # 地面投影：让家具站在地上而不是飘着
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([10, 116, 118, 126], fill=(0, 0, 0, 80))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(2)))

    # 灯亮时的暖光：先铺在底层，家具压在上面，看起来是灯在发光
    if lit:
        glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([66, 0, 126, 66], fill=(255, 190, 110, 95))
        gd.ellipse([80, 12, 114, 54], fill=(255, 216, 152, 130))
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(4)))

    d = ImageDraw.Draw(img)

    # ── 落地灯（右） ──
    d.rectangle([94, 42, 99, 122], fill=POLE)
    d.ellipse([84, 114, 110, 125], fill=BASE)
    d.polygon([(91, 20), (103, 20), (110, 46), (84, 46)], fill=SHADE_ON if lit else SHADE_OFF)
    d.line([(91, 20), (103, 20)], fill=CHAIR_EDGE)
    d.line([(84, 46), (110, 46)], fill=CHAIR_EDGE)

    # ── 扶手椅（左） ──
    d.rectangle([30, 42, 76, 84], fill=CHAIR, outline=CHAIR_EDGE)          # 靠背
    d.rectangle([26, 78, 80, 98], fill=CUSHION, outline=CHAIR_EDGE)        # 坐垫
    d.rectangle([24, 62, 33, 98], fill=CHAIR, outline=CHAIR_EDGE)          # 左扶手
    d.rectangle([73, 62, 82, 98], fill=CHAIR, outline=CHAIR_EDGE)          # 右扶手
    d.rectangle([31, 98, 37, 122], fill=LEG)                               # 左腿
    d.rectangle([67, 98, 73, 122], fill=LEG)                               # 右腿

    # ── 书：灭灯时合着，亮灯时摊开 ──
    if lit:
        d.polygon([(38, 79), (64, 79), (62, 71), (40, 71)], fill=BOOK_COVER)   # 封面
        d.polygon([(41, 71), (52, 69), (52, 78), (41, 78)], fill=PAGE)         # 左页
        d.polygon([(52, 69), (63, 71), (63, 78), (52, 78)], fill=PAGE)         # 右页
        d.line([(52, 69), (52, 78)], fill=CHAIR_EDGE)                          # 书脊
    else:
        d.rectangle([40, 72, 64, 79], fill=BOOK_COVER, outline=CHAIR_EDGE)     # 合上的书
        d.line([(42, 74), (62, 74)], fill=PAGE)

    return img.resize((W * SCALE, H * SCALE), Image.NEAREST)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for lit, name in ((False, 'furn-read-off.png'), (True, 'furn-read-on.png')):
        path = OUT_DIR / name
        draw(lit).save(path)
        print(f'wrote {path}')


if __name__ == '__main__':
    main()
