"""Print the frame in submission (action) order: draw groups + non-multidraw leaves, so the
post-processing chain can be aligned with Iris pass order."""
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\46941\Desktop\11.txt"
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
row = re.compile(r"^\s*(\d+)\s*\|\s*(?P<tree>.*?)\s*\|\s*(?P<act>[0-9\-]+)\s*\|\s*(?P<dur>[\d.]+)\s*$")

items = []
for line in lines:
    m = row.match(line)
    if not m:
        continue
    name = re.sub(r"^[-\\|\s]+", "", m.group("tree")).strip()
    act, dur = m.group("act"), float(m.group("dur"))
    if "-" in act:
        a, b = (int(x) for x in act.split("-"))
        items.append((a, b, name, dur, True))
    elif act.isdigit():
        a = int(act)
        items.append((a, a, name, dur, False))

# 只看「不嵌套在任何 multi-draw 组里」的事件 + 所有 multi-draw 组
groups = [(a, b) for a, b, n, d, isg in items if isg]
def inside_multidraw(a):
    for ga, gb in groups:
        if ga <= a <= gb and (gb - ga) > 0:
            try:
                nm = next(n for x, y, n, d, g in items if g and x == ga and y == gb)
            except StopIteration:
                continue
            if "MultiDraw" in nm:
                return True
    return False

seq = []
for a, b, n, d, isg in items:
    if isg:
        if "MultiDraw" in n:
            seq.append((a, b, f"[multidraw group: {n}]", d, "group"))
        continue
    if inside_multidraw(a):
        continue
    seq.append((a, b, n, d, "leaf"))

seq.sort(key=lambda x: x[0])
print(f"{'act':>7}  {'ms':>8}  event")
for a, b, n, d, kind in seq:
    rng = f"{a}-{b}" if kind == "group" else str(a)
    print(f"{rng:>7}  {d/1000:8.3f}  {n[:76]}")
