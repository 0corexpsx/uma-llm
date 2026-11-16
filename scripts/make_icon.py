"""Builds the app icons from the Uma LLM artwork in build/icon-source.png.

Small icons (taskbar, title bar, the chat avatar) use a close-up of the head, which stays readable
at 16-64 pixels. Large ones keep the whole drawing.

Writes build/icon.png (1024), build/icon-512.png, build/icon.ico, and src/assets/uma-logo.png (the
in-app logo). To change the icon, replace build/icon-source.png, adjust HEAD_BOX if the head moved,
and run: python scripts/make_icon.py
"""
from pathlib import Path

from PIL import Image

# The head, ears to chin, as (left, top, side) in the 1280 x 1280 source drawing.
HEAD_BOX = (210, 60, 780)
SMALL_SIZES = (16, 24, 32, 48, 64)
LARGE_SIZES = (128, 256)

root = Path(__file__).resolve().parents[1]
source = root / "build" / "icon-source.png"
art = Image.open(source).convert("RGBA")

# Keep the artwork's own framing, only making it square if it is not already.
side = max(art.size)
full = Image.new("RGBA", (side, side), (0, 0, 0, 0))
full.paste(art, ((side - art.width) // 2, (side - art.height) // 2))
left, top, size = HEAD_BOX
head = full.crop((left, top, left + size, top + size))


def fit(image, pixels):
    return image.resize((pixels, pixels), Image.LANCZOS)


fit(full, 1024).save(root / "build" / "icon.png")
fit(full, 512).save(root / "build" / "icon-512.png")
# Each size in the .ico is its own picture: the head when small, the whole drawing when large.
frames = [fit(head, pixels) for pixels in SMALL_SIZES] + [fit(full, pixels) for pixels in LARGE_SIZES]
frames[-1].save(
    root / "build" / "icon.ico",
    sizes=[(pixels, pixels) for pixels in SMALL_SIZES + LARGE_SIZES],
    append_images=frames[:-1],
)
(root / "src" / "assets").mkdir(parents=True, exist_ok=True)
fit(head, 256).save(root / "src" / "assets" / "uma-logo.png", optimize=True)
print("built icons from", source)
