#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RTWSM 第一阶段(骨架)验证: 表驱动可分离 warp vs 现有解析径向 warp

模拟链(与 shader 一一对应):
  lib/lighting/shadow/Common.glsl  CalcAnalyticDistortionFactor -> 解析径向曲线
  lib/lighting/shadow/Warp.glsl    SampleShadowWarpTable         -> 双线性(纹素中心映射)
                                   ApplyShadowWarpTable          -> vec2(wx.x, wy.x) + max(wx.y, wy.y)
  program/setup/ShadowWarp.comp    WarpAxisCurve/WarpAxis        -> 表内容(256 项, float16 存储)

输出:
  1) 两条坐标轴上是否逐点一致(骨架阶段的核心承诺)
  2) 差异随半径/角度怎么分布, 离轴最大值在哪
  3) 局部缩放(bias / PCF 半径用的那个量)与解析式的比值
  4) 角点差异的"固有下限"(可分离 warp 无法复现径向 warp 的角点压缩)

用法: python rdc_analysis/rtwsm_phase1_check.py [SHADOW_DISTORTION_STRENGTH] [shadowMapResolution]
"""

import math
import struct
import sys

TABLE_SIZE = 256          # SHADOW_WARP_TABLE_SIZE
SHADOW_MAP = 1024         # shadowMapResolution
STRENGTH = 3.0            # SHADOW_DISTORTION_STRENGTH


def f16(x):
    """按 RGBA16F 存储量化(表声明为 HALF_FLOAT)"""
    try:
        return struct.unpack('e', struct.pack('e', x))[0]
    except (OverflowError, struct.error):
        return math.copysign(float('inf'), x)


# ------------------------------------------------------- 解析径向(shader 现状)
def legacy_factor(px, py, s=STRENGTH):
    d2 = px * px + py * py
    if d2 < 1e-12:
        return (math.exp(s) - 1.0) / s      # 中心处的解析极限(原式在那里是 0*inf=NaN)
    inv_clip_len = 1.0 / math.sqrt(d2)
    curve = math.log((math.exp(s) - 1.0) / inv_clip_len + 1.0)
    return curve * inv_clip_len * (1.0 / s)


def legacy_warp(px, py, s=STRENGTH):
    f = legacy_factor(px, py, s)
    return px * f, py * f


# ------------------------------------------------------- 表(骨架阶段内容)
def axis_curve(u, s=STRENGTH):
    r = max(abs(u), 1e-5)
    inv_clip_len = 1.0 / r
    curve = math.log((math.exp(s) - 1.0) / inv_clip_len + 1.0)
    return curve * inv_clip_len * (1.0 / s)


def axis_warp(u, s=STRENGTH):
    return max(-1.0, min(1.0, u * axis_curve(u, s)))


def build_table(s=STRENGTH):
    last = float(TABLE_SIZE - 1)
    h = (2.0 / last) * 0.5
    out = []
    for i in range(TABLE_SIZE):
        u = (i / last) * 2.0 - 1.0
        out.append((f16(axis_warp(u, s)),
                    f16(max((axis_warp(u + h, s) - axis_warp(u - h, s)) / (2.0 * h), 0.0))))
    return out


def sample_table(table, u):
    t = max(0.0, min(1.0, u * 0.5 + 0.5))
    x = t * (TABLE_SIZE - 1.0) + 0.5
    x0 = math.floor(x - 0.5)
    frac = (x - 0.5) - x0
    i0 = max(0, min(TABLE_SIZE - 1, int(x0)))
    i1 = max(0, min(TABLE_SIZE - 1, int(x0) + 1))
    w0, s0 = table[i0]
    w1, s1 = table[i1]
    return w0 + (w1 - w0) * frac, s0 + (s1 - s0) * frac


def table_warp(table, px, py):
    wx, sx = sample_table(table, px)
    wy, sy = sample_table(table, py)
    return wx, wy, max(sx, sy), sx, sy


def analytic_jacobian(px, py, s=STRENGTH):
    """
    解析径向 warp W(p)=p*f(|p|) 的局部雅可比特征值:
      沿射线方向  f + r*f'   /  垂直方向  f
    返回 (max 特征值, 几何平均 sqrt(f*(f+r*f')))
    表里存的是 dW/du(雅可比), 而 calc 出来的 factor 是 W/u(比值) —— 两者不是同一个量,
    所以缩放要对齐到雅可比再比。
    """
    r = math.hypot(px, py)
    if r < 1e-6:
        f = legacy_factor(1e-6, 0.0, s)
        return f, f
    f = legacy_factor(px, py, s)
    e = 1e-4
    fp = (legacy_factor(px + px / r * e, py + py / r * e, s) - legacy_factor(px - px / r * e, py - py / r * e, s)) / (2 * e)
    along = f + r * fp
    return max(f, along), math.sqrt(max(f * along, 0.0))


def pct(vals, q):
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(q * (len(vals) - 1)))]


def main():
    global STRENGTH, SHADOW_MAP
    if len(sys.argv) > 1:
        STRENGTH = float(sys.argv[1])
    if len(sys.argv) > 2:
        SHADOW_MAP = int(sys.argv[2])
    tpc = SHADOW_MAP / 2.0        # 1 clip 单位 = 多少纹素
    table = build_table()
    print(f"S={STRENGTH}  表 {TABLE_SIZE} 项(float16)  阴影图 {SHADOW_MAP}  1 clip 单位 = {tpc:.0f} 纹素")

    # ---- 0. 表内局部缩放 vs 真实斜率(自检)
    last = float(TABLE_SIZE - 1)
    h = 1.0 / last
    err = max(abs(table[i][1] - max((axis_warp((i / last) * 2 - 1 + h) - axis_warp((i / last) * 2 - 1 - h)) / (2 * h), 0.0))
              for i in range(TABLE_SIZE))
    print(f"[自检] 表内存储的局部缩放 vs 真实中心差分斜率: 最大偏差 {err:.3e}")

    # ---- 1. 轴上一致性: 位移 + 局部缩放(对齐雅可比)
    for name, fn in (("x 轴(y=0)", lambda v: (v, 0.0)), ("y 轴(x=0)", lambda v: (0.0, v))):
        worst = 0.0
        r_max, r_geo = [], []
        for k in range(-1024, 1025):
            v = k / 1024.0
            px, py = fn(v)
            lx, ly = legacy_warp(px, py)
            tx, ty, ts_max, sx, sy = table_warp(table, px, py)
            worst = max(worst, math.hypot(tx - lx, ty - ly))
            if abs(v) > 0.02:
                a_max, a_geo = analytic_jacobian(px, py)
                if a_max > 1e-3:
                    r_max.append(ts_max / a_max)
                if a_geo > 1e-3:
                    r_geo.append(math.sqrt(sx * sy) / a_geo)
        print(f"[{name}] 最大 |Δ| = {worst:.3e} clip = {worst * tpc:.3f} 纹素")
        print(f"        缩放比 max 型 表/解析 = {min(r_max):.4f} ~ {max(r_max):.4f}; "
              f"几何平均型 = {min(r_geo):.4f} ~ {max(r_geo):.4f}")

    # ---- 2. 差异随角度(半径 0.5 / 0.9)
    print("[角度扫描] 半径 0.50 / 0.90, 角度 0°~45°(对称)")
    for r in (0.5, 0.9):
        row = []
        for deg in (0, 5, 10, 15, 20, 30, 45):
            a = math.radians(deg)
            px, py = r * math.cos(a), r * math.sin(a)
            lx, ly = legacy_warp(px, py)
            tx, ty, _, _, _ = table_warp(table, px, py)
            row.append(f"{deg}°:{math.hypot(tx - lx, ty - ly) * tpc:6.1f}")
        print(f"  r={r:.2f} 纹素位移差  " + "  ".join(row))

    # ---- 3. 全域统计
    n = 200
    errs, r_max, r_geo = [], [], []
    for i in range(n + 1):
        px = -1.0 + 2.0 * i / n
        for j in range(n + 1):
            py = -1.0 + 2.0 * j / n
            lx, ly = legacy_warp(px, py)
            tx, ty, ts_max, sx, sy = table_warp(table, px, py)
            errs.append(math.hypot(tx - lx, ty - ly))
            if max(abs(px), abs(py)) > 0.02:
                a_max, a_geo = analytic_jacobian(px, py)
                if a_max > 1e-3:
                    r_max.append(ts_max / a_max)
                if a_geo > 1e-3:
                    r_geo.append(math.sqrt(sx * sy) / a_geo)
    print(f"[全域] 位移差 均值 {sum(errs) / len(errs) * tpc:6.1f}  中位 {pct(errs, 0.5) * tpc:6.1f}  "
          f"P95 {pct(errs, 0.95) * tpc:6.1f}  最大 {max(errs) * tpc:7.1f} 纹素")
    for tag, arr in (("max 型", r_max), ("几何平均型", r_geo)):
        print(f"[全域] 缩放比 {tag} 表/解析: min {min(arr):.4f}  P05 {pct(arr, 0.05):.4f}  "
              f"中位 {pct(arr, 0.5):.4f}  P95 {pct(arr, 0.95):.4f}  max {max(arr):.4f}")

    print("[关键点]  (解析 -> 表) 单位 clip; 缩放比对齐到雅可比")
    for px, py in ((0.0, 0.0), (0.5, 0.0), (1.0, 0.0), (0.5, 0.5), (0.7071, 0.7071),
                   (1.0, 0.5), (1.0, 1.0)):
        lx, ly = legacy_warp(px, py)
        tx, ty, ts_max, sx, sy = table_warp(table, px, py)
        a_max, a_geo = analytic_jacobian(px, py)
        print(f"  ({px:+.3f},{py:+.3f})  解析({lx:+.4f},{ly:+.4f})  表({tx:+.4f},{ty:+.4f})  "
              f"|Δ|={math.hypot(tx - lx, ty - ly) * tpc:6.1f} 纹素  "
              f"缩放比 max {ts_max / a_max:5.3f} / geo {math.sqrt(sx * sy) / a_geo:5.3f}")

    # ---- 4. 角点固有下限
    f_corner = legacy_factor(1.0, 1.0)
    print(f"[固有下限] 角点(1,1): 解析径向压到 ({f_corner:.4f},{f_corner:.4f}) "
          f"= 位移 {math.hypot(1 - f_corner, 1 - f_corner) * tpc:.0f} 纹素; "
          f"可分离 warp 必须落在 (1,1) ⇒ 这部分差异不可消除")
    print()
    print("判据: 轴上 |Δ| ≈ float16 量化(<0.5 纹素) ⇒ 表在轴上是解析曲线的忠实复刻;")
    print("      离轴/角点差异是该近似的固有性质(不是 bug);")
    print("      缩放比决定 z 偏置与 PCF 半径的偏差幅度, 越接近 1 越好。")


if __name__ == '__main__':
    main()
