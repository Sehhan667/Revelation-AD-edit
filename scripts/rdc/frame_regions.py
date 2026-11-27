"""Parse a RenderDoc text event export into regions (colour/compute passes) + draws."""
import re, sys, collections

path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\46941\Desktop\11.txt"
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()

row = re.compile(r"^\s*(\d+)\s*\|\s*(?P<tree>.*?)\s*\|\s*(?P<act>[0-9\-]+)\s*\|\s*(?P<dur>[\d.]+)\s*$")
regions = []   # dict(eid, name, a, b, dur, order)
events = []    # dict(eid, name, act, dur, order)

for i, line in enumerate(lines):
    m = row.match(line)
    if not m:
        continue
    name = m.group("tree").strip()
    name = re.sub(r"^[-\\|\s]+", "", name)
    act = m.group("act")
    dur = float(m.group("dur"))
    if "-" in act:
        a, b = act.split("-")
        regions.append(dict(eid=int(m.group(1)), name=name, a=int(a), b=int(b), dur=dur, order=i))
    elif act.isdigit():
        events.append(dict(eid=int(m.group(1)), name=name, act=int(act), dur=dur, order=i))

# attribute each event to the smallest enclosing region
for e in events:
    best = None
    for r in regions:
        if r["a"] <= e["act"] <= r["b"]:
            if best is None or (r["b"] - r["a"]) < (best["b"] - best["a"]):
                best = r
    e["region"] = best["name"] if best else "(none)"
    e["region_eid"] = best["eid"] if best else 0

total = sum(r["dur"] for r in regions if r["a"] == min(x["a"] for x in regions)) or 0
print(f"frame: {len(regions)} regions, {len(events)} leaf actions")
print(f"region durations (sum of top-level) ~ {total/1000:.2f} ms\n")

by_region = collections.defaultdict(list)
for e in events:
    by_region[e["region_eid"]].append(e)

print(f"{'ms':>8}  {'children':>8}  {'sum_child_ms':>12}  region")
for r in sorted(regions, key=lambda r: -r["dur"]):
    kids = by_region.get(r["eid"], [])
    s = sum(k["dur"] for k in kids)
    print(f"{r['dur']/1000:8.3f}  {len(kids):8d}  {s/1000:12.3f}  {r['name'][:60]}")

print("\n===== top 25 leaf actions =====")
print(f"{'ms':>8}  {'eid':>6}  region                          action")
for e in sorted(events, key=lambda e: -e["dur"])[:25]:
    print(f"{e['dur']/1000:8.3f}  {e['eid']:6d}  {e['region'][:28]:28}  {e['name'][:46]}")

print("\n===== aggregate by action name =====")
agg = collections.Counter()
cnt = collections.Counter()
for e in events:
    key = re.sub(r"\(\d.*?\)", "(...)", e["name"])
    key = re.sub(r"\[\d+\]", "[N]", key)
    agg[key] += e["dur"]
    cnt[key] += 1
for k, v in agg.most_common(18):
    print(f"{v/1000:9.3f} ms  x{cnt[k]:<5d} {k[:58]}")
