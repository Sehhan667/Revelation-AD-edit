#version 460 compatibility

// [2026-11-27 LIGHTING_HALF_RES] 光照缓冲固定 0.5 屏（= 全分辨率的一半），与渲染缩放**不叠加**。
// 所以这里**不**按 renderScale 缩三角形：四边盖满整张缓冲，一个光照纹素覆盖
// lightingTexelScale 个画布纹素（100% 档 2.0 / 50% 档 1.0），全部由 shader 里的
// texelPos 映射处理。关掉该选项时仍走原来的按 renderScale 缩三角形（逐位不变）。
#ifdef LIGHTING_HALF_RES
	#define NO_SCALE
#endif

#include "/program/Simple.vert"
