#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""What does the SpriteAnimationInfo pass actually touch?

Rebuilds, for the sprite-animation region of the frame, which textures are
bound as render target and as CurrentSprite / NextSprite, plus their formats.
"""
import re
import collections

import lookme_lib as L

# ---- texture inventory ------------------------------------------------------
tex = {}          # id -> dict(w,h,fmt,levels)
fbo = collections.defaultdict(dict)   # fbo id -> {attachment point: tex id}
for c in L.chunks:
    n, b = c["name"], c["body"]
    if n in ("glTexStorage2D", "glTextureStorage2D", "glTexImage2D",
             "glTextureStorage2DMultisample"):
        tid = L.grab("texture", b)
        if not tid:
            continue
        fmt = re.search(r'name="internalformat"[^>]*string="(GL_[A-Z0-9_]+)"', b)
        w, h = L.grab_int("width", b), L.grab_int("height", b)
        lv = L.grab_int("levels", b)
        if tid not in tex or (w and not tex[tid].get("w")):
            tex[tid] = dict(w=w, h=h, fmt=fmt.group(1) if fmt else "?", levels=lv)
    elif n in ("glNamedFramebufferTexture", "glFramebufferTexture2D"):
        f = L.grab("framebuffer", b)
        t = L.grab("texture", b)
        a = re.search(r'string="(GL_[A-Z0-9_]+)"', b)
        lv = L.grab_int("level", b)
        if f and t:
            fbo[f][(a.group(1) if a else "?", lv)] = t

# ---- sprite region ----------------------------------------------------------
SPRITE_REGION = range(5170, 6940)
unit, bound = None, {}
curfbo, curprog = None, None
rows = []
for c in L.chunks:
    if c["ci"] not in SPRITE_REGION:
        continue
    n, b = c["name"], c["body"]
    if n == "glActiveTexture":
        unit = re.search(r'string="(GL_TEXTURE[0-9A-Z_]+)"', b)
        unit = unit.group(1) if unit else None
        continue
    if n in ("glBindTexture", "glBindTextureUnit"):
        t = L.grab("texture", b)
        u = unit or (b and re.search(r'unit="?(\d+)', b))
        u = L.grab_int("unit", b) if n == "glBindTextureUnit" else unit
        if t and u is not None:
            bound[u] = t
        continue
    if n in ("glBindFramebuffer", "glBindFramebuffer2"):
        curfbo = L.grab("framebuffer", b)
        continue
    if n == "glUseProgram":
        curprog = L.grab("program", b)
        continue
    if n == "glViewport":
        continue
    if n == "glDrawArrays" and curprog in ("281", "351"):
        rows.append((c["ci"], curprog, curfbo, dict(bound), c["dur"]))

print("=== sprite draws: %d ===" % len(rows))
for prog in ("281", "351"):
    sub = [r for r in rows if r[1] == prog]
    fbos = collections.Counter(r[2] for r in sub)
    print("\nprog %s : %d draws, %d us" % (prog, len(sub), sum(r[4] for r in sub)))
    for f, cnt in fbos.most_common():
        att = fbo.get(f, {})
        print("   fbo %s -> %d draws   attachments: %s"
              % (f, cnt, ", ".join("%s(lvl%s)=%s" % (k[0], k[1], v) for k, v in sorted(att.items()))))
        for k, v in sorted(att.items()):
            t = tex.get(v, {})
            print("        tex %s  %sx%s  %s  levels=%s" % (v, t.get("w"), t.get("h"),
                                                            t.get("fmt"), t.get("levels")))

print("\n=== textures bound as sampler units during those draws ===")
ucnt = collections.Counter()
for _ci, _p, _f, bd, _d in rows:
    for u, t in bd.items():
        ucnt[(u, t)] += 1
for (u, t), cnt in sorted(ucnt.items(), key=lambda kv: -kv[1])[:12]:
    info = tex.get(t, {})
    print("  unit %-18s tex %-8s x%-4d  %sx%s  %s" % (u, t, cnt, info.get("w"), info.get("h"),
                                                      info.get("fmt")))

print("\n=== first 14 sprite draws, in order ===")
for ci, p, f, bd, d in rows[:14]:
    att = fbo.get(f, {})
    tgt = [v for k, v in sorted(att.items())]
    src = [t for u, t in sorted(bd.items())]
    print("  ci=%-5d prog=%-4s dur=%-5d target=%s  units=%s"
          % (ci, p, d, ",".join(tgt), ",".join(src)))
