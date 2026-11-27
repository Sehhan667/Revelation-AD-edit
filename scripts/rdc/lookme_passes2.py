#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lookme.rdc -> per-feature GPU cost table (v2).

* programs are identified by code fingerprint against shaders/program/**,
* resource labels (glObjectLabel) are used to name copy/clear targets,
* copy / clear / blit / barrier are NOT attributed to a shader program.
"""
import re
import os
import sys
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.abspath(os.path.join(HERE, "..", "shaders"))
XML = sys.argv[1] if len(sys.argv) > 1 else "lookme.xml"

text = open(XML, encoding="utf-8", errors="replace").read()
CHUNK = re.compile(
    r'<chunk id="(?P<id>\d+)" chunkIndex="(?P<ci>\d+)" name="(?P<name>[^"]*)"'
    r'(?: length="(?P<len>\d+)")? threadID="(?P<tid>\d+)"'
    r' timestamp="(?P<ts>\d+)" duration="(?P<dur>\d+)"(?P<self>\s*/>|>(?P<body>.*?)</chunk>)',
    re.S,
)


def unesc(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))


chunks = [dict(ci=int(m.group("ci")), name=m.group("name"), ts=int(m.group("ts")),
               dur=int(m.group("dur")), body=m.group("body") or "")
          for m in CHUNK.finditer(text)]


def grab(res_name, body):
    m = re.search(r'<ResourceId name="%s"[^>]*>(\d+)</ResourceId>' % res_name, body)
    return m.group(1) if m else None


def grab_int(name, body):
    m = re.search(r'<int name="%s"[^>]*>(-?\d+)</int>' % name, body)
    return int(m.group(1)) if m else None


# ---- resource labels ---------------------------------------------------------
labels = {}
for c in chunks:
    if c["name"] in ("glObjectLabel", "glObjectPtrLabel"):
        r = grab("Resource", c["body"]) or grab("resource", c["body"])
        m = re.search(r'<string name="Label"[^>]*>(.*?)</string>', c["body"], re.S)
        if r and m:
            labels[r] = unesc(m.group(1))

# ---- shader / program tables -------------------------------------------------
shader_src, prog_shaders = {}, collections.defaultdict(list)
for c in chunks:
    if c["name"] == "glShaderSource":
        sid = grab("shader", c["body"])
        shader_src[sid] = unesc("\n".join(re.findall(r"<string[^>]*>(.*?)</string>", c["body"], re.S)))
    elif c["name"] == "glAttachShader":
        p, s = grab("program", c["body"]), grab("shader", c["body"])
        if p and s:
            prog_shaders[p].append(s)


def prog_source(pid):
    return "\n".join(shader_src.get(s, "") for s in prog_shaders.get(pid, []))


# ---- fingerprints from the pack ---------------------------------------------
IDENT = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]{7,})\b")
fp = {}                       # file -> set(rare identifiers)
for root, _d, fs in os.walk(os.path.join(PACK, "program")):
    for f in fs:
        p = os.path.join(root, f)
        src = open(p, encoding="utf-8", errors="replace").read()
        fp[os.path.relpath(p, PACK).replace("\\", "/")] = set(IDENT.findall(src))

# keep identifiers unique to a single file
owner = collections.Counter()
for f, ids in fp.items():
    for i in ids:
        owner[i] += 1
rare = {f: {i for i in ids if owner[i] <= 2} for f, ids in fp.items()}

# vanilla / non-pack programs
VANILLA = ("glsl-transformer",)


def name_program(pid):
    src = prog_source(pid)
    if not src:
        return "(no program)"
    ids = set(IDENT.findall(src))
    best, score = None, 0
    for f, r in rare.items():
        s = len(ids & r)
        if s > score:
            best, score = f, s
    if best is None or score < 3:
        return "(vanilla/other, %d B)" % len(src)
    return best


# ---- walk the frame ----------------------------------------------------------
frame_start = next((c["ci"] for c in chunks if c["name"] == "Internal::Beginning of Capture"), 0)

DRAW = {"glDrawArrays", "glDrawElements", "glDrawElementsBaseVertex",
        "glMultiDrawElementsBaseVertex", "glMultiDrawArrays"}
OTHER = {"glDispatchCompute": "compute dispatch",
         "glClear": "clear", "glClearNamedFramebufferuiv": "clear",
         "glBlitNamedFramebuffer": "blit to screen",
         "glCopyImageSubData": "image copy", "glCopyTexSubImage2D": "depth/color copy",
         "glMemoryBarrier": "barrier", "glClientWaitSync": "sync stall"}

cur_prog, rows = None, []
for c in chunks:
    if c["ci"] < frame_start:
        continue
    n = c["name"]
    if n == "glUseProgram":
        cur_prog = grab("program", c["body"])
        continue
    if n in DRAW or n in OTHER:
        kind = "geometry/quad draw" if n in DRAW else OTHER[n]
        det = ""
        if n == "glDrawArrays":
            v = grab_int("count", c["body"])
            det = "verts=%s" % v if v is not None else ""
        elif n == "glDispatchCompute":
            g = [grab_int(k, c["body"]) for k in ("num_groups_x", "num_groups_y", "num_groups_z")]
            if all(x is not None for x in g):
                det = "groups=%dx%dx%d" % tuple(g)
        elif n in ("glCopyTexSubImage2D", "glCopyImageSubData", "glBlitNamedFramebuffer"):
            t = grab("dst", c["body"]) or grab("target", c["body"]) or grab("dstName", c["body"])
            det = "-> %s" % (labels.get(t, t or "?"))
        feat = name_program(cur_prog) if (n in DRAW or n == "glDispatchCompute") else kind
        rows.append(dict(ci=c["ci"], name=n, dur=c["dur"], kind=kind, det=det, feat=feat))

total = sum(r["dur"] for r in rows)
print("frame actions %d | total %d units | frame chunks %d..%d"
      % (len(rows), total, frame_start, chunks[-1]["ci"]))

print("\n=== cost by kind ===")
agg = collections.Counter()
for r in rows:
    agg[r["kind"]] += r["dur"]
for k, v in agg.most_common():
    print("  %8d  %5.1f%%  %s" % (v, 100.0 * v / total, k))

print("\n=== TOP FEATURES (shader work only) ===")
feat = collections.Counter()
cnt = collections.Counter()
for r in rows:
    if r["kind"] not in ("geometry/quad draw", "compute dispatch"):
        continue
    feat[r["feat"]] += r["dur"]
    cnt[r["feat"]] += 1
shader_total = sum(feat.values())
for k, v in feat.most_common(20):
    print("  %8d  %5.1f%% of frame | %5.1f%% of shader | x%-4d %s"
          % (v, 100.0 * v / total, 100.0 * v / shader_total, cnt[k], k))

print("\n=== NON-SHADER work ===")
for r in sorted(rows, key=lambda x: -x["dur"]):
    if r["kind"] in ("geometry/quad draw", "compute dispatch"):
        continue
    if r["dur"] < 100:
        continue
    print("  %8d  %5.1f%%  %-22s %s" % (r["dur"], 100.0 * r["dur"] / total, r["name"], r["det"]))
