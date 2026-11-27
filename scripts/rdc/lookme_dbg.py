#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Debug view: per-program cost + what each program actually is."""
import re, os, collections, sys
import lookme_lib as L

chunks = L.chunks
DRAW = L.DRAW
frame_start = L.frame_start
print("frame starts at", frame_start, "| chunks", len(chunks))

cur = None
by = collections.defaultdict(lambda: [0, 0, collections.Counter()])
for c in chunks:
    if c["ci"] < frame_start:
        continue
    if c["name"] == "glUseProgram":
        cur = L.grab("program", c["body"])
        continue
    if c["name"] in DRAW or c["name"] == "glDispatchCompute":
        by[cur][0] += c["dur"]
        by[cur][1] += 1
        by[cur][2][c["name"]] += 1

print("\n%-10s %8s %6s  %-9s  %s" % ("prog", "dur", "calls", "srcB", "head"))
for pid, (d, n, kinds) in sorted(by.items(), key=lambda kv: -kv[1][0])[:16]:
    s = L.prog_source(pid)
    ls = [l.strip() for l in s.split("\n")
          if l.strip() and not l.strip().startswith("#") and l.strip() not in ("{", "}", ");")]
    head = " ".join(ls)[:88]
    print("%-10s %8d %6d  %-9s  %s" % (pid, d, n, len(s), head))
    print("%10s  kinds=%s" % ("", dict(kinds)))
