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
XML = "lookme.xml"

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



DRAW = {"glDrawArrays", "glDrawElements", "glDrawElementsBaseVertex",
        "glMultiDrawElementsBaseVertex", "glMultiDrawArrays"}
frame_start = next((c["ci"] for c in chunks if c["name"] == "Internal::Beginning of Capture"), 0)
