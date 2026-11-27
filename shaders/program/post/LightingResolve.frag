/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

	Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.

	Pass: deferred24 —— 光照半分辨率的还原（仅 LIGHTING_HALF_RES 开启时调度）

	DeferredLight(deferred20) 在 0.5 屏的缓冲里算出两个量（**永远**按全分辨率的一半，
	不随渲染缩放再除一次，避免两级 2x 上采样串联）：
	  colortex11 = 光照系数（**没有**乘 albedo）
	  colortex10 = 附加色（反射 / 直射高光 / 体素 GI / 天空 / 玻璃水面底色）
	本 pass 在画布分辨率把它们做深度感知上采样，再乘**全分辨率** albedo：

	    sceneOut = light * albedo + extra

	上采样比值 = lightingTexelScale（100% 档 2.0；50% 档 1.0，此时等价 1:1 直通）。

	为什么不直接在半分辨率乘好 albedo 再上采样：albedo 是纹理细节（高频），一旦进了
	半分辨率缓冲就再也回不来了 —— 那是「整屏糊」，不是「光影轮廓软」。这里只让光照
	变软，纹理保持 1:1。

	边界：上采样权重用相对视深差（12.5% 以上判为不同表面），几何轮廓处不会把背后的
	光照拖到前景；权重全灭时退化为最近邻，避免黑边。

--------------------------------------------------------------------------------
*/

//======// Output //==============================================================================//

/* RENDERTARGETS: 0 */
layout(location = 0) out vec3 sceneOut;

//======// Uniform //=============================================================================//

#include "/lib/Utility.glsl"

#include "/lib/universal/Uniform.glsl"
#include "/lib/universal/Transform.glsl"

// colortex11 只在本 pass 里被读 ⇒ 采样器就地声明，避免全局 Uniform.glsl 给它添一条
// 用不到的采样器（关闭 LIGHTING_HALF_RES 时连这个 pass 都不会被编译）。
uniform sampler2D colortex11;

//======// Function //============================================================================//

// 相对视深差 → 上采样权重：差 12.5% 及以上判为不同表面（权重 0）。
// 阈值口径与 SpatialUpscale 的 GI 上采样一致（那边是 1%/3%/5% 三档，这里放宽：
// 光照比 GI 更低频，过紧会在斜面上出现块状拼接）。
float LightDepthWeight(float zCenter, float zTap) {
	float rel = abs(zCenter - zTap) * rcp(max(abs(zCenter), abs(zTap)) + 1e-3);
	return saturate(1.0 - rel * 8.0);
}

//======// Main //================================================================================//

void main() {
	ivec2 texelPos = ivec2(gl_FragCoord.xy);

	// 顶点入口用 NO_SCALE 的整屏三角形（保证斜边永远在画面外），所以这里必须自己裁画布：
	// 画布外没有读者，写 0 早退。不裁的话那些纹素会被写入垃圾值，再被 TAA 的双线性边缘带进来。
	if (any(greaterThanEqual(texelPos, ivec2(scaledViewSize)))) {
		sceneOut = vec3(0.0);
		return;
	}

	// 光照有效区域固定 = 左下 0.5 屏（缓冲本身是全屏尺寸，只用了这一块）
	ivec2 lightEnd = max(ivec2(lightingViewSize) - 1, ivec2(0));
	ivec2 canvasEnd = ivec2(scaledViewSize) - 1;

	// 画布 texel → 光照纹素的双线性位置：一个光照纹素覆盖 lightingTexelScale 个画布纹素
	// （100% 档 = 2，50% 档 = 1 ⇒ 此时是 1:1 直通）
	vec2 lightPos = (vec2(texelPos) + 0.5) * rcp(lightingTexelScale);
	ivec2 base = ivec2(floor(lightPos - 0.5));
	vec2 f = saturate(lightPos - 0.5 - vec2(base));

	float zCenter = ScreenToViewDepth(loadDepth0(texelPos));

	vec3 lightSum = vec3(0.0);
	vec3 extraSum = vec3(0.0);
	float wSum = 0.0;

	ivec2 offs[4] = ivec2[4](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 1));
	float tents[4] = float[4]((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y),
	                          (1.0 - f.x) * f.y, f.x * f.y);

	for (int i = 0; i < 4; ++i) {
		ivec2 lt = clamp(base + offs[i], ivec2(0), lightEnd);
		// 该光照纹素对应的画布 texel（覆盖块的左上角）的全分辨率深度
		float zTap = ScreenToViewDepth(loadDepth0(min(ivec2(vec2(lt) * lightingTexelScale), canvasEnd)));
		float w = tents[i] * LightDepthWeight(zCenter, zTap);
		lightSum += texelFetch(colortex11, lt, 0).rgb * w;
		extraSum += texelFetch(colortex10, lt, 0).rgb * w;
		wSum += w;
	}

	// 权重全灭（几何轮廓处）⇒ 退化为最近邻，避免出现黑缝
	if (wSum < 1e-4) {
		ivec2 lt = clamp(base, ivec2(0), lightEnd);
		lightSum = texelFetch(colortex11, lt, 0).rgb;
		extraSum = texelFetch(colortex10, lt, 0).rgb;
		wSum = 1.0;
	}

	// albedo 与 DeferredLight 里的取法必须完全一致（同一个 gbuffer、同一条 sRGB 解码）
	vec3 albedo = sRGBToLinear(loadAlbedo(texelPos));

	sceneOut = (lightSum * rcp(wSum)) * albedo + extraSum * rcp(wSum);
}
