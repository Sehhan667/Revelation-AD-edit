#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capture.rdc(RenderDoc XML) -> 单帧 pass 清单 + 缓冲带宽模型（仅供分析，不入库）。

注意：duration 是每次 GL 调用的 wall-time（含 RenderDoc 注入/驱动序列化的固定开销），
只能看相对量与调用结构，不能当 GPU 时间；带宽模型（字节数）才是可靠信号。
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
    dict(ci=int(m.group("ci")), name=m.group("name"), ts=int(m.group("ts")),
         dur=int(m.group("dur")), body=m.group("body") or "")
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

# ---------- 资源标签 ----------
labels = {}
for c in chunks:
    if c["name"] in ("glObjectLabel", "glObjectPtrLabel"):
        r = res("Resource", c["body"])
        m = re.search(r'<string name="Label"[^>]*>(.*?)</string>', c["body"], re.S)
        if r and m:
            labels[r] = unesc(m.group(1))

# ---------- 纹理尺寸/格式 ----------
tex = {}
for c in chunks:
    if c["name"] in ("glTexImage2D", "glTexStorage2D"):
        t, w, h = res("texture", c["body"]), num("width", c["body"]), num("height", c["body"])
        fmt = enumstr("internalformat", c["body"]) or ""
        if t and w and h:
            tex[t] = dict(w=w, h=h, fmt=fmt)


def tex_label(tid):
    return labels.get(tid, "tex" + str(tid)) if tid else "?"


def tex_desc(tid):
    t = tex.get(tid)
    return "?" if not t else "%dx%d %s" % (t["w"], t["h"], t["fmt"].replace("GL_", ""))


def tex_bytes(tid):
    t = tex.get(tid)
    return 0 if not t else t["w"] * t["h"] * BYTES.get(t["fmt"], 4)


# ---------- FBO 附件 ----------
fbo_att = collections.defaultdict(dict)
for c in chunks:
    if c["name"] in ("glFramebufferTexture2D", "glNamedFramebufferTexture"):
        fbo = res("framebuffer", c["body"])
        att = enumint("attachment", c["body"])
        t = res("texture", c["body"])
        if fbo is not None and att is not None:
            fbo_att[fbo][att] = t

# ---------- main ----------
cur_prog = None
vp = (0, 0)
bound_fbo = {"DRAW": None, "READ": None}
bound_images = {}
per_pass = collections.OrderedDict()
buf_write_draw = collections.Counter()
buf_write_dispatch = collections.Counter()
buf_write_calls = collections.Counter()
nonshader = collections.Counter()
nonshader_detail = collections.Counter()
dispatches = []
draws = []
sync_us = 0

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
        d = per_pass.setdefault((label, "draw"), dict(calls=0, dur=0,
                                                      vps=collections.Counter(),
                                                      outs=collections.Counter()))
        d["calls"] += 1
        d["dur"] += c["dur"]
        d["vps"]["%dx%d" % vp] += 1
        fbo = bound_fbo["DRAW"]
        for att, t in (fbo_att.get(fbo) or {}).items():
            if not t or t == "0":
                continue
            lab = tex_label(t)
            d["outs"][lab] += 1
            buf_write_draw[lab] += tex_bytes(t)
            buf_write_calls[lab] += 1
            draws.append((label, lab, tex_bytes(t) / 1048576.0))
    elif n == "glDispatchCompute":
        label = labels.get(cur_prog, "prog" + str(cur_prog))
        gx, gy = num("num_groups_x", body), num("num_groups_y", body)
        d = per_pass.setdefault((label, "dispatch"), dict(calls=0, dur=0,
                                                          vps=collections.Counter(),
                                                          outs=collections.Counter()))
        d["calls"] += 1
        d["dur"] += c["dur"]
        d["vps"]["groups %dx%d" % (gx, gy)] += 1
        outs = []
        for unit, (t, access) in bound_images.items():
            if t and t != "0" and "READ_ONLY" not in access:
                lab = tex_label(t)
                ti = tex.get(t) or dict(w=0, h=0, fmt="")
                px = min(gx * 16, ti["w"]) * min(gy * 16, ti["h"])
                d["outs"][lab] += 1
                buf_write_dispatch[lab] += px * BYTES.get(ti["fmt"], 4)
                buf_write_calls[lab] += 1
                outs.append("%s %dx%d" % (lab, min(gx * 16, ti["w"]), min(gy * 16, ti["h"])))
        dispatches.append((label, gx, gy, outs))
    elif n.startswith("glClear"):
        nonshader["clear"] += c["dur"]
        fbo = bound_fbo["DRAW"]
        names = [tex_label(t) for t in (fbo_att.get(fbo) or {}).values() if t and t != "0"]
        nonshader_detail["clear " + ",".join(names)] += c["dur"]
    elif n in ("glBlitFramebuffer", "glCopyImageSubData", "glCopyTexSubImage2D"):
        nonshader["copy/blit"] += c["dur"]
        s = res("srcName", body) or res("src", body)
        dst = res("dstName", body) or res("dst", body)
        nonshader_detail["copy %s -> %s" % (tex_label(s), tex_label(dst))] += c["dur"]
    elif n in ("glMemoryBarrier", "glTextureBarrier"):
        nonshader["barrier"] += c["dur"]
    elif "Sync" in n or n in ("glFinish", "glFlush"):
        sync_us += c["dur"]

shader_us = sum(d["dur"] for d in per_pass.values())
print("=" * 120)
print("capture.rdc 单帧结构（duration = GL 调用 wall-time，含 RenderDoc 固定开销，只看结构/相对量）")
print("chunks=%d  pass 数=%d  着色器 wall=%.1f ms  非着色器=%.1f ms  sync=%.1f ms"
      % (len(chunks), len(per_pass), shader_us / 1000.0,
         sum(nonshader.values()) / 1000.0, sync_us / 1000.0))
print("=" * 120)

print("\n### A. 每个 pass")
print("%-28s %-8s %5s %9s %8s  %s" % ("pass(label)", "stage", "calls", "wall_us", "avg_u", "viewport / 输出"))
print("-" * 120)
for (label, stage), d in sorted(per_pass.items(), key=lambda kv: -kv[1]["dur"]):
    vps = " ".join("%s*%d" % (k, v) for k, v in d["vps"].most_common(2))
    outs = " ".join("%s*%d" % (k, v) for k, v in d["outs"].most_common(5))
    print("%-28s %-8s %5d %9d %8d  %-22s | %s"
          % (label[:28], stage, d["calls"], d["dur"], d["dur"] / max(d["calls"], 1), vps, outs or "-"))

print("\n### B. 每帧写入的缓冲（MB/frame）")
print("%-24s %-24s %6s %10s %10s %10s" % ("buffer", "desc", "calls", "draw MB", "disp MB", "total MB"))
print("-" * 120)
rows = []
for lab in set(list(buf_write_draw) + list(buf_write_dispatch)):
    tid = next((t for t, l in labels.items() if l == lab), None)
    rows.append((lab, tid, buf_write_calls[lab], buf_write_draw[lab], buf_write_dispatch[lab]))
rows.sort(key=lambda r: -(r[3] + r[4]))
for lab, tid, calls, dd, pd in rows:
    print("%-24s %-24s %6d %10.1f %10.1f %10.1f"
          % (lab[:24], tex_desc(tid), calls, dd / 1048576.0, pd / 1048576.0, (dd + pd) / 1048576.0))
print("-" * 120)
print("写入合计 %.1f MB/frame（draw %.1f + dispatch %.1f；不含深度附件/未标注纹理）"
      % ((sum(buf_write_draw.values()) + sum(buf_write_dispatch.values())) / 1048576.0,
         sum(buf_write_draw.values()) / 1048576.0, sum(buf_write_dispatch.values()) / 1048576.0))

print("\n### C. compute dispatch（groups*16 = 覆盖像素；括号内为实际写入区域）")
for label, gx, gy, outs in sorted(dispatches, key=lambda x: -(x[1] * x[2])):
    print("%-28s %5dx%-5d  out: %s" % (label[:28], gx, gy, " ".join(outs) or "-"))

print("\n### D. 非着色器")
for k, v in nonshader.most_common():
    print("  %-12s %8d us" % (k, v))
for k, v in nonshader_detail.most_common(8):
    print("    %-60s %8d us" % (k[:60], v))
