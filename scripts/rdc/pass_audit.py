import re, os

ROOT = r'shaders'
WORLD = 'world0'

# 1) 读你的运行配置（GUI 覆盖值）
opts = {}
optfile = r'..\Revelation-AD-edit.txt'
if os.path.exists(optfile):
    for line in open(optfile, encoding='utf-8', errors='ignore'):
        line = line.strip()
        if '=' in line:
            k, v = line.split('=', 1)
            opts[k.strip()] = v.strip()

def opt_state(name):
    """返回 True/False/数值/None(未设置)"""
    if name in opts:
        v = opts[name]
        if v.lower() == 'true': return True
        if v.lower() == 'false': return False
        try: return float(v)
        except: return True
    return None

# 2) 读 settings.glsl 的默认 #define（无 GUI 设置时用）
defaults = set()
for line in open(os.path.join(ROOT, 'settings.glsl'), encoding='utf-8', errors='ignore'):
    m = re.match(r'\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)', line)
    if m: defaults.add(m.group(1))

def token_value(name):
    st = opt_state(name)
    if st is not None: return st
    if name in defaults: return True
    return None   # 未知

# 3) 解析 properties 里 program.<world>/<pass>.enabled = expr
rules = {}
for line in open(os.path.join(ROOT, 'shaders.properties'), encoding='utf-8', errors='ignore'):
    m = re.match(r'\s*program\.([^/]+)/([^.\s]+)\.enabled\s*=\s*(.+?)\s*$', line)
    if m:
        w, p, expr = m.group(1), m.group(2), m.group(3)
        if w == WORLD:
            rules[p] = expr

# 4) 收集该 world 实际存在的 pass 文件
passes = set()
for f in os.listdir(os.path.join(ROOT, WORLD)):
    m = re.match(r'(.+)\.(csh|fsh|vsh)$', f)
    if m: passes.add(m.group(1))
passes = {p for p in passes if not p.endswith('.vsh')}

def evaluate(expr, unknown):
    e = expr
    e = e.replace('&&', ' and ').replace('||', ' or ')
    e = re.sub(r'!(?!=)', ' not ', e)
    e = e.replace('==', '==')
    def repl(m):
        name = m.group(0)
        v = token_value(name)
        if v is None:
            unknown.add(name)
            return 'True'
        if isinstance(v, bool): return str(v)
        return str(v)
    e = re.sub(r'[A-Za-z_][A-Za-z0-9_]*', repl, e)
    try:
        return bool(eval(e))
    except Exception as ex:
        return ('ERR:' + str(ex))

print('=== world0 pass 审计（enabled 规则求值，按你的配置）===')
on, off, norule = [], [], []
for p in sorted(passes):
    if p in rules:
        unk = set()
        r = evaluate(rules[p], unk)
        if r is True: on.append((p, rules[p], unk))
        elif r is False: off.append((p, rules[p]))
        else: on.append((p, rules[p] + '  ' + str(r), unk))
    else:
        norule.append(p)

print('\n--- 会执行的 pass (%d) ---' % len(on))
for p, expr, unk in on:
    flag = ('  [未知符号:%s]' % ','.join(sorted(unk))) if unk else ''
    print('%-26s = %s%s' % (p, expr[:90], flag))

print('\n--- 被规则关闭的 pass (%d) ---' % len(off))
for p, expr in off:
    print('%-26s = %s' % (p, expr[:90]))

print('\n--- 无 enabled 规则(默认执行) 的 pass (%d) ---' % len(norule))
print(', '.join(norule))

print('\n--- 你配置里被关闭的选项 ---')
off_opts = [k for k, v in opts.items() if v.lower() == 'false']
print(', '.join(sorted(off_opts)))
