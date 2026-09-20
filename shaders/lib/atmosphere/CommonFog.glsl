void RenderVanillaFog(inout vec3 scene, inout float fogTransmittance, in float viewDistance) {
    // Lava fog
	#ifdef LAVA_FOG
		if (isEyeInWater == 2) {
			fogTransmittance = exp2(-4.0 * viewDistance);
			scene = mix(vec3(3.96, 0.68, 0.02) * EMISSIVE_BRIGHTNESS, scene, fogTransmittance);
		}
	#endif

    // Powdered snow fog
	#ifdef POWDERED_SNOW_FOG
		if (isEyeInWater == 3) {
			fogTransmittance = exp(-viewDistance);

			vec3 scattering = global.skyUpIlluminance + global.directIlluminance * rPI;
			scene = mix(scattering * 0.25 * eyeSkylightSmooth, scene, fogTransmittance);
		}
	#endif

    // Blindness and darkness fog
	#ifdef BLINDNESS_DARKNESS_FOG
	    // [2026-09-20] BLINDNESS_STRENGTH（settings.glsl，GUI 在 Fog 页）：失明项的总强度倍率，
	    // 直接乘进指数衰减率——1.0 = 原版行为，0.0 = 完全关闭失明压黑（exp(0)=1），
	    // >1.0 = 同等失明等级下黑得更快更近。只影响失明，不影响黑暗效果项。
	    scene *= exp(-viewDistance * blindness * BLINDNESS_STRENGTH);
	    scene *= smoothstep(12.0, 2.0, darknessFactor * viewDistance);
	#endif
}