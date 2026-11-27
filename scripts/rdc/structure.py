import json, collections

with open(r'rdc_analysis\chrome.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
events = data['traceEvents'] if isinstance(data, dict) else data

# 采样事件结构
print('--- sample events ---')
shown = 0
for e in events:
    if isinstance(e, dict) and e.get('name') not in ('', None) and 'glDispatch' in str(e.get('name')):
        print(json.dumps(e)[:300]); shown += 1
        if shown >= 3: break
if shown == 0:
    for e in events[:3]:
        print(json.dumps(e)[:200])

names = collections.Counter()
for e in events:
    if isinstance(e, dict):
        names[e.get('name','')] += 1

print('\n--- counts of interest ---')
for k in ('glDispatchCompute','glDispatchComputeGroupSizeARB','glDrawArrays','glDrawElements','glDrawArraysInstanced',
          'glMemoryBarrier','glTextureBarrier','glBlitFramebuffer','glClear','glClearTexImage','glCopyImageSubData',
          'glFinish','glFlush','glUseProgram','glBindImageTexture','glBindTextureUnit','glNamedFramebufferTexture'):
    if k in names:
        print('%-32s %d' % (k, names[k]))

print('\n--- all names containing Dispatch/Barrier/Blit/Copy (top 25) ---')
for k, v in sorted(names.items(), key=lambda kv: -kv[1]):
    kl = k.lower()
    if any(t in kl for t in ('dispatch','barrier','blit','copy','clear','map')):
        print('%6d  %s' % (v, k[:120]))
