import json, collections, sys

path = r'rdc_analysis\chrome.json'
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)

events = data['traceEvents'] if isinstance(data, dict) else data
print('total events:', len(events))

by_name = collections.defaultdict(lambda: {'n': 0, 'dur': 0.0, 'maxdur': 0.0})
cats = collections.Counter()
have_dur = 0
for e in events:
    if not isinstance(e, dict):
        continue
    name = e.get('name', '')
    cats[e.get('cat', '')] += 1
    d = e.get('dur', 0) or 0
    if d:
        have_dur += 1
    r = by_name[name]
    r['n'] += 1
    r['dur'] += d
    r['maxdur'] = max(r['maxdur'], d)

print('events with dur>0:', have_dur)
print('\ncategories:', dict(cats))

def show(title, key, topn, filt=None):
    items = [(k, v) for k, v in by_name.items() if (filt is None or filt(k))]
    items.sort(key=lambda kv: kv[1][key], reverse=True)
    print('\n=== top %d by %s ===' % (topn, title))
    for k, v in items[:topn]:
        print('%9.3f ms  x%-6d max %8.3f  %s' % (v['dur'], v['n'], v['maxdur'], k[:110]))

show('total duration', 'dur', 45)
show('count', 'n', 30)

# 关注 pass 类名字
print('\n=== pass-like events (composite/deferred/prepare/setup/begin/final/...) ===')
for k, v in sorted(by_name.items(), key=lambda kv: kv[0]):
    kl = k.lower()
    if any(t in kl for t in ('composite', 'deferred', 'prepare', 'setup', 'begin', 'final', 'downsample', 'upsample', 'blur', 'specularfilter', 'voxelgi', 'eaqf', 'eawf', 'accumulate', 'skyview', 'cloud', 'translucent', 'taa', 'motionblur', 'histogram', 'exposure', 'grade', 'integrate')):
        print('%9.3f ms  x%-6d  %s' % (v['dur'], v['n'], k[:120]))
