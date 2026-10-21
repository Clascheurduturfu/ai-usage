"""Generate app icons for AI Usage for Windows without external dependencies.

Creates:
  build/icon.ico     (16/32/48/256 PNG-in-ICO entries)
  resources/icon.png  (512x512 app icon)
  resources/tray.png  (32x32 tray icon)
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def lerp(a, b, t):
    return a + (b - a) * t


def clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def rounded_rect_sdf(x, y, cx, cy, hw, hh, r):
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    mx = max(dx, 0.0)
    my = max(dy, 0.0)
    return (mx * mx + my * my) ** 0.5 + min(max(dx, dy), 0.0) - r


def render(size):
    """Rounded-square gradient tile with four rising white bars (usage motif)."""
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    # gradient: #6ea8ff (top-left) -> #a78bfa (bottom-right)
    c1 = (0x6e / 255.0, 0xa8 / 255.0, 0xFF / 255.0)
    c2 = (0xA7 / 255.0, 0x8B / 255.0, 0xFA / 255.0)
    s = float(size)

    # background tile
    tile_hw, tile_hh, tile_r = s * 0.48, s * 0.48, s * 0.115
    # bars (relative geometry): x centers and heights as fraction of inner area
    bar_w = s * 0.088
    bar_gap = s * 0.075
    heights = [0.42, 0.60, 0.78, 0.95]
    bar_r = bar_w * 0.5
    centers = []
    total_w = 4 * bar_w + 3 * bar_gap
    x0 = (s - total_w) / 2.0 + bar_w / 2.0
    for i in range(4):
        centers.append(x0 + i * (bar_w + bar_gap))
    base_y = s * 0.76  # common baseline for bars

    for yi in range(size):
        y = yi + 0.5
        for xi in range(size):
            x = xi + 0.5
            t = clamp01((x / s * 0.6) + (y / s * 0.4))
            r = lerp(c1[0], c2[0], t)
            g = lerp(c1[1], c2[1], t)
            b = lerp(c1[2], c2[2], t)

            d_tile = rounded_rect_sdf(x, y, s / 2, s / 2, tile_hw, tile_hh, tile_r)
            if d_tile > 0.5:
                px[yi][xi] = (0, 0, 0, 0)
                continue

            alpha = 255 if d_tile < -0.5 else int(255 * (1 - clamp01(d_tile + 0.5)))
            color = None
            best = 1e9
            for i, hgt in enumerate(heights):
                bh = (s * 0.56) * hgt
                d = rounded_rect_sdf(x, y, centers[i], base_y - bh / 2.0, bar_w / 2.0, bh / 2.0, bar_r)
                if d < best:
                    best = d
            if best < -0.5:
                color = (255, 255, 255, 246)
            elif best < 0.5:
                aa = int(246 * (1 - clamp01(best + 0.5)))
                color = (255, 255, 255, aa)

            if color is not None:
                # simple over-composite white bar over gradient
                ca = color[3] / 255.0
                out = (
                    int(lerp(r, 1.0, ca) * 255),
                    int(lerp(g, 1.0, ca) * 255),
                    int(lerp(b, 1.0, ca) * 255),
                    max(alpha, color[3]),
                )
            else:
                out = (int(r * 255), int(g * 255), int(b * 255), alpha)
            px[yi][xi] = out
    return px


def png_bytes(px):
    h = len(px)
    w = len(px[0])
    raw = b""
    for row in px:
        raw += b"\x00" + b"".join(struct.pack("4B", *p) for p in row)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def write_ico(path, entries):
    """entries: list of (size, png_data)"""
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_items = b""
    data = b""
    for size, png in entries:
        dir_items += struct.pack("<BBBBHHII", size & 0xFF, size & 0xFF, 0, 0, 1, 32, len(png), offset)
        data += png
        offset += len(png)
    with open(path, "wb") as f:
        f.write(header + dir_items + data)


def main():
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "resources"), exist_ok=True)

    sizes = [16, 32, 48, 256, 512]
    rendered = {}
    for sz in sizes:
        rendered[sz] = png_bytes(render(sz))

    write_ico(os.path.join(ROOT, "build", "icon.ico"), [(s, rendered[s]) for s in [16, 32, 48, 256]])
    with open(os.path.join(ROOT, "resources", "icon.png"), "wb") as f:
        f.write(rendered[512])
    with open(os.path.join(ROOT, "resources", "tray.png"), "wb") as f:
        f.write(rendered[32])
    print("icons written: build/icon.ico, resources/icon.png, resources/tray.png")


if __name__ == "__main__":
    main()
