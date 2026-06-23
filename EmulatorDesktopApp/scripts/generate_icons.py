from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "Assets" / "generated"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SIZE = 1024
CARD_BOUNDS = (92, 92, 932, 932)
CARD_RADIUS = 210


def icon_canvas() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle(
        (CARD_BOUNDS[0], CARD_BOUNDS[1] + 24, CARD_BOUNDS[2], CARD_BOUNDS[3] + 24),
        radius=CARD_RADIUS,
        fill=(15, 23, 42, 42),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    img.alpha_composite(shadow)

    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(CARD_BOUNDS, radius=CARD_RADIUS, fill=(59, 130, 246, 255))
    return img


def draw_app_glyph(img: Image.Image):
    draw = ImageDraw.Draw(img)

    body = (284, 248, 740, 776)
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle((body[0], body[1] + 22, body[2], body[3] + 22), radius=108, fill=(15, 23, 42, 64))
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    img.alpha_composite(shadow)

    draw.rounded_rectangle(body, radius=108, fill=(255, 255, 255, 244))
    draw.rounded_rectangle((326, 304, 698, 578), radius=66, fill=(59, 130, 246, 255))
    draw.rounded_rectangle((364, 642, 660, 666), radius=12, fill=(203, 213, 225, 255))
    draw.rounded_rectangle((364, 690, 554, 714), radius=12, fill=(226, 232, 240, 255))

    play = [(468, 368), (468, 514), (590, 441)]
    draw.polygon(play, fill=(255, 255, 255, 255))

    arc_color = (255, 255, 255, 236)
    draw.arc((374, 346, 694, 666), start=315, end=25, fill=arc_color, width=20)
    draw.arc((418, 390, 650, 622), start=318, end=22, fill=arc_color, width=14)


def draw_stream_glyph(img: Image.Image):
    draw = ImageDraw.Draw(img)

    phone = (344, 214, 680, 810)
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle((phone[0], phone[1] + 20, phone[2], phone[3] + 20), radius=90, fill=(0, 0, 0, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    img.alpha_composite(shadow)

    draw.rounded_rectangle(phone, radius=90, fill=(255, 255, 255, 246))
    draw.rounded_rectangle((372, 286, 652, 680), radius=52, fill=(30, 41, 59, 255))
    draw.rounded_rectangle((478, 246, 546, 262), radius=8, fill=(203, 213, 225, 255))
    draw.ellipse((492, 728, 532, 768), fill=(226, 232, 240, 255))

    draw.rounded_rectangle((434, 398, 590, 554), radius=32, outline=(147, 197, 253, 255), width=18)
    draw.line((512, 430, 512, 522), fill=(147, 197, 253, 255), width=18)
    draw.line((466, 476, 558, 476), fill=(147, 197, 253, 255), width=18)

    wave = (255, 255, 255, 220)
    draw.arc((270, 360, 412, 592), start=300, end=60, fill=wave, width=14)
    draw.arc((228, 318, 454, 634), start=300, end=60, fill=wave, width=14)
    draw.arc((612, 360, 754, 592), start=120, end=240, fill=wave, width=14)
    draw.arc((570, 318, 796, 634), start=120, end=240, fill=wave, width=14)


def write_icon(name: str, drawer, create_source: bool = True):
    img = icon_canvas()
    drawer(img)
    small_path = OUT_DIR / f"{name}.png"
    if create_source:
        source_path = OUT_DIR / f"{name}-source.png"
        img.save(source_path)
    img.resize((256, 256), Image.LANCZOS).save(small_path)


write_icon("app-icon", draw_app_glyph)
write_icon("stream-icon", draw_stream_glyph, create_source=False)

print("Generated icons in", OUT_DIR)
