#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dump the frame's program/draw sequence to sanity-check attribution."""
import lookme_lib as L
import sys

start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
end = int(sys.argv[2]) if len(sys.argv) > 2 else 10 ** 9

for c in L.chunks:
    if c["ci"] < L.frame_start or c["ci"] < start or c["ci"] > end:
        continue
    n = c["name"]
    if n == "glUseProgram":
        pid = L.grab("program", c["body"])
        print("ci=%-5d USEPROGRAM %-8s  (%d B src)" % (c["ci"], pid, len(L.prog_source(pid))))
    elif n in L.DRAW or n == "glDispatchCompute":
        det = ""
        if n == "glDrawArrays":
            det = " verts=%s" % L.grab_int("count", c["body"])
        elif n == "glDispatchCompute":
            g = [L.grab_int(k, c["body"]) for k in ("num_groups_x", "num_groups_y", "num_groups_z")]
            det = " groups=%s" % (g,)
        print("ci=%-5d   %-32s dur=%-6d%s" % (c["ci"], n, c["dur"], det))
