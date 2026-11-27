# -*- coding: utf-8 -*-
"""验证 CompressRel 是否能压住"毛糙"的 rel 而不产生条纹。

输入：带 1e4 跨度 + 逐 bin 乘性噪声的 rel 剖面（模拟屏幕采样密度 ∝ 1/视距² 造成的
      极端不均 + 每个 bin 只有 ~256 个采样的采样噪声）。
输出：最终表的"纹理放大率"序列，看有没有 <1 的塌缩段（条纹）和离散台阶。
"""
import math, random

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


def raw_rel():
    """真实感 rel：中心极密 + 两端极稀（跨度 ~1e4）+ 逐 bin 乘性噪声"""
    random.seed(7)
    e = []
    for i in range(BINS):
        u = bc(i)
        v = (1.0 + 60.0 * math.exp(-(u / 0.30) ** 2)) / (1.0 + 40.0 * abs(u) ** 2)
        v *= (1.0 + 0.35 * (random.random() - 0.5))          # 采样噪声 ±17%
        e.append(max(v, 1e-5))
    m = sum(e) / BINS
    return [x / m for x in e], [(1.0 + 60.0 * math.exp(-(bc(i) / 0.30) ** 2)) /
                                (1.0 + 40.0 * abs(bc(i)) ** 2) for i in range(BINS)]


def smooth(prof, iters):
    for _ in range(iters):
        prof = [0.25 * prof[max(i - 1, 0)] + 0.5 * prof[i] + 0.25 * prof[min(i + 1, BINS - 1)]
                for i in range(BINS)]
    return prof


def compress(rel):
    return 2.0 ** math.tanh(math.log2(max(rel, 1e-6)) * 0.5)


def build(rel, k, mode):
    def dens(i):
        a = scale_a(bc(i))
        if mode == "clamp":
            c = max(0.25, min(4.0, rel[i]))
        else:
            c = compress(rel[i])
        return a * (1.0 + (c - 1.0) * k)
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
    pos = [(p - o) * kx - 1.0 for p in pos]
    slots = [p * (BINS - 1) / 2.0 + (BINS - 1) / 2.0 for p in pos]
    return [slots[i + 1] - slots[i] for i in range(BINS - 1)]


raw, clean = raw_rel()
print("原始 rel: %.5f .. %.1f  (跨度 %.0f:1)" % (min(raw), max(raw), max(raw) / min(raw)))
print("压缩后  : %.3f .. %.3f  (跨度 %.1f:1)" % (min(map(compress, raw)), max(map(compress, raw)),
      max(map(compress, raw)) / min(map(compress, raw))))
print()
print("%-6s %-34s %s" % ("平滑", "模式", "纹理放大率 / 塌缩段(<0.5) / 锯齿度"))
for iters in (64, 256):
    sm = smooth(raw, iters)
    for k in (1.0, 4.0):
        for mode, tag in (("clamp", "clamp[0.25,4]"), ("compress", "CompressRel(tanh)")):
            d = build(sm, k, mode)
            coll = sum(1 for x in d if x < 0.5)
            # 锯齿度：相邻段差值的中位数 / 平均值（越大越"一格一格"）
            diffs = sorted(abs(d[i + 1] - d[i]) for i in range(len(d) - 1))
            jag = diffs[len(diffs) // 2] / (sum(d) / len(d))
            print("%-6d k=%-4s %-34s %.4f..%7.3f  塌缩 %3d/255   锯齿 %.4f"
                  % (iters, k, tag, min(d), max(d), coll, jag))
    print()
