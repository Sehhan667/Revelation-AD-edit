"""Categorise a RenderDoc text event export: geometry groups / fullscreen draws / dispatches /
copies, with the biggest multi-draw batches resolved to their sub-draw counts."""
import re, sys, collections

path = sys.argv[1]
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
row = re.compile(r"^\s*(\d+)\s*\|\s*(?P<tree>.*?)\s*\|\s*(?P<act>[0-9\-]+)\s*\|\s*(?P<dur>[\d.]+)\s*$")

items = []
for line in lines:
    m = row.match(line)
    if not m:
        continue
    name = re.sub(r"^[-\\|\s]+", "", m.group("tree")).strip()
    act, dur = m.group("act"), float(m.group("dur")) / 1000.0     # us -> ms
    if "-" in act:
        a, b = (int(x) for x in act.split("-"))
        items.append(dict(eid=int(m.group(1)), name=name, a=a, b=b, dur=dur, kind="group"))
    elif act.isdigit():
        items.append(dict(eid=int(m.group(1)), name=name, a=int(act), b=int(act), dur=dur, kind="leaf"))

groups = [i for i in items if i["kind"] == "group"]
def parent_of(x):
    best = None
    for g in groups:
        if g is x:
            continue
        if g["a"] <= x["a"] and x["b"] <= g["b"] and (g["b"] - g["a"]) > (x["b"] - x["a"]):
            if best is None or (g["b"] - g["a"]) < (best["b"] - best["a"]):
                best = g
    return best
for i in items:
    i["parent"] = parent_of(i)

tops = [i for i in items if i["parent"] is None]
total = sum(i["dur"] for i in tops)
print(f"frame total (top-level): {total:.3f} ms | {len(tops)} top units | {len(items)} events")

cats = collections.Counter()
for i in tops:
    n = i["name"]
    if "MultiDraw" in n:      cats["geometry: multi-draw batches"] += i["dur"]
    elif "Dispatch" in n:     cats["compute dispatches"] += i["dur"]
    elif "CopyImage" in n or "Blit" in n or "Copy" in n: cats["copies/blits"] += i["dur"]
    elif "Clear" in n:        cats["clears"] += i["dur"]
    elif "Draw" in n:         cats["fullscreen draws (post chain)"] += i["dur"]
    else:                     cats[n.split("(")[0][:28]] += i["dur"]

print("\n=== cost by category (top-level units) ===")
for k, v in cats.most_common():
    print(f"{v:9.3f} ms  {100*v/total:5.1f}%  {k}")

print("\n=== biggest geometry batches (top-level multi-draw groups) ===")
geo = sorted([i for i in tops if "MultiDraw" in i["name"]], key=lambda x: -x["dur"])
for g in geo[:8]:
    kids = [i for i in items if i["parent"] is g]
    first = max(kids, key=lambda k: k["dur"]) if kids else None
    m = re.search(r"\((\d+)\)", first["name"]) if first else None
    print(f"{g['dur']:9.3f} ms  actions {g['a']}-{g['b']}  calls={len(kids):<4d} "
          f"biggest_subdraws={m.group(1) if m else '-'}  ({g['name'][:40]})")

print("\n=== biggest single draws / dispatches ===")
for i in sorted(tops, key=lambda x: -x["dur"]):
    if "MultiDraw" in i["name"]:
        continue
    print(f"{i['dur']:9.3f} ms  act {i['a']:<5d} {i['name'][:56]}")
