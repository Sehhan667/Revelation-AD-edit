#version 460 compatibility

// [2026-11-15] 这里必须是 Iris 认识的 image 名。skyMapImg 只是 lib/utility/Load.glsl 里的别名
// （skyMapImg -> colorimg5），而本 pass 不 include 那个文件，别名不会展开，编译出的 uniform
// 字面就叫 skyMapImg。Iris 1.12 起按名字查 image 绑定，查不到直接抛 IllegalArgumentException
// （ProgramSamplers.finish），整条 pipeline 创建失败、光影被禁用。故直接写 colorimg5。
#define CLEAR_IMAGE colorimg5
#define CLEAR_COLOR vec4(0.0)

layout (local_size_x = 16, local_size_y = 16) in;
const ivec3 workGroups = ivec3(16, 16, 1);

#include "/program/setup/ImageClear.comp"