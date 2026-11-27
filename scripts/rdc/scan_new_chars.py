"""Diff the non-ASCII character set of my new/edited shader files against the rest of the pack.

JCPP evidently accepts every character the pre-existing pack uses (it loads fine), so any
character that appears ONLY in the files I added is a candidate for `Bad token`.
Output is ASCII-only so the console codepage cannot mangle it.
"""
import io
import os
import unicodedata

MINE = {
    'shaders/lib/lighting/Subsurface.glsl',
    'shaders/program/post/SubsurfaceBlur.comp',
    'shaders/world0/composite1.csh', 'shaders/world0/composite3.csh',
    'shaders/world1/composite1.csh', 'shaders/world1/composite3.csh',
    'shaders/world-1/composite1.csh', 'shaders/world-1/composite3.csh',
    'shaders/program/DeferredLight.frag', 'shaders/program/IntegrateScene.frag',
    'shaders/settings.glsl', 'shaders/config.glsl',
}
EXTS = ('.csh', '.comp', '.fsh', '.frag', '.vsh', '.glsl', '.vert', '.gsh')

mine_chars = {}
pack_chars = {}

for root, _dirs, files in os.walk('shaders'):
    for fn in files:
        if os.path.splitext(fn)[1] not in EXTS:
            continue
        path = os.path.join(root, fn).replace('\\', '/')
        try:
            text = io.open(path, encoding='utf-8').read()
        except Exception:
            continue
        bucket = mine_chars if path in MINE else pack_chars
        for lineno, line in enumerate(text.split('\n'), 1):
            for col, ch in enumerate(line, 1):
                if ord(ch) > 127:
                    bucket.setdefault(ch, []).append(f'{path}:{lineno}:{col}')

only_mine = sorted(set(mine_chars) - set(pack_chars))
print('files considered MINE:', len(MINE))
print('distinct non-ASCII chars in pack (rest):', len(pack_chars))
print('distinct non-ASCII chars in mine         :', len(mine_chars))
print('chars ONLY in my files:', len(only_mine))
for ch in only_mine:
    cat = unicodedata.category(ch)
    name = unicodedata.name(ch, '?')
    where = mine_chars[ch][:3]
    print(f'  U+{ord(ch):04X} cat={cat} name={name} count={len(mine_chars[ch])} first={where}')

# also: package the set of characters present in the pack, for reference on the suspicious ones
print()
print('sample of chars the pack already uses (sanity):')
for ch in sorted(pack_chars)[:12]:
    print(f'  U+{ord(ch):04X} {unicodedata.category(ch)} {unicodedata.name(ch, "?")}')
