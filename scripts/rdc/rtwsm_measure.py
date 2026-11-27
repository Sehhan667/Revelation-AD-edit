# -*- coding: utf-8 -*-
"""按 Revelation 包 DeferredLight.frag:313-328 的确切式子，对一个真实场景
（平坦地面 + 正交阴影 frustum + 45 度太阳）逐个屏幕像素算 importance，
再按 shadow clip 位置分 256 个 bin，看 rel = bin计数 / 均值 到底有没有结构。

目的：解释"条纹消失了，但调高 k 和 k=0 没区别"。
"""
import math

BINS = 256
SHADOW_DIST = 64.0          # shadowDistance
SUN_ELEV = 45.0             # 太阳高度角（常见）
SCREEN_W, SCREEN_H = 1920, 1080
EYE_H = 1.62
FOV = 70.0
DIST_FACTOR = 1.3           # RTWSM_DIST_FACTOR
FACING_FACTOR = 2.0         # RTWSM_FACING_FACTOR


def importance_of(view_dist, ndotv):
    dw = 1.0 / (max(view_dist, 1.0) ** DIST_FACTOR * 0.1 + 1.0)
    return dw * (1.0 + FACING_FACTOR * max(0.0, min(1.0, ndotv)))


def bin_of(u):
    """DeferredLight: binF = clamp(u*0.5+0.5,0,1)*256 ; ivec2(binF) 截断"""
    t = min(max(u * 0.5 + 0.5, 0.0), 1.0) * BINS
    return min(int(t), BINS - 1)


def run(sun_azimuth_deg, label):
    """相机水平看 +x；阴影 frustum 是正交盒，宽度 = 2*shadowDistance，绕 y 轴按太阳方位旋转。
    地面 y=0，相机 y=EYE_H。屏幕像素 → 地面交点 → shadow clip x/y → bin。"""
    elev = math.radians(SUN_ELEV)
    # 太阳方向（光行进方向）水平分量受方位角影响；阴影空间的横轴与太阳方位垂直
    az = math.radians(sun_azimuth_deg)
    # 阴影空间基：light_forward = 太阳方向；right = 与它垂直的水平向量
    fwd = (math.cos(elev) * math.cos(az), -math.sin(elev), math.cos(elev) * math.sin(az))
    rightv = (-math.sin(az), 0.0, math.cos(az))          # 水平、垂直于 fwd
    upv = (fwd[1] * rightv[2] - fwd[2] * rightv[1],
           fwd[2] * rightv[0] - fwd[0] * rightv[2],
           fwd[0] * rightv[1] - fwd[1] * rightv[0])

    histX = [0.0] * BINS
    histY = [0.0] * BINS
    cntX = [0] * BINS
    cntY = [0] * BINS
    tan_half = math.tan(math.radians(FOV * 0.5))

    for py in range(0, SCREEN_H, 2):
        # NDC y: 上为正
        ndc_y = 1.0 - 2.0 * (py + 0.5) / SCREEN_H
        for px in range(0, SCREEN_W, 2):
            ndc_x = 2.0 * (px + 0.5) / SCREEN_W - 1.0
            # 相机朝 +x，水平看
            dirx = 1.0
            diry = ndc_y * tan_half
            dirz = ndc_x * tan_half * (SCREEN_W / SCREEN_H)
            # 地面交点（y = -EYE_H 相对相机）
            if diry >= -1e-6:
                continue                       # 打到天空
            t = -EYE_H / diry
            wx, wy, wz = dirx * t, 0.0, dirz * t
            if t <= 0 or t > 400:
                continue
            view_dist = math.sqrt(t * t + EYE_H * EYE_H)
            # 地面法线 (0,1,0)，-V = -normalize(dir)
            ln = math.sqrt(dirx * dirx + diry * diry + dirz * dirz)
            ndotv = -diry / ln                # dot(N, -V) = -dir.y/|dir|
            imp = importance_of(view_dist, ndotv)

            # 相对相机的世界坐标 → 阴影空间
            sx = wx * rightv[0] + wy * rightv[1] + wz * rightv[2]
            sy = wx * upv[0] + wy * upv[1] + wz * upv[2]
            # 正交投影：宽度 2*shadowDistance → clip = s/shadowDistance
            cx = sx / SHADOW_DIST
            cy = sy / SHADOW_DIST
            if abs(cx) < 1.0:
                b = bin_of(cx)
                histX[b] += imp
                cntX[b] += 1
            if abs(cy) < 1.0:
                b = bin_of(cy)
                histY[b] += imp
                cntY[b] += 1

    def stats(hist, cnt, name):
        nz = [h for h in hist]
        tot = sum(nz)
        mean = tot / BINS
        if mean <= 0:
            print("  %s: 全零！" % name)
            return None
        rel = [h / mean for h in nz]
        relnz = [r for i, r in enumerate(rel) if cnt[i] > 0]
        # 只用有采样的 bin 统计（Clamp 后如何？）
        below = sum(1 for r in rel if r < 0.25)
        above = sum(1 for r in rel if r > 4.0)
        print("  %-4s 有效bin=%3d  原始rel范围=%.4f..%.2f  中位=%.3f  落在<0.25的bin=%d  >4的bin=%d"
              % (name, len(relnz), min(relnz), max(relnz),
                 sorted(relnz)[len(relnz) // 2], below, above))
        # 逐32bin 平均（看低频谱形状）
        prof = []
        for b in range(0, BINS, 32):
            chunk = [rel[i] for i in range(b, b + 32) if cnt[i] > 0]
            prof.append("%.2f" % (sum(chunk) / len(chunk)) if chunk else " -- ")
        print("        逐32bin平均 rel:", " ".join(prof))
        # 关键：clamp 之后还剩多少结构？
        relc = [max(0.25, min(4.0, r)) for r in rel]
        profc = []
        for b in range(0, BINS, 32):
            chunk = [relc[i] for i in range(b, b + 32) if cnt[i] > 0]
            profc.append("%.2f" % (sum(chunk) / len(chunk)) if chunk else " -- ")
        print("        clamp后逐32bin:  ", " ".join(profc))
        return rel

    print("\n=== %s（太阳方位 %d°）===" % (label, sun_azimuth_deg))
    stats(histX, cntX, "x轴")
    stats(histY, cntY, "y轴")


# 相机朝 +x：太阳方位 0° = 太阳在相机前方 ⇒ 阴影 x 轴 ≈ 屏幕水平方向（最有利的情形）
run(0.0, "阴影横轴对齐屏幕横轴")
run(90.0, "太阳在相机左侧/右侧")
run(45.0, "45 度")
