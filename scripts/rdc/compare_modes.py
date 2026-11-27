"""Compare 3 RenderDoc text exports (same scene, different shadow.culling mode)."""
import re, sys, collections

def load(path):
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    row = re.compile(r"^\s*(\d+)\s*\|\s*(?P<tree>.*?)\s*\|\s*(?P<act>[0-9\-]+)\s*\|\s*(?P<dur>[\d.]+)\s*$")
    items = []
    for line in lines:
        m = row.match(line)
        if not m:
            continue
        name = re.sub(r"^[-\\|\s]+", "", m.group("tree")).strip()
        act, dur = m.group("act"), float(m.group("dur")) / 1000.0
        if "-" in act:
            a, b = (int(x) for x in act.split("-"))
            items.append(dict(name=name, a=a, b=b, dur=dur, group=True))
        elif act.isdigit():
            items.append(dict(name=name, a=int(act), b=int(act), dur=dur, group=False))
    groups = [i for i in items if i["group"]]
    for i in items:
        par = None
        for g in groups:
            if g is i:
                continue
            if g["a"] <= i["a"] and i["b"] <= g["b"] and (g["b"] - g["a"]) > (i["b"] - i["a"]):
                if par is None or (g["b"] - g["a"]) < (par["b"] - par["a"]):
                    par = g
        i["parent"] = par
    tops = [i for i in items if i["parent"] is None]
    return tops, items

files = sys.argv[1:]
data = {}
for f in files:
    tops, items = load(f)
    total = sum(i["dur"] for i in tops)
    geo = sum(i["dur"] for i in tops if "MultiDraw" in i["name"])
    post = sum(i["dur"] for i in tops if i["name"].startswith(("glDrawElements", "glDrawArrays")))
    disp = sum(i["dur"] for i in tops if "Dispatch" in i["name"])
    other = total - geo - post - disp
    data[f] = dict(tops=tops, items=items, total=total, geo=geo, post=post, disp=disp, other=other,
                   geo_units=sorted([i for i in tops if "MultiDraw" in i["name"]], key=lambda x: -x["dur"])[:3])

print(f"{'file':<12} {'total':>8} {'geometry':>9} {'post':>7} {'compute':>8} {'other':>7}")
for f, d in data.items():
    print(f"{f:<12} {d['total']:8.3f} {d['geo']:9.3f} {d['post']:7.3f} {d['disp']:8.3f} {d['other']:7.3f}")

print("\n=== biggest geometry batches per file ===")
for f, d in data.items():
    print(f"-- {f}")
    for g in d["geo_units"]:
        kids = [i for i in d["items"] if i["parent"] is g]
        first = max(kids, key=lambda k: k["dur"]) if kids else None
        m = re.search(r"\((\d+)\)", first["name"]) if first else None
        print(f"   {g['dur']:8.3f} ms  acts {g['a']}-{g['b']}  calls={len(kids):<4d} subdraws={m.group(1) if m else '-'}")

print("\n=== top-level units >= 0.30 ms, in submission order ===")
names = list(data)
# union of action numbers to align rows
rows = sorted({i["a"] for d in data.values() for i in d["tops"] if i["dur"] >= 0.30})
header = f"{'act':>9} " + " ".join(f"{f.replace('.txt',''):>9}" for f in names) + "  unit"
print(header)
for a in rows:
    cells = []
    label = ""
    for f in names:
        hit = [i for i in data[f]["tops"] if i["a"] == a]
        if hit:
            cells.append(f"{hit[0]['dur']:9.3f}")
            label = label or hit[0]["name"]
        else:
            cells.append(f"{'-':>9}")
    print(f"{a:>9} " + " ".join(cells) + f"  {label[:44]}")
