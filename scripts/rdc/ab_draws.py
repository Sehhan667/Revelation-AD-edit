"""List draw/dispatch events in submission order with B/E-derived durations, for A/B comparison
between two chrome.json exports produced by the same path."""
import json, sys, collections

def load(path):
    d = json.load(open(path, encoding="utf-8", errors="replace"))
    evs = d["traceEvents"]
    stack = collections.defaultdict(list)
    flat = []          # (order, depth, name, dur_ms)
    order = 0
    for e in evs:
        ph, tid = e.get("ph"), e.get("tid")
        if ph == "B":
            node = dict(name=e.get("name") or "", ts=e.get("ts"), depth=len(stack[tid]),
                        order=order, children=0)
            order += 1
            if stack[tid]:
                stack[tid][-1]["children"] += 1
            flat.append(node)
            stack[tid].append(node)
        elif ph == "E" and stack[tid]:
            n = stack[tid].pop()
            n["dur"] = (e.get("ts") - n["ts"]) / 1e6
    return flat

KEY = ("Dispatch", "Draw", "MultiDraw", "Blit", "CopyImage")

for path in sys.argv[1:]:
    flat = load(path)
    hits = [n for n in flat if any(k in n["name"] for k in KEY)]
    big = [n for n in hits if n.get("dur", 0) >= 0.5]
    tot = sum(n.get("dur", 0) for n in hits)
    print(f"=== {path}")
    print(f"  draw/dispatch events: {len(hits)} | sum dur {tot:.3f} ms | >=0.5ms: {len(big)}")
    for n in big[:22]:
        print(f"    {n.get('dur',0):8.3f} ms  d{n['depth']} kids={n['children']:<4d} {n['name'][:52]}")
    print("  first 12 in submission order:")
    for n in hits[:12]:
        print(f"    {n.get('dur',0):8.3f} ms  d{n['depth']} kids={n['children']:<4d} {n['name'][:52]}")
    print()
