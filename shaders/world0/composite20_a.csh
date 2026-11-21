#version 460 compatibility

// Horizontal blur pass: colortex4 L0 canvas -> colortex19 (ping-pong)
#define OFFSET ivec2(1, 0)
// [2026-11-15] 原来这行注释以方括号 B8 开头，Iris 把方括号里的内容当成可选值列表，于是该宏被
// 登记成 string 选项；而 composite20 默认 0、composite21 默认 1，同名却默认值不同 -> Iris 判为
// Ignoring ambiguous string option 并把选项整条剔除。这里改用宏标识符（展开仍是 0/1），
// 不带方括号注释就不会进选项表，pass 语义完全不变。
#define BLOOM_PASS BLOOM_PASS_HORIZONTAL   // B8 0 = horizontal (colortex4 -> colortex19)
layout (local_size_x = 128, local_size_y = 1) in;

#include "/program/post/bloom/Blur.comp"
