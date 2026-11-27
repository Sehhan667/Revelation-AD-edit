import re, sys, io

# 只输出 ASCII，避免 GBK 终端报错
path = "shaders/settings.glsl"
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()

stack = []
target = None
for ln, line in enumerate(lines, 1):
    s = line.strip()
    if s.startswith("#"):
        d = s[1:].strip()
        if d.startswith("if"):
            stack.append((ln, d))
        elif d.startswith("endif"):
            if stack:
                stack.pop()
    if "GI_MODE < 2" in line:
        target = ln
        stack_snapshot = list(stack)

print("line of '#if GI_MODE < 2':", target)
print("enclosing conditional stack (depth = %d):" % len(stack_snapshot))
for ln, d in stack_snapshot:
    print(f"   from line {ln}: {d}")
print("--> top-level block:", len(stack_snapshot) == 0)

# 极简求值：验证该行在 GI_MODE 取 0/1/2/3 时的真假
def evaluate(expr, macros):
    e = expr
    e = re.sub(r"defined\s*\(\s*(\w+)\s*\)", lambda m: "1" if m.group(1) in macros else "0", e)
    e = re.sub(r"defined\s+(\w+)", lambda m: "1" if m.group(1) in macros else "0", e)
    e = re.sub(r"\b[A-Za-z_]\w*\b", lambda m: str(macros.get(m.group(0), 0)), e)
    e = e.replace("&&", " and ").replace("||", " or ").replace("!", " not ")
    e = re.sub(r"(?<![<>!=])=(?!=)", "==", e)
    return bool(eval(e))

for mode in (0, 1, 2, 3):
    macros = {"GI_MODE": mode}
    on = evaluate("GI_MODE < 2", macros)
    print(f"GI_MODE={mode}: '#if GI_MODE < 2' -> {on}  => ENABLE_VOXELIZATION {'UNDEF (voxelization off)' if on else 'kept (voxelization on)'}")
