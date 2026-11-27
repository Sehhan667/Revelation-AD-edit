# -*- coding: utf-8 -*-
"""打印表映射的逐项结构：每个输入 bin 段占多少个输出表项（= 该处纹素放大率）。
值 <1 表示多个输入 bin 塌到同一纹素（分辨率塌缩）；周期性起伏 = 条纹。"""
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


def dens(u, rel, k):
    return scale(u) * (1 - k) + max(0.25, min(4.0, rel)) * k


def build(edge, k, smooth_iters=0):
    e = list(edge)
    for _ in range(smooth_iters):
        e = [0.25 * e[max(i - 1, 0)] + 0.5 * e[i] + 0.25 * e[min(i + 1, BINS - 1)] for i in range(BINS)]
    mean = max(sum(e) / BINS, 1.0)
    total = 0.0
    for i in range(BINS):
        total += dens(bc(i), e[i] / mean, k)
    total = max(total, 1e-5)
    su = 2.0 / BINS
    mn, mx = SLOPE_MIN * su, SLOPE_MAX * su
    cum, prev, pos = 0.0, -1.0, []
    for i in range(BINS):
        cum += dens(bc(i), e[i] / mean, k)
        p = max(prev + mn, min(prev + mx, 2.0 * cum / total - 1.0))
        pos.append(p)
        prev = p
    kx = 2.0 / max(pos[-1] - pos[0], 1e-5)
    o = pos[0]
    return [(p - o) * kx - 1.0 for p in pos]


def real_profile():
    """真实感剖面：屏幕像素密度 × 距离权重 × 朝向；阴影 frustum 只覆盖中间一段 2/3。"""
    e = []
    for i in range(BINS):
        u = bc(i)
        # 屏幕可见（NDC 上约 -1..0.35 的地形，cos45 视角下）
        vis = 1.0 if -1.0 <= u <= 0.35 else 0.0
        dist = 8.0 + 70.0 * max(u + 0.35, 0.0) ** 1.4      # 中心近、两端远
        dw = 1.0 / (dist ** 1.3 * 0.1 + 1.0)
        e.append(vis * dw * 3.0 * 3000.0)
    return e


def show(name, edge, k, smooth_iters):
    pos = build(edge, k, smooth_iters)
    slots = [p * (BINS - 1) / 2.0 + (BINS - 1) / 2.0 for p in pos]
    d = [slots[i + 1] - slots[i] for i in range(BINS - 1)]
    print("\n--- %s  k=%s  smooth=%d ---" % (name, k, smooth_iters))
    print("  放大率(表项/输入bin) min=%.3f max=%.3f mean=%.3f" % (min(d), max(d), sum(d) / len(d)))
    # 压缩区（<0.9）统计
    comp = [i for i, x in enumerate(d) if x < 0.9]
    print("  压缩段数=%d  (<0.5 的段数=%d)" % (len(comp), sum(1 for x in d if x < 0.5)))
    # 打印每 8 个 bin 的平均放大率，看是否周期性起伏
    line = []
    for b in range(0, BINS - 1, 8):
        chunk = d[b:b + 8]
        line.append("%.2f" % (sum(chunk) / len(chunk)))
    print("  逐8bin平均放大率:", " ".join(line))


p = real_profile()
for k in (0.0, 0.25, 1.0):
    show("real", p, k, 0)
    show("real", p, k, 64)

# 逐项放大率的自相关，找周期性
import statistics
pos = build(p, 1.0, 64)
slots = [x * (BINS - 1) / 2.0 + (BINS - 1) / 2.0 for x in pos]
d = [slots[i + 1] - slots[i] for i in range(BINS - 1)]
m = statistics.mean(d)
dd = [x - m for x in d]
var = sum(x * x for x in dd)
print("\n放大率序列自相关（lag=1..12）:", end=" ")
for lag in range(1, 13):
    c = sum(dd[i] * dd[i + lag] for i in range(len(dd) - lag)) / var
    print("%.3f" % c, end=" ")
print()
