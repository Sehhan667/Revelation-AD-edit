#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lookme.rdc - final per-feature GPU cost table.

Identification: every world0/world-1/world1 entry (e.g. deferred20) is expanded
through "#include" and turned into a fingerprint of rare identifiers, so each
captured GL program can be attributed to a named Iris pass.
"""
import os
import re
import collections

import lookme_lib as L

SHADERS = L.PACK
IDENT = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]{7,})\b")
INC = re.compile(r'^\s*#include\s+"([^"]+)"', re.M)


def expand(path, seen=None):
    seen = seen or set()
    if path in seen:
        return ""
    seen.add(path)
    try:
        t = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""
    out = [t]
    for inc in INC.findall(t):
        p = inc.lstrip("/")
        out.append(expand(os.path.join(SHADERS, p.replace("/", os.sep)), seen))
    return "\n".join(out)


# ---- fingerprints, one per Iris pass ---------------------------------------
entries = collections.OrderedDict()      # pass name -> source
for w in ("world0", "world-1", "world1"):
    d = os.path.join(SHADERS, w)
    if not os.path.isdir(d):
        continue
    groups = collections.defaultdict(list)
    for f in os.listdir(d):
        base, ext = os.path.splitext(f)
        if ext in (".vsh", ".fsh", ".gsh", ".csh", ".glsl"):
            groups[base].append(os.path.join(d, f))
    for base, files in sorted(groups.items()):
        if base in entries:
            continue
        entries[base] = "\n".join(expand(p) for p in sorted(files))

# pretty names: pass -> entry program
PRETTY = {}
for base in entries:
    prog = sorted(set(re.findall(r"#include\s+\"/program/([^\"]+)\"",
                                 open(os.path.join(SHADERS, "world0",
                                                   base + [e for e in
                                                           (".vsh", ".fsh", ".gsh", ".csh", ".glsl")
                                                           if os.path.exists(os.path.join(SHADERS, "world0", base + e))][0]),
                                      encoding="utf-8", errors="replace").read())))
    PRETTY[base] = ", ".join(p.replace("program/", "") for p in prog) or base

fp = {b: set(IDENT.findall(s)) for b, s in entries.items()}
owner = collections.Counter()
for _b, ids in fp.items():
    for i in ids:
        owner[i] += 1
rare = {b: {i for i in ids if owner[i] <= 3} for b, ids in fp.items()}


def identify(pid):
    src = L.prog_source(pid)
    if not src:
        return "?", 0, 0
    ids = set(IDENT.findall(src))
    scored = sorted(((len(ids & r), b) for b, r in rare.items()), reverse=True)
    if not scored or scored[0][0] < 6:
        return "vanilla/other", 0, len(src)
    return scored[0][1], scored[0][0], 0


# ---- walk the frame ---------------------------------------------------------
COST = collections.Counter()   # feature -> duration
CALLS = collections.Counter()  # feature -> call count
BYPASS = collections.defaultdict(list)
COPY = collections.Counter()

prog = None
vp = None
rows = []
for c in L.chunks:
    if c["ci"] < L.frame_start:
        continue
    n = c["name"]
    if n == "glViewport":
        vp = "%sx%s" % (L.grab_int("width", c["body"]), L.grab_int("height", c["body"]))
        continue
    if n == "glUseProgram":
        prog = L.grab("program", c["body"])
        continue
    if n in L.DRAW:
        name, score, _ = identify(prog)
        det = ""
        if n == "glDrawArrays":
            det = "verts=%s" % L.grab_int("count", c["body"])
        elif n == "glMultiDrawElementsBaseVertex":
            det = "draws=%s" % L.grab_int("drawcount", c["body"])
        rows.append((c["ci"], name, prog, vp, det, c["dur"]))
        COST[name] += c["dur"]
        CALLS[name] += 1
        BYPASS[name].append((c["ci"], vp, det, c["dur"]))
    elif n == "glDispatchCompute":
        name, score, _ = identify(prog)
        rows.append((c["ci"], name, prog, vp, "compute", c["dur"]))
        COST[name] += c["dur"]
        CALLS[name] += 1
        BYPASS[name].append((c["ci"], vp, "compute", c["dur"]))
    elif n in ("glCopyTexSubImage2D", "glCopyImageSubData", "glBlitFramebuffer"):
        COPY["framebuffer copy / blit"] += c["dur"]
    elif n in ("glClear", "glClearBufferfv", "glClearBufferfi", "glClearBufferuiv"):
        COPY["clear"] += c["dur"]
    elif n in ("glMemoryBarrier", "glTextureBarrier"):
        COPY["barrier"] += c["dur"]
    elif n.startswith("gl") and "Sync" in n or n in ("glFinish", "glFlush"):
        COPY["sync / stall"] += c["dur"]

total = sum(COST.values()) + sum(COPY.values())
shader_total = sum(COST.values())

print("frame chunks %d..%d   total %d us   (shader work %d us = %.1f%%)"
      % (L.frame_start, L.chunks[-1]["ci"], total, shader_total, 100.0 * shader_total / total))
print()
print("%-26s %8s %7s %6s %s" % ("feature / pass", "us", "%frame", "calls", "entry program"))
print("-" * 96)
for name, cost in COST.most_common():
    print("%-26s %8d %6.1f%% %6d  %s"
          % (name[:26], cost, 100.0 * cost / total, CALLS[name], PRETTY.get(name, "")[:40]))
print("-" * 96)
for k, v in COPY.most_common():
    print("%-26s %8d %6.1f%%" % (k, v, 100.0 * v / total))

print()
print("=== detail: viewport chain per pass ===")
for name, cost in COST.most_common():
    vps = collections.Counter(v for _ci, v, _d, _t in BYPASS[name])
    print("%-24s %6d us  x%-4d  %s" % (name[:24], cost, len(BYPASS[name]),
                                       ", ".join("%s(%d)" % (v, k) for v, k in vps.most_common(6))))

print()
print("=== all compute dispatches in order ===")
for ci, name, pid, v, det, dur in rows:
    if det == "compute":
        print("  %-6d %-24s %-10s %6d  %s" % (ci, name[:24], v, dur, PRETTY.get(name, "")[:46]))
