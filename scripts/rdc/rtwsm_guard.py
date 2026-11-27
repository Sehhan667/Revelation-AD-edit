# -*- coding: utf-8 -*-
"""WarpEntryInvalid 是否会**静默丢弃**真实的内容驱动表？

Warp.glsl 的 WarpEntryInvalid 判定：scale < 0.01 或 scale > 64.0 即视为坏数据，
逐轴**回退到解析曲线**。而内容 warp 在"本该压缩"的区域 scale 会很大。
本脚本按 ShadowWarp.comp 的真实步骤建表（含 k、clamp、SLOPE 夹紧、端点归一化），
再按 Warp.glsl 的原文算法算 scale，统计被判定为坏的表项数。
"""
import math

BINS = 256
S = 2.75
SLOPE_MIN, SLOPE_MAX = 0.05, 32.0


def curve(u):
    r = max(abs(u), 1e-5)
    inv = 1.0 / r
    return math.log((math.exp(S) - 1.0) / inv + 1.0) * inv / S


def warp_a(u):
    return max(-1.0, min(1.0, u * curve(u)))


def scale_a(u):
    h = 1.0 / (BINS - 1)
    return max((warp_a(u + h) - warp_a(u - h)) / (2.0 * h), 0.0)


def bc(i):
    return (i / (BINS - 1)) * 2.0 - 1.0


def content(peak, halfwidth):
    c = []
    for i in range(BINS):
        u = bc(i)
        c.append(1.0 + (peak - 1.0) * math.exp(-(u / halfwidth) ** 2))
    m = sum(c) / BINS
    return [x / m for x in c]


def build(c, k):
    def dens(i):
        a = scale_a(bc(i))
        r = max(0.25, min(4.0, c[i]))
        return a * (1.0 + (r - 1.0) * k)
    total = max(sum(dens(i) for i in range(BINS)), 1e-5)
    su = 2.0 / BINS
    mn, mx = SLOPE_MIN * su, SLOPE_MAX * su
    cum, prev, pos = 0.0, -1.0, []
    for i in range(BINS):
        cum += dens(i)
        p = max(prev + mn, min(prev + mx, 2.0 * cum / total - 1.0))
        pos.append(p)
        prev = p
    kx = 2.0 / max(pos[-1] - pos[0], 1e-5)
    o = pos[0]
    return [(p - o) * kx - 1.0 for p in pos]


def table_scale(pos):
    """Warp.glsl 的算法：中心差分，步长 2/(BINS-1)"""
    h = 2.0 / float(BINS - 1)
    out = []
    for i in range(BINS):
        l = pos[max(i - 1, 0)]
        r = pos[min(i + 1, BINS - 1)]
        out.append(max((r - l) / (2.0 * h), 0.0))
    return out


def is_invalid(w, s):
    """WarpEntryInvalid 逐条判据"""
    if not (w == w) or not (s == s):
        return True
    if w == 0.0 and s == 0.0:
        return True
    if abs(w) > 1.05:
        return True
    if s < 0.01 or s > 64.0:
        return True
    return False


print("WarpEntryInvalid 允许的 scale: 0.01 .. 64.0")
print()
for hw, name in ((0.35, "中等宽度"), (0.12, "窄")):
    for peak in (18.0, 60.0):
        c = content(peak, hw)
        for k in (0.0, 1.0, 4.0):
            pos = build(c, k)
            sc = table_scale(pos)
            bad = [i for i in range(BINS) if is_invalid(pos[i], sc[i])]
            lo = min(sc)
            hi = max(sc)
            print("%s peak%-3.0f k=%-4s: scale %.2f..%8.2f  被判定坏的表项 %3d/256 %s"
                  % (name, peak, k, lo, hi, len(bad),
                     ("<-- 这些项回退成解析曲线!" if bad else "")))
    print()
