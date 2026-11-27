#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理「空开关」：只动 GUI 列表 / sliders / profile 与 lang 文案，**不碰任何 #define**。
- screen.* 单行列表：删掉的元素原位换成 <empty>（保持网格布局）
- sliders 多行列表：整体收集后过滤，重新输出为单行（避免留下空的续行）
- profile.*：直接删 token
- lang：删 option.NAME / option.NAME.comment / value.NAME.* / suffix.NAME
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
    # B) lang 有文案、全仓没有对应 #define 的死文案（平台内置项保留）
    "DEBUG_PROBE_PLUMBING", "DEBUG_RESHADING", "NRD_DISOCCLUSION", "NRD_RELIABILITY",
    "REFLECTION_SCREEN_SPACE", "TRANSLUCENT_SSRT", "VOXELIZATION", "VOXEL_DISTANCE",
    "VOXEL_GI_DECAY", "VOXEL_GI_DIR_DIST", "VOXEL_GI_DIR_SAMPLES", "VOXEL_GI_RAYS",
    "VOXEL_GI_RAY_STEPS",
    # C) 有 #define、但全仓没有任何消费者（grep 核实：只剩定义/兜底/注释）
    "AGN_STRENGTH", "AGN_RESOLUTION", "WATER_PARALLAX_SAMPLES", "CLOUD_HIGH_SUNLIGHT_SAMPLES",
    "CLOUD_MID_SUNLIGHT_SAMPLES", "CLOUD_AS_COVERAGE", "CLOUD_TAAU_ANTIFLICKER",
    "SKY_VIEW_RESOLUTION", "VOXEL_GI_STRENGTH", "PROBE_GI_STRENGTH", "PROBE_MAX_FRAMES",
    "REFLECTION_FALLBACK_BASE", "SSPT_ENABLED", "SSPT_MAX_ACCUM_FRAMES", "SSPT_BLENDED_LIGHTMAP",
    "RSM_MAX_ACCUM_FRAMES",
    # D) 只剩滑条残留的死参数（Fresnel / FSR RCAS / 逐光反射采样数，代码里已无对应宏）
    "FRESNEL_EXPONENT", "FRESNEL_STRENGTH", "FSR_RCAS_SHARPNESS", "LIGHT_REFLECTION_SAMPLES",
    "REF_MIN", "REF_MAX",
]
NAMES = set(REMOVE)

props_path = os.path.join(SHADERS, "shaders.properties")
lines = open(props_path, encoding="utf-8", errors="replace").read().split("\n")


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


SCREEN = re.compile(r"^(\s*)(screen\.[^\s=]+\s*=\s*)(.*)$")
step1 = []
for line in lines:
    m = SCREEN.match(line)
    if not m:
        step1.append(line)
        continue
    prefix, rest = m.group(2), m.group(3)
    tokens = rest.split()
    kept = strip_dead(tokens, True)
    step1.append(line if kept == tokens else m.group(1) + prefix + " ".join(kept))

SLIDERS = re.compile(r"^(\s*)sliders\s*=\s*(.*)$")
step2 = []
i = 0
while i < len(step1):
    line = step1[i]
    m = SLIDERS.match(line)
    if not m:
        step2.append(line)
        i += 1
        continue
    indent, chunk = m.group(1), m.group(2)
    while chunk.rstrip().endswith("\\") and i + 1 < len(step1):
        chunk = chunk.rstrip()[:-1]
        i += 1
        chunk += " " + step1[i].strip()
    i += 1
    kept = strip_dead(chunk.split(), False)
    step2.append(indent + "sliders = " + " ".join(kept))

PROFILE = re.compile(r"^(\s*)(profile\.[^\s=]+\s*=\s*)(.*)$")
step3 = []
for line in step2:
    m = PROFILE.match(line)
    if not m:
        step3.append(line)
        continue
    prefix, rest = m.group(2), m.group(3)
    tokens = rest.split()
    kept = strip_dead(tokens, False)
    step3.append(line if kept == tokens else m.group(1) + prefix + " ".join(kept))

open(props_path, "w", encoding="utf-8", newline="\n").write("\n".join(step3))
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
