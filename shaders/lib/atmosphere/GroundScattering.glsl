/*
--------------------------------------------------------------------------------
	Revelation Shaders — 地面大气散射 / 空气透视 (Ground Atmospheric Scattering)

	视线穿过低层大气时，空气分子（瑞利）与气溶胶（米氏）一边按指数律吸掉地形本身
	的光，一边把太阳直射光与天光散射进这条视线。净效果即"空气透视"：越远的地形
	本征颜色越淡、越接近大气散射色——白天偏蓝（瑞利胜），朝太阳方向偏暖（米氏前向峰）。

	本层与体积雾（lib/atmosphere/AtmosphericFog.glsl）的分工：
		体积雾 = 可随高度/时段/噪声起伏的"雾体"，带云影与光轴，负责近中场；
		本层   = 不含噪声、不被时段消隐的"空气透视底噪"，负责中远场的色彩与对比度衰减。
	两者独立开关、各有浓度旋钮；同时开启是叠加关系（远景总雾量 ≈ 两者之和）。

	单次散射的闭式近似（逐像素常数开销，无光线步进）：
		T(λ) = exp( -σ_t(λ) · s )                        视线透射率（逐通道，蓝通道消光最强）
		out  = in · T + (1 - T) · [ E_sky·(1/4π) + p(μ)·E_sun ]
	σ_t 直接复用天空模型的瑞利/米氏系数（与 Hillaire 天空 LUT 同一套大气参数 → 远景
	色相与天空、体积雾自洽）；E_sky / E_sun 用本包 global.skyUpIlluminance /
	global.directIlluminance，与体积雾的入散射同量纲，因此亮度无需额外标定。

	s 是视线在地面大气中的路径长度。物理上贴地百余格路径在蓝通道只有 5e-3 量级光学
	厚度，肉眼几乎看不出空气透视，故按 GROUND_SCATTER_PATH_SCALE 统一放大，并暴露
	GS_DENSITY 供现场增减（空气透视本身是"看得见的夸张"，标定值见下方常量注释）。
--------------------------------------------------------------------------------






	Added for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
	Copyright 2026 AnotherCream.
*/

// 参数兜底默认值（与 settings.glsl 一致；GUI 解压后通常由 settings 定义覆盖）
#ifndef GS_DENSITY
	#define GS_DENSITY 3.0
#endif
#ifndef GS_SKY_BRIGHTNESS
	#define GS_SKY_BRIGHTNESS 1.0
#endif
#ifndef GS_SUN_BRIGHTNESS
	#define GS_SUN_BRIGHTNESS 0.1
#endif
#ifndef GS_MIE_G
	#define GS_MIE_G 0.2
#endif
#ifndef GS_RAIN_BOOST
	#define GS_RAIN_BOOST 4.0
#endif

// 地面视线的"空气量放大基数"。
// 物理值：贴地 128 格 × 蓝通道 4.08e-5 /m ≈ 5.2e-3 光学厚度 → (1-T) ≈ 0.5%，
// 屏幕上完全看不出空气透视。放大 20 倍后 128 格处 (1-T) ≈ 0.12（蓝）/ 0.035（红）
//（相机 y≈64、瑞利/米氏密度 0.96/0.80 代入实算），远景开始明显偏蓝、朝太阳方向
// 出现暖色雾霭，而近景几乎不受影响（近处 (1-T) ∝ s，10 格处 < 1%）。
// 之所以是常数而不是滑条：可调区间完全由 GS_DENSITY 覆盖（见下），多一个旋钮只会更乱。
const float GROUND_SCATTER_PATH_SCALE = 20.0;

//================================================================================================//

// 返回 mat2x3(scattering, transmittance)，与 RaymarchAtmosphericFog / AnalyticWaterFog 同约定，
// 可直接交给 lib/Utility.glsl 的 ApplyFog(scene, fog) 使用。
//
// worldDir      视线方向（世界空间，单位向量）
// rayDistance   视线在地面大气中的路径长度（米，= 到该像素几何体的距离）
// skyLight      天空可见度门控（0 = 洞穴/室内，1 = 露天；传 eyeSkylightSmooth）
// sunVisibility 屏幕上太阳可见度（0..1，传 CalcSunScreenVisibility() 的结果）
mat2x3 AnalyticGroundScattering(in vec3 worldDir, in float rayDistance, in float skyLight, in float sunVisibility) {
	const float LOG2_E = 1.4426950408889634; // log2(e)：exp(-x) = exp2(-x·log2(e))

	// ---- 视线所在高度的空气密度（随高度按标高指数衰减：相机爬升 → 空气透视自然变薄）----
	// 高度约定与天空模型一致（y = 0 对应 VIEWER_BASE_ALTITUDE），保证与天空 LUT 同源。
	float altitude = VIEWER_BASE_ALTITUDE + max0(cameraPosition.y);
	vec3 airDensity = AtmosphereDensityAtPoint(vec3(0.0, atmosphere.bottomRadius + altitude, 0.0));

	// ---- 逐通道消光 → 透射率 ----
	// 只计瑞利 + 米氏：臭氧层标高 25 km，贴地路径上密度≈0（AtmosphereDensityAtPoint.z 在
	// 地面高度就是 0），带上它只是白加一次乘法。
	vec3 extinction = atmosphere.rayleighScattering * airDensity.x + atmosphere.mieExtinction * airDensity.y;

	// 路径长度 × 浓度。雨天（wetness）增浓：能见度下降是雨雾最主要的观感来源。
	// 浓度与路径长度在数学上等价（都只作用在 σ_t·s 上），因此只留一个总浓度旋钮，
	// 不设"路径倍数"这类会与浓度互相打架的并行滑条。
	float pathScale = GS_DENSITY * GROUND_SCATTER_PATH_SCALE * (1.0 + wetness * GS_RAIN_BOOST);
	vec3 transmittance = exp2(-extinction * (rayDistance * pathScale) * LOG2_E);

	// ---- 入散射：各向同性天空项 + 气溶胶前向太阳项 ----
	// 天空项 = 上半球辐照度 × 均匀相函数（1/4π），与体积雾的 ambient 项完全同量纲；
	// 太阳项 = 直射辐照度 × HG 相函数，g 越大越集中在太阳方向（"远景朝太阳发暖"）。
	vec3 skyScattering = global.skyUpIlluminance * (uniformPhase * GS_SKY_BRIGHTNESS);
	float sunPhase = HenyeyGreensteinPhase(dot(worldLightDir, worldDir), GS_MIE_G);
	vec3 sunScattering = global.directIlluminance * (sunPhase * GS_SUN_BRIGHTNESS) * sunVisibility;

	// 天空可见度门控：与体积雾的地面路径同款 clamp(sky*0.8+0.2) —— 洞穴/室内远景只保留
	// 20% 底雾而不是完全归零，观感与体积雾一致（房内/洞口看向远处时仍保留空气透视）。
	// 层内不再叠加其他门控：如不喜欢室内这层淡蓝雾，直接调小 GS_DENSITY。
	vec3 scattering = (skyScattering + sunScattering) * clamp(skyLight * 0.8 + 0.2, 0.0, 1.0);

	// (1 - T) 作饱和权重：近处近似线性增长、远处收敛到散射色（单次散射的标准廉价形式）。
	return mat2x3(scattering * (vec3(1.0) - transmittance), transmittance);
}
