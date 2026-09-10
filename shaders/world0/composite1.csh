#version 460 compatibility

// SSS 屏幕空间扩散：横向（全分辨率源 colortex18 -> 半分辨率 colortex19）
#define SSS_BLUR_HORIZONTAL

#include \"/program/post/SubsurfaceBlur.comp\"
