#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capture.xml -> 清屏/拷贝明细 + 带标签纹理清单（VRAM 估算）。仅供分析。"""
import re
import collections

XML = "rdc_analysis/capture.xml"
text = open(XML, encoding="utf-8", errors="replace").read()
CHUNK = re.compile(
    r'<chunk id="(?P<id>\d+)" chunkIndex="(?P<ci>\d+)" name="(?P<name>[^"]*)"'
    r'(?: length="(?P<len>\d+)")? threadID="(?P<tid>\d+)"'
    r' timestamp="(?P<ts>\d+)" duration="(?P<dur>\d+)"(?P<self>\s*/>|>(?P<body>.*?)</chunk>)',
    re.S,
)
chunks = [dict(ci=int(m.group("ci")), name=m.group("name"), dur=int(m.group("dur")),
               body=m.group("body") or "") for m in CHUNK.finditer(text)]


def unesc(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


def res(name, body):
    m = re.search(r'<ResourceId name="%s"[^>]*>(-?\d+)</ResourceId>' % name, body)
    return m.group(1) if m else None


def num(name, body):
    m = re.search(r'<int name="%s"[^>]*>(-?\d+)</int>' % name, body)
    if m:
        return int(m.group(1))
    m = re.search(r'<enum name="%s"[^>]*>(\d+)</enum>' % name, body)
    if m:
        return int(m.group(1))
    m = re.search(r'<uint name="%s"[^>]*>(\d+)</uint>' % name, body)
    return int(m.group(1)) if m else None


def enumstr(name, body):
    m = re.search(r'<enum name="%s"[^>]*string="([^"]*)"' % name, body)
    return m.group(1) if m else None


labels = {}
for c in chunks:
    if c["name"] in ("glObjectLabel", "glObjectPtrLabel"):
        r = res("Resource", c["body"])
        m = re.search(r'<string name="Label"[^>]*>(.*?)</string>', c["body"], re.S)
        if r and m:
            labels[r] = unesc(m.group(1))

tex = {}
for c in chunks:
    if c["name"] in ("glTexImage2D", "glTexStorage2D"):
        t, w, h = res("texture", c["body"]), num("width", c["body"]), num("height", c["body"])
        fmt = enumstr("internalformat", c["body"]) or ""
        if t and w and h:
            tex[t] = dict(w=w, h=h, fmt=fmt)

BYTES = {"GL_RGBA16F": 8, "GL_RGBA8": 4, "GL_RGBA32F": 16, "GL_RGBA16": 8, "GL_RGBA": 4,
         "GL_R11F_G11F_B10F": 4, "GL_RGBA16UI": 8, "GL_RGBA16_SNORM": 8, "GL_RG16F": 4,
         "GL_RG16": 4, "GL_R8": 1, "GL_R8I": 1, "GL_RGB16F": 6, "GL_DEPTH_COMPONENT32F": 4,
         "GL_DEPTH_COMPONENT32": 4, "GL_DEPTH24_STENCIL8": 4, "GL_RGBA8_SNORM": 4}

fbo_att = collections.defaultdict(dict)
for c in chunks:
    if c["name"] in ("glFramebufferTexture2D", "glNamedFramebufferTexture"):
        fbo = res("framebuffer", c["body"])
        att = num("attachment", c["body"])
        t = res("texture", c["body"])
        if fbo is not None and att is not None:
            fbo_att[fbo][att] = t

cur_fbo = {"DRAW": None}
images = {}
clears = collections.Counter()
copies = collections.Counter()
for c in chunks:
    n, b = c["name"], c["body"]
    if n == "glBindFramebuffer":
        slot = "READ" if "READ" in (enumstr("target", b) or "") else "DRAW"
        if slot == "DRAW":
            cur_fbo["DRAW"] = res("framebuffer", b)
    elif n == "glBindImageTexture":
        images[num("unit", b)] = res("texture", b)
    elif n.startswith("glClear"):
        mask = enumstr("mask", b) or ""
        for att, t in (fbo_att.get(cur_fbo["DRAW"]) or {}).items():
            if t and t != "0":
                clears["%s [%s]" % (labels.get(t, "tex" + t), mask)] += c["dur"]
    elif n in ("glBlitFramebuffer", "glCopyImageSubData", "glCopyTexSubImage2D"):
        s = res("srcName", b) or res("src", b)
        d = res("dstName", b) or res("dst", b)
        copies["%s -> %s" % (labels.get(s, "tex" + str(s)), labels.get(d, "tex" + str(d)))] += c["dur"]

print("### 清屏（按目标缓冲）")
for k, v in clears.most_common():
    print("  %-58s %7d us" % (k[:58], v))

print("\n### copy / blit / resolve")
for k, v in copies.most_common(12):
    print("  %-64s %7d us" % (k[:64], v))

print("\n### 带标签纹理清单（含 main/alt 两份）")
print("%-26s %-14s %-22s %8s" % ("label", "size", "format", "MB"))
print("-" * 78)
tot = 0.0
rows = []
for t, lab in labels.items():
    if t in tex and ("colortex" in lab or "shadowcolor" in lab or "Img" in lab):
        ti = tex[t]
        mb = ti["w"] * ti["h"] * BYTES.get(ti["fmt"], 4) / 1048576.0
        rows.append((lab, ti["w"], ti["h"], ti["fmt"].replace("GL_", ""), mb))
for lab, w, h, fmt, mb in sorted(rows, key=lambda r: (-r[4], r[0])):
    print("%-26s %-14s %-22s %8.1f" % (lab[:26], "%dx%d" % (w, h), fmt, mb))
    tot += mb
print("-" * 78)
print("合计 %.0f MB（colortex/shadowcolor/image 纹理，未计 depth 与图集）" % tot)
