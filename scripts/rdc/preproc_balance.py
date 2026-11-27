import os, re, sys

# 预处理条件配对检查：确认没有多余的 #endif / 未闭合的 #if（编辑后 sanity check）
root = "shaders"
bad = 0
for dp, _, fns in os.walk(root):
    for fn in fns:
        if not fn.endswith((".glsl", ".frag", ".vert", ".comp", ".geom", ".vsh", ".fsh", ".gsh", ".csh")):
            continue
        p = os.path.join(dp, fn)
        txt = open(p, encoding="utf-8", errors="replace").read()
        depth = 0
        minv = 0
        for ln, line in enumerate(txt.splitlines(), 1):
            s = line.strip()
            if not s.startswith("#"):
                continue
            d = s[1:].strip()
            if d.startswith("if"):
                depth += 1
            elif d.startswith("endif"):
                depth -= 1
                minv = min(minv, depth)
        if depth != 0 or minv < 0:
            bad += 1
            print(f"UNBALANCED {p}: depth={depth} min={minv}")
print("files checked:", "all balanced" if bad == 0 else f"{bad} unbalanced")

# 目标文件：打印编辑区域
p = "shaders/settings.glsl"
txt = open(p, encoding="utf-8", errors="replace").read()
print("BOM:", txt.startswith("\ufeff"), "| file bytes:", len(txt.encode("utf-8")))
lines = txt.splitlines()
for i in range(395, 432):
    if i < len(lines):
        print(f"{i+1}: {lines[i]}")
