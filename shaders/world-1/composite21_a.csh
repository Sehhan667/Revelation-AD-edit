#version 460 compatibility

// Vertical blur pass: colortex19 -> colortex4 L0 canvas (ping-pong)
#define OFFSET ivec2(0, 1)
#define BLOOM_PASS BLOOM_PASS_VERTICAL     // B8 1 = vertical；用标识符避免进选项表，理由见 world0/composite20_a
layout (local_size_x = 1, local_size_y = 128) in;

#include "/program/post/bloom/Blur.comp"
