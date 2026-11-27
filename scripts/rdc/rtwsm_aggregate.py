# -*- coding: utf-8 -*-
"""对比两种"逐 bin 重要性聚合"方式（同一场景、同一个重要性公式）：

  sum（本包现状 DeferredLight.frag:325-326 imageAtomicAdd）
      bin 值 = 落在该 bin 的所有屏幕像素的 importance 之和
      → 正比于"采样数 × 平均权重"，统计噪声大、动态范围 ~1e5
  max（itrp BackwardAnalysis:83 / Alpha Piscium shadow.vsh:1370 imageAtomicMax）
      bin 值 = 该 bin（= 阴影空间里一条切片）上 importance 的最大值
      → 描述"这条切片最需要分辨率的地方有多需要"，与采样密度无关

然后把 bin 值归一化成 rel，检查 clamp(rel,0.25,4) 之后还剩多少结构。
"""
import math

BINS = 256
SHADOW_DIST = 64.0
EYE_H = 1.62
DIST_FACTOR = 1.3
FACING_FACTOR = 2.0


def importance(view_dist, ndotv):
    dw = 1.0 / (max(view_dist, 1.0) ** DIST_FACTOR * 0.1 + 1.0)
    return dw * (1.0 + FACING_FACTOR * max(0.0, min(1.0, ndotv)))


def bin_of(u):
    t = min(max(u * 0.5 + 0.5, 0.0), 1.0) * BINS
    return min(int(t), BINS - 1)


def ground_profile(sun_elev_deg=45.0):
    """相机高 EYE_H 看无尽地面（法线朝上），太阳高度角 sun_elev。
    对每个阴影空间 bin（沿 x 的切片，等价于"沿太阳方向距离原点 d 的垂直面"族），
    取该切片上所有可见地面点的 importance 最大值与总和。

    几何：阴影 up 轴 ≈ 世界上方，右轴水平。地面点 P=(px,0,pz) 相对相机。
    shadow clip x = P·right / SHADOW_DIST。切片 = { P : P·right = c }，即可见地面上的一条斜线。
    """
    elev = math.radians(sun_elev_deg)
    # 阴影空间：up ≈ 世界 y 轴（正交阴影图对地形取景，up 基本上就是世界 up）
    #            right = 水平方向，与太阳方位垂直；这里取 right = 世界 x 轴（太阳在 +z 侧）
    sun_dir = (0.0, -math.sin(elev), math.cos(elev))     # 光行进方向
    rightv = (1.0, 0.0, 0.0)
    upv = (0.0, math.cos(elev), math.sin(elev))          # 与 right、sun_dir 正交

    hist_sum = [0.0] * BINS
    hist_max = [0.0] * BINS
    hist_cnt = [0] * BINS

    # 相机在原点，朝 +z 方向看；地面从相机前方铺开
    step = 0.25
    z = 1.0
    while z < 400.0:
        x = -200.0
        while x < 200.0:
            P = (x, -EYE_H, z)                            # 相对相机（地面 y = -EYE_H）
            c = P[0] * rightv[0] + P[1] * rightv[1] + P[2] * rightv[2]
            u = c / SHADOW_DIST
            if abs(u) < 1.0:
                dist = math.sqrt(x * x + EYE_H * EYE_H + z * z)
                # -V = -normalize(P)，N=(0,1,0)
                ln = dist
                ndotv = EYE_H / ln
                imp = importance(dist, ndotv)
                b = bin_of(u)
                hist_sum[b] += imp
                hist_cnt[b] += 1
                if imp > hist_max[b]:
                    hist_max[b] = imp
            x += step
        z += step

    return hist_sum, hist_max, hist_cnt


def report(tag, hist, cnt):
    tot = sum(hist)
    mean = tot / BINS
    if mean <= 0:
        print("  %-18s 全零" % tag)
        return
    rel = [h / mean for h in hist]
    raw_lo = min(rel[i] for i in range(BINS) if cnt[i] > 0)
    raw_hi = max(rel[i] for i in range(BINS) if cnt[i] > 0)
    relc = [max(0.25, min(4.0, r)) for r in rel]
    # clamp 后的"剩余结构" = clamp 后的动态范围 / 逐32bin 形状
    prof = []
    for b in range(0, BINS, 32):
        chunk = [relc[i] for i in range(b, b + 32) if cnt[i] > 0]
        prof.append("%.2f" % (sum(chunk) / len(chunk)) if chunk else " -- ")
    usable = len([1 for i in range(BINS) if cnt[i] > 0])
    print("  %-18s 有效bin=%3d  归一rel=%.4f..%.2f   clamp后范围=%.2f..%.2f   逐32bin(clamp后): %s"
          % (tag, usable, raw_lo, raw_hi, min(relc[i] for i in range(BINS) if cnt[i] > 0),
             max(relc[i] for i in range(BINS) if cnt[i] > 0), " ".join(prof)))


for elev in (45.0, 20.0, 70.0):
    hs, hm, hc = ground_profile(elev)
    print("\n=== 太阳高度角 %.0f° ===" % elev)
    report("sum (现状)", hs, hc)
    report("max (itrp)", hm, hc)
