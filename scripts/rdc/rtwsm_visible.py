# -*- coding: utf-8 -*-
"""找出"能看出区别"的合成方式。

关键认识：CDF 会整体归一化 ⇒ **只有形状存活**。所以"能不能看出来"取决于
最终纹理放大率（d(slot)/d(bin)）的**对比度**，而不是 k 的大小。

rtwsm_strength.py 的结论：
  - 夹紧上下限（[0.0625,16] 或不夹紧）与 [0.25,4] 结果**完全一样** ⇒ 不是夹紧的问题；
  - 现状 `a * mix(1,clamp(rel),k)`：k=0 → 29.6:1，k=0.25 → 51:1，k=1 → 168:1，k=4 → 222:1
    （k>=0.25 后几乎饱和，因为内容项被 clamp 锁在 4:1）。
    但解析底座与内容**都集中在中心** ⇒ 乘起来只是把中心压得更窄，宏观分配几乎不变。

本脚本检验一个更强的做法（更接近 itrp / Alpha Piscium：密度直接就是内容剖面）：
    density = mix(解析底座, 内容剖面, k)
即 k 大时让解析底座真正退场，由内容单独决定形状。
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


def make_content(peak, width, tail):
    """内容剖面（相对值，均值 1）：中心尖峰 + 平坦尾部。max 聚合 + 平滑后的形状。"""
    c = []
    for i in range(BINS):
        u = bc(i)
        c.append(tail + (peak - tail) * math.exp(-(u / width) ** 2))
    m = sum(c) / BINS
    return [x / m for x in c]


def build(content, k, mode):
    def dens(i):
        a = scale(bc(i))
        c = max(content[i], 1e-4)
        if mode == "mul":                       # 现状：乘法
            return a * (1.0 + (max(0.25, min(4.0, c)) - 1.0) * k)
        elif mode == "mul_noclamp":             # 乘法、不夹紧
            return a * (1.0 + (c - 1.0) * k)
        elif mode == "lerp":                    # 解析底座与内容剖面线性插值
            return a * (1.0 - k) + c * k
        elif mode == "content":                 # 纯内容
            return c
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
    # 宏观指标：中心 1/4 域吃掉多少比例的纹理（k=0 参考值）
    quarter = sum(d[BINS // 2 - BINS // 8: BINS // 2 + BINS // 8]) / sum(d)
    return d, quarter


# max 聚合实测形状：rel 0.166..8.04 ⇒ 峰值/均值 ≈ 8，宽度中等，尾部 ~0.17
content = make_content(peak=18.0, width=0.35, tail=0.16)

print("内容剖面: 范围 %.3f..%.2f  中心1/4域质量占比 %.3f" %
      (min(content), max(content),
       sum(content[BINS // 2 - BINS // 8: BINS // 2 + BINS // 8]) / sum(content)))

base_d, base_q = build(content, 0.0, "content")
print("\nk=0（解析底座，基准）: 放大率 %.3f..%.2f  中心1/4域占纹理 %.1f%%"
      % (min(base_d), max(base_d), base_q * 100))

for k in (0.25, 0.5, 0.75, 1.0):
    print("\n k=%s" % k)
    for mode, tag in (("mul", "现状 乘法+clamp[0.25,4]"),
                      ("mul_noclamp", "乘法 不夹紧"),
                      ("lerp", "插值 mix(底座, 内容, k)"),
                      ("content", "纯内容（k 无关，仅对照）")):
        d, q = build(content, k, mode)
        print("    %-26s 放大率 %.3f..%6.2f  中心1/4域占纹理 %5.1f%%  (相对基准 %+5.1f 个百分点)"
              % (tag, min(d), max(d), q * 100, (q - base_q) * 100))
