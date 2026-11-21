#version 460 compatibility

// Horizontal blur pass: colortex4 L0 canvas -> colortex19 (ping-pong)
#define OFFSET ivec2(1, 0)
#define BLOOM_PASS BLOOM_PASS_HORIZONTAL   // B8 0 = horizontal；用标识符避免进选项表，理由见 world0/composite20_a
layout (local_size_x = 128, local_size_y = 1) in;

#include "/program/post/bloom/Blur.comp"
