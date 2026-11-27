path = r'C:\Users\46941\Desktop\11.txt'
lines = open(path, encoding='utf-8', errors='ignore').read().splitlines()

passes = []
cur = None
for ln in lines:
    if '|' not in ln:
        continue
    parts = ln.split('|')
    if len(parts) < 4:
        continue
    eid = parts[0].strip()
    mid = parts[1]
    if not eid.isdigit():
        continue
    try:
        dur = float(parts[3].strip())
    except ValueError:
        continue
    name = mid.replace('\\', ' ').strip().lstrip('-').strip()
    lead = len(mid) - len(mid.lstrip(' '))
    is_pass = (lead <= 1 and '\\' not in mid and ('Pass' in name or 'Targets' in name))
    if is_pass:
        cur = {'name': name, 'dur': dur, 'kids': []}
        passes.append(cur)
    elif cur is not None:
        cur['kids'].append((name, dur))

print('passes: %d   frame total = %.2f ms' % (len(passes), sum(p['dur'] for p in passes)/1000))
print('\n=== 按耗时排序 ===')
for p in sorted(passes, key=lambda p: -p['dur'])[:22]:
    print('%8.1f us  %-46s  children=%d' % (p['dur'], p['name'][:46], len(p['kids'])))

print('\n=== 帧内顺序 ===')
for i, p in enumerate(passes):
    print('%3d %8.1f us | %-46s | n=%d' % (i, p['dur'], p['name'][:46], len(p['kids'])))

print('\n=== 最耗时 pass 的内部明细 (top 8) ===')
for p in sorted(passes, key=lambda p: -p['dur'])[:8]:
    print('\n[%s]  total %.1f us' % (p['name'], p['dur']))
    for n, d in sorted(p['kids'], key=lambda k: -k[1])[:5]:
        print('    %8.1f us  %s' % (d, n[:60]))
