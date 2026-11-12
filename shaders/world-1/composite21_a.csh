#version 460 compatibility

// Vertical blur pass: colortex19 -> colortex4 L0 canvas (ping-pong)
#define OFFSET ivec2(0, 1)
#define BLOOM_PASS 1   // [B8] 0 = horizontal (colortex4 -> colortex19), 1 = vertical (colortex19 -> colortex4)
layout (local_size_x = 1, local_size_y = 128) in;

#include "/program/post/bloom/Blur.comp"
