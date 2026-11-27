#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capture.rdc(RenderDoc XML) -> 按「功能」聚合的单帧写入带宽 + CPU 调用时间。

为什么不是 GPU 时间：这个抓帧里没有 GPU 计时（RenderDoc 未记录 timer query），
XML 的 duration 是每次 GL 调用的 **CPU wall-time**（含 RenderDoc 注入开销）。

两个**实测**量：
  · 每帧写入字节数（MB/frame）—— 对带宽受限的 GTX 1050 是最可靠的代理指标；
  · CPU 调用时间（µs）—— 只能看相对量。

[2026-11-12 修正] 不属于光影包的 pass 单独归类，不计入字节模型：
  · SpriteAnimationInfo（prog204/prog328）= **Iris 的 labPBR 图集动画同步**：
    viewport 是整个 4096x2048 图集的某一级 mip，但每次 draw 只光栅化一个精灵的小矩形，
    按 viewport 算字节会高估几十倍；真实开销以「每次 draw 的固定成本」为主
    （见 rdc_analysis/sprite_animation_pass.md 的复核：真实约 1–2 ms，且用户实测关 PBR 帧率不变）。
  · 1920x1080 的 blit / position_color（prog189/205/255/307）= 原版 HUD/GUI 与最终 blit。
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

# ---- program -> 源码（用于识别非包内 pass）----
src = {}
for c in chunks:
    if c["name"] == "glShaderSource":
        sid = res("shader", c["body"])
        m = re.search(r'<string typename="string">(.*?)</string>', c["body"], re.S)
        if sid and m:
            src[sid] = unesc(m.group(1))

prog_src = collections.defaultdict(str)
cur = None
for c in chunks:
    if c["name"] == "glCreateProgram":
        cur = res("Program", c["body"]) or res("program", c["body"])
    elif c["name"] == "glAttachShader" and cur:
        s = res("shader", c["body"])
        if s:
            prog_src[cur] += src.get(s, "")


def is_pbr_sprite(prog):
    return "SpriteAnimationInfo" in prog_src.get(prog, "")


fbo_att = collections.defaultdict(dict)
for c in chunks:
    if c["name"] in ("glFramebufferTexture2D", "glNamedFramebufferTexture"):
        fbo = res("framebuffer", c["body"])
        att = enumint("attachment", c["body"])
        t = res("texture", c["body"])
        if fbo is not None and att is not None:
            fbo_att[fbo][att] = t


def tex_bytes(tid):
    t = tex.get(tid)
    return 0 if not t else t["w"] * t["h"] * BYTES.get(t["fmt"], 4)


FEATURES = [
    ("阴影 pass（地形/实体/切割/半透明 + 体素化）", lambda lab: "shadow" in lab.lower()),
    ("主 G-buffer：地形", lambda lab: "sodium-terrain-terrain" in lab),
    ("主 G-buffer：实体", lambda lab: "entities" in lab),
    ("主 G-buffer：半透明/水", lambda lab: "sodium-terrain-translucent" in lab or "water" in lab or "translucent" in lab),
    ("主 G-buffer：手部/粒子/天气/天空", lambda lab: any(k in lab for k in ("hand", "particles", "weather", "sky", "cloud", "selection", "block"))),
    ("延迟光照 deferred20", lambda lab: lab == "deferred20"),
    ("GI 链（deferred1-7 / composite2 / prepare / begin）",
     lambda lab: (lab.startswith("deferred") and lab != "deferred20") or lab.startswith("prepare") or lab in ("composite2", "begin")),
    ("半透明合成 composite4（Translucent + IntegrateScene + 雾）", lambda lab: lab == "composite4"),
    ("DOF（composite6 / composite6_a）", lambda lab: lab.startswith("composite6")),
    ("TAA（composite7）", lambda lab: lab.startswith("composite7")),
    ("运动模糊（composite10_a）", lambda lab: lab.startswith("composite10_a")),
    ("Bloom（composite10-15 + 20_a/21_a）",
     lambda lab: re.match(r"composite1[0-5]$", lab) or lab.startswith("composite20_a") or lab.startswith("composite21_a")),
    ("自动曝光（composite20 / composite21）", lambda lab: re.match(r"composite2[01]$", lab) is not None),
    ("调色/输出（final / composite31）", lambda lab: lab == "final" or lab.startswith("composite31")),
    ("启动面板模糊（composite32-34）", lambda lab: re.match(r"composite3[2-4]$", lab) is not None),
]

NON_PACK = [
    ("[非包内] Iris labPBR 图集动画同步（SpriteAnimationInfo）", lambda lab, prog: is_pbr_sprite(prog)),
    ("[非包内] 原版 HUD/GUI + blit（1920x1080）",
     lambda lab, prog: lab.startswith("prog") and "SpriteAnimationInfo" not in prog_src.get(prog or "", "")),
]


def feature_of(label, prog):
    for name, fn in NON_PACK:
        if fn(label, prog):
            return name
    for name, fn in FEATURES:
        if fn(label):
            return name
    return "其他 / 未标注 pass"


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
        fname = feature_of(label, cur_prog)
        d = per_pass.setdefault(label, dict(mb=0.0, us=0, calls=0))
        d["calls"] += 1
        d["us"] += c["dur"]
        F = feat[fname]
        F["us"] += c["dur"]
        F["passes"][label] += 1
        skip_bytes = fname.startswith("[非包内]")
        if not skip_bytes:
            fbo = bound_fbo["DRAW"]
            for att, t in (fbo_att.get(fbo) or {}).items():
                if not t or t == "0":
                    continue
                b = tex_bytes(t)
                d["mb"] += b / 1048576.0
                F["mb"] += b / 1048576.0
                F["calls"] += 1
    elif n == "glDispatchCompute":
        label = labels.get(cur_prog, "prog" + str(cur_prog))
        gx, gy = num("num_groups_x", body), num("num_groups_y", body)
        d = per_pass.setdefault(label, dict(mb=0.0, us=0, calls=0))
        d["calls"] += 1
        d["us"] += c["dur"]
        F = feat[feature_of(label, cur_prog)]
        F["us"] += c["dur"]
        F["passes"][label] += 1
        for unit, (t, access) in bound_images.items():
            if not t or t == "0" or "READ_ONLY" in access:
                continue
            ti = tex.get(t) or dict(w=0, h=0, fmt="")
            px = min(gx * 16, ti["w"]) * min(gy * 16, ti["h"])
            b = px * BYTES.get(ti["fmt"], 4)
            d["mb"] += b / 1048576.0
            F["mb"] += b / 1048576.0
            F["calls"] += 1

BW_GBS = 112.0
print("=" * 118)
print("capture.rdc 单帧：按功能聚合（写入带宽实测；CPU 调用时间实测，非 GPU 时间）")
print("=" * 118)
print("%-56s %6s %10s %9s %10s" % ("功能", "调用", "MB/frame", "CPU µs", "带宽下限 ms"))
print("-" * 118)
rows = sorted(feat.items(), key=lambda kv: -kv[1]["mb"])
for name, F in rows:
    print("%-56s %6d %10.1f %9d %10.2f"
          % (name[:56], F["calls"], F["mb"], F["us"], F["mb"] / 1024.0 / BW_GBS * 1000.0))
print("-" * 118)
total_mb = sum(F["mb"] for _, F in rows)
print("计入字节的写入合计 %.1f MB/frame；带宽下限 %.2f ms（112 GB/s）；总 CPU wall %.1f ms"
      % (total_mb, total_mb / 1024.0 / BW_GBS * 1000.0, sum(F["us"] for _, F in rows) / 1000.0))
print()
print("注：以 [非包内] 开头的行**不计字节**（viewport 远大于实际光栅化面积），只看 CPU µs。")
print()
print("### 单 pass Top 15（按写入 MB/frame）")
for label, d in sorted(per_pass.items(), key=lambda kv: -kv[1]["mb"])[:15]:
    print("%-30s %6d %10.1f %9d" % (label[:30], d["calls"], d["mb"], d["us"]))
