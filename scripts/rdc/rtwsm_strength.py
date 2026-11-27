# -*- coding: utf-8 -*-
"""关键问题：k（RTWSM_CONTENT_STRENGTH）究竟能改变多少表的形状？

链条（本包现状）：
    density(u) = scale_analytic(u) * mix(1, clamp(rel,0.25,4), k)
    CDF 归一化 + 端点拉伸 ⇒ 只有**形状**存活，整体倍率被约掉。

于是：
  - k 变大只是把 clamp 后的比值从 [1,1]..[1,4] 线性推到 [1,4]，对比度上界被
    clamp 比例锁死在 4:1（k>=0.25 就基本到顶）；
  - 而且 CDF 还整体归一化，所以 k 只影响"内容项相对于解析底座的权重"，
    一旦 clamp 到顶，k 再大也没用。

本脚本用真实感的 rel 剖面，直接量"最终纹理放大率的动态范围"（= 重新分配分辨率的能力），
比较三种合成方式在 k = 0 / 0.25 / 1 / 4 下的表现。
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


def make_rel(kind):
    """内容比例 rel：均值 1。用测量端模拟得到的形状（max 聚合）。
    center_ratio = 中心 bin 相对均值的倍数（越大说明内容集中在中心）。"""
    if kind == "max_agg":          # max 聚合：跨度小、平滑（实测 0.166..8.04）
        peak = 8.04
    elif kind == "strong":         # 内容更集中（玩家贴地、视野窄）
        peak = 60.0
    else:
        peak = 3.0
    rel = []
    for i in range(BINS):
        u = bc(i)
        rel.append((peak - 1.0) * math.exp(-(u / 0.30) ** 2) + 1.0)
    m = sum(rel) / BINS
    return [r / m for r in rel]


def build(rel, k, mode, lo, hi):
    def dens(i):
        a = scale(bc(i))
        r = max(lo, min(hi, rel[i]))
        if mode == "mix":
            return a * (1.0 + (r - 1.0) * k)
        elif mode == "pow":                       # 内容强度当指数
            return a * (r ** k)
        else:                                     # 无 clamp（只用 SLOPE 兜底）
            return a * r
    total = sum(dens(i) for i in range(BINS))
    total = max(total, 1e-5)
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
    return d


def show(tag, d):
    print("    %-42s 纹理放大率 %.3f .. %6.2f  (对比度 %6.1f:1)  最细段=%.3f"
          % (tag, min(d), max(d), max(d) / max(min(d), 1e-9), min(d)))


for kind in ("max_agg", "strong", "weak"):
    rel = make_rel(kind)
    print("\n===== 内容比例剖面: %s (rel 范围 %.3f..%.2f) =====" %
          (kind, min(rel), max(rel)))
    for k in (0.0, 0.25, 1.0, 4.0):
        print("  k=%s" % k)
        if k == 0.0:
            show("解析底座（无内容）", build(rel, 0.0, "mix", 0.25, 4.0))
            continue
        show("mix + clamp[0.25,4]（现状）", build(rel, k, "mix", 0.25, 4.0))
        show("mix + clamp[0.0625,16]", build(rel, k, "mix", 0.0625, 16.0))
        show("mix + 不夹紧", build(rel, k, "mix", 0.0, 1e9))
        show("pow(rel,k) + clamp[0.25,4]", build(rel, min(k, 4.0), "pow", 0.25, 4.0))
