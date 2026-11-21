#version 460 compatibility
#define DIMENSION_NETHER

// [2026-11-15] 直接写 colorimg5，理由同 world0/setup.csh：skyMapImg 是 Load.glsl 里的别名，
// 本 pass 不 include 它，别名不展开 -> uniform 名字对不上 Iris 的 image 绑定表。
#define CLEAR_IMAGE colorimg5
#define CLEAR_COLOR vec4(0.0)

layout (local_size_x = 16, local_size_y = 16) in;
const ivec3 workGroups = ivec3(16, 16, 1);

#include "/program/setup/ImageClear.comp"