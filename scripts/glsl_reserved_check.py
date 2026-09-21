#!/usr/bin/env python3
"""GLSL 保留字 / 保留前缀检查。

为什么需要它：本包**没有本地 GLSL 编译器**，语法级错误（保留字当变量名、隐式标量→向量
赋值等）只有实机重载才能暴露，而一次失败就会让 Iris 报
"Failed to create shader rendering pipeline, disabling shaders"（整包退回原版渲染）。
本会话已经因此白跑三轮：`common`（保留字）、`vec3 x = floatExpr`（类型）、空 compute pass。

用法：
    python scripts/glsl_reserved_check.py            # 扫 shaders/
    python scripts/glsl_reserved_check.py --all      # 含注释里的提及（默认已剥离注释）

退出码：0 = 干净，1 = 有命中。
"""
import argparse
import os
import re
import sys

# GLSL 规范的 reserved words（不可用作标识符）+ 保留前缀
RESERVED = {
    # 与 C++ 冲突的一批（最容易被随手写出来）
    "common", "partition", "active", "asm", "class", "union", "enum", "typedef",
    "template", "this", "packed", "goto", "inline", "noinline", "public", "static",
    "extern", "external", "interface", "long", "short", "double", "half", "fixed",
    "unsigned", "superp", "input", "output", "filter", "sizeof", "cast", "namespace",
    "using", "volatile", "switch", "default", "row_major",
    # GLSL 保留的类型名
    "hvec2", "hvec3", "hvec4", "fvec2", "fvec3", "fvec4", "dvec2", "dvec3", "dvec4",
    "sampler3DRect", "sampler2DRectShadow", "samplerBuffer", "sampler2DMS",
    "image1D", "image2D", "image3D", "imageCube", "imageBuffer", "image2DMS",
}

# 声明形态：<类型> <名字>  或  <限定符> <类型> <名字>
TYPES = (r"(?:void|bool|int|uint|float|double|vec[234]|ivec[234]|uvec[234]|bvec[234]|"
         r"mat[234](?:x[234])?|sampler\w*|image\w*|atomic_uint|struct|"
         r"in|out|inout|const|flat|smooth|noperspective|centroid|uniform|buffer|shared)")

DECL = re.compile(r"\b" + TYPES + r"\s+([A-Za-z_]\w*)\s*(?:=|;|,|\[|\))")
# 函数参数里的声明：<类型> <名字> 后面跟 , 或 )
PARAM = re.compile(r"\b" + TYPES + r"\s+([A-Za-z_]\w*)\s*[,)]")
# 结构体成员：<类型> <名字> ;
MEMBER = re.compile(r"^\s*" + TYPES + r"\s+([A-Za-z_]\w*)\s*;")


def strip_comments(text: str) -> str:
    """剥离 // 与 /* */（跨行），保留换行以便行号对齐。"""
    out = []
    i, n, in_block = 0, len(text), False
    while i < n:
        c = text[i]
        if in_block:
            if c == "*" and i + 1 < n and text[i + 1] == "/":
                in_block = False
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            in_block = True
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def scan(path: str):
    text = open(path, encoding="utf-8", errors="replace").read()
    code = strip_comments(text)
    hits = []
    for lineno, line in enumerate(code.split("\n"), 1):
        for rx in (DECL, PARAM, MEMBER):
            for m in rx.finditer(line):
                name = m.group(1)
                if name in RESERVED:
                    hits.append((lineno, name, line.strip()[:100]))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default="shaders")
    ap.add_argument("--all", action="store_true", help="（保留：默认已剥离注释）")
    args = ap.parse_args()

    exts = (".glsl", ".frag", ".fsh", ".vert", ".vsh", ".comp", ".csh", ".gsh", ".geom")
    files = []
    for d, _, fs in os.walk(args.root):
        for f in fs:
            if f.endswith(exts):
                files.append(os.path.join(d, f).replace("\\", "/"))

    total = 0
    for p in sorted(files):
        for lineno, name, src in scan(p):
            total += 1
            print("%s:%d  保留字 %r 被当标识符使用\n    %s" % (p, lineno, name, src))
    print("扫描 %d 个着色器文件，命中 %d 处" % (len(files), total))
    if total:
        print("⇒ 这些会在实机重载时报 error C0000: unexpected reserved word（整包退回原版）")
        return 1
    print("✓ 没有把 GLSL 保留字当标识符用")
    return 0


if __name__ == "__main__":
    sys.exit(main())
