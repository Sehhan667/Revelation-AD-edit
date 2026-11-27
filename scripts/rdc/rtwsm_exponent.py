# -*- coding: utf-8 -*-
"""验证最终方案：内容强度用**指数**，让内容剖面变窄（而不是靠调大 k）。

为什么必须这样：
  rtwsm_width.py 显示，宏观重分配（中心1/4域吃掉的纹理比例，k=0 基准 67.6%）
  强烈依赖内容剖面的**有效宽度**：
      很宽（近似平）  k=4 只能推到 73.6%  ← 几乎看不出
      中等            k=1 → 82.8%
      窄              k=1 → 91.2%        ← 一眼可见
  而本包的 rel（距离衰减 1/(d^1.3*0.1+1) → 除中心外全部远小于 1）
  在 clamp[0.25,4] + mix 之后**恰好落在"很宽"那一档**，且 k>=0.25 就饱和
  （因为 clamp 把比值锁在 4:1）⇒ 所以 k 调到 4 也没区别，**加大 k 没用**。

新式子：density = scale * (1 + clamp(rel,0.25,4)^k - 1)
  k=0 → 恒等（纯解析底座，不回归）；k=1 → 16:1；k=4 → 有效比值更高但仍有上限。
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


def build(c, k, formula):
    def dens(i):
        a = scale(bc(i))
        r = max(0.25, min(4.0, c[i]))
        if formula == "old":
            return a * (1.0 + (r - 1.0) * k)
        else:                                  # 新：指数
            return a * (1.0 + (r ** k - 1.0))
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


# 本包实际形状：rel 中心峰较高、宽 ~0.35（max 聚合后的估计）
c = content(peak=18.0, halfwidth=0.35)
base_lo, base_hi, base_q = build(c, 0.0, "old")
print("k=0 基准: 放大率 %.3f..%.2f  中心1/4域 %.1f%%" % (base_lo, base_hi, base_q * 100))
print()
print("%-8s %-22s %-26s %s" % ("k", "公式", "放大率 范围", "中心1/4域(相对基准)"))
for k in (0.25, 0.5, 1.0, 2.0, 3.0, 4.0):
    for f, tag in (("old", "现状 mul(线性)"), ("new", "新 pow(指数)")):
        lo, hi, q = build(c, k, f)
        print("%-8s %-22s %6.3f..%7.2f        %5.1f%%  (%+5.1f pt)"
              % (k, tag, lo, hi, q * 100, (q - base_q) * 100))
    print()
