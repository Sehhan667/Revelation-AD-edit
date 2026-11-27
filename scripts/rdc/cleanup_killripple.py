#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""删除击杀特效（kill-ripple）后，清理它在 GUI / sliders / profile / lang 里的残留。
- screen.*：原位换 <empty>（保持网格）
- sliders / profile：直接删 token
- lang：删 option./value./suffix. 条目
"""
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHADERS = os.path.join(ROOT, "shaders")

NAMES = {
    "KILL_RIPPLE", "KILL_RIPPLE_TRIGGER_TIME", "KILL_RIPPLE_DURATION",
    "KILL_RIPPLE_RANGE", "KILL_RIPPLE_HIGHLIGHT", "DEBUG_KILL_RIPPLE_GRID",
    "KILL_RIPPLE_HAND_DEPTH", "KILL_RIPPLE_TIMER_CAP", "KILL_RIPPLE_GRID",
}

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
    m = SLIDERS.match(step1[i])
    if not m:
        step2.append(step1[i])
        i += 1
        continue
    indent, chunk = m.group(1), m.group(2)
    while chunk.rstrip().endswith("\\") and i + 1 < len(step1):
        chunk = chunk.rstrip()[:-1]
        i += 1
        chunk += " " + step1[i].strip()
    i += 1
    step2.append(indent + "sliders = " + " ".join(strip_dead(chunk.split(), False)))

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
