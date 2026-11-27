import json, re, collections, sys

path = sys.argv[1] if len(sys.argv) > 1 else "rdc_analysis/chrome.json"
data = json.load(open(path, encoding="utf-8", errors="replace"))

names = collections.Counter()
durs = collections.Counter()

def walk(ev):
    n = ev.get("name") or ""
    if "Dispatch" in n:
        names[n] += 1
    d = ev.get("dur")
    if d:
        durs[n] += d
    for c in ev.get("children") or []:
        walk(c)

for ev in data if isinstance(data, list) else data.get("traceEvents", []):
    if ev.get("ph") in ("X", "B") or "name" in ev:
        walk(ev)

print("== Dispatch actions ==")
for n, c in names.most_common():
    print(f"{c:4d} x  {n}")
print()
print("== Top actions by total dur ==")
for n, d in durs.most_common(12):
    print(f"{d/1000.0:9.3f} ms  {n[:90]}")
