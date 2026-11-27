#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cost breakdown for lookme.chrome.json (RenderDoc convert -c chrome.json).

chrome.json carries no arguments, so passes are named by aligning the ordered
list of real actions (draws / dispatches / clears / copies) with the shaderpack's
own world0 pipeline (see PIPELINE below).
"""
import json
import sys
import collections

PATH = sys.argv[1] if len(sys.argv) > 1 else "lookme.chrome.json"

ACTIONS = (
    "glDrawArrays", "glDrawElements", "glDrawElementsBaseVertex",
    "glMultiDrawElementsBaseVertex", "glMultiDrawArrays",
    "glDispatchCompute", "glClear", "glClearNamedFramebufferuiv",
    "glBlitNamedFramebuffer", "glCopyImageSubData", "glCopyTexSubImage2D",
    "glMemoryBarrier", "glClientWaitSync",
)

d = json.load(open(PATH, encoding="utf-8"))
evs = d["traceEvents"]

stack = collections.defaultdict(list)
flat = []
order = 0
for e in evs:
    ph, tid = e.get("ph"), e.get("tid")
    if ph == "B":
        node = dict(name=e.get("name") or "", ts=e.get("ts"), idx=order, dur=0)
        order += 1
        stack[tid].append(node)
    elif ph == "E" and stack[tid]:
        node = stack[tid].pop()
        node["dur"] = e.get("ts") - node["ts"]
        flat.append(node)

# ts unit: RenderDoc exports microseconds. Show both and let the numbers decide.
acts = [n for n in flat if n["name"] in ACTIONS]
total = sum(n["dur"] for n in acts)
print("file          : %s" % PATH)
print("all B/E pairs : %d" % len(flat))
print("action events : %d   sum(dur) = %d (chrome ts units)" % (len(acts), total))
print()

by = collections.Counter()
cnt = collections.Counter()
for n in acts:
    by[n["name"]] += n["dur"]
    cnt[n["name"]] += 1
print("=== cost by call type ===")
for k, v in by.most_common():
    print("  %12d  %5.1f%%  x%-5d  %s" % (v, 100.0 * v / total, cnt[k], k))
print()

print("=== top 30 individual actions (submission order) ===")
top = sorted(acts, key=lambda n: -n["dur"])[:30]
for n in sorted(top, key=lambda n: n["idx"]):
    print("  #%-5d %10d  %s" % (n["idx"], n["dur"], n["name"]))
print()

print("=== full action sequence (dur > 0), grouped in runs ===")
run_i = 0
for n in acts:
    if n["dur"] > 0:
        print("  #%-5d %10d  %s" % (n["idx"], n["dur"], n["name"]))
        run_i += 1
