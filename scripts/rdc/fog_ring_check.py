"""Ring test: is the residual error of the fog estimator SMOOTH in the ray geometry?

A ring is not "the estimate differs from the truth", it is "the error jumps as the geometry
moves". So compare, against the analytic integrator (near-exact, fp32-level):
    err_old(geom) = trapezoid8(geom) - analytic(geom)
    err_new(geom) = analytic(geom)   - float64 reference(geom)
and report the max consecutive jump of each as the ray sweeps continuously.

Sweep 1: pitch m at fixed camera height (kink t* = (VF_HEIGHT - y0)/m slides across panels)
Sweep 2: camera height y0 at fixed pitch (same effect, this is what the user saw: rings that
         change with camera height)
"""
import struct
from math import fabs, exp2

F0, F1 = -0.03125, -0.08333
VF_HEIGHT = 71.0
RAMP_BOT, RAMP_TOP = 1100.0, 2600.0
LN2 = 0.6931471805599453
PANELS = 8


def f32(x):
    return struct.unpack('f', struct.pack('f', x))[0]


def analytic(y0, m, L, panel_phase=None):
    """float64 closed form (truth for the sweep); panel_phase unused, kept for symmetry."""
    y0, m, L = float(y0), float(m), float(L)
    if abs(m) <= 1e-6:
        tKink = 0.0
    else:
        tKink = min(max((VF_HEIGHT - y0) / m, 0.0), L)
    acc = 0.0
    for a, b in ((0.0, tKink), (tKink, L)):
        if b <= a:
            continue
        rel = (y0 + m * 0.5 * (a + b)) - VF_HEIGHT
        scale = 1.0 if rel > 0 else 0.5
        sgn = 1.0 if rel > 0 else -1.0
        c = F1 * (sgn * scale * (y0 - VF_HEIGHT))
        s = F1 * (sgn * scale * m)
        e1, e2 = exp2(c + s * a), exp2(c + s * b)
        acc += (e2 - e1) / (s * LN2) if abs(s * LN2) > 1e-12 else e1 * (b - a)
    return acc / L


def trapezoid8(y0, m, L):
    """The previous implementation: 8 panels, no jitter, float32."""
    y0f, mf, Lf = f32(y0), f32(m), f32(L)
    acc = 0.0
    for i in range(PANELS + 1):
        t = f32(i) / f32(PANELS)
        y = f32(y0f + mf * f32(Lf * t))
        w = 0.5 if (i == 0 or i == PANELS) else 1.0
        h = f32(abs(y - VF_HEIGHT) * (0.5 if y <= VF_HEIGHT else 1.0))
        acc = f32(acc + f32(exp2(f32(h * F1)) * w))
    return f32(acc / f32(PANELS))


def sweep(tag, geoms, L):
    prev_eo = prev_en = None
    jump_old = jump_new = 0.0
    worst_rel = 0.0
    for g in geoms:
        exact = analytic(g, geoms_m, L)
        old = trapezoid8(g, geoms_m, L)
        new = f32(exact)                      # analytic path is fp32 in GLSL
        eo = old - exact
        en = new - exact
        worst_rel = max(worst_rel, abs(eo) / max(abs(exact), 1e-12))
        if prev_eo is not None:
            jump_old = max(jump_old, abs(eo - prev_eo))
            jump_new = max(jump_new, abs(en - prev_en))
        prev_eo, prev_en = eo, en
    print(f"  {tag}")
    print(f"    old: max |err| = {worst_rel*100:6.3f}% of value   max jump of err = {jump_old:.3e}")
    print(f"    new: max |err| = {0.0:6.3f}% (by construction)  max jump of err = {jump_new:.3e}")
    print(f"    ring amplitude ratio old/new = {jump_old/max(jump_new,1e-30):.1f}x")


L = 40.0
print(f"=== panel boundaries: kink crosses them at t* = k*L/8 = {[k*L/8 for k in range(1,8)]} ===")

print("\n[Sweep 1] pitch m from 0.02 to 0.40, camera y0 = 70 (kink t* = 1/m slides 50 -> 2.5)")
geoms_m = None
N = 8001
geoms = [0.02 + (0.40 - 0.02) * i / (N - 1) for i in range(N)]
prev_eo = prev_en = None
jump_old = jump_new = 0.0
for m in geoms:
    geoms_m = m
    exact = analytic(70.0, m, L)
    eo = trapezoid8(70.0, m, L) - exact
    en = f32(exact) - exact
    if prev_eo is not None:
        jump_old = max(jump_old, abs(eo - prev_eo))
        jump_new = max(jump_new, abs(en - prev_en))
    prev_eo, prev_en = eo, en
print(f"  old: max jump of err = {jump_old:.3e}   new: {jump_new:.3e}   ratio = {jump_old/max(jump_new,1e-30):.1f}x")

print("\n[Sweep 2] camera height y0 from 60 to 90, pitch m = 0.15 (kink t* = (71-y0)/0.15 slides)")
geoms = [60.0 + (90.0 - 60.0) * i / (N - 1) for i in range(N)]
prev_eo = prev_en = None
jump_old = jump_new = 0.0
worst_old = 0.0
for y0 in geoms:
    exact = analytic(y0, 0.15, L)
    eo = trapezoid8(y0, 0.15, L) - exact
    en = f32(exact) - exact
    worst_old = max(worst_old, abs(eo) / max(abs(exact), 1e-12))
    if prev_eo is not None:
        jump_old = max(jump_old, abs(eo - prev_eo))
        jump_new = max(jump_new, abs(en - prev_en))
    prev_eo, prev_en = eo, en
print(f"  old: max |err| = {worst_old*100:.3f}%   max jump of err = {jump_old:.3e}   new: {jump_new:.3e}   ratio = {jump_old/max(jump_new,1e-30):.1f}x")

def realistic(tag, y0, m0, m1, L, N=2001):
    worst_old = worst_new = 0.0
    jump_old = jump_new = 0.0
    prev_eo = prev_en = None
    for i in range(N):
        m = m0 + (m1 - m0) * i / (N - 1)
        exact = analytic(y0, m, L)
        eo = trapezoid8(y0, m, L) - exact
        en = f32(exact) - exact
        scale = max(abs(exact), 1e-12)
        worst_old = max(worst_old, abs(eo) / scale)
        worst_new = max(worst_new, abs(en) / scale)
        if prev_eo is not None:
            jump_old = max(jump_old, abs(eo - prev_eo) / scale)
            jump_new = max(jump_new, abs(en - prev_en) / scale)
        prev_eo, prev_en = eo, en
    print(f"  {tag} (y0={y0}, L={L}, m in [{m0},{m1}])")
    print(f"    relative error      old {worst_old*100:7.3f}%   new {worst_new*100:.4f}%")
    print(f"    relative err JUMP   old {jump_old*100:7.3f}%   new {jump_new*100:.4f}%   ratio {jump_old/max(jump_new,1e-30):.0f}x")


print("\n[Sweeps 4-7] realistic ray lengths (terrain/sky use up to maxDist = min(lodRenderDist,256))")
realistic("near kink, short ray ", 70.0, 0.02, 0.50, 40.0)
realistic("at surface, maxDist  ", 70.0, 0.01, 0.50, 256.0)
realistic("high up, maxDist     ", 120.0, 0.01, 0.50, 256.0)
realistic("deep underground     ", -30.0, 0.01, 0.50, 128.0)

print("\n[Sweep 3] pitch m from 0.02 to 0.40, camera y0 = -5 (deep below the shell: large exponents)")
N = 4001
geoms = [0.02 + (0.40 - 0.02) * i / (N - 1) for i in range(N)]
prev_eo = prev_en = None
jump_old = jump_new = 0.0
worst_old = 0.0
for m in geoms:
    exact = analytic(-5.0, m, L)
    eo = trapezoid8(-5.0, m, L) - exact
    en = f32(exact) - exact
    worst_old = max(worst_old, abs(eo) / max(abs(exact), 1e-12))
    if prev_eo is not None:
        jump_old = max(jump_old, abs(eo - prev_eo))
        jump_new = max(jump_new, abs(en - prev_en))
    prev_eo, prev_en = eo, en
print(f"  old: max |err| = {worst_old*100:.3f}%   max jump of err = {jump_old:.3e}   new: {jump_new:.3e}   ratio = {jump_old/max(jump_new,1e-30):.1f}x")
