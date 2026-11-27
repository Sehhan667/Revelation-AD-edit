"""Write the RTWSM table-builder wrappers with correct quoting and LF line endings.

Same trap as the SSS blur wrappers: generating #include lines through PowerShell string
escaping writes literal backslashes into the file, which makes Iris resolve
`worldN/"/program/...` and throw InvalidPathException. Always write these with Python.
"""
import os

BODY = (
    '#version 460 compatibility\n'
    '\n'
    '// Shadow warp table builder (RTWSM skeleton): fills image.shadowWarpImg before the shadow pass\n'
    '#include "/program/setup/ShadowWarp.comp"\n'
)

for world in ('world0', 'world1', 'world-1'):
    path = os.path.join('shaders', world, 'setup12.csh')
    with open(path, 'wb') as f:
        f.write(BODY.encode('utf-8'))
    raw = open(path, 'rb').read()
    assert b'\\"' not in raw, path
    assert b'\r' not in raw, path
    assert b'#include "/program/setup/ShadowWarp.comp"' in raw, path
    print(f'{path}: ok ({len(raw)} bytes, LF, clean include)')
