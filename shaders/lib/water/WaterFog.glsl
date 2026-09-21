//================================================================================================//

// [2026-08-20] 水雾太阳前向散射是否受"屏幕上太阳被遮挡"影响：
// sunVisFactor 由调用方（Translucent / IntegrateScene）算好的太阳屏幕可见性（0/1）。
// 开启后，太阳被地形挡/出屏/在相机背后 → 压掉水中正对太阳方向的模糊光晕。
// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.
#ifndef UW_VOLUMETRIC_LIGHT_PHASE_FLATTEN
    #define UW_VOLUMETRIC_LIGHT_PHASE_FLATTEN 0.6
#endif
#ifndef UW_VOLUMETRIC_LIGHT_DEPTH_FALLOFF
    #define UW_VOLUMETRIC_LIGHT_DEPTH_FALLOFF 0.2
#endif
#ifndef UW_VOLUMETRIC_LIGHT_STRENGTH
    #define UW_VOLUMETRIC_LIGHT_STRENGTH 2.0
#endif
#ifndef UW_SUN_OCCLUSION
    #define UW_SUN_OCCLUSION // [OFF ON] 水雾太阳光晕受太阳是否被遮挡影响
#endif

mat2x3 AnalyticWaterFog(in float skylight, in float waterDepth, in float LdotV, in float sunVisFactor) {
	vec3 sunTransmittance = exp2(-rLOG2 * waterExtinction * mix(4.0, 1.0, worldLightDir.y));

	#if 0
		float phase = FournierForandPhase(LdotV, 1.175, 4.065);
	#else
		float phase = DualLobePhase(LdotV, 0.95, -0.6, 0.1);
	#endif
	#ifdef UW_SUN_OCCLUSION
		phase *= sunVisFactor;   // 仅压前向散射相位（光晕），保留均匀多散射环境项
	#endif

	const vec3 msV = waterAlbedo * 0.99;
	vec3 scattering = phase + uniformPhase * msV / oms(msV);
	scattering *= oms(wetnessCustom * 0.8) * global.directIlluminance * sunTransmittance;

	vec3 transmittance = exp2(-rLOG2 * waterExtinction * waterDepth);
	scattering *= oms(transmittance) * skylight;

	return mat2x3(scattering * waterAlbedo, transmittance);
}

//================================================================================================//
// [2026-09-21 水下体积雾/体积光] 混合式水下雾的纯数学部分。循环本体在 IntegrateScene.frag，
// 因为逐点阴影可见度（SampleFogSunShadow）及其阴影贴图 include 都在那边。

// 相机水深估计：由 eyeSkylightSmooth 反解。它是 smooth(pow(eyeBrightness.y / 240, 4), 5, 5)
//（shaders.properties 自定义 uniform），而水下天光随深度近似每格降 1 级（15 级制），
// 即原始天光 sky ≈ 1 - d/15 → 先开 0.25 次方还原 sky，再线性反解深度 [0,15] 格。
// 定标用的近似（5 秒平滑 → 快速下潜时深度响应偏慢；洞顶/遮蔽处偏低），只用于深度
// 渐变与增浓，不参与透射精确计算。超过 15 格后该值饱和（天光已归零）。
float EstimateCameraWaterDepth(in float skylight) {
	return saturate(1.0 - pow(skylight, 0.25)) * 15.0;
}

// 逐点散射源强：给定该点有效水深，返回单位路径 in-scatter 能量（直接相位光晕项 +
// 均匀多散射环境项）。与 AnalyticWaterFog 同一套相位/湿度/能量约定，差别仅在于：
//   · 阳光穿水柱的衰减带逐点水深（浅水几乎不衰减、深水指数变暗；旧版是深度无关常数）；
//   · 源强随深度增浓（UW_FOG_DEEP_DENSITY，深水浓蓝黑）。
// vis 为该点阴影可见度（UW_VOLUMETRIC_LIGHT 逐点采样，关 = vec3(1.0)；开启
// UW_WAVE_SHAFTS 时 vis 还乘入波面焦散调制 —— 只影响直射光束项），lightEnergy 为
// 白天太阳/夜晚月光补蓝的定向光能量（与雾中光束同一约定，调用方算好）。
vec3 WaterFogPointSource(in float pointDepth, in float LdotV, in float sunVisFactor, in vec3 vis, in vec3 lightEnergy) {
	float phase = DualLobePhase(LdotV, 0.95, -0.6, 0.1);
	// [2026-09-21 **相位压平**] 实测 g=0.95 时：0°=62、15°=0.45、30°=0.06、90°=0.006
	// ⇒ 只有太阳 ±5° 锥内可见。与均匀相位混合即"把各向异性降到 g≈0.3~0.6"，业界标准做法。
	phase = mix(phase, uniformPhase, saturate(UW_VOLUMETRIC_LIGHT_PHASE_FLATTEN));
	#ifdef UW_SUN_OCCLUSION
		phase *= sunVisFactor;   // 仅压前向散射相位（光晕），保留均匀多散射环境项
	#endif

	// 阳光/月光到达该点：穿过的水柱 = 该点水深 × 太阳高度路径系数（太阳越低路径越长）
	vec3 waterColumn = pointDepth * mix(4.0, 1.0, worldLightDir.y);
	// [2026-09-21 **光束独立深度衰减**] 光束用轻衰减（否则 10 格深处只剩 0.15、倍率调到 20 也没用）；
	// 均匀多散射环境项仍用全量水消光 —— 它是"从整个上半球漫射进来"的，物理上该被水吃光。
	vec3 shaftTransmittance = exp2(-rLOG2 * waterExtinction * waterColumn * UW_VOLUMETRIC_LIGHT_DEPTH_FALLOFF);
	vec3 ambientTransmittance = exp2(-rLOG2 * waterExtinction * waterColumn);

	const vec3 msV = waterAlbedo * 0.99;
	// [2026-09-21] 定向相位项乘 UW_VOLUMETRIC_LIGHT_STRENGTH（环境项不动）
	vec3 shaftPart = phase * vis * UW_VOLUMETRIC_LIGHT_STRENGTH * shaftTransmittance;
	vec3 ambientPart = uniformPhase * msV / oms(msV) * ambientTransmittance;
	vec3 source = shaftPart + ambientPart;
	source *= oms(wetnessCustom * 0.8) * lightEnergy;

	// 深水增浓：散射源随深度增强（透射侧的增浓在 RaymarchWaterFog 里按相机深度定标）
	source *= mix(1.0, UW_FOG_DEEP_DENSITY, saturate(pointDepth / UW_FOG_DEEP_RANGE));

	return source * waterAlbedo;
}
