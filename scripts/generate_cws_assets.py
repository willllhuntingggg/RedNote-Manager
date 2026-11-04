#!/usr/bin/env python3
"""
生成符合 Chrome Web Store 严格规范的商店素材：
1. Small promo tile (440x280, 24-bit PNG, no alpha)
2. Marquee promo tile (1400x560, 24-bit PNG, no alpha) - 抽象矢量卡片风设计，无拟真截图，无失效 Emoji
3. Main Screenshot (1280x800, 24-bit PNG, no alpha)
"""

import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUTPUT_DIR = "assets/cws"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 字体选择（兼容 macOS 系统中文字体与英文字体）
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

def draw_gradient_background(width, height, color1, color2):
    """绘制细腻的双色平滑对角线渐变背景"""
    base = Image.new("RGB", (width, height), color1)
    draw = ImageDraw.Draw(base)
    r1, g1, b1 = color1
    r2, g2, b2 = color2
    total_steps = width + height
    for i in range(total_steps):
        ratio = min(1.0, max(0.0, i / float(total_steps)))
        r = int(r1 + (r2 - r1) * ratio)
        g = int(g1 + (g2 - g1) * ratio)
        b = int(b1 + (b2 - b1) * ratio)
        draw.line([(0, i), (i, 0)], fill=(r, g, b))
    return base

def round_corners(im, radius):
    """给图像添加平滑抗锯齿圆角"""
    mask = Image.new("L", im.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), im.size], radius=radius, fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), mask=mask)
    return out

# ==================== 矢量图标纯数学绘制（彻底避免 emoji 缺失乱码） ====================

def draw_bolt(draw, cx, cy, s, fill):
    """绘制高科技闪电矢量"""
    pts = [
        (cx + s * 0.15, cy - s),
        (cx - s * 0.65, cy + s * 0.05),
        (cx, cy + s * 0.05),
        (cx - s * 0.15, cy + s),
        (cx + s * 0.65, cy - s * 0.05),
        (cx, cy - s * 0.05),
    ]
    draw.polygon(pts, fill=fill)

def draw_cards_icon(draw, cx, cy, size, fill):
    """绘制叠卡速览矢量图标"""
    w, h = size * 0.75, size * 1.05
    # 底卡
    draw.rounded_rectangle([(cx - w//2 + 4, cy - h//2 - 4), (cx + w//2 + 4, cy + h//2 - 4)], radius=3, outline=fill, width=2)
    # 面卡
    draw.rounded_rectangle([(cx - w//2 - 3, cy - h//2 + 3), (cx + w//2 - 3, cy + h//2 + 3)], radius=3, fill=(30, 26, 42), outline=fill, width=2)

def draw_sparkle(draw, cx, cy, r_outer, r_inner, fill):
    """绘制 AI 智能星芒火花"""
    points = []
    for i in range(8):
        angle = i * math.pi / 4 - math.pi / 2
        r = r_outer if i % 2 == 0 else r_inner
        points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    draw.polygon(points, fill=fill)

def draw_undo_icon(draw, cx, cy, r, fill, width=2):
    """绘制撤回圆弧矢量箭头"""
    draw.arc([(cx - r, cy - r), (cx + r, cy + r)], start=35, end=300, fill=fill, width=width)
    ax = cx + r * math.cos(math.radians(35))
    ay = cy + r * math.sin(math.radians(35))
    draw.polygon([(ax, ay), (ax + 6, ay - 2), (ax + 2, ay + 6)], fill=fill)

def draw_cross(draw, cx, cy, size, fill, width=3):
    """绘制叉号"""
    d = size // 2
    draw.line([(cx - d, cy - d), (cx + d, cy + d)], fill=fill, width=width)
    draw.line([(cx - d, cy + d), (cx + d, cy - d)], fill=fill, width=width)

def draw_check(draw, cx, cy, size, fill, width=3):
    """绘制对勾"""
    draw.line([(cx - size * 0.5, cy), (cx - size * 0.1, cy + size * 0.4)], fill=fill, width=width)
    draw.line([(cx - size * 0.1, cy + size * 0.4), (cx + size * 0.5, cy - size * 0.4)], fill=fill, width=width)

def draw_star(draw, cx, cy, r_outer, r_inner, fill):
    """绘制五角星"""
    points = []
    for i in range(10):
        angle = i * math.pi / 5 - math.pi / 2
        r = r_outer if i % 2 == 0 else r_inner
        points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    draw.polygon(points, fill=fill)

# ==============================================================
# 1. Small promo tile (440x280) - 严格 440x280, 24-bit 无透明通道
# ==============================================================
def create_small_promo():
    w, h = 440, 280
    im = draw_gradient_background(w, h, (14, 15, 24), (28, 22, 38))
    
    # 柔和红紫双色光晕
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([(-50, -50), (220, 220)], fill=(255, 36, 66, 45))
    gdraw.ellipse([(260, 100), (490, 330)], fill=(139, 92, 246, 35))
    glow = glow.filter(ImageFilter.GaussianBlur(38))
    im.paste(glow, (0, 0), glow)

    draw = ImageDraw.Draw(im)

    # 装饰边框
    draw.rounded_rectangle([(8, 8), (w - 8, h - 8)], radius=14, outline=(48, 44, 65), width=1)

    # 图标
    icon_size = 54
    if os.path.exists(ICON_PATH):
        icon = Image.open(ICON_PATH).convert("RGBA").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        icon_rounded = round_corners(icon, 13)
        im.paste(icon_rounded, (w // 2 - icon_size // 2, 26), icon_rounded)

    # 主标题: RedNote Manager
    font_title = get_font(FONT_EN_BOLD, 22)
    title_text = "RedNote Manager"
    t_box = draw.textbbox((0, 0), title_text, font=font_title)
    tw = t_box[2] - t_box[0]
    draw.text(((w - tw) // 2, 94), title_text, font=font_title, fill=(255, 255, 255))

    # 副标题
    font_sub = get_font(FONT_ZH_BOLD, 14)
    sub_text = "小红书批量整理与 AI 助手"
    s_box = draw.textbbox((0, 0), sub_text, font=font_sub)
    sw = s_box[2] - s_box[0]
    draw.text(((w - sw) // 2, 128), sub_text, font=font_sub, fill=(255, 80, 105))

    # 特性标签组（胶囊式）
    tags = ["批量取赞/取关", "叠卡速览", "智能分类", "限速防熔断"]
    font_tag = get_font(FONT_ZH_BOLD, 11)
    
    row1 = tags[:2]
    row2 = tags[2:]
    
    def draw_tag_row(row_tags, y):
        total_w = sum((draw.textbbox((0, 0), t, font=font_tag)[2] - draw.textbbox((0, 0), t, font=font_tag)[0] + 20) for t in row_tags) + (len(row_tags) - 1) * 8
        cur_x = (w - total_w) // 2
        for t in row_tags:
            tw = draw.textbbox((0, 0), t, font=font_tag)[2] - draw.textbbox((0, 0), t, font=font_tag)[0]
            bw = tw + 20
            bh = 24
            draw.rounded_rectangle([(cur_x, y), (cur_x + bw, y + bh)], radius=12, fill=(35, 30, 48), outline=(68, 58, 85), width=1)
            draw.text((cur_x + 10, y + 5), t, font=font_tag, fill=(215, 215, 230))
            cur_x += bw + 8

    draw_tag_row(row1, 168)
    draw_tag_row(row2, 202)

    # 底部状态微标
    font_bottom = get_font(FONT_ZH_BOLD, 10)
    b_text = "安全拟人随机延迟 · 支持快照撤回"
    bb = draw.textbbox((0, 0), b_text, font=font_bottom)
    bw = bb[2] - bb[0]
    draw.text(((w - bw) // 2, 242), b_text, font=font_bottom, fill=(140, 135, 155))

    final_im = im.convert("RGB")
    out_path = os.path.join(OUTPUT_DIR, "small-promo-440x280.png")
    final_im.save(out_path, "PNG")
    print(f"[Generated] {out_path} ({final_im.size}, mode={final_im.mode})")

# ==============================================================
# 2. Marquee promo tile (1400x560) - 严格 1400x560, 24-bit 无透明通道
# 现代抽象矢量卡片风设计，告别拟真截图与 Emoji 缺失乱码
# ==============================================================
def create_marquee_promo():
    w, h = 1400, 560
    base = draw_gradient_background(w, h, (12, 13, 20), (26, 19, 34))

    # 背景氛围光晕
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([(-80, -80), (500, 500)], fill=(255, 36, 66, 32))
    gdraw.ellipse([(950, 60), (1450, 580)], fill=(139, 92, 246, 28))
    gdraw.ellipse([(1100, 300), (1500, 660)], fill=(255, 36, 66, 22))
    glow = glow.filter(ImageFilter.GaussianBlur(65))
    base.paste(glow, (0, 0), glow)

    draw = ImageDraw.Draw(base)

    # 精致外边框
    draw.rounded_rectangle([(12, 12), (w - 12, h - 12)], radius=18, outline=(42, 38, 58), width=1)

    # ------------------ 左侧栏：品牌与核心能力 ------------------
    left_x = 75

    # 顶部徽章
    tag_font = get_font(FONT_EN_BOLD, 11)
    tag_text = "CHROME EXTENSION  ·  AI POWERED"
    draw.rounded_rectangle([(left_x, 46), (left_x + 230, 70)], radius=12, fill=(30, 26, 44), outline=(65, 55, 85), width=1)
    draw.text((left_x + 16, 51), tag_text, font=tag_font, fill=(255, 100, 130))

    # 应用图标 + 主标题
    icon_size = 64
    if os.path.exists(ICON_PATH):
        icon = Image.open(ICON_PATH).convert("RGBA").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        icon_rounded = round_corners(icon, 14)
        base.paste(icon_rounded, (left_x, 86), icon_rounded)

    font_title = get_font(FONT_EN_BOLD, 36)
    draw.text((left_x + icon_size + 18, 92), "RedNote Manager", font=font_title, fill=(255, 255, 255))

    font_sub = get_font(FONT_ZH_BOLD, 17)
    draw.text((left_x, 162), "小红书批量整理与 AI 智能决策助手", font=font_sub, fill=(255, 85, 115))

    # 特性卡片（4 项带高精矢量绘制徽标，无 emoji 字符）
    features = [
        ("bolt", (255, 50, 80), (45, 22, 32), (110, 38, 52),
         "批量取消收藏 / 批量取赞",
         "原生嵌入侧边栏，模拟真人随机延时，安全防风控熔断"),
        ("cards", (129, 140, 248), (26, 26, 50), (70, 68, 125),
         "沉浸式叠卡速览翻阅",
         "左右滑卡轻松决策，手感丝滑顺畅，告别枯燥重复点击"),
        ("sparkle", (245, 158, 11), (45, 35, 20), (120, 85, 35),
         "AI 智能语义分析打标",
         "支持 DeepSeek 与本地模型，一键精准识别时效过期与营销广告"),
        ("undo", (16, 185, 129), (18, 42, 34), (35, 105, 80),
         "全流程快照历史与随时撤回",
         "执行任务自动存档快照，误操作支持一键原路撤回恢复"),
    ]

    card_y = 202
    font_f_title = get_font(FONT_ZH_BOLD, 14)
    font_f_desc = get_font(FONT_ZH_BOLD, 12)

    for icon_type, fg_color, bg_color, border_color, ft, fd in features:
        # 卡片底框
        draw.rounded_rectangle([(left_x, card_y), (left_x + 560, card_y + 64)], radius=10, fill=(22, 20, 32), outline=(45, 42, 60), width=1)
        
        # 矢量圆形徽标
        cx, cy = left_x + 36, card_y + 32
        r = 18
        draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=bg_color, outline=border_color, width=1)
        
        # 纯几何绘制矢量图标
        if icon_type == "bolt":
            draw_bolt(draw, cx, cy, 10, fg_color)
        elif icon_type == "cards":
            draw_cards_icon(draw, cx, cy, 14, fg_color)
        elif icon_type == "sparkle":
            draw_sparkle(draw, cx, cy, 10, 4, fg_color)
        elif icon_type == "undo":
            draw_undo_icon(draw, cx, cy, 8, fg_color, width=2)

        # 标题与描述
        draw.text((left_x + 66, card_y + 12), ft, font=font_f_title, fill=(255, 255, 255))
        draw.text((left_x + 66, card_y + 36), fd, font=font_f_desc, fill=(155, 155, 175))
        card_y += 76

    # ------------------ 右侧栏：抽象 2.5D 产品交互与叠卡插画 ------------------
    # 1. 概览分析统计毛玻璃卡片（左上方底衬）
    ax, ay, aw, ah = 680, 75, 280, 185
    ashadow = Image.new("RGBA", (aw + 24, ah + 24), (0, 0, 0, 0))
    asdraw = ImageDraw.Draw(ashadow)
    asdraw.rounded_rectangle([(6, 6), (aw + 18, ah + 18)], radius=14, fill=(0, 0, 0, 100))
    ashadow = ashadow.filter(ImageFilter.GaussianBlur(10))
    base.paste(ashadow, (ax - 6, ay - 6), ashadow)

    draw.rounded_rectangle([(ax, ay), (ax + aw, ay + ah)], radius=14, fill=(22, 20, 32), outline=(55, 50, 75), width=1)
    
    font_a_label = get_font(FONT_EN_BOLD, 10)
    draw.ellipse([(ax + 18, ay + 17), (ax + 24, ay + 23)], fill=(16, 185, 129))
    draw.text((ax + 32, ay + 14), "OVERVIEW · 笔记统计分析", font=font_a_label, fill=(160, 160, 180))

    font_a_num = get_font(FONT_EN_BOLD, 28)
    draw.text((ax + 18, ay + 38), "2,580", font=font_a_num, fill=(255, 255, 255))
    font_a_sub = get_font(FONT_ZH_BOLD, 11)
    draw.text((ax + 115, ay + 50), "篇已扫描笔记", font=font_a_sub, fill=(140, 140, 160))

    # 双色进度条
    pb_x, pb_y, pb_w, pb_h = ax + 18, ay + 82, aw - 36, 8
    draw.rounded_rectangle([(pb_x, pb_y), (pb_x + pb_w, pb_y + pb_h)], radius=4, fill=(40, 36, 56))
    keep_w = int(pb_w * 0.72)
    draw.rounded_rectangle([(pb_x, pb_y), (pb_x + keep_w, pb_y + pb_h)], radius=4, fill=(16, 185, 129))
    draw.rounded_rectangle([(pb_x + keep_w + 3, pb_y), (pb_x + pb_w, pb_y + pb_h)], radius=4, fill=(255, 59, 92))

    draw.ellipse([(ax + 18, ay + 104), (ax + 24, ay + 110)], fill=(16, 185, 129))
    draw.text((ax + 30, ay + 101), "保留干货 1,857 篇", font=font_a_sub, fill=(210, 235, 220))

    draw.ellipse([(ax + 150, ay + 104), (ax + 156, ay + 110)], fill=(255, 59, 92))
    draw.text((ax + 162, ay + 101), "待清理 723 篇", font=font_a_sub, fill=(255, 180, 190))

    # 防封安全保护微标签
    draw.rounded_rectangle([(ax + 18, ay + 130), (ax + aw - 18, ay + 165)], radius=8, fill=(28, 25, 40), outline=(50, 46, 68), width=1)
    draw.ellipse([(ax + 30, ay + 144), (ax + 36, ay + 150)], fill=(16, 185, 129))
    draw.text((ax + 44, ay + 140), "已启用动态安全限速保护", font=font_a_sub, fill=(150, 225, 190))

    # 2. 叠卡底层卡片（营造 3D 卡堆层次感）
    bx, by, bw, bh = 870, 70, 385, 430
    draw.rounded_rectangle([(bx, by), (bx + bw, by + bh)], radius=18, fill=(24, 21, 35), outline=(52, 48, 70), width=1)
    deck_top = Image.new("RGBA", (bw, 70), (0, 0, 0, 0))
    dtdraw = ImageDraw.Draw(deck_top)
    for i in range(bw):
        ratio = i / float(bw)
        r = int(90 + (139 - 90) * ratio)
        g = int(40 + (92 - 40) * ratio)
        b = int(140 + (246 - 140) * ratio)
        dtdraw.line([(i, 0), (i, 70)], fill=(r, g, b, 140))
    deck_top_rounded = round_corners(deck_top, 18)
    base.paste(deck_top_rounded, (bx, by), deck_top_rounded)

    # 3. 主角叠卡：翻阅手势卡片 (Tinder 风格)
    hx, hy, hw, hh = 920, 55, 395, 450

    hshadow = Image.new("RGBA", (hw + 36, hh + 36), (0, 0, 0, 0))
    hsdraw = ImageDraw.Draw(hshadow)
    hsdraw.rounded_rectangle([(12, 12), (hw + 24, hh + 24)], radius=22, fill=(0, 0, 0, 130))
    hshadow = hshadow.filter(ImageFilter.GaussianBlur(16))
    base.paste(hshadow, (hx - 12, hy - 8), hshadow)

    draw.rounded_rectangle([(hx, hy), (hx + hw, hy + hh)], radius=18, fill=(27, 24, 38), outline=(80, 72, 108), width=2)

    # 卡片顶部：抽象艺术日落渐变封面
    cover_h = 165
    cover = Image.new("RGBA", (hw, cover_h), (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(cover)
    for x in range(hw):
        ratio = x / float(hw)
        r = int(255 * (1 - ratio * 0.3))
        g = int(45 + 50 * ratio)
        b = int(85 + 140 * ratio)
        cdraw.line([(x, 0), (x, cover_h)], fill=(r, g, b, 255))
    
    # 抽象几何纹理
    cdraw.ellipse([(hw - 90, -30), (hw + 70, 130)], fill=(255, 255, 255, 40))
    cdraw.ellipse([(-20, 40), (120, 180)], fill=(255, 200, 100, 50))
    cdraw.polygon([(40, 165), (140, 70), (240, 165)], fill=(30, 20, 50, 80))
    cdraw.polygon([(180, 165), (280, 95), (380, 165)], fill=(30, 20, 50, 100))

    cover_mask = Image.new("L", (hw, cover_h), 0)
    cmdraw = ImageDraw.Draw(cover_mask)
    cmdraw.rounded_rectangle([(0, 0), (hw, cover_h + 30)], radius=18, fill=255)
    base.paste(cover, (hx, hy), cover_mask)

    # 封面浮动标签
    font_tag_c = get_font(FONT_ZH_BOLD, 11)
    draw.rounded_rectangle([(hx + 14, hy + 14), (hx + 115, hy + 38)], radius=10, fill=(0, 0, 0, 160))
    draw.text((hx + 24, hy + 19), "穿搭 · 收藏夹", font=font_tag_c, fill=(240, 240, 255))

    draw.rounded_rectangle([(hx + hw - 105, hy + 14), (hx + hw - 14, hy + 38)], radius=10, fill=(255, 36, 66), outline=(255, 120, 140), width=1)
    draw.text((hx + hw - 93, hy + 19), "AI 建议清理", font=font_tag_c, fill=(255, 255, 255))

    # 笔记详情
    font_note_title = get_font(FONT_ZH_BOLD, 15)
    draw.text((hx + 18, hy + cover_h + 16), "2023 最新秋冬大衣穿搭与购买推荐", font=font_note_title, fill=(255, 255, 255))

    font_note_meta = get_font(FONT_ZH_BOLD, 12)
    draw.ellipse([(hx + 18, hy + cover_h + 46), (hx + 26, hy + cover_h + 54)], fill=(255, 80, 110))
    draw.text((hx + 34, hy + cover_h + 43), "生活穿搭馆  ·  18 个月前发布  ·  842 赞", font=font_note_meta, fill=(155, 155, 175))

    # AI 智能诊断框
    ai_box_y = hy + cover_h + 74
    draw.rounded_rectangle([(hx + 16, ai_box_y), (hx + hw - 16, ai_box_y + 72)], radius=10, fill=(35, 30, 48), outline=(68, 60, 92), width=1)
    draw_sparkle(draw, hx + 32, ai_box_y + 24, 7, 3, (245, 158, 11))
    
    font_ai_title = get_font(FONT_ZH_BOLD, 12)
    draw.text((hx + 46, ai_box_y + 14), "AI 诊断判定：时效已过期 · 广告引流", font=font_ai_title, fill=(255, 195, 100))
    
    font_ai_desc = get_font(FONT_ZH_BOLD, 11)
    draw.text((hx + 46, ai_box_y + 38), "优惠活动已结束且包含失效第三方外链，建议清理。", font=font_ai_desc, fill=(200, 200, 220))

    # 底部滑动操作按键
    btn_y = hy + hh - 54
    font_btn_lbl = get_font(FONT_ZH_BOLD, 11)

    # 左侧：清理（滑向左）
    btn1_cx = hx + 75
    draw.ellipse([(btn1_cx - 24, btn_y - 24), (btn1_cx + 24, btn_y + 24)], fill=(45, 22, 34), outline=(255, 59, 92), width=2)
    draw_cross(draw, btn1_cx, btn_y, 16, (255, 75, 100), width=3)
    lbl1 = "左滑清理"
    l1w = draw.textbbox((0, 0), lbl1, font=font_btn_lbl)[2] - draw.textbbox((0, 0), lbl1, font=font_btn_lbl)[0]
    draw.text((btn1_cx - l1w // 2, btn_y + 30), lbl1, font=font_btn_lbl, fill=(255, 90, 115))

    # 中间：跳过
    btn2_cx = hx + hw // 2
    draw.ellipse([(btn2_cx - 20, btn_y - 20), (btn2_cx + 20, btn_y + 20)], fill=(34, 30, 48), outline=(100, 95, 130), width=1)
    draw_star(draw, btn2_cx, btn_y, 10, 4, (180, 180, 205))
    lbl2 = "跳过"
    l2w = draw.textbbox((0, 0), lbl2, font=font_btn_lbl)[2] - draw.textbbox((0, 0), lbl2, font=font_btn_lbl)[0]
    draw.text((btn2_cx - l2w // 2, btn_y + 30), lbl2, font=font_btn_lbl, fill=(160, 160, 180))

    # 右侧：保留（滑向右）
    btn3_cx = hx + hw - 75
    draw.ellipse([(btn3_cx - 24, btn_y - 24), (btn3_cx + 24, btn_y + 24)], fill=(18, 42, 34), outline=(16, 185, 129), width=2)
    draw_check(draw, btn3_cx, btn_y, 16, (16, 185, 129), width=3)
    lbl3 = "右滑保留"
    l3w = draw.textbbox((0, 0), lbl3, font=font_btn_lbl)[2] - draw.textbbox((0, 0), lbl3, font=font_btn_lbl)[0]
    draw.text((btn3_cx - l3w // 2, btn_y + 30), lbl3, font=font_btn_lbl, fill=(52, 211, 153))

    # 4. 环绕浮动高科技胶囊
    # 浮标 1：右上角 AI 置信度
    s1_x, s1_y = 1170, 36
    draw.rounded_rectangle([(s1_x, s1_y), (s1_x + 160, s1_y + 34)], radius=14, fill=(35, 26, 54), outline=(139, 92, 246), width=1)
    draw_sparkle(draw, s1_x + 18, s1_y + 17, 7, 3, (168, 85, 247))
    font_sat = get_font(FONT_EN_BOLD, 11)
    draw.text((s1_x + 32, s1_y + 9), "AI 置信度 96.8%", font=font_sat, fill=(235, 220, 255))

    # 浮标 2：左下支持模型
    s2_x, s2_y = 690, 280
    draw.rounded_rectangle([(s2_x, s2_y), (s2_x + 185, s2_y + 32)], radius=12, fill=(20, 24, 38), outline=(59, 130, 246), width=1)
    draw.ellipse([(s2_x + 14, s2_y + 12), (s2_x + 20, s2_y + 18)], fill=(59, 130, 246))
    draw.text((s2_x + 28, s2_y + 8), "已接入 DeepSeek AI", font=font_sat, fill=(185, 215, 255))

    # 浮标 3：底部安全保护
    s3_x, s3_y = 705, 440
    draw.rounded_rectangle([(s3_x, s3_y), (s3_x + 195, s3_y + 32)], radius=12, fill=(18, 36, 30), outline=(16, 185, 129), width=1)
    draw.ellipse([(s3_x + 14, s3_y + 12), (s3_x + 20, s3_y + 18)], fill=(16, 185, 129))
    draw.text((s3_x + 28, s3_y + 8), "安全延时 1.5s ~ 3.2s", font=font_sat, fill=(165, 235, 205))

    # 严格转为 24-bit RGB (no alpha)
    final_im = base.convert("RGB")
    out_path = os.path.join(OUTPUT_DIR, "marquee-promo-1400x560.png")
    final_im.save(out_path, "PNG")
    print(f"[Generated] {out_path} ({final_im.size}, mode={final_im.mode})")

# ==============================================================
# 3. Main Screenshot (1280x800) - 满足商店必备 1280x800 截图要求
# ==============================================================
def create_screenshot():
    w, h = 1280, 800
    im = draw_gradient_background(w, h, (18, 18, 25), (25, 20, 32))
    draw = ImageDraw.Draw(im)

    # 顶栏装饰
    font_header = get_font(FONT_EN_BOLD, 28)
    font_sub = get_font(FONT_ZH_BOLD, 16)
    draw.text((70, 42), "RedNote Manager", font=font_header, fill=(255, 255, 255))
    draw.text((320, 52), "小红书网页版原生侧边栏 · 批量取消收藏/点赞 & AI 智能打标", font=font_sub, fill=(255, 80, 105))

    # 放置界面主体实拍
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
