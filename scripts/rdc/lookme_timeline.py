#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ordered timeline of the frame: viewport / program / action / duration.

Also resolves each program to a pack file (code fingerprint) so the phases of
the frame become readable.
"""
import re
import os
import collections
import lookme_lib as L

PACK = L.PACK
IDENT = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]{7,})\b")

fp = {}
for root, _d, fs in os.walk(os.path.join(PACK, "program")):
    for f in fs:
        p = os.path.join(root, f)
        fp[os.path.relpath(p, PACK).replace("\\", "/")] = set(
            IDENT.findall(open(p, encoding="utf-8", errors="replace").read()))

owner = collections.Counter()
for _f, ids in fp.items():
    for i in ids:
        owner[i] += 1
rare = {f: {i for i in ids if owner[i] <= 2} for f, ids in fp.items()}


def identify(pid):
    src = L.prog_source(pid)
    if not src or len(src) < 2000:
        return "vanilla/other(%dB)" % len(src)
    ids = set(IDENT.findall(src))
    best, score = None, 0
    for f, r in rare.items():
        s = len(ids & r)
        if s > score:
            best, score = f, s
    return best.replace("program/", "") if best and score >= 4 else "pack?(%dB)" % len(src)


vp = None
cur = None
rows = []
for c in L.chunks:
    if c["ci"] < L.frame_start:
        continue
    n = c["name"]
    if n == "glViewport":
        w = L.grab_int("width", c["body"])
        h = L.grab_int("height", c["body"])
        vp = "%dx%d" % (w, h)
        continue
    if n == "glUseProgram":
        cur = L.grab("program", c["body"])
        continue
    if n in L.DRAW or n == "glDispatchCompute":
        det = ""
        if n == "glDrawArrays":
            det = "verts=%s" % L.grab_int("count", c["body"])
        elif n == "glMultiDrawElementsBaseVertex":
            det = "draws=%s" % L.grab_int("drawcount", c["body"])
        elif n == "glDispatchCompute":
            g = [L.grab_int(k, c["body"]) for k in
                 ("num_groups_x", "num_groups_y", "num_groups_z")]
            det = "g=%sx%sx%s" % tuple(g)
        rows.append((c["ci"], n.replace("gl", ""), det, vp or "?", cur or "?", c["dur"]))

total = sum(r[5] for r in rows)
print("frame %d..%d | %d actions | total %d units\n" % (L.frame_start, L.chunks[-1]["ci"], len(rows), total))
print("%-6s %-28s %-12s %-10s %-9s %7s  %s" %
      ("ci", "call", "args", "viewport", "prog", "dur", "program id"))
for ci, n, det, v, pid, dur in rows:
    print("%-6d %-28s %-12s %-10s %-9s %7d  %s" % (ci, n, det, v, pid, dur, identify(pid)[:40]))
