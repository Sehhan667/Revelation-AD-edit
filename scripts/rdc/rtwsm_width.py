# -*- coding: utf-8 -*-
"""内容剖面越窄，同样 k 下的宏观重分配越明显吗？
（决定"为什么 k 到 4 仍看不出"到底是数据平还是效果天然弱）
指标：中心 1/4 域吃掉多少比例的阴影图纹理（k=0 基准 67.6%）。
"""
import math

BINS = 256
S = 2.75
SLOPE_MIN, SLOPE_MAX = 0.05, 32.0


def curve(u):
    r = max(abs(u), 1e-5)
    inv = 1.0 / r
    return math.log((math.exp(S) - 1.0) / inv + 1.0) * inv / S


def warp(u):
    return max(-1.0, min(1.0, u * curve(u)))


def scale(u):
    h = 1.0 / (BINS - 1)
    return max((warp(u + h) - warp(u - h)) / (2.0 * h), 0.0)


def bc(i):
    return (i / (BINS - 1)) * 2.0 - 1.0


def content(peak, halfwidth):
    c = []
    for i in range(BINS):
        u = bc(i)
        c.append(1.0 + (peak - 1.0) * math.exp(-(u / halfwidth) ** 2))
    m = sum(c) / BINS
    return [x / m for x in c]


def build(c, k, mode, clamp_lo=0.25, clamp_hi=4.0):
    def dens(i):
        a = scale(bc(i))
        r = max(clamp_lo, min(clamp_hi, c[i]))
        if mode == "mul":
            return a * (1.0 + (r - 1.0) * k)
        else:                                  # 地板抬起：让底座退居次要
            return max(a, 0.05) * (1.0 + (r - 1.0) * k)
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
    d = [slots[i + 1] - slots[i] for i in range(BINS - 1)]
    q = sum(d[BINS // 2 - BINS // 8: BINS // 2 + BINS // 8]) / sum(d)
    return min(d), max(d), q


print("k=0 基准：中心1/4域 = 67.6% 纹理, 放大率 0.050..3.16")
print()
print("%-28s %-6s %-24s %s" % ("内容剖面", "k", "放大率 范围", "中心1/4域占比"))
for hw, name in ((0.9, "很宽（近似平）"), (0.35, "中等"), (0.12, "窄（地形占屏幕一小片）")):
    for peak in (4.0, 18.0):
        c = content(peak, hw)
        for k in (0.5, 1.0, 4.0):
            lo, hi, q = build(c, k, "mul")
            print("%-28s %-6s %6.3f..%7.2f        %5.1f%%  (rel峰 %.1f)"
                  % (name + " peak%d" % peak, k, lo, hi, q * 100, max(c)))
        print()
