"""
Generates a simple placeholder app icon for PTZ Follow: a camera lens/target motif with
pan-rotation arrows, drawn directly with PIL (no external SVG renderer needed). Produces
packaging/AppIcon.png (1024x1024) as the source image, which build_mac.sh then turns into a
real macOS .icns via sips + iconutil.

Swap this out anytime by replacing packaging/AppIcon.png with real artwork (also 1024x1024,
square, no pre-rounded corners - macOS applies its own corner treatment) and skipping this
script.
"""
import math
from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- Background: rounded square, blue gradient (top-left light -> bottom-right dark) ---
margin = 32
corner_radius = 210
top_color = (66, 165, 245)   # lighter blue
bottom_color = (13, 71, 161)  # darker blue

bg = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
bg_draw = ImageDraw.Draw(bg)
for y in range(SIZE):
    t = y / SIZE
    r = int(top_color[0] + (bottom_color[0] - top_color[0]) * t)
    g = int(top_color[1] + (bottom_color[1] - top_color[1]) * t)
    b = int(top_color[2] + (bottom_color[2] - top_color[2]) * t)
    bg_draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

mask = Image.new('L', (SIZE, SIZE), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin], radius=corner_radius, fill=255)
img.paste(bg, (0, 0), mask)
draw = ImageDraw.Draw(img)

# --- Camera lens: concentric circles ---
cx, cy = SIZE // 2, SIZE // 2 + 10
outer_r = 260
mid_r = 195
inner_r = 95
highlight_r = 34

draw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=(255, 255, 255, 255))
draw.ellipse([cx - mid_r, cy - mid_r, cx + mid_r, cy + mid_r], fill=(15, 32, 66, 255))
draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=(66, 165, 245, 255))
# highlight, offset up-left for a glassy look
hx, hy = cx - 40, cy - 45
draw.ellipse([hx - highlight_r, hy - highlight_r, hx + highlight_r, hy + highlight_r], fill=(255, 255, 255, 200))

# --- Pan-rotation arrows: two arcs around the lens with arrowhead triangles ---
arc_r = outer_r + 70
arc_width = 26
arrow_color = (255, 255, 255, 255)

def draw_arrow_arc(center, radius, start_deg, end_deg, width, color):
    bbox = [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius]
    draw.arc(bbox, start=start_deg, end=end_deg, fill=color, width=width)
    # arrowhead at the end_deg point, tangent to the arc
    tip_angle = math.radians(end_deg)
    tip = (center[0] + radius * math.cos(tip_angle), center[1] + radius * math.sin(tip_angle))
    tangent = tip_angle + math.pi / 2  # direction of travel along the arc
    head_len = width * 2.1
    head_spread = math.radians(28)
    p1 = tip
    p2 = (tip[0] - head_len * math.cos(tangent - head_spread), tip[1] - head_len * math.sin(tangent - head_spread))
    p3 = (tip[0] - head_len * math.cos(tangent + head_spread), tip[1] - head_len * math.sin(tangent + head_spread))
    draw.polygon([p1, p2, p3], fill=color)

# Top-left arc sweeping down (pan left), bottom-right arc sweeping up (pan right) - together
# they suggest circular/rotational motion around the lens, evoking "pan/tilt".
draw_arrow_arc((cx, cy), arc_r, 200, 330, arc_width, arrow_color)
draw_arrow_arc((cx, cy), arc_r, 20, 150, arc_width, arrow_color)

img.save('/Users/c/Documents/Programming/PTZ-Follow/packaging/AppIcon.png')
print("Saved packaging/AppIcon.png")
