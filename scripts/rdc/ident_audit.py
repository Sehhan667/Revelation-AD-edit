"""Identifier audit for the SSS code I added.

For every identifier in my files/blocks, check whether it also appears somewhere else in the
pack (i.e. it is defined by the pack) or is a GLSL builtin/keyword. Identifiers that appear ONLY
in my code must be definitions I introduced myself - anything else is a likely typo/undefined
symbol that would fail to compile in game.
"""
import io
import os
import re

MINE = [
    'shaders/lib/lighting/Subsurface.glsl',
    'shaders/program/post/SubsurfaceBlur.comp',
]

BUILTINS = set("""
void bool int uint float double vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4
mat2 mat3 mat4 mat2x3 mat3x2 mat2x2 mat4x4 sampler2D sampler2DShadow sampler3D samplerCube usampler2D
image2D uimage2D writeonly readonly restrict coherent volatile layout uniform in out inout flat smooth
const struct if else for while do switch case default break continue return discard true false
lowp mediump highp precision invariant centroid
gl_FragCoord gl_FragDepth gl_GlobalInvocationID gl_LocalInvocationID gl_WorkGroupID gl_NumWorkGroups
gl_WorkGroupSize gl_VertexID gl_InstanceID gl_Position gl_PointSize gl_MultiTexCoord0 gl_Normal
main abs sign floor trunc round roundEven ceil fract mod min max clamp mix step smoothstep
isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat fma frexp ldexp
packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16 packHalf2x16 unpackHalf2x16
length distance dot cross normalize faceforward reflect refract
matrixCompMult outerProduct transpose determinant inverse
lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not
texture textureProj textureLod textureOffset texelFetch texelFetchOffset textureProjOffset
textureLodOffset textureProjLod textureProjLodOffset textureGrad textureGradOffset
textureProjGrad textureProjGradOffset textureSize textureQueryLod textureQueryLevels
imageSize imageLoad imageStore imageAtomicAdd imageAtomicMin imageAtomicMax imageAtomicAnd
imageAtomicOr imageAtomicXor imageAtomicExchange imageAtomicCompSwap
dFdx dFdy fwidth sqrt inversesqrt pow exp log exp2 log2 sin cos tan asin acos atan sinh cosh
tanh asinh acosh atanh radians degrees
""".split())

def idents(text):
    return set(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', text))

def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
    text = re.sub(r'//[^\n]*', ' ', text)
    return text

mine_text = ''
for p in MINE:
    mine_text += io.open(p, encoding='utf-8').read()
mine_ids = idents(strip_comments(mine_text))

pack_ids = set()
for root, _d, files in os.walk('shaders'):
    for fn in files:
        if os.path.splitext(fn)[1] not in ('.csh', '.comp', '.fsh', '.frag', '.vsh', '.glsl', '.vert', '.gsh'):
            continue
        p = os.path.join(root, fn).replace('\\', '/')
        if p in MINE:
            continue
        pack_ids |= idents(strip_comments(io.open(p, encoding='utf-8', errors='replace').read()))

unknown = sorted(i for i in mine_ids if i not in BUILTINS and i not in pack_ids)
print('identifiers only in my code (must be my own definitions):', len(unknown))
for name in unknown:
    # show where it is declared/used in my files
    where = []
    for p in MINE:
        for n, line in enumerate(io.open(p, encoding='utf-8').read().split('\n'), 1):
            if re.search(r'\b%s\b' % name, line):
                where.append(f'{os.path.basename(p)}:{n}:{line.strip()[:80]}')
    print(f'  {name}')
    for w in where[:3]:
        print(f'      {w}')
