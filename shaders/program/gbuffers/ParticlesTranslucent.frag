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

/* RENDERTARGETS: 7,8 */
layout (location = 0) out uvec4 materialOut;
layout (location = 1) out vec4 normalOut;

//======// Input //===============================================================================//

in vec3 worldPos;

in vec4 vertColor;
in vec2 texCoord;
in vec2 lightmap;

//======// Uniform //=============================================================================//

uniform sampler2D tex;

//======// Main //================================================================================//
void main() {
	vec4 albedo = texture(tex, texCoord) * vertColor;

	if (albedo.a < 0.1) { discard; return; }

	materialOut.x = Packup2x8U(lightmap);
	materialOut.y = 500u;

	materialOut.z = Packup2x8U(albedo.xy);
	materialOut.w = Packup2x8U(albedo.zw);

	vec3 geoNormal = normalize(cross(dFdx(worldPos), dFdy(worldPos)));

	normalOut.xy = OctEncodeSnorm(geoNormal);
	normalOut.zw = normalOut.xy;

	// [2026-09-22] 清除 colortex7.w 的低 2 位（实体/受伤标志），防止打包的 albedo
	// 泄露成标志位。与 Block.frag / Terrain.frag 已有的处理一致。
	materialOut.w &= 0xFCu;
}