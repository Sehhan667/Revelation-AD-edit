/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

--------------------------------------------------------------------------------
*/

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 6,7,8 */
layout (location = 0) out vec4 albedoOut;
layout (location = 1) out uvec4 materialOut;
layout (location = 2) out vec4 normalOut;

// [2026-10-06 视差阴影接线] DH（远景）方块同样会进 deferred 的直射阳光分支，必须写 POM 阴影通道：
// colortex0 每帧不清（config.glsl colortex0Clear = false），本程序不写的话 deferred 的
// shadow *= 1 - colortex0.x 会读到上一帧画面的红通道 → 整片远景被按上一帧亮度压暗。
// DH 地形恒在视差距离（64 m）之外，故固定写 0 = 无自阴影。
#if defined PARALLAX && defined PARALLAX_SHADOW && !defined PARALLAX_DEPTH_WRITE
/* RENDERTARGETS: 6,7,8,0 */
layout (location = 3) out float parallaxShadowOut;
#endif

//======// Input //===============================================================================//

flat in vec3 geoNormal;
in vec3 worldPos;

in vec3 vertColor;
in vec2 lightmap;
flat in uint materialID;

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Random.glsl"

//======// Main //================================================================================//
void main() {
    float alpha = smoothstep(sqr(far - 32.0), sqr(far - 16.0), sdot(worldPos));
	float dither = BlueNoise(ivec2(gl_FragCoord.xy), frameCounter);

    if (alpha < dither) {
        discard;
        return;
    }

	albedoOut = vec4(vertColor, 1.0);
	/* Terrain noises */ {
		const float res = 8.0;
		const float strength = 0.5;

		mat3 tbnMatrix = BuildOrthonormalBasis(geoNormal);

		vec2 noisePos = ((worldPos + cameraPosition) * tbnMatrix).xy;
		float noise = texture(noisetex, noisePos * (res / 256.0)).x * 2.0;

		albedoOut.rgb = pow(albedoOut.rgb, vec3(mix(1.0, noise, strength)));
	}

	#ifdef WHITE_WORLD
		albedoOut = vec4(1.0);
	#endif

	materialOut.x = Packup2x8U(lightmap);
	materialOut.y = materialID;
	materialOut.zw = uvec2(0);

	normalOut.xy = OctEncodeSnorm(geoNormal);
	normalOut.zw = normalOut.xy;

	#if defined PARALLAX && defined PARALLAX_SHADOW && !defined PARALLAX_DEPTH_WRITE
		parallaxShadowOut = 0.0;
	#endif
}