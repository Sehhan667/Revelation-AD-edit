#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lookme.rdc -> per-feature GPU cost table.

Pipeline:
  renderdoccmd convert -c xml  ->  lookme.xml
This script walks the chunk list, tracks glUseProgram, resolves each program to
the concatenated GLSL of its attached shaders, and names the pass from the
markers Iris leaves in the source (PASS_ defines, "Pass:" comment lines, or a
distinctive token). Durations come from the capture's per-chunk `duration`.
"""
import re
import sys
import html
import collections

XML = sys.argv[1] if len(sys.argv) > 1 else "lookme.xml"

text = open(XML, encoding="utf-8", errors="replace").read()

CHUNK = re.compile(
    r'<chunk id="(?P<id>\d+)" chunkIndex="(?P<ci>\d+)" name="(?P<name>[^"]*)"'
    r'(?: length="(?P<len>\d+)")? threadID="(?P<tid>\d+)"'
    r' timestamp="(?P<ts>\d+)" duration="(?P<dur>\d+)"(?P<self>\s*/>|>(?P<body>.*?)</chunk>)',
    re.S,
)


def unescape(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))


chunks = []
for m in CHUNK.finditer(text):
    body = m.group("body") or ""
    chunks.append(dict(
        ci=int(m.group("ci")), name=m.group("name"),
        ts=int(m.group("ts")), dur=int(m.group("dur")), body=body,
    ))
print("chunks parsed: %d" % len(chunks))

# --- frame boundary -----------------------------------------------------------
frame_start = 0
for c in chunks:
    if c["name"] == "Internal::Beginning of Capture":
        frame_start = c["ci"]
print("frame starts at chunkIndex %d" % frame_start)

# --- shader / program tables --------------------------------------------------
def grab(res_name, body):
    m = re.search(r'<ResourceId name="%s"[^>]*>(\d+)</ResourceId>' % res_name, body)
    return m.group(1) if m else None


def grab_int(name, body):
    m = re.search(r'<int name="%s"[^>]*>(-?\d+)</int>' % name, body)
    return int(m.group(1)) if m else None


shader_src = {}      # shaderId -> source
prog_shaders = collections.defaultdict(list)
for c in chunks:
    if c["name"] == "glShaderSource":
        sid = grab("shader", c["body"])
        src = unescape("\n".join(re.findall(r"<string[^>]*>(.*?)</string>", c["body"], re.S)))
        shader_src[sid] = src
    elif c["name"] == "glAttachShader":
        p, s = grab("program", c["body"]), grab("shader", c["body"])
        if p and s:
            prog_shaders[p].append(s)
print("shaders: %d | programs: %d" % (len(shader_src), len(prog_shaders)))


def prog_source(pid):
    return "\n".join(shader_src.get(s, "") for s in prog_shaders.get(pid, []))


# --- name each program --------------------------------------------------------
MARKERS = [
    (re.compile(r"Pass:\s*(.+)"), lambda m: m.group(1).strip()),
    (re.compile(r"#define\s+PASS_([A-Z0-9_]+)"), lambda m: "PASS_" + m.group(1)),
    (re.compile(r"Description:\s*(.+)"), lambda m: m.group(1).strip()),
    (re.compile(r"//\s*(Revelation-AD-edit[^\n]*)"), lambda m: m.group(1).strip()),
]
# fallback: distinctive tokens -> human label
TOKENS = [
    ("VoxelGI", "Voxel GI"), ("ProbeGI", "Probe GI (DDGI)"), ("PTGI_Median", "PTGI median"),
    ("DiffuseIndirect", "Diffuse indirect"), ("EAWF", "EAWF filter"),
    ("VarianceEstimate", "SVGF variance"), ("SpecularFilter", "Specular filter"),
    ("SpecularIndirect", "Specular indirect"), ("SSILVB", "SSILVB"),
    ("GTAO", "GTAO"), ("SSAO", "SSAO"), ("AOMultiBounce", "AO multi-bounce"),
    ("SpatialUpscale", "Spatial upscale"), ("MultiScatter", "Atmo multi-scatter"),
    ("SkyView", "Sky view LUT"), ("Transmittance", "Transmittance LUT"),
    ("Render.comp", "Cloud render"), ("Reconstruct", "Cloud reconstruct"),
    ("GenCloudShadow", "Cloud shadow"), ("GenSkyMap", "Sky map"),
    ("ShadowWarp", "Shadow warp LUT"), ("Shadow.frag", "Shadow map"),
    ("VoxelClear", "Voxel clear"), ("HurtTimer", "Hurt timer"),
    ("SubsurfaceBlur", "SSS blur"), ("KillRipple", "Kill ripple"),
    ("DOF", "Depth of field"), ("MotionBlur", "Motion blur"),
    ("TemporalAA", "Temporal AA"), ("Grade", "Color grade"),
    ("Final.frag", "Final composite"), ("Bloom", "Bloom"),
    ("DeferredLight", "Deferred lighting"), ("Translucent", "Translucent"),
    ("IntegrateScene", "Integrate scene"), ("Volumetric", "Volumetric fog"),
    ("ReprojectScene", "Reproject"), ("Blit", "Voxy blit"),
]


def name_program(pid):
    src = prog_source(pid)
    if not src:
        return "(unknown program %s)" % pid
    for rx, f in MARKERS:
        m = rx.search(src)
        if m:
            return f(m)[:60]
    for tok, label in TOKENS:
        if tok in src:
            return label
    return "(unidentified, %d B source)" % len(src)


# --- walk the frame -----------------------------------------------------------
ACTIONS = {
    "glDrawArrays": "fullscreen/quad draw",
    "glDrawElements": "indexed draw",
    "glDrawElementsBaseVertex": "indexed draw",
    "glMultiDrawElementsBaseVertex": "geometry multidraw",
    "glMultiDrawArrays": "geometry multidraw",
    "glDispatchCompute": "compute dispatch",
    "glClear": "clear",
    "glClearNamedFramebufferuiv": "clear",
    "glBlitNamedFramebuffer": "blit",
    "glCopyImageSubData": "image copy",
    "glCopyTexSubImage2D": "tex copy",
    "glMemoryBarrier": "barrier",
    "glClientWaitSync": "sync stall",
}

cur_prog = None
rows = []
for c in chunks:
    if c["ci"] < frame_start:
        continue
    n = c["name"]
    if n == "glUseProgram":
        cur_prog = grab("program", c["body"])
        continue
    if n in ACTIONS:
        extra = ""
        if n == "glDrawArrays":
            v = grab_int("count", c["body"])
            extra = " verts=%s" % v if v is not None else ""
        elif n.startswith("glDispatchCompute"):
            g = [grab_int(k, c["body"]) for k in ("num_groups_x", "num_groups_y", "num_groups_z")]
            if all(x is not None for x in g):
                extra = " groups=%dx%dx%d" % tuple(g)
        rows.append(dict(ci=c["ci"], name=n, dur=c["dur"], prog=cur_prog,
                         kind=ACTIONS[n], extra=extra,
                         label=name_program(cur_prog) if cur_prog else "-"))

total = sum(r["dur"] for r in rows)
print("\nframe actions: %d | sum(duration) = %d units" % (len(rows), total))

print("\n=== cost by action kind ===")
for k, v in collections.Counter({}).most_common():
    pass
agg = collections.Counter()
for r in rows:
    agg[r["kind"]] += r["dur"]
for k, v in agg.most_common():
    print("  %8d  %5.1f%%  %s" % (v, 100.0 * v / total, k))

print("\n=== top 25 individual actions ===")
for r in sorted(rows, key=lambda x: -x["dur"])[:25]:
    print("  %7d  ci=%-5d %-22s %-28s%s" % (r["dur"], r["ci"], r["name"], r["label"][:28], r["extra"]))

print("\n=== aggregated by identified feature ===")
feat = collections.Counter()
featn = collections.Counter()
for r in rows:
    if r["kind"] in ("barrier", "sync stall"):
        continue
    feat[r["label"]] += r["dur"]
    featn[r["label"]] += 1
for k, v in feat.most_common(30):
    print("  %8d  %5.1f%%  x%-4d %s" % (v, 100.0 * v / total, featn[k], k))
