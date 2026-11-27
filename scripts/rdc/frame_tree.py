"""RenderDoc text export -> frame tree: top-level units (= Iris passes / draw groups) + leaf actions."""
import re, sys, collections

path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\46941\Desktop\11.txt"
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()

row = re.compile(r"^\s*(\d+)\s*\|\s*(?P<tree>.*?)\s*\|\s*(?P<act>[0-9\-]+)\s*\|\s*(?P<dur>[\d.]+)\s*$")
units, leaves = [], []
for i, line in enumerate(lines):
    m = row.match(line)
    if not m:
        continue
    name = re.sub(r"^[-\\|\s]+", "", m.group("tree")).strip()
    act, dur = m.group("act"), float(m.group("dur"))
    rec = dict(eid=int(m.group(1)), name=name, dur=dur, order=i)
    if "-" in act:
        a, b = act.split("-")
        rec.update(a=int(a), b=int(b))
        units.append(rec)
    elif act.isdigit():
        rec["act"] = int(act)
        leaves.append(rec)

# parent = smallest strictly-containing unit
for u in units:
    par = None
    for v in units:
        if v is u:
            continue
        if v["a"] <= u["a"] and u["b"] <= v["b"] and (v["b"] - v["a"]) > (u["b"] - u["a"]):
            if par is None or (v["b"] - v["a"]) < (par["b"] - par["a"]):
                par = v
    u["parent"] = par["eid"] if par else 0
    u["depth"] = 0
for u in units:
    d, cur = 0, u
    seen = set()
    while cur["parent"]:
        if cur["parent"] in seen:
            break
        seen.add(cur["parent"])
        cur = next(v for v in units if v["eid"] == cur["parent"])
        d += 1
    u["depth"] = d

for e in leaves:
    par = None
    for v in units:
        if v["a"] <= e["act"] <= v["b"]:
            if par is None or (v["b"] - v["a"]) < (par["b"] - par["a"]):
                par = v
    e["parent"] = par["eid"] if par else 0

by_parent = collections.defaultdict(list)
for x in units + leaves:
    by_parent[x["parent"]].append(x)

top = sorted(by_parent[0], key=lambda x: -x["dur"])
total = sum(x["dur"] for x in top)
print(f"{len(units)} groups, {len(leaves)} leaf actions | top-level total = {total/1000:.3f} ms")
print(f"\n===== TOP-LEVEL UNITS in submission order =====\n{'ms':>8} {'kids':>5} {'eid':>6}  unit")
for x in by_parent[0]:
    kids = by_parent.get(x["eid"], [])
    print(f"{x['dur']/1000:8.3f} {len(kids):5d} {x['eid']:6d}  {x['name'][:62]}")

print(f"\n===== TOP-LEVEL UNITS sorted by cost =====")
for x in top[:18]:
    kids = sorted(by_parent.get(x["eid"], []), key=lambda k: -k["dur"])[:4]
    print(f"{x['dur']/1000:8.3f} ms  kids={len(by_parent.get(x['eid'], [])):<5d} {x['name'][:58]}")
    for k in kids:
        print(f"           {k['dur']/1000:8.3f} ms   {k['name'][:56]}")

print("\n===== ALL fullscreen draws (glDrawElements(6)/glDrawArrays(6)) in order =====")
n = 0
for x in units + leaves:
    nm = x["name"]
    if nm in ("glDrawElements(6)", "glDrawArrays(6)") and x["parent"] == 0:
        n += 1
        print(f"{n:3d}. {x['dur']/1000:8.3f} ms  eid={x['eid']}")

print("\n===== aggregate by action name (top 15) =====")
agg, cnt = collections.Counter(), collections.Counter()
for e in leaves:
    key = re.sub(r"\(\d[\d, ]*\)", "(...)", e["name"])
    key = re.sub(r"\[\d+\]", "[N]", key)
    agg[key] += e["dur"]; cnt[key] += 1
for k, v in agg.most_common(15):
    print(f"{v/1000:9.3f} ms  x{cnt[k]:<6d} {k[:56]}")
