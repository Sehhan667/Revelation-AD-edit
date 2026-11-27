#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打印 capture.xml 里未标注 program（progNNN）的 shader 源码，用于识别它们是什么 pass。"""
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
chunks = [dict(name=m.group("name"), body=m.group("body") or "") for m in CHUNK.finditer(text)]


def res(name, body):
    m = re.search(r'<ResourceId name="%s"[^>]*>(-?\d+)</ResourceId>' % name, body)
    return m.group(1) if m else None


def unesc(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


src = {}
for c in chunks:
    if c["name"] == "glShaderSource":
        sid = res("shader", c["body"])
        m = re.search(r'<string typename="string">(.*?)</string>', c["body"], re.S)
        if sid and m:
            src[sid] = unesc(m.group(1))

prog_shaders = collections.defaultdict(list)
cur = None
for c in chunks:
    if c["name"] == "glCreateProgram":
        cur = res("Program", c["body"]) or res("program", c["body"])
    elif c["name"] == "glAttachShader" and cur:
        s = res("shader", c["body"])
        if s:
            prog_shaders[cur].append(s)

labels = {}
for c in chunks:
    if c["name"] in ("glObjectLabel", "glObjectPtrLabel"):
        r = res("Resource", c["body"])
        m = re.search(r'<string name="Label"[^>]*>(.*?)</string>', c["body"], re.S)
        if r and m:
            labels[r] = unesc(m.group(1))

TARGETS = ["prog189", "prog201", "prog204", "prog205", "prog255", "prog307", "prog328"]
for pid, shaders in prog_shaders.items():
    lab = labels.get(pid, "prog" + str(pid))
    if lab not in TARGETS:
        continue
    body = "\n".join(src.get(s, "") for s in shaders)
    print("=" * 100)
    print("### %s  （%d 个 shader，合计 %d 字符）" % (lab, len(shaders), len(body)))
    print("=" * 100)
    print(body[:2600])
    print("...\n")
