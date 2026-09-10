#version 460 compatibility

// SSS screen-space diffusion: horizontal pass (half-res colortex18 -> colortex19)
#define SSS_BLUR_HORIZONTAL

#include "/program/post/SubsurfaceBlur.comp"
