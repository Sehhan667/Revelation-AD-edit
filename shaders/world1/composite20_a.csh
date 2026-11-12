#version 460 compatibility

// Horizontal blur pass: colortex4 L0 canvas -> colortex19 (ping-pong)
#define OFFSET ivec2(1, 0)
#define BLOOM_PASS 0   // [B8] 0 = horizontal (colortex4 -> colortex19), 1 = vertical (colortex19 -> colortex4)
layout (local_size_x = 128, local_size_y = 1) in;

#include "/program/post/bloom/Blur.comp"
