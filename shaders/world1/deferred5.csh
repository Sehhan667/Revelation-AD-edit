#version 460 compatibility
#define DIMENSION_THE_END

// [2026-11-11 修复] 本文件此前**无条件** include VarianceEstimate —— 第十一轮把
// HistoryFix 迁到 deferred5 时只改了 world0，下界/末地漏掉了，于是这两个维度的
// NRD 链根本没有 HistoryFix（colortex25 永远是 0，整条链黑）。
// 与 world0 同口径：先 include settings.glsl 拿到派生宏再判断（guard 保证不重复展开）。
// DIMENSION_THE_END 必须写在 include 之前：settings.glsl 内部有 `#ifdef DIMENSION_THE_END`。
#include "/settings.glsl"

#if defined VOXEL_GI_NRD_ACTIVE
#include "/program/diffuse/GIHistoryFix.comp"
#else
#include "/program/diffuse/VarianceEstimate.comp"
#endif
