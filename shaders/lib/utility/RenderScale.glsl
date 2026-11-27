/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

	Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.

	Render scale helpers.

	RENDER_SCALE_1000X != 1000 时，世界几何只画到每张全屏缓冲的左下角
	RENDER_SCALE x RENDER_SCALE 区域。本包保持"全屏像素坐标"体系：
	画布 texel 仍是全屏 texel 坐标（范围 0..scaledViewSize），因此
	- 采样全屏纹理时用画布 uv（0..RENDER_SCALE）直接乘 viewSize，不需要额外换算；
	- 只有"画布 uv 0..1"与"全屏 uv"之间互转的地方才需要这里的宏。
	1000 档两个宏都退化为恒等，不产生任何额外指令。

--------------------------------------------------------------------------------
*/

#ifndef RENDER_SCALE_1000X
	#define RENDER_SCALE_1000X 1000
#endif
#ifndef RENDER_SCALE
	#define RENDER_SCALE 1.0
#endif
#ifndef RENDER_SCALE_HALF
	#define RENDER_SCALE_HALF 0.5
#endif

// 缩放域尺寸统一由 settings.glsl 的宏推导（不依赖 shaders.properties 的选项宏注入）。
// 使用处必须已经 include 过 Uniform.glsl（提供 viewSize / viewPixelSize）。
#define scaledViewSize		(viewSize * RENDER_SCALE)
#define scaledHalfViewSize	(viewSize * RENDER_SCALE_HALF)
#define scaledTexelSize		(viewPixelSize / RENDER_SCALE)
#define renderScale			(vec2(RENDER_SCALE))

// [2026-11-27] 光照半分辨率（LIGHTING_HALF_RES）的坐标口径：
// 光照**有效区域**永远按全分辨率的一半（0.5 屏），不随渲染缩放再除一次 —— 否则 50% 档会变成
// 「一半的一半」（1/4 屏），两级 2x 上采样串联会把光影糊成毛玻璃。
// 注意缓冲本身仍是**全屏尺寸**（不写 size.buffer）：0.5 尺寸的颜色目标会和全屏深度附件尺寸不一致，
// pass 只覆盖一部分，表现为「屏幕上一个大三角区域」。这与 colortex4 泛光 tile、启动面板用的
// 「全尺寸缓冲 + 只写左下象限」是同一套路。
// 一个光照纹素覆盖的画布纹素数是随挡位变的：
//   100% 档 → 2.0（光照 = 半画布）      75% 档 → 1.5      50% 档 → 1.0（= 画布 1:1）
#define lightingViewSize	(viewSize * 0.5)
#define lightingTexelScale	(RENDER_SCALE * 2.0)

// taaJitter 本身按最终画面（全屏）像素计算，TAA 的历史/输出也是最终画面，
// 所以这里**不再**换算到画布像素：抖 1 个画布像素等于抖 2 个全屏像素，会让时域平均失效、噪点翻倍。
// 顶点/Transform/TAA/云都统一用这个（1000 档与 taaJitter 相同）。
#define taaJitterScaled		(taaJitter)

#if (RENDER_SCALE_1000X != 1000)
	// 画布 texel -> 全屏 texel（两者都在全屏像素坐标系里，仅差一个比例）
	#define scaleTexelPos(texelPos) ivec2(vec2(texelPos) * renderScale)
	// 画布 uv 0..1 -> 全屏 uv 0..RENDER_SCALE
	#define scaleScreenUv(uv) ((uv) * renderScale)
#else
	#define scaleTexelPos(texelPos) (texelPos)
	#define scaleScreenUv(uv) (uv)
#endif
