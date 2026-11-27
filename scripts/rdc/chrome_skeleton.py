"""Parse a RenderDoc chrome.json (B/E events) into a pass-cost skeleton.

chrome.json stores no argument strings, so passes are identified by submission order /
structure, and compared against a reference capture by position.
"""
import json, sys, collections

path = sys.argv[1]
thr = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05

d = json.load(open(path, encoding="utf-8", errors="replace"))
evs = d["traceEvents"]

# build tree from B/E pairs per thread (single main tid in practice)
stack = collections.defaultdict(list)
roots = []
order = 0
for e in evs:
    ph, tid = e.get("ph"), e.get("tid")
    if ph == "B":
        node = dict(name=e.get("name") or "", ts=e.get("ts"), children=[], start=order, idx=order)
        order += 1
        if stack[tid]:
            stack[tid][-1]["children"].append(node)
        else:
            roots.append(node)
        stack[tid].append(node)
    elif ph == "E" and stack[tid]:
        node = stack[tid].pop()
        node["dur"] = e.get("ts") - node["ts"]          # ns

def dur_ms(n):
    return n.get("dur", 0) / 1e6

total = sum(dur_ms(r) for r in roots)
print(f"file: {path}")
print(f"root units: {len(roots)} | sum of root durations = {total:.3f} ms")
print(f"\n===== ROOT UNITS > {thr} ms, in submission order =====")
run = 0.0
for r in roots:
    ms = dur_ms(r)
    if ms < thr:
        run += ms
        continue
    if run:
        print(f"{'':>11}  {run:8.3f}  ...(skipped small units: {run:.3f} ms)")
        run = 0.0
    print(f"{'#'+str(r['idx']):>11}  {ms:8.3f}  {len(r['children']):5d} kids  {r['name'][:56]}")

print("\n===== ROOT UNITS sorted by cost (top 15) =====")
for r in sorted(roots, key=lambda n: -dur_ms(n))[:15]:
    print(f"{dur_ms(r):8.3f} ms  kids={len(r['children']):<5d} {r['name'][:52]}")
    for c in sorted(r["children"], key=lambda n: -dur_ms(n))[:3]:
        print(f"          {dur_ms(c):8.3f} ms  {len(c['children']):5d} kids  {c['name'][:46]}")
