"""
生成 ReverieSoil Android 图标和启动屏
- 图标来源：../../素材/logo.png（无文字版）
- 启动屏背景色：#1a1108
"""
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np

BASE = Path(__file__).parent
LOGO_PATH = BASE.parent.parent / "素材" / "logo.png"
RES_DIR = BASE / "android" / "app" / "src" / "main" / "res"

BG_COLOR = (26, 17, 8)   # #1a1108

# ------- 1. 启动图标尺寸 -------
ICON_SIZES = {
    "mipmap-mdpi":    (48, 48),
    "mipmap-hdpi":    (72, 72),
    "mipmap-xhdpi":   (96, 96),
    "mipmap-xxhdpi":  (144, 144),
    "mipmap-xxxhdpi": (192, 192),
}
# 自适应图标前景层（108dp @ 各密度，实际像素含安全区）
FOREGROUND_SIZES = {
    "mipmap-mdpi":    (108, 108),
    "mipmap-hdpi":    (162, 162),
    "mipmap-xhdpi":   (216, 216),
    "mipmap-xxhdpi":  (324, 324),
    "mipmap-xxxhdpi": (432, 432),
}

# ------- 2. 启动屏尺寸 -------
SPLASH_SIZES = {
    "drawable":           (960, 540),    # 通用备选
    "drawable-land-mdpi": (800, 480),
    "drawable-land-hdpi": (1024, 600),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
    "drawable-port-mdpi": (480, 800),
    "drawable-port-hdpi": (600, 1024),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
}

def remove_white_bg(img: Image.Image, threshold: int = 245) -> Image.Image:
    """洪水填充法去除图片四角白色背景，加入边缘羽化"""
    from PIL import ImageFilter
    img = img.convert("RGBA")
    arr = np.array(img, dtype=np.uint8)
    h, w = arr.shape[:2]
    # 标记白色像素
    is_white = (arr[:, :, 0] >= threshold) & \
               (arr[:, :, 1] >= threshold) & \
               (arr[:, :, 2] >= threshold)
    # BFS 从四边开始，标记连通的白色背景区域
    visited = np.zeros((h, w), dtype=bool)
    from collections import deque
    queue = deque()
    for y in range(h):
        for x in [0, w - 1]:
            if is_white[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    for x in range(w):
        for y in [0, h - 1]:
            if is_white[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and is_white[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))
    # 背景区域设为透明
    arr[visited, 3] = 0
    result = Image.fromarray(arr, "RGBA")
    # 对 alpha 通道做模糊，实现边缘羽化 (4px 半径)
    r, g, b, a = result.split()
    a = a.filter(ImageFilter.GaussianBlur(radius=4))
    result = Image.merge("RGBA", (r, g, b, a))
    return result


def make_round_icon(img: Image.Image, size: tuple) -> Image.Image:
    """生成圆形裁剪图标（用于 ic_launcher_round）"""
    img = img.resize(size, Image.LANCZOS)
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size[0], size[1]), fill=255)
    result = Image.new("RGBA", size, (255, 255, 255, 0))
    result.paste(img, mask=mask)
    return result

def make_splash(logo: Image.Image, size: tuple) -> Image.Image:
    """生成启动屏：logo 居中，背景深色，使用 alpha 通道合成"""
    w, h = size
    canvas = Image.new("RGBA", (w, h), BG_COLOR + (255,))
    # logo 占画面短边的 60%
    ratio = min(w, h) * 0.60 / max(logo.size)
    new_w = int(logo.width * ratio)
    new_h = int(logo.height * ratio)
    logo_resized = logo.resize((new_w, new_h), Image.LANCZOS)
    x = (w - new_w) // 2
    y = (h - new_h) // 2
    # 使用 alpha 通道作为遮罩进行合成
    canvas.paste(logo_resized, (x, y), logo_resized)
    return canvas.convert("RGB")

def main():
    print(f"读取 logo：{LOGO_PATH}")
    logo_orig = Image.open(LOGO_PATH).convert("RGBA")
    print(f"原始尺寸：{logo_orig.size}")

    # 去除白底 logo（用于启动屏合成）
    logo_nobg = remove_white_bg(logo_orig.copy())

    # -------- 生成启动图标 --------
    for folder, size in ICON_SIZES.items():
        out_dir = RES_DIR / folder
        out_dir.mkdir(parents=True, exist_ok=True)

        # ic_launcher.png（方形，白底）
        icon = logo_orig.resize(size, Image.LANCZOS).convert("RGB")
        p = out_dir / "ic_launcher.png"
        icon.save(p, "PNG")
        print(f"  {p.relative_to(BASE)} {size}")

        # ic_launcher_round.png（圆形）
        round_icon = make_round_icon(logo_orig.copy(), size)
        pr = out_dir / "ic_launcher_round.png"
        round_icon.save(pr, "PNG")
        print(f"  {pr.relative_to(BASE)} {size} (round)")

        # ic_launcher_foreground.png（自适应图标前景）
        fg_size = FOREGROUND_SIZES[folder]
        fg = logo_orig.resize(fg_size, Image.LANCZOS).convert("RGBA")
        pf = out_dir / "ic_launcher_foreground.png"
        fg.save(pf, "PNG")
        print(f"  {pf.relative_to(BASE)} {fg_size} (foreground)")

    # -------- 生成启动屏（使用去白底 logo）--------
    for folder, size in SPLASH_SIZES.items():
        out_dir = RES_DIR / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        splash = make_splash(logo_nobg.copy(), size)
        p = out_dir / "splash.png"
        splash.save(p, "PNG")
        print(f"  {p.relative_to(BASE)} {size}")

    print("\n完成！所有图标和启动屏已生成。")

if __name__ == "__main__":
    main()
