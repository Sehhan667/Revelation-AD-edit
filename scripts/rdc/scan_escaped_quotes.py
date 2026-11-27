"""Scan shader sources for the PowerShell escaping trap: a literal backslash before a quote.

Generated wrappers once contained `#include \\"/program/...\\"`, which makes Iris resolve
`worldN/"/program/...` and fail with InvalidPathException. Run this after creating any
wrapper/`#include` line.
"""
import os

EXTS = ('.csh', '.comp', '.fsh', '.frag', '.vsh', '.glsl', '.vert', '.gsh', '.properties')
NEEDLE = b'\\"'

bad = []
for root, _dirs, files in os.walk('shaders'):
    for fn in files:
        if os.path.splitext(fn)[1] not in EXTS:
            continue
        path = os.path.join(root, fn)
        with open(path, 'rb') as f:
            if NEEDLE in f.read():
                bad.append(path)

print('files containing a backslash-quote sequence:', bad if bad else 'none (ok)')
