#version 460 compatibility

// [2026-11-27] 强制整屏三角形：不乘 renderScale。
// 原因：Simple.vert 的三角形顶点是 (0,0),(2,0),(0,2)，缩放后斜边只是**刚好**过画布右上角；
// 一旦哪一档的取整差一点，斜边就会落进画面里，表现为「屏幕上一个大三角区域、外面内容不对」。
// 这里让三角形永远盖满整张缓冲，画布外的片元由 LightingResolve.frag 里的早退丢掉。
#define NO_SCALE

#include "/program/Simple.vert"
