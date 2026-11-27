#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时：dump capture.xml 里每种相关 chunk 的一个样例 body，确认字段名。"""
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
chunks = [dict(ci=int(m.group("ci")), name=m.group("name"), dur=int(m.group("dur")),
               body=m.group("body") or "") for m in CHUNK.finditer(text)]
print("chunks:", len(chunks))

counts = collections.Counter(c["name"] for c in chunks)
for n, k in counts.most_common(40):
    print(f"{k:6d}  {n}")

want = ["glViewport", "glBindFramebuffer", "glFramebufferTexture2D", "glNamedFramebufferTexture",
        "glDispatchCompute", "glBindImageTexture", "glDrawElements", "glMultiDrawElementsBaseVertex",
        "glClear", "glBlitFramebuffer", "glCopyImageSubData", "glUseProgram", "glMemoryBarrier",
        "glFenceSync", "glObjectLabel"]
print("\n=== samples ===")
for w in want:
    for c in chunks:
        if c["name"] == w and c["body"]:
            body = c["body"]
            body = re.sub(r"\s+", " ", body)[:700]
            print(f"--- {w} (ci={c['ci']}, dur={c['dur']}):\n{body}\n")
            break
