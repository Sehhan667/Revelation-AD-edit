//================================================================================================//

// [2026-08-20] 水雾太阳前向散射是否受"屏幕上太阳被遮挡"影响：
// sunVisFactor 由调用方（Translucent / IntegrateScene）算好的太阳屏幕可见性（0/1）。
// 开启后，太阳被地形挡/出屏/在相机背后 → 压掉水中正对太阳方向的模糊光晕。
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
// 体积雾（体积焦散）分支已禁用，仅保留分析水体雾
//#if defined PASS_VOLUMETRIC_FOG
//	... (RaymarchWaterFog 已移除)
//#endif