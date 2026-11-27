#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capture.rdc(RenderDoc XML) -> 按「功能」聚合的单帧写入带宽 + CPU 调用时间。

为什么不是 GPU 时间：这个抓帧里没有 GPU 计时（RenderDoc 未记录 timer query），
XML 的 duration 是每次 GL 调用的 **CPU wall-time**（含 RenderDoc 注入开销）。
所以本脚本给出两个**实测**量：
  · 每帧写入字节数（MB/frame）—— 对带宽受限的 GTX 1050 是最可靠的代理指标；
  · CPU 调用时间（µs）—— 只能看相对量，不能当 GPU 时间。
最后按「带宽 ÷ 112 GB/s」给出一个**下限估计**，并注明它是模型值。
"""
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
chunks = [
    dict(ci=int(m.group("ci")), name=m.group("name"), dur=int(m.group("dur")),
         body=m.group("body") or "")
    for m in CHUNK.finditer(text)
]


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
    m = re.search(r'<uint name="%s"[^>]*>(\d+)</uint>' % name, body)
    return int(m.group(1)) if m else None


def enumint(name, body):
    m = re.search(r'<enum name="%s"[^>]*>(\d+)</enum>' % name, body)
    return int(m.group(1)) if m else None


def enumstr(name, body):
    m = re.search(r'<enum name="%s"[^>]*string="([^"]*)"' % name, body)
    return m.group(1) if m else None


DRAW = {"glDrawArrays", "glDrawElements", "glDrawElementsBaseVertex", "glDrawArraysInstanced",
        "glDrawElementsInstanced", "glDrawElementsInstancedBaseVertex",
        "glMultiDrawElementsBaseVertex", "glMultiDrawArrays", "glMultiDrawElements",
        "glMultiDrawArraysIndirect", "glMultiDrawElementsIndirect"}

BYTES = {"GL_RGBA16F": 8, "GL_RGBA8": 4, "GL_RGBA32F": 16, "GL_RGBA16": 8, "GL_RGBA": 4,
         "GL_R11F_G11F_B10F": 4, "GL_RGBA16UI": 8, "GL_RGBA16_SNORM": 8, "GL_RG16F": 4,
         "GL_RG16": 4, "GL_R8": 1, "GL_R8I": 1, "GL_RGB16F": 6, "GL_DEPTH_COMPONENT32F": 4,
         "GL_DEPTH_COMPONENT32": 4, "GL_DEPTH24_STENCIL8": 4, "GL_RGB10_A2": 4,
         "GL_RGBA32UI": 16, "GL_RGBA8_SNORM": 4, "GL_RGBA16_SNORM_EXT": 8}

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


def tex_label(tid):
    return labels.get(tid, "tex" + str(tid)) if tid else "?"


def tex_bytes(tid):
    t = tex.get(tid)
    return 0 if not t else t["w"] * t["h"] * BYTES.get(t["fmt"], 4)


fbo_att = collections.defaultdict(dict)
for c in chunks:
    if c["name"] in ("glFramebufferTexture2D", "glNamedFramebufferTexture"):
        fbo = res("framebuffer", c["body"])
        att = enumint("attachment", c["body"])
        t = res("texture", c["body"])
        if fbo is not None and att is not None:
            fbo_att[fbo][att] = t


# ---------------- 功能归类 ----------------
FEATURES = [
    ("阴影 pass（地形/实体/切割/半透明 + 体素化）", lambda lab: "shadow" in lab.lower()),
    ("主 G-buffer：地形", lambda lab: "sodium-terrain-terrain" in lab),
    ("主 G-buffer：实体", lambda lab: "entities" in lab),
    ("主 G-buffer：半透明/水", lambda lab: "sodium-terrain-translucent" in lab or "water" in lab or "translucent" in lab),
    ("主 G-buffer：手部/粒子/天气/天空", lambda lab: any(k in lab for k in ("hand", "particles", "weather", "sky", "cloud", "selection", "block"))),
    ("延迟光照 deferred20", lambda lab: lab == "deferred20"),
    ("GI 链（deferred1-7 / composite2 / prepare_a / NRD / EAWF）",
     lambda lab: lab.startswith("deferred") and lab != "deferred20" or lab.startswith("prepare") or lab in ("composite2", "begin")),
    ("半透明合成 composite4（Translucent + IntegrateScene + 雾）", lambda lab: lab == "composite4"),
    ("DOF（composite6 / composite6_a）", lambda lab: lab.startswith("composite6")),
    ("TAA（composite7）", lambda lab: lab.startswith("composite7")),
    ("运动模糊（composite10_a）", lambda lab: lab.startswith("composite10_a")),
    ("Bloom（composite10-15 + 20_a/21_a）",
     lambda lab: re.match(r"composite1[0-5]$", lab) or lab.startswith("composite20_a") or lab.startswith("composite21_a")),
    ("自动曝光（composite20 / composite21）",
     lambda lab: re.match(r"composite2[01]$", lab) is not None),
    ("调色/输出（composite31 / final）", lambda lab: lab in ("final",) or lab.startswith("composite31")),
    ("启动面板模糊（composite32-34）", lambda lab: re.match(r"composite3[2-4]$", lab) is not None),
]

FEATURE_OF = collections.OrderedDict((name, classify) for name, classify in
                                     [(n, f) for n, f in FEATURES])


def feature_of(label):
    for name, fn in FEATURES:
        if fn(label):
            return name
    return "其他 / 未标注 pass"


# ---------------- 遍历 ----------------
cur_prog = None
vp = (0, 0)
bound_fbo = {"DRAW": None, "READ": None}
bound_images = {}
feat = collections.defaultdict(lambda: dict(mb=0.0, us=0, calls=0, passes=collections.Counter()))
per_pass = collections.OrderedDict()

for c in chunks:
    n, body = c["name"], c["body"]
    if n == "glViewport":
        vp = (num("width", body), num("height", body))
    elif n == "glUseProgram":
        cur_prog = res("program", body)
        bound_images.clear()
    elif n == "glBindFramebuffer":
        slot = "READ" if "READ" in (enumstr("target", body) or "") else "DRAW"
        bound_fbo[slot] = res("framebuffer", body)
    elif n == "glBindImageTexture":
        bound_images[num("unit", body)] = (res("texture", body), enumstr("access", body) or "")
    elif n in DRAW:
        label = labels.get(cur_prog, "prog" + str(cur_prog))
        d = per_pass.setdefault(label, dict(mb=0.0, us=0, calls=0))
        d["calls"] += 1
        d["us"] += c["dur"]
        fbo = bound_fbo["DRAW"]
        for att, t in (fbo_att.get(fbo) or {}).items():
            if not t or t == "0":
                continue
            b = tex_bytes(t)
            d["mb"] += b / 1048576.0
            F = feat[feature_of(label)]
            F["mb"] += b / 1048576.0
            F["calls"] += 1
            F["passes"][label] += 1
        F = feat[feature_of(label)]
        F["us"] += c["dur"]
    elif n == "glDispatchCompute":
        label = labels.get(cur_prog, "prog" + str(cur_prog))
        gx, gy = num("num_groups_x", body), num("num_groups_y", body)
        d = per_pass.setdefault(label, dict(mb=0.0, us=0, calls=0))
        d["calls"] += 1
        d["us"] += c["dur"]
        for unit, (t, access) in bound_images.items():
            if not t or t == "0" or "READ_ONLY" in access:
                continue
            ti = tex.get(t) or dict(w=0, h=0, fmt="")
            px = min(gx * 16, ti["w"]) * min(gy * 16, ti["h"])
            b = px * BYTES.get(ti["fmt"], 4)
            d["mb"] += b / 1048576.0
            F = feat[feature_of(label)]
            F["mb"] += b / 1048576.0
            F["calls"] += 1
            F["passes"][label] += 1
        F = feat[feature_of(label)]
        F["us"] += c["dur"]

BW_GBS = 112.0  # GTX 1050 理论带宽

print("=" * 118)
print("capture.rdc 单帧：按功能聚合的写入带宽（实测）与 CPU 调用时间（实测，非 GPU 时间）")
print("=" * 118)
print("%-52s %6s %10s %9s %10s" % ("功能", "调用", "MB/frame", "CPU µs", "带宽下限 ms"))
print("-" * 118)
rows = sorted(feat.items(), key=lambda kv: -kv[1]["mb"])
for name, F in rows:
    lower_ms = F["mb"] / 1024.0 / BW_GBS * 1000.0
    print("%-52s %6d %10.1f %9d %10.2f" % (name[:52], F["calls"], F["mb"], F["us"], lower_ms))
print("-" * 118)
total_mb = sum(F["mb"] for _, F in rows)
print("写入合计 %.1f MB/frame；若完全带宽受限 = %.2f ms（112 GB/s）；实测总 CPU wall = %.1f ms"
      % (total_mb, total_mb / 1024.0 / BW_GBS * 1000.0,
         sum(F["us"] for _, F in rows) / 1000.0))

print()
print("### 每功能包含的 pass")
for name, F in rows:
    tops = ", ".join("%s*%d" % (k, v) for k, v in F["passes"].most_common(6))
    print("- %-50s %s" % (name[:50], tops or "-"))

print()
print("### 单 pass Top 20（按写入 MB/frame）")
print("%-30s %6s %10s %9s" % ("pass", "calls", "MB/frame", "CPU µs"))
print("-" * 70)
for label, d in sorted(per_pass.items(), key=lambda kv: -kv[1]["mb"])[:20]:
    print("%-30s %6d %10.1f %9d" % (label[:30], d["calls"], d["mb"], d["us"]))
