"""Frame skeleton in submission order: units >= threshold only."""
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\46941\Desktop\11.txt"
thr = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
row = re.compile(r"^\s*(\d+)\s*\|\s*(?P<tree>.*?)\s*\|\s*(?P<act>[0-9\-]+)\s*\|\s*(?P<dur>[\d.]+)\s*$")

groups, leaves = [], []
for line in lines:
    m = row.match(line)
    if not m:
        continue
    name = re.sub(r"^[-\\|\s]+", "", m.group("tree")).strip()
    act, dur = m.group("act"), float(m.group("dur"))
    if "-" in act:
        a, b = (int(x) for x in act.split("-"))
        groups.append((a, b, name, dur))
    elif act.isdigit():
        leaves.append((int(act), name, dur))

def in_multidraw(a):
    for ga, gb, n, d in groups:
        if ga <= a <= gb and gb > ga and "MultiDraw" in n:
            return True
    return False

units = [(a, b, n, d, "grp") for a, b, n, d in groups if "MultiDraw" in n]
units += [(a, a, n, d, "leaf") for a, n, d in leaves if not in_multidraw(a)]
units.sort(key=lambda x: x[0])

run = 0.0
print(f"{'act':>11}  {'ms':>8}  {'cum_ms':>8}  unit")
for a, b, n, d, kind in units:
    if d / 1000.0 < thr:
        run += d / 1000.0
        continue
    if run > 0:
        print(f"{'':>11}  {'':>8}  {run:8.3f}  ...(sum of {run:.3f} ms of small units skipped)")
        run = 0.0
    rng = f"{a}-{b}" if kind == "grp" else str(a)
    print(f"{rng:>11}  {d/1000:8.3f}  {'':>8}  {n[:64]}")
print(f"\ntotal of listed+skipped = {(sum(x[3] for x in units))/1000:.3f} ms")
