"""Rewrite the six SSS blur pass wrappers: correct include quoting + LF line endings.

The first version was generated through PowerShell string escaping, which wrote literal
backslashes into the file (`#include \\"/program/...\\"`), so Iris resolved the include as
`worldN/"/program/...` and threw InvalidPathException. Also: every other wrapper in this
pack uses LF, not CRLF, so match that.
"""
import os

H = (
    '#version 460 compatibility\n'
    '\n'
    '// SSS screen-space diffusion: horizontal pass (half-res colortex18 -> colortex19)\n'
    '#define SSS_BLUR_HORIZONTAL\n'
    '\n'
    '#include "/program/post/SubsurfaceBlur.comp"\n'
)

V = (
    '#version 460 compatibility\n'
    '\n'
    '// SSS screen-space diffusion: vertical pass (half-res colortex19 -> colortex20)\n'
    '\n'
    '#include "/program/post/SubsurfaceBlur.comp"\n'
)

for world in ('world0', 'world1', 'world-1'):
    for name, text in (('composite1.csh', H), ('composite3.csh', V)):
        path = os.path.join('shaders', world, name)
        with open(path, 'wb') as f:
            f.write(text.encode('utf-8'))
        raw = open(path, 'rb').read()
        assert b'\\"' not in raw, path
        assert b'\r' not in raw, path
        print(f'{path}: {len(raw)} bytes, no backslash-quote, LF only')
