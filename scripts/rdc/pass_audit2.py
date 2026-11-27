import re, os, sys, json

PROPS = "shaders/shaders.properties"
SETTINGS = "shaders/settings.glsl"
OPTS = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit.txt"

# ---------- 1. 宏表：settings.glsl 的 #define 默认值 ----------
macros = {}
for line in open(SETTINGS, encoding="utf-8", errors="replace"):
    s = line.strip()
    m = re.match(r"#define\s+(\w+)\s*(.*?)\s*(?://.*)?$", s)
    if m and not s.startswith("//"):
        name, val = m.group(1), m.group(2).strip()
        macros[name] = val if val else "1"
    m = re.match(r"#undef\s+(\w+)", s)
    if m:
        macros.pop(m.group(1), None)

def apply_options(text, table):
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("!"):
            table.pop(s[1:].strip(), None)
            continue
        if "=" in s:
            k, v = s.split("=", 1)
            k, v = k.strip(), v.strip()
            if k:
                table[k] = v if v else "1"
        elif re.fullmatch(r"[A-Za-z_]\w*", s):
            table[s] = "1"

# profile.Default 在 properties 第 1 行
props_text = open(PROPS, encoding="utf-8", errors="replace").read()
first = props_text.splitlines()[0]
if first.startswith("profile.Default"):
    apply_options(first.split("=", 1)[1].replace(" ", "\n"), macros)
# 用户实际选项最后覆盖
apply_options(open(OPTS, encoding="utf-8", errors="replace").read(), macros)

def num(name):
    v = macros.get(name, "0")
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None

# ---------- 2. 求值器 ----------
def evaluate(expr):
    e = expr
    e = re.sub(r"defined\s*\(\s*(\w+)\s*\)", lambda m: "1" if m.group(1) in macros else "0", e)
    e = re.sub(r"defined\s+(\w+)", lambda m: "1" if m.group(1) in macros else "0", e)

    def repl(m):
        n = m.group(0)
        if n in ("and", "or", "not"):
            return n
        if n == "true":
            return "1"
        if n == "false":
            return "0"
        v = macros.get(n)
        if v is None:
            return "0"
        if v in ("true", "false"):
            return "1" if v == "true" else "0"
        try:
            return str(int(float(v)))
        except (TypeError, ValueError):
            return "1"

    e = re.sub(r"\b[A-Za-z_]\w*\b", repl, e)
    e = e.replace("&&", " and ").replace("||", " or ")
    e = re.sub(r"(?<![<>!=])=(?!=)", "==", e)
    e = re.sub(r"!(?![=])", " not ", e)
    try:
        return bool(eval(e))
    except Exception as ex:
        raise ValueError(f"{expr!r} -> {e!r}: {ex}")

# ---------- 3. 处理 properties 的条件块与规则 ----------
stack = []          # (parent_active, this_branch_taken, active)
rules = []          # (world, pass, expr)
for ln, line in enumerate(props_text.splitlines(), 1):
    s = line.strip()
    if s.startswith("#") and re.match(r"#\s*(if|ifdef|ifndef|elif|else|endif)\b", s):
        d = re.sub(r"^#\s*", "", s)
        kind = d.split()[0]
        if kind in ("if", "ifdef", "ifndef"):
            if kind == "if":
                cond = d[3:].strip()
            else:
                cond = ("defined " + d[len(kind):].strip())
                if kind == "ifndef":
                    cond = "!(" + cond + ")"
            parent = stack[-1][2] if stack else True
            try:
                val = evaluate(cond) if parent else False
            except ValueError:
                val = False
            stack.append((parent, val, parent and val))
        elif kind == "elif":
            parent, taken, _ = stack.pop()
            cond = d[4:].strip()
            try:
                val = evaluate(cond) if (parent and not taken) else False
            except ValueError:
                val = False
            stack.append((parent, taken or val, parent and not taken and val))
        elif kind == "else":
            parent, taken, _ = stack.pop()
            stack.append((parent, True, parent and not taken))
        elif kind == "endif":
            if stack:
                stack.pop()
        continue
    if not s or s.startswith("#"):
        continue
    active = stack[-1][2] if stack else True
    m = re.match(r"program\.(world0|world-1|world1)/([\w]+)\.enabled\s*=\s*(.+?)\s*$", s)
    if m and active:
        rules.append((m.group(1), m.group(2), m.group(3)))

# ---------- 4. 判定 ----------
world = "world0"
present = set()
for ext in (".csh", ".fsh", ".vsh", ".gsh", ".frag", ".comp"):
    d = f"shaders/{world}"
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.endswith(ext):
                present.add(os.path.splitext(f)[0])

ruled = {}
for w, p, expr in rules:
    if w != world:
        continue
    try:
        ruled[p] = (evaluate(expr), expr)
    except ValueError as ex:
        ruled[p] = (None, f"{expr}   <UNPARSED: {ex}>")

off, on, unknown = [], [], []
for p in sorted(present):
    if p in ruled:
        val, expr = ruled[p]
        (on if val else off if val is False else unknown).append((p, expr))
    else:
        on.append((p, "<no rule -> Iris default ON>"))

print("world:", world, "| GI_MODE =", macros.get("GI_MODE"), "| ENABLE_VOXELIZATION =", macros.get("ENABLE_VOXELIZATION", "(undefined)"),
      "| VOXEL_GI_DENOISE =", macros.get("VOXEL_GI_DENOISE", "(undefined)"))
print(f"\n=== DISABLED passes ({len(off)}) ===")
for p, e in off:
    print(f"  {p:<26} = {e}")
print(f"\n=== ENABLED passes ({len(on)}) ===")
for p, e in on:
    print(f"  {p:<26} = {e}")
if unknown:
    print(f"\n=== UNRESOLVED ({len(unknown)}) ===")
    for p, e in unknown:
        print(f"  {p:<26} = {e}")
