#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""选项接线审计：GUI 里有但代码没有 / 有定义但没人用 / lang 有文案但选项没有。
只读；输出清单供确认后再清理。
"""
import os
import re
import collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SHADERS = os.path.join(ROOT, "shaders")
SKIP_DIRS = {"ffx"}


def strip_comments(text):
    out = []
    i, n = 0, len(text)
    in_line = in_block = False
    while i < n:
        c = text[i]
        two = text[i:i+2]
        if in_line:
            if c == "\n":
                in_line = False
                out.append(c)
            else:
                out.append(" ")
            i += 1
        elif in_block:
            if two == "*/":
                in_block = False
                out.append("  ")
                i += 2
            else:
                out.append("\n" if c == "\n" else " ")
                i += 1
        elif two == "//":
            in_line = True
            out.append("  ")
            i += 2
        elif two == "/*":
            in_block = True
            out.append("  ")
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


files = []
for dirpath, dirnames, filenames in os.walk(SHADERS):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    for f in filenames:
        if f.endswith((".glsl", ".frag", ".comp", ".csh", ".vsh", ".fsh", ".vert", ".inc")):
            files.append(os.path.join(dirpath, f))

raw, code = {}, {}
for p in files:
    t = open(p, encoding="utf-8", errors="replace").read()
    raw[p] = t
    code[p] = strip_comments(t)

IDENT = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")
DEFLINE = re.compile(r"^\s*#\s*(define|ifndef)\s+([A-Za-z_][A-Za-z0-9_]*)")
# Iris/OptiFine 的选项解析不忽略行首注释：`//#define NAME 值 // [可选值]` 依然是一个 GUI 选项
# （默认关）。所以定义发现必须扫**原始文本**，兼容 `#define` 与 `//#define` 两种写法。
RAWDEF = re.compile(r"^\s*(?://\s*)?#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$")

defines = {}                  # name -> [(relpath, lineno, has_value, annotated, commented_out)]
uses = collections.Counter()  # name -> 使用次数（排除定义行；注释行不计）

props_path_early = os.path.join(SHADERS, "shaders.properties")
scan_sources = [(os.path.relpath(p, ROOT), code[p]) for p in files]
scan_sources.append(("shaders.properties", strip_comments(
    open(props_path_early, encoding="utf-8", errors="replace").read())))

for p in files:
    rel = os.path.relpath(p, ROOT)
    raw_lines = raw[p].splitlines()
    for idx, raw_line in enumerate(raw_lines):
        m = RAWDEF.match(raw_line)
        if m:
            name = m.group(1)
            commented = bool(re.match(r"^\s*//", raw_line))
            defines.setdefault(name, []).append(
                (rel, idx + 1, bool(m.group(2).strip()), bool(re.search(r"//\s*\[", raw_line)), commented))

# 统计"真正被消费"的次数：属性文件里的 GUI 列表/`#if` 也算；
# `#ifndef X` 只有在紧跟着 `#define X` 时才算"兜底定义"（不算使用），否则算使用。
GUI_LIST_LINE = re.compile(r"^\s*(screen\.|sliders\s*=|profile\.)")
for rel, stripped in scan_sources:
    lines = stripped.splitlines()
    for idx, line in enumerate(lines):
        m = DEFLINE.match(line)
        guard = m.group(2) if m else None
        if m and m.group(1) == "define":
            continue                     # 定义行
        if m and m.group(1) == "ifndef" and guard:
            nxt = next((l for l in lines[idx+1:idx+4] if l.strip()), "")
            if re.match(r"^\s*#\s*define\s+%s\b" % re.escape(guard), nxt):
                continue                 # 兜底定义块（ifndef X + define X）
        if rel in ("shaders.properties",) and not line.lstrip().startswith("#"):
            continue                     # properties 里只有 `#if ...` 这类指令才算使用（GUI 列表不算）
        for name in IDENT.findall(line):
            uses[name] += 1

# ---- shaders.properties ----
props_raw = open(os.path.join(SHADERS, "shaders.properties"), encoding="utf-8", errors="replace").read()
props = strip_comments(props_raw)


def collect(keypat):
    out = []
    lines = props.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^\s*%s\s*=\s*(.*)$" % keypat, lines[i])
        if m:
            chunk = m.group(1)
            while chunk.rstrip().endswith("\\") and i + 1 < len(lines):
                i += 1
                chunk = chunk.rstrip()[:-1] + " " + lines[i]
            out.append(chunk)
        i += 1
    return out


def idents(chunks):
    s = set()
    for chunk in chunks:
        for tok in chunk.split():
            if tok.startswith("[") or tok == "<empty>":
                continue
            if "=" in tok:
                tok = tok.split("=", 1)[0].lstrip("!")
            if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", tok):
                s.add(tok)
    return s


screen_elements = idents(collect(r"screen\.[A-Za-z0-9_]+"))
slider_elements = idents(collect("sliders"))
profile_tokens = idents(collect(r"profile\.[A-Za-z0-9_]+"))

lang_opts, lang_values, lang_suffix = set(), set(), set()
lang_dir = os.path.join(SHADERS, "lang")
for f in sorted(os.listdir(lang_dir)):
    if not f.endswith(".lang"):
        continue
    for line in open(os.path.join(lang_dir, f), encoding="utf-8", errors="replace").read().splitlines():
        m = re.match(r"^\s*option\.([A-Za-z0-9_]+)\s*=", line)
        if m:
            lang_opts.add(m.group(1))
            continue
        m = re.match(r"^\s*value\.([A-Za-z0-9_]+)\.", line)
        if m:
            lang_values.add((f, m.group(1)))
            continue
        m = re.match(r"^\s*suffix\.([A-Za-z0-9_]+)\s*=", line)
        if m:
            lang_suffix.add(m.group(1))

def where(name):
    tag = []
    if name in screen_elements: tag.append("screen")
    if name in slider_elements: tag.append("sliders")
    if name in profile_tokens: tag.append("profile")
    if name in lang_opts: tag.append("lang")
    return ",".join(tag) or "-"

def define_loc(name):
    info = defines.get(name)
    if not info:
        return "(无定义)"
    rel, ln, hv, an, commented = info[0]
    return "%s:%d%s%s" % (rel, ln, " [滑条]" if an else "", " [默认关/注释]" if commented else "")

print("=" * 104)
print("A. 进了 GUI / profile，但代码里找不到 #define（Iris 日志会报 Unable to resolve）")
broken = sorted(n for n in (screen_elements | slider_elements | profile_tokens) if n not in defines)
for n in broken:
    print("  %-38s 出现于: %s" % (n, where(n)))
print("  合计 %d 个" % len(broken))

print("\n" + "=" * 104)
print("B. 有 #define、但去掉注释后没有任何使用（死选项）")
dead = sorted(n for n in defines if uses[n] == 0)
for n in dead:
    print("  %-38s %-34s 接线: %s" % (n, define_loc(n), where(n)))
print("  合计 %d 个" % len(dead))

print("\n" + "=" * 104)
print("C. lang 有文案、代码里没有对应定义（死文案）")
for n in sorted(lang_opts - set(defines)):
    print("  option.%-33s 引用: %s" % (n, where(n)))
for f, n in sorted(lang_values):
    if n not in defines:
        print("  value.%-34s [%s]" % (n, f))
for n in sorted(lang_suffix - set(defines)):
    print("  suffix.%-33s" % n)

print("\n" + "=" * 104)
print("D. 有定义且在用、但没进 GUI 的选项（多数是内部/调试宏，供参考）")
only_code = [n for n in defines if uses[n] > 0 and n not in screen_elements and n not in slider_elements]
for n in sorted(only_code):
    print("  %-38s %-34s 用 %d 次" % (n, define_loc(n), uses[n]))
print("  合计 %d 个" % len(only_code))
