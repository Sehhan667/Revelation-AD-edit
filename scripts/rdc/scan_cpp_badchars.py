"""Find non-ASCII punctuation in compute-path shader sources (JCPP rejects some of them).

JCPP (the C preprocessor Iris uses) lexes non-ASCII *letters* (hanzi, category Lo) fine, but
non-ASCII *punctuation* has no token rule. Print, per file, every distinct non-ASCII character
whose Unicode category is not L* (letter) / N* (number) / Z* (space), with line:col.
"""
import io
import os
import unicodedata

FILES = [
    # known-good compute path files (pre-existing, the pack loads fine with them)
    'shaders/program/Translucent.comp',
    'shaders/program/post/bloom/Blur.comp',
    'shaders/program/clouds/Render.comp',
    'shaders/program/diffuse/DiffuseIndirect.comp',
    'shaders/lib/atmosphere/AtmosphericFog.glsl',
    # my new files
    'shaders/program/post/SubsurfaceBlur.comp',
    'shaders/world0/composite1.csh',
    'shaders/world0/composite3.csh',
]

def bad_category(ch):
    cat = unicodedata.category(ch)
    return not (cat[0] in ('L', 'N', 'Z') or cat in ('Cf',))

for path in FILES:
    if not os.path.exists(path):
        print(f'{path}: MISSING')
        continue
    text = io.open(path, encoding='utf-8').read()
    found = {}
    for lineno, line in enumerate(text.split('\n'), 1):
        for col, ch in enumerate(line, 1):
            if ord(ch) > 127 and bad_category(ch):
                found.setdefault(ch, []).append(f'{lineno}:{col}')
    print(f'== {path}')
    if not found:
        print('   (no non-ASCII punctuation)')
    for ch, pos in found.items():
        name = unicodedata.name(ch, '?')
        cat = unicodedata.category(ch)
        print(f'   {ch!r} U+{ord(ch):04X} {cat} {name}: {len(pos)}x, first at {pos[0]}')
