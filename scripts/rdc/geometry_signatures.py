"""List every geometry unit in submission order with its draw signature, to align passes
across captures by their sub-draw counts (stable for the main pass, varying for the shadow pass)."""
import re, sys

def units(path):
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
    out = []
    for i in items:
        if i["parent"] is None and "MultiDraw" in i["name"]:
            kids = [k for k in items if k["parent"] is i]
            subs = 0
            for k in kids:
                mm = re.search(r"\((\d+)\)$", k["name"])
                if mm:
                    subs += int(mm.group(1))
            out.append((i["a"], i["b"], len(kids), subs, i["dur"]))
    out.sort()
    return out

for path in sys.argv[1:]:
    u = units(path)
    tot = sum(x[4] for x in u)
    print(f"===== {path.split(chr(92))[-1]}  |  {len(u)} geometry units, total {tot:.3f} ms")
    for a, b, calls, subs, d in u:
        if d >= 0.10:
            print(f"   acts {a:>5}-{b:<5} calls={calls:<4} subdraws={subs:<7} {d:8.3f} ms")
    print()
