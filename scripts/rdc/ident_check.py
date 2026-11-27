"""Generic identifier audit: report identifiers that appear only in the given files.

Usage: python rdc_analysis/ident_check.py <file> [<file> ...]

Anything listed must be a definition inside those files (macro, const, function, local);
a name that is neither a GLSL builtin nor present anywhere else in the pack would be a
compile error in game.
"""
import io
import os
import re
import sys

BUILTINS = set("""
void bool int uint float double vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4
mat2 mat3 mat4 mat2x3 mat3x2 mat2x2 mat4x4 sampler2D sampler2DShadow sampler3D samplerCube usampler2D
image2D uimage2D writeonly readonly restrict coherent volatile layout uniform in out inout flat smooth
const struct if else for while do switch case default break continue return discard true false
lowp mediump highp precision invariant centroid
gl_FragCoord gl_FragDepth gl_GlobalInvocationID gl_LocalInvocationID gl_WorkGroupID gl_NumWorkGroups
gl_WorkGroupSize gl_Position gl_PointSize gl_ProjectionMatrix gl_ModelViewMatrix gl_MultiTexCoord0
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

EXTS = ('.csh', '.comp', '.fsh', '.frag', '.vsh', '.glsl', '.vert', '.gsh', '.properties', '.lang')


def idents(text):
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
    text = re.sub(r'//[^\n]*', ' ', text)
    return set(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', text))


targets = [p.replace('\\', '/') for p in sys.argv[1:]]
mine = ''
for p in targets:
    mine += io.open(p, encoding='utf-8').read()
mine_ids = idents(mine)

pack = set()
for root, _d, files in os.walk('shaders'):
    for fn in files:
        if os.path.splitext(fn)[1] not in EXTS:
            continue
        p = os.path.join(root, fn).replace('\\', '/')
        if p in targets:
            continue
        pack |= idents(io.open(p, encoding='utf-8', errors='replace').read())

unknown = sorted(i for i in mine_ids if i not in BUILTINS and i not in pack)
print('only-in-these-files identifiers (must be their own definitions):', unknown)
