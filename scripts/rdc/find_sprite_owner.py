#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Search the instance's mod jars for the SpriteAnimationInfo shader."""
import os
import zipfile

MODS = r"D:\Games\HMCL\.minecraft\versions\1.21.11-Fabric 0.18.4\mods"
NEEDLES = (b"SpriteAnimationInfo", b"CurrentSprite", b"MipMapLevel",
           b"UPadding", b"fAnimationProgress")

hits = []
for f in sorted(os.listdir(MODS)):
    if not f.endswith(".jar"):
        continue
    p = os.path.join(MODS, f)
    try:
        z = zipfile.ZipFile(p)
    except Exception:
        continue
    for n in z.namelist():
        low = n.lower()
        if not (low.endswith(".glsl") or low.endswith(".fsh") or low.endswith(".vsh")
                or low.endswith(".json") or low.endswith(".txt")
                or low.endswith(".class") or low.endswith(".vert")
                or low.endswith(".frag")):
            continue
        try:
            d = z.read(n)
        except Exception:
            continue
        found = [k.decode() for k in NEEDLES if k in d]
        if found:
            hits.append((f, n, found, len(d)))
            break

for f, n, found, sz in hits:
    print("%-58s %s\n    -> %s  (%d B)\n" % (f, n, ", ".join(found), sz))
if not hits:
    print("no jar contains SpriteAnimationInfo (source probably generated at runtime)")
