#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 capture.xml 里的 progNNN（无 label 的 program）映射到可识别的 pass。
做法：glCreateProgram/glAttachShader 建 program->shader 关系，glShaderSource 取源码，
在源码里找包内特征串（PASS_*、/*   Pass: ...  */、独特函数名）。
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
    dict(name=m.group("name"), body=m.group("body") or "")
    for m in CHUNK.finditer(text)
]


def res(name, body):
    m = re.search(r'<ResourceId name="%s"[^>]*>(-?\d+)</ResourceId>' % name, body)
    return m.group(1) if m else None


def unesc(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


# shader 源码
src = {}
for c in chunks:
    if c["name"] == "glShaderSource":
        sid = res("shader", c["body"])
        m = re.search(r'<string typename="string">(.*?)</string>', c["body"], re.S)
        if sid and m:
            src[sid] = unesc(m.group(1))

# program -> shaders
prog_shaders = collections.defaultdict(list)
cur_prog = None
for c in chunks:
    if c["name"] == "glCreateProgram":
        cur_prog = res("Program", c["body"]) or res("program", c["body"])
    elif c["name"] == "glAttachShader" and cur_prog:
        s = res("shader", c["body"])
        if s:
            prog_shaders[cur_prog].append(s)

# program 标签
labels = {}
for c in chunks:
    if c["name"] in ("glObjectLabel", "glObjectPtrLabel"):
        r = res("Resource", c["body"])
        m = re.search(r'<string name="Label"[^>]*>(.*?)</string>', c["body"], re.S)
        if r and m:
            labels[r] = unesc(m.group(1))

TOKENS = [
    ("shadow/voxel", ["shadowcolor0", "VOXEL_SHADOW", "voxelMask", "ShiftShadowScreenPos"]),
    ("gbuffer-terrain", ["gbuffers_terrain", "mat2(gl_NormalMatrix)", "texture(tex, texCoordOut)"]),
    ("gbuffer-entities", ["gbuffers_entities", "entityId", "materialID"]),
    ("translucent", ["PASS_TRANSLUCENT", "Translucent", "waterMask"]),
    ("integrate/fog", ["IntegrateScene", "ComputeFogSunVisibility", "AtmosphericFog"]),
    ("deferred-light", ["DeferredLight", "CalculatePCSS", "PercentageCloserFilter"]),
    ("dof", ["DofGatherDisk", "DofPropagateCoC", "colorimg15"]),
    ("taa", ["TemporalReprojection", "convexHull", "colortex1"]),
    ("bloom", ["bloomKernel", "colorimg4", "sharedData"]),
    ("cloud", ["CloudVolumeDensity", "cloudShadowImg"]),
    ("gi/voxel", ["voxelMask", "GICanvasCoord", "SSILVB"]),
    ("sky", ["skyViewImg", "AtmosphereTransmittanceToSun", "RenderSkyView"]),
    ("final", ["finalOut", "GradeScene", "SAMPLE_STBN"]),
    ("motion", ["MOTION_BLUR", "motionVector"]),
]

print("program -> 可能的 pass（按特征串）")
seen = set()
for p, shaders in prog_shaders.items():
    lab = labels.get(p, "prog" + str(p))
    body = "\n".join(src.get(s, "") for s in shaders)
    hits = [name for name, toks in TOKENS if any(t in body for t in toks)]
    if lab in seen:
        continue
    seen.add(lab)
    print("%-12s len=%7d  %s" % (lab, len(body), ", ".join(hits) or "?"))
