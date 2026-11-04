#!/usr/bin/env python3
"""
生成符合 Chrome Web Store 严格规范的商店素材：
1. Small promo tile (440x280, 24-bit PNG, no alpha)
2. Marquee promo tile (1400x560, 24-bit PNG, no alpha)
3. Main Screenshot (1280x800, 24-bit PNG, no alpha)
"""

import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUTPUT_DIR = "assets/cws"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 字体选择
FONT_ZH_BOLD = "/System/Library/Fonts/Hiragino Sans GB.ttc"
if not os.path.exists(FONT_ZH_BOLD):
    FONT_ZH_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_EN_BOLD = "/System/Library/Fonts/HelveticaNeue.ttc"
if not os.path.exists(FONT_EN_BOLD):
    FONT_EN_BOLD = FONT_ZH_BOLD

ICON_PATH = "assets/icon128.png"
PREVIEW_PATH = "docs/panel-preview.png"

def get_font(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.load_default()

def draw_gradient_background(width, height, color1, color2, direction="diag"):
    """绘制细腻的双色平滑渐变背景"""
    base = Image.new("RGB", (width, height), color1)
    draw = ImageDraw.Draw(base)
    r1, g1, b1 = color1
    r2, g2, b2 = color2

    if direction == "vert":
        for y in range(height):
            ratio = y / max(1, height - 1)
            r = int(r1 + (r2 - r1) * ratio)
            g = int(g1 + (g2 - g1) * ratio)
            b = int(b1 + (b2 - b1) * ratio)
            draw.line([(0, y), (width, y)], fill=(r, g, b))
    elif direction == "diag":
        for i in range(width + height):
            ratio = min(1.0, max(0.0, i / float(width + height)))
            r = int(r1 + (r2 - r1) * ratio)
            g = int(g1 + (g2 - g1) * ratio)
            b = int(b1 + (b2 - b1) * ratio)
            # 绘制对角线
            draw.line([(0, i), (i, 0)], fill=(r, g, b))
    return base

def round_corners(im, radius):
    """给图像添加圆角"""
    mask = Image.new("L", im.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), im.size], radius=radius, fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), mask=mask)
    return out

# ==============================================================
# 1. Small promo tile (440x280) - 必须严格 440x280, 24-bit 无透明通道
# ==============================================================
def create_small_promo():
    w, h = 440, 280
    # 背景：沉浸暗色高级渐变 + 小红书红光晕
    im = draw_gradient_background(w, h, (18, 18, 26), (30, 24, 38), direction="diag")
    
    # 添加一个柔和的红色光晕
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([(-40, -40), (220, 220)], fill=(255, 36, 66, 45))
    gdraw.ellipse([(260, 100), (480, 320)], fill=(255, 36, 66, 30))
    glow = glow.filter(ImageFilter.GaussianBlur(35))
    im.paste(glow, (0, 0), glow)

    draw = ImageDraw.Draw(im)

    # 装饰边框
    draw.rounded_rectangle([(8, 8), (w - 8, h - 8)], radius=12, outline=(50, 45, 65), width=1)

    # 图标
    icon_size = 56
    if os.path.exists(ICON_PATH):
        icon = Image.open(ICON_PATH).convert("RGBA").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        icon_rounded = round_corners(icon, 12)
        im.paste(icon_rounded, (w // 2 - icon_size // 2, 28), icon_rounded)

    # 主标题: RedNote Manager
    font_title = get_font(FONT_EN_BOLD, 22)
    title_text = "RedNote Manager"
    t_box = draw.textbbox((0, 0), title_text, font=font_title)
    tw = t_box[2] - t_box[0]
    draw.text(((w - tw) // 2, 98), title_text, font=font_title, fill=(255, 255, 255))

    # 副标题
    font_sub = get_font(FONT_ZH_BOLD, 15)
    sub_text = "小红书批量整理与 AI 助手"
    s_box = draw.textbbox((0, 0), sub_text, font=font_sub)
    sw = s_box[2] - s_box[0]
    draw.text(((w - sw) // 2, 132), sub_text, font=font_sub, fill=(255, 80, 105))

    # 特性标签组（胶囊式）
    tags = ["批量取赞/取关", "叠卡速览", "智能分类", "限速防熔断"]
    font_tag = get_font(FONT_ZH_BOLD, 11)
    
    # 算两排居中
    row1 = tags[:2]
    row2 = tags[2:]
    
    def draw_tag_row(row_tags, y):
        total_w = sum((draw.textbbox((0, 0), t, font=font_tag)[2] - draw.textbbox((0, 0), t, font=font_tag)[0] + 20) for t in row_tags) + (len(row_tags) - 1) * 8
        cur_x = (w - total_w) // 2
        for t in row_tags:
            tw = draw.textbbox((0, 0), t, font=font_tag)[2] - draw.textbbox((0, 0), t, font=font_tag)[0]
            bw = tw + 20
            bh = 24
            draw.rounded_rectangle([(cur_x, y), (cur_x + bw, y + bh)], radius=12, fill=(35, 32, 48), outline=(65, 55, 80), width=1)
            draw.text((cur_x + 10, y + 5), t, font=font_tag, fill=(215, 215, 230))
            cur_x += bw + 8

    draw_tag_row(row1, 172)
    draw_tag_row(row2, 206)

    # 确认为 24-bit RGB (no alpha)
    final_im = im.convert("RGB")
    out_path = os.path.join(OUTPUT_DIR, "small-promo-440x280.png")
    final_im.save(out_path, "PNG")
    print(f"[Generated] {out_path} ({final_im.size}, mode={final_im.mode})")

# ==============================================================
# 2. Marquee promo tile (1400x560) - 严格 1400x560, 24-bit 无透明通道
# ==============================================================
def create_marquee_promo():
    w, h = 1400, 560
    im = draw_gradient_background(w, h, (15, 15, 22), (28, 22, 36), direction="diag")

    # 柔和红光晕
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([(-100, -100), (600, 600)], fill=(255, 36, 66, 40))
    gdraw.ellipse([(800, 200), (1500, 700)], fill=(255, 36, 66, 25))
    glow = glow.filter(ImageFilter.GaussianBlur(65))
    im.paste(glow, (0, 0), glow)

    draw = ImageDraw.Draw(im)

    # 外边框
    draw.rounded_rectangle([(14, 14), (w - 14, h - 14)], radius=20, outline=(45, 42, 60), width=1)

    # 左侧文字区域
    left_x = 90

    # 图标与标题并排
    icon_size = 72
    if os.path.exists(ICON_PATH):
        icon = Image.open(ICON_PATH).convert("RGBA").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        icon_rounded = round_corners(icon, 16)
        im.paste(icon_rounded, (left_x, 70), icon_rounded)

    font_title = get_font(FONT_EN_BOLD, 42)
    draw.text((left_x + icon_size + 24, 76), "RedNote Manager", font=font_title, fill=(255, 255, 255))

    font_sub = get_font(FONT_ZH_BOLD, 22)
    draw.text((left_x, 168), "小红书批量取消收藏 / 点赞 · AI 智能整理助手", font=font_sub, fill=(255, 75, 100))

    # 特性列表 (4 项卡片)
    features = [
        ("⚡ 纯原生侧边栏操作", "无感融入小红书网页，人味随机延时，安全防风控熔断"),
        ("🎴 沉浸式叠卡速览", "像刷社交软件一样轻松翻阅，随手撤回整理，告别枯燥"),
        ("🤖 DeepSeek AI 语义打标", "一键识别时效过期与营销广告，干货长青笔记精准保留"),
        ("↩️ 全流程安全可撤销", "每次运行自动记录历史快照，误操作支持一键原路撤回"),
    ]

    card_y = 224
    font_f_title = get_font(FONT_ZH_BOLD, 15)
    font_f_desc = get_font(FONT_ZH_BOLD, 13)

    for ft, fd in features:
        draw.rounded_rectangle([(left_x, card_y), (left_x + 580, card_y + 64)], radius=10, fill=(26, 25, 36), outline=(52, 48, 68), width=1)
        draw.text((left_x + 18, card_y + 12), ft, font=font_f_title, fill=(255, 255, 255))
        draw.text((left_x + 18, card_y + 36), fd, font=font_f_desc, fill=(165, 165, 185))
        card_y += 74

    # 右侧放置插件界面实拍 Mockup
    if os.path.exists(PREVIEW_PATH):
        preview = Image.open(PREVIEW_PATH).convert("RGBA")
        # 裁剪并缩放以适应右侧展示
        pw = 560
        ph = int(preview.size[1] * (pw / preview.size[0]))
        preview_scaled = preview.resize((pw, ph), Image.Resampling.LANCZOS)
        
        # 限制在右侧卡片高度内
        crop_h = min(420, ph)
        preview_cropped = preview_scaled.crop((0, 0, pw, crop_h))
        preview_rounded = round_corners(preview_cropped, 16)

        # 阴影底衬
        px = 750
        py = 70
        shadow = Image.new("RGBA", (pw + 24, crop_h + 24), (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(shadow)
        sdraw.rounded_rectangle([(6, 6), (pw + 18, crop_h + 18)], radius=18, fill=(0, 0, 0, 110))
        shadow = shadow.filter(ImageFilter.GaussianBlur(14))
        im.paste(shadow, (px - 12, py - 6), shadow)

        # 贴入界面图
        im.paste(preview_rounded, (px, py), preview_rounded)
        draw.rounded_rectangle([(px, py), (px + pw, py + crop_h)], radius=16, outline=(80, 75, 105), width=2)

    final_im = im.convert("RGB")
    out_path = os.path.join(OUTPUT_DIR, "marquee-promo-1400x560.png")
    final_im.save(out_path, "PNG")
    print(f"[Generated] {out_path} ({final_im.size}, mode={final_im.mode})")

# ==============================================================
# 3. Main Screenshot (1280x800) - 满足商店必备 1280x800 截图要求
# ==============================================================
def create_screenshot():
    w, h = 1280, 800
    im = draw_gradient_background(w, h, (18, 18, 25), (25, 20, 32), direction="diag")
    draw = ImageDraw.Draw(im)

    # 顶栏装饰
    font_header = get_font(FONT_EN_BOLD, 28)
    font_sub = get_font(FONT_ZH_BOLD, 16)
    draw.text((70, 42), "RedNote Manager", font=font_header, fill=(255, 255, 255))
    draw.text((320, 52), "小红书网页版原生侧边栏 · 批量取消收藏/点赞 & AI 智能打标", font=font_sub, fill=(255, 80, 105))

    # 放置界面主体
    if os.path.exists(PREVIEW_PATH):
        preview = Image.open(PREVIEW_PATH).convert("RGBA")
        target_h = 660
        target_w = int(preview.size[0] * (target_h / preview.size[1]))
        if target_w > 1140:
            target_w = 1140
            target_h = int(preview.size[1] * (target_w / preview.size[0]))
        preview_scaled = preview.resize((target_w, target_h), Image.Resampling.LANCZOS)
        preview_rounded = round_corners(preview_scaled, 14)

        px = (w - target_w) // 2
        py = 95

        # 阴影
        shadow = Image.new("RGBA", (target_w + 30, target_h + 30), (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(shadow)
        sdraw.rounded_rectangle([(10, 10), (target_w + 20, target_h + 20)], radius=18, fill=(0, 0, 0, 130))
        shadow = shadow.filter(ImageFilter.GaussianBlur(18))
        im.paste(shadow, (px - 15, py - 10), shadow)

        # 贴图
        im.paste(preview_rounded, (px, py), preview_rounded)
        draw.rounded_rectangle([(px, py), (px + target_w, py + target_h)], radius=14, outline=(70, 65, 90), width=2)

    final_im = im.convert("RGB")
    out_path = os.path.join(OUTPUT_DIR, "screenshot-1280x800.png")
    final_im.save(out_path, "PNG")
    print(f"[Generated] {out_path} ({final_im.size}, mode={final_im.mode})")

if __name__ == "__main__":
    create_small_promo()
    create_marquee_promo()
    create_screenshot()
    print("\n✅ 所有 Chrome Web Store 商店素材已高质量生成完毕！")
