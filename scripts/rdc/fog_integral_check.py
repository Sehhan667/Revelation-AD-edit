"""Verify the analytic fog integrator in AtmosphericFog.glsl against a fine numerical reference.

Pure-python (no numpy): float32 rounding is emulated with struct so the GLSL arithmetic is
reproduced faithfully.
Compares:
  * new  : exact split + closed form (IntegrateFogDensityAlongRay)
  * old  : the previous VF_FOG_PANELS=8 trapezoid (jitter = 0), i.e. what the pack did before
against a 200k-sample float64 reference. Section B is the "ring" test: move the ray geometry
continuously and look for deterministic jumps in the integrated result.
"""
import struct
from math import fabs, exp2, inf

F0, F1 = -0.03125, -0.08333          # FOG_HEIGHT_FALLOFF
VF_HEIGHT = 71.0                     # their live VF_HEIGHT
RAMP_BOT = 1100.0                    # cumulusBottomAltitude = CLOUD_CU_ALTITUDE
RAMP_TOP = 2600.0                    # cumulusTopAltitude = bottom + thickness
LN2 = 0.6931471805599453
PANELS = 8
SAMPLES = 200001


def f32(x):
    try:
        return struct.unpack('f', struct.pack('f', x))[0]
    except (OverflowError, struct.error):
        return inf if x > 0 else -inf


def env_ref(y):
    h = abs(y - VF_HEIGHT) * (0.5 if y <= VF_HEIGHT else 1.0)
    return (exp2(h * F0), exp2(h * F1))


def ramp_ref(y):
    r = (y - RAMP_TOP) / (RAMP_BOT - RAMP_TOP)
    return 0.0 if r < 0.0 else (1.0 if r > 1.0 else r)


def clamp(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)


def reference(y0, m, L, uniform_fog, n=SAMPLES):
    se0 = se1 = su = 0.0
    step = L / (n - 1)
    for i in range(n):
        y = y0 + m * (i * step)
        e = env_ref(y)
        se0 += e[0]
        se1 += e[1]
        su += ramp_ref(y)
    return (se0 / n, se1 / n), su / n * uniform_fog


def new_integrator(y0, m, L, uniform_fog):
    y0, m, L, uniform_fog = f32(y0), f32(m), f32(L), f32(uniform_fog)
    slanted = fabs(m) > 1e-6
    invM = f32(1.0 / m) if slanted else 0.0
    invLen = f32(1.0 / L)
    # ---- shell envelope, split exactly at the y = VF_HEIGHT kink ----
    tKink = f32(clamp((VF_HEIGHT - y0) * invM, 0.0, L)) if slanted else 0.0
    acc0 = acc1 = 0.0
    for a, b in ((0.0, tKink), (tKink, L)):
        if b <= a:
            continue
        rel = f32(y0 + m * f32(0.5) * (a + b)) - VF_HEIGHT
        scale = 1.0 if rel > 0 else 0.5
        sgn = 1.0 if rel > 0 else -1.0
        c0 = f32(F0 * f32(sgn * scale * (y0 - VF_HEIGHT)))
        c1 = f32(F1 * f32(sgn * scale * (y0 - VF_HEIGHT)))
        s0 = f32(F0 * f32(sgn * scale * m))
        s1 = f32(F1 * f32(sgn * scale * m))
        e1_0 = f32(exp2(f32(c0 + s0 * a)))
        e2_0 = f32(exp2(f32(c0 + s0 * b)))
        e1_1 = f32(exp2(f32(c1 + s1 * a)))
        e2_1 = f32(exp2(f32(c1 + s1 * b)))
        d0 = f32(s0 * LN2)
        d1 = f32(s1 * LN2)
        h0 = f32(s0 * f32((b - a) * LN2))
        h1 = f32(s1 * f32((b - a) * LN2))
        lin0 = f32(e1_0 * f32((b - a) * f32(1.0 + h0 * f32(0.5 + h0 * f32(1.0 / 6.0)))))
        lin1 = f32(e1_1 * f32((b - a) * f32(1.0 + h1 * f32(0.5 + h1 * f32(1.0 / 6.0)))))
        acc0 = f32(acc0 + (f32((e2_0 - e1_0) / d0) if fabs(h0) > 1e-3 else lin0))
        acc1 = f32(acc1 + (f32((e2_1 - e1_1) / d1) if fabs(h1) > 1e-3 else lin1))
    # ---- uniform term, split at both linearstep kinks ----
    tTop = f32(clamp((RAMP_TOP - y0) * invM, 0.0, L)) if slanted else 0.0
    tBot = f32(clamp((RAMP_BOT - y0) * invM, 0.0, L)) if slanted else 0.0
    lo, hi = min(tTop, tBot), max(tTop, tBot)
    uniAcc = 0.0
    for a, b in ((0.0, lo), (lo, hi), (hi, L)):
        if b <= a:
            continue
        rA = f32(clamp((RAMP_TOP - f32(y0 + m * a)) / (RAMP_TOP - RAMP_BOT), 0.0, 1.0))
        rB = f32(clamp((RAMP_TOP - f32(y0 + m * b)) / (RAMP_TOP - RAMP_BOT), 0.0, 1.0))
        uniAcc = f32(uniAcc + f32(f32(0.5 * (rA + rB)) * (b - a)))
    return (f32(acc0 * invLen), f32(acc1 * invLen)), f32(uniform_fog * f32(uniAcc * invLen))


def old_trapezoid(y0, m, L, uniform_fog, panels=PANELS):
    y0, m, L = f32(y0), f32(m), f32(L)
    e0 = e1 = u = 0.0
    for i in range(panels + 1):
        t = f32(i) / f32(panels)
        y = f32(y0 + m * f32(L * t))
        w = 0.5 if (i == 0 or i == panels) else 1.0
        h = f32(abs(y - VF_HEIGHT) * (0.5 if y <= VF_HEIGHT else 1.0))
        e0 = f32(e0 + f32(exp2(f32(h * F0)) * w))
        e1 = f32(e1 + f32(exp2(f32(h * F1)) * w))
        u = f32(u + f32(clamp((y - RAMP_TOP) / (RAMP_BOT - RAMP_TOP), 0.0, 1.0) * w))
    return (f32(e0 / f32(panels)), f32(e1 / f32(panels))), f32(f32(uniform_fog) * f32(u / f32(panels)))


def rel_err(a, b):
    return fabs(a - b) / max(fabs(b), 1e-12)


# deterministic pseudo-random generator (no numpy)
class Rng:
    def __init__(self, seed):
        self.s = seed

    def next(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF

    def uni(self, a, b):
        return a + (b - a) * self.next()


print("=== A. 300 random rays vs 200k-sample float64 reference (y channel = strongest fog) ===")
rng = Rng(7)
worst_new = worst_old = 0.0
for _ in range(300):
    y0 = rng.uni(-64.0, 400.0)
    m = rng.uni(-1.0, 1.0)
    L = rng.uni(8.0, 256.0)
    ref, _ = reference(y0, m, L, 8.0)
    envN, _ = new_integrator(y0, m, L, 8.0)
    envO, _ = old_trapezoid(y0, m, L, 8.0)
    worst_new = max(worst_new, rel_err(envN[1], ref[1]))
    worst_old = max(worst_old, rel_err(envO[1], ref[1]))
print(f"  max rel err   new = {worst_new:.3e}   old(8-panel trapezoid) = {worst_old:.3e}")

print("\n=== B. ring sweep: y0=70, L=40, pitch m swept 0.02 .. 0.4 (40001 steps) ===")
prevN = prevO = None
jumpN = jumpO = 0.0
steps = 40001
for i in range(steps):
    m = 0.02 + (0.4 - 0.02) * i / (steps - 1)
    envN, _ = new_integrator(70.0, m, 40.0, 8.0)
    envO, _ = old_trapezoid(70.0, m, 40.0, 8.0)
    if prevN is not None:
        jumpN = max(jumpN, fabs(envN[1] - prevN))
        jumpO = max(jumpO, fabs(envO[1] - prevO))
    prevN, prevO = envN[1], envO[1]
print(f"  max consecutive-pitch jump   new = {jumpN:.3e}   old = {jumpO:.3e}")

print("\n=== C. horizontal-ray cancellation regime (y0=-100, m=5e-5, L=100) ===")
ref, _ = reference(-100.0, 5e-5, 100.0, 8.0)
envN, _ = new_integrator(-100.0, 5e-5, 100.0, 8.0)
envO, _ = old_trapezoid(-100.0, 5e-5, 100.0, 8.0)
print(f"  reference = {ref}")
print(f"  new       = {envN}   rel err {rel_err(envN[1], ref[1]):.3e}")
print(f"  old       = {envO}   rel err {rel_err(envO[1], ref[1]):.3e}")

print("\n=== D. uniform-fog term: ray crossing both ramp kinks (y0=500, m=1.0, L=2500) ===")
_, refu = reference(500.0, 1.0, 2500.0, 8.0, n=20001)
_, uniN = new_integrator(500.0, 1.0, 2500.0, 8.0)
_, uniO = old_trapezoid(500.0, 1.0, 2500.0, 8.0)
print(f"  uniform ref={refu:.6f}  new={uniN:.6f} (err {rel_err(uniN, refu):.3e})  old={uniO:.6f} (err {rel_err(uniO, refu):.3e})")

print("\n=== E. ray entirely above the shell / below it / below going down ===")
for (y0, m, L, tag) in [(200.0, 0.1, 64.0, "above"), (-60.0, 0.05, 30.0, "below-up"), (-60.0, -0.02, 30.0, "below-down")]:
    ref, _ = reference(y0, m, L, 8.0)
    envN, _ = new_integrator(y0, m, L, 8.0)
    envO, _ = old_trapezoid(y0, m, L, 8.0)
    print(f"  {tag:10s} ref={ref}  new={envN} (err {rel_err(envN[1], ref[1]):.2e})  old={envO} (err {rel_err(envO[1], ref[1]):.2e})")
