# -*- coding: utf-8 -*-
"""对比两种密度合成方式（都用真实的 rank-1 重要性剖面 + 现有 SLOPE 夹紧）：

  A) 现状   density = mix(scale_analytic(u), clamp(rel,0.25,4), k)     [ShadowWarp.comp:107]
  B) 参考   density = scale_analytic(u) * rel                          [itrp / Alpha Piscium]

判据：每个输入 bin 段占多少输出表项（放大率 d(slot)/d(bin)）。
放大率的**动态范围**就是可用的分辨率重新分配能力；
若有大量段 < 0.5 表项 ⇒ 多个输入 bin 塌到同一纹素 ⇒ 条纹/塌缩。
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


def build(edge, k, mode, clamp_rel=True, adaptive=False):
    mean = max(sum(edge) / BINS, 1.0)
    def dens(i):
        u = bc(i)
        a = scale(u)
        r = edge[i] / mean
        if clamp_rel:
            r = max(0.25, min(4.0, r))
        if mode == "A":          # 现状：线性混合（加法先验）
            return a * (1.0 - k) + r * k
        else:                    # 参考：乘法先验
            return a * (r * k + (1.0 - k))
    total = 0.0
    for i in range(BINS):
        total += dens(i)
    total = max(total, 1e-5)
    su = 2.0 / BINS
    prev, cum, pos = -1.0, 0.0, []
    for i in range(BINS):
        cum += dens(i)
        if adaptive:
            # 夹紧范围跟随"该 bin 的名义密度"：允许内容把它拉伸 ~8 倍 / 压缩 ~8 倍
            mn = max(dens(i) * 0.125, 1e-4) * su
            mx = max(dens(i) * 8.0, 1e-3) * su
            mn, mx = min(mn, su), max(mx, su)
        else:
            mn, mx = SLOPE_MIN * su, SLOPE_MAX * su
        p = max(prev + mn, min(prev + mx, 2.0 * cum / total - 1.0))
        pos.append(p)
        prev = p
    kx = 2.0 / max(pos[-1] - pos[0], 1e-5)
    o = pos[0]
    pos = [(p - o) * kx - 1.0 for p in pos]
    slots = [p * (BINS - 1) / 2.0 + (BINS - 1) / 2.0 for p in pos]
    d = [slots[i + 1] - slots[i] for i in range(BINS - 1)]
    return d


def profile(kind):
    e = []
    for i in range(BINS):
        u = bc(i)
        if kind == "smooth":
            rel = 1.0 / ((8.0 + 70.0 * max(u + 0.35, 0.0) ** 1.4) ** 1.3 * 0.1 + 1.0)
        else:  # "peaked"：近处一个小区域收走大部分屏幕像素（玩家脚下的地面）
            rel = 1.0 / ((6.0 + 70.0 * max(u + 0.35, 0.0) ** 2.2) ** 1.3 * 0.1 + 1.0)
        e.append(max(rel, 1e-6) * 3000.0)
    return e


def report(name, d):
    comp = sum(1 for x in d if x < 0.5)
    print("  %-34s 放大率 min=%6.3f max=%7.2f 动态范围=%7.1f  <0.5的段=%3d/%d"
          % (name, min(d), max(d), max(d) / max(min(d), 1e-9), comp, len(d)))


for kind in ("smooth", "peaked"):
    prof = profile(kind)
    print("\n===== 剖面: %s =====" % kind)
    for k in (0.25, 1.0, 4.0):
        print(" k=%s" % k)
        report("A 现状 mix + 夹紧rel + 固定SLOPE", build(prof, k, "A"))
        report("B 乘法先验 + 夹紧rel + 固定SLOPE", build(prof, k, "B"))
        report("B 乘法先验 + rel不夹紧 + 固定SLOPE", build(prof, k, "B", clamp_rel=False))
        report("B 乘法先验 + rel不夹紧 + 自适应SLOPE", build(prof, k, "B", clamp_rel=False, adaptive=True))
