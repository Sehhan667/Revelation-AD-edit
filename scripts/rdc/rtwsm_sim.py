# -*- coding: utf-8 -*-
"""
RTWSM 表构建数值模拟：完全照抄 program/setup/ShadowWarp.comp 的 main() 数学，
用合成的重要性剖面检查 CDF 是否退化（多个 bin 映射到同一坐标 = 条纹/塌缩）。
只做数值实验，不改包。
"""
import math

BINS = 256
S = 2.75            # SHADOW_DISTORTION_STRENGTH
SLOPE_MIN = 0.05
SLOPE_MAX = 32.0


def curve_analytic(u):
    r = max(abs(u), 1e-5)
    inv = 1.0 / r
    dc = math.log((math.exp(S) - 1.0) / inv + 1.0)
    return dc * inv / S


def warp_analytic(u):
    return max(-1.0, min(1.0, u * curve_analytic(u)))


def scale_analytic(u):
    h = 1.0 / (BINS - 1)
    return max((warp_analytic(u + h) - warp_analytic(u - h)) / (2.0 * h), 0.0)


def bin_to_clip(i):
    return (i / (BINS - 1)) * 2.0 - 1.0


def density_at(u, rel, k):
    a = scale_analytic(u)
    c = max(0.25, min(4.0, rel))
    return a * (1.0 - k) + c * k


def build(edge, k, name, temporal_speed=None, old_pos=None, iters=0):
    """返回 pos[]；edge 是 256 个重要性计数（未平滑）。"""
    e = list(edge)
    # 64 轮 [0.25,0.5,0.25] 平滑（若 iters>0）
    for _ in range(iters):
        e = [0.25 * e[max(i - 1, 0)] + 0.5 * e[i] + 0.25 * e[min(i + 1, BINS - 1)]
             for i in range(BINS)]
    mean = max(sum(e) / BINS, 1.0)
    total = 0.0
    for i in range(BINS):
        total += density_at(bin_to_clip(i), e[i] / mean, k)
    total = max(total, 1e-5)
    step_u = 2.0 / BINS
    min_step = SLOPE_MIN * step_u
    max_step = SLOPE_MAX * step_u
    cum = 0.0
    prev = -1.0
    pos = []
    for i in range(BINS):
        u = bin_to_clip(i)
        cum += density_at(u, e[i] / mean, k)
        p = max(prev + min_step, min(prev + max_step, 2.0 * (cum / total) - 1.0))
        if old_pos is not None and temporal_speed is not None:
            p = old_pos[i] * (1.0 - temporal_speed) + p * temporal_speed
            p = max(prev + min_step, min(prev + max_step, p))
        pos.append(p)
        prev = p
    kx = 2.0 / max(pos[-1] - pos[0], 1e-5)
    o = pos[0]
    pos = [(p - o) * kx - 1.0 for p in pos]

    # ---- 诊断 ----
    slots = [p * (BINS - 1) / 2.0 + (BINS - 1) / 2.0 for p in pos]  # [0,255]
    d = [slots[i + 1] - slots[i] for i in range(BINS - 1)]
    flat = sum(1 for x in d if x < 1e-6)                  # 完全塌缩的段
    sub_half = sum(1 for x in d if x < 0.5)               # 一个表项跨不到半格
    worst = max(d) if d else 0.0
    print("%-28s k=%.2f  total=%9.3f  kx=%6.3f  flatRuns=%3d  <0.5slot=%3d  maxJump=%6.2f  "
          "minStep=%6.2f  maxStep=%6.2f" %
          (name, k, total, kx, flat, sub_half, worst, min(d), max(d)))
    return pos, slots


def sint_profile_axis():
    """合成 x 轴重要性：屏幕采样数按阴影空间均匀 + 距离权重 + 朝向权重。
    近似：中间密（近处地形）、两端稀。"""
    edge = []
    for i in range(BINS):
        u = bin_to_clip(i)
        # 距中心越远 -> 越远 -> distWeight 越小；再加地形朝向
        d = 8.0 + 60.0 * abs(u) ** 1.5
        dist_w = 1.0 / (d ** 1.3 * 0.1 + 1.0)
        facing = 1.0 + 2.0 * 0.5
        density_of_screen = 1.0 - 0.6 * abs(u) ** 2
        edge.append(max(density_of_screen, 0.02) * dist_w * facing * 1000.0)
    return edge


def uniform_profile():
    return [1000.0] * BINS


def noisy_profile(seed=12345):
    """均匀底 + 乘性噪声（模拟逐 bin 采样噪声）"""
    st = seed
    out = []
    for i in range(BINS):
        st = (1103515245 * st + 12345) % (1 << 31)
        n = 1.0 + 0.5 * ((st / (1 << 31)) - 0.5) * 2.0
        out.append(1000.0 * n)
    return out


print("== 无平滑、无时域 ==")
for prof, nm in ((uniform_profile(), "uniform"), (sint_profile_axis(), "synthetic"),
                 (noisy_profile(), "noisy")):
    for k in (0.0, 0.25, 1.0, 4.0):
        build(prof, k, nm)

print()
print("== 64 轮平滑、无时域 ==")
for prof, nm in ((sint_profile_axis(), "synthetic"), (noisy_profile(), "noisy")):
    for k in (0.25, 1.0, 4.0):
        build(prof, k, nm, iters=64)

print()
print("== 64 轮平滑 + 时域 0.2（20 帧） ==")
for prof, nm in ((sint_profile_axis(), "synthetic"),):
    for k in (0.25, 1.0, 4.0):
        pos = None
        for f in range(20):
            pos, _ = build(prof, k, nm + " f%d" % (f + 1), temporal_speed=0.2, old_pos=pos, iters=64)

print()
print("== k 很小时的密度动态范围 ==")
for k in (0.0, 0.01, 0.25, 1.0):
    lo = min(density_at(bin_to_clip(i), 0.25, k) for i in range(BINS))
    hi = max(density_at(bin_to_clip(i), 4.0, k) for i in range(BINS))
    lo2 = min(density_at(bin_to_clip(i), 0.0, k) for i in range(BINS))
    hi2 = max(density_at(bin_to_clip(i), 1e6, k) for i in range(BINS))
    print("  k=%.2f  rel∈[0.25,4] -> density∈[%.4f,%.4f] (%.2f:1)   rel∈[0,inf) -> [%.4f,%.4f] (%.2f:1)"
          % (k, lo, hi, hi / lo, lo2, hi2, hi2 / max(lo2, 1e-9)))
