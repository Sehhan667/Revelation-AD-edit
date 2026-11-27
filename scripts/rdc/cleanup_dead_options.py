#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理「空开关」：只动 GUI 列表 / sliders / profile 与 lang 文案，**不碰任何 #define**。
- screen.* 里删掉的元素原位换成 <empty>（保持网格）；sliders/profile.* 里直接删。
- 只重写 token 真正变化的行，保留原有缩进/前缀/续行反斜杠，避免无谓 diff。
"""
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHADERS = os.path.join(ROOT, "shaders")

REMOVE = [
    # A) 游戏日志里 Iris 报 "Unable to resolve"（定义在未生效分支 / 已注释）
    "ATMOSPHERE_TURBIDITY", "AUTO_GENERATED_NORMAL", "BLOOM_NO_DOWNSAMPLE", "FXAA_ENABLED",
    "GI_STABILIZE_FRAMES", "KILL_RIPPLE_HIGHLIGHT", "KILL_RIPPLE_RANGE", "RAYTRACED_REFRACTION",
    "RSM_BRIGHTNESS", "RSM_ENABLED", "RSM_RADIUS", "RSM_SAMPLES", "SSILVB_TEMPORAL_MIX_SPEED",
    "SVGF_QUALITY", "UW_VOLUMETRIC_FOG", "VOXEL_GI_FIREFLY_MEDIAN", "VOXEL_GI_NRD",
    "VOXEL_LD_SAMPLING",
    # B) lang 有文案、全仓没有对应 #define 的死文案（平台内置 shadowDistance / sunPathRotation /
    #    shadowMapResolution 保留）
    "DEBUG_PROBE_PLUMBING", "DEBUG_RESHADING", "NRD_DISOCCLUSION", "NRD_RELIABILITY",
    "REFLECTION_SCREEN_SPACE", "TRANSLUCENT_SSRT", "VOXELIZATION", "VOXEL_DISTANCE",
    "VOXEL_GI_DECAY", "VOXEL_GI_DIR_DIST", "VOXEL_GI_DIR_SAMPLES", "VOXEL_GI_RAYS",
    "VOXEL_GI_RAY_STEPS",
    # C) 有 #define、但全仓没有任何消费者（grep 核实：只剩自己的定义/兜底/注释）——滑块是空的
    "AGN_STRENGTH", "AGN_RESOLUTION", "WATER_PARALLAX_SAMPLES", "CLOUD_HIGH_SUNLIGHT_SAMPLES",
    "CLOUD_MID_SUNLIGHT_SAMPLES", "CLOUD_AS_COVERAGE", "CLOUD_TAAU_ANTIFLICKER",
    "SKY_VIEW_RESOLUTION", "VOXEL_GI_STRENGTH", "PROBE_GI_STRENGTH", "PROBE_MAX_FRAMES",
    "REFLECTION_FALLBACK_BASE", "SSPT_ENABLED", "SSPT_MAX_ACCUM_FRAMES", "SSPT_BLENDED_LIGHTMAP",
    "RSM_MAX_ACCUM_FRAMES",
]
NAMES = set(REMOVE)

props_path = os.path.join(SHADERS, "shaders.properties")
text = open(props_path, encoding="utf-8", errors="replace").read()
lines = text.split("\\n")

def strip_dead(tokens, to_empty):
    kept = []
    for tok in tokens:
        bare = tok.lstrip("!").split("=", 1)[0]
        if bare in NAMES:
            if to_empty:
                kept.append("<empty>")
            continue
        kept.append(tok)
    return kept

# --- 1) screen.* 单行列表：原位替换成 <empty>（保持网格布局）---
SCREEN = re.compile(r"^(\\s*)(screen\\.[^\\s=]+\\s*=\\s*)(.*)$")
out = []
for line in lines:
    m = SCREEN.match(line)
    if not m:
        out.append(line)
        continue
    indent, prefix, rest = m.groups()
    tokens = rest.split()
    kept = strip_dead(tokens, True)
    out.append(line if kept == tokens else prefix + " ".join(kept))

# --- 2) sliders 多行列表：整体收集后过滤，重新输出为单行（避免空的续行）---
text2 = "\\n".join(out)
lines2 = text2.split("\\n")
out2 = []
i = 0
while i < len(lines2):
    line = lines2[i]
    m = re.match(r"^(\\s*)sliders\\s*=\\s*(.*)$", line)
    if not m:
        out2.append(line)
        i += 1
        continue
    indent = m.group(1)
    chunk = m.group(2)
    while chunk.rstrip().endswith("\\") and i + 1 < len(lines2):
        chunk = chunk.rstrip()[:-1]
        i += 1
        chunk += " " + lines2[i].strip()
    i += 1
    tokens = chunk.split()
    kept = strip_dead(tokens, False)
    out2.append(indent + "sliders = " + " ".join(kept))

# --- 3) profile.* 单行列表：直接删 token ---
PROFILE = re.compile(r"^(\\s*)(profile\\.[^\\s=]+\\s*=\\s*)(.*)$")
out3 = []
for line in out2:
    m = PROFILE.match(line)
    if not m:
        out3.append(line)
        continue
    indent, prefix, rest = m.groups()
    tokens = rest.split()
    kept = strip_dead(tokens, False)
    out3.append(line if kept == tokens else prefix + " ".join(kept))

open(props_path, "w", encoding="utf-8", newline="\\n").write("\\n".join(out3))
print("properties rewritten")
for f in sorted(os.listdir(os.path.join(SHADERS, "lang"))):
    if not f.endswith(".lang"):
        continue
    p = os.path.join(SHADERS, "lang", f)
    src = open(p, encoding="utf-8", errors="replace").read()
    keep, dropped = [], 0
    for line in src.split("\n"):
        m = re.match(r"^\s*(option|value|suffix)\.([A-Za-z0-9_]+)(\.[A-Za-z0-9_]+)?\s*=", line)
        if m and m.group(2) in NAMES:
            dropped += 1
            continue
        keep.append(line)
    if dropped:
        open(p, "w", encoding="utf-8", newline="\n").write("\n".join(keep))
        print("%s: 删除 %d 条文案" % (f, dropped))
