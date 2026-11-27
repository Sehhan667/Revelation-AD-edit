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

flat out uint normalPack;
#if defined MC_NORMAL_MAP
flat out uvec2 tangentPack;
#endif

out vec4 vertColor;
out vec2 texCoord;
out vec2 lightmap;

//======// Attribute //===========================================================================//

in vec4 at_tangent;

//======// Uniform //=============================================================================//

uniform mat4 gbufferModelViewInverse;

uniform vec2 taaJitter;

//======// Main //================================================================================//
void main() {
	vertColor = gl_Color;
	texCoord = mat2(gl_TextureMatrix[0]) * gl_MultiTexCoord0.xy + gl_TextureMatrix[0][3].xy;

	lightmap = saturate((gl_MultiTexCoord1.xy - 8.0) * rcp(232.0));

	vec3 viewPos = transMAD(gl_ModelViewMatrix, gl_Vertex.xyz);
	// worldPos = transMAD(gbufferModelViewInverse, viewPos);
	gl_Position = diagonal4(gl_ProjectionMatrix) * viewPos.xyzz + gl_ProjectionMatrix[3];

	#ifdef TAA_ENABLED
		gl_Position.xy += taaJitterScaled * gl_Position.w;
	#endif

	#if RENDER_SCALE_1000X != 1000
		gl_Position.xy = gl_Position.xy * renderScale + (renderScale - 1.0) * gl_Position.w;
	#endif

	// Encode normal and tangent
	vec3 normal = mat3(gbufferModelViewInverse) * normalize(gl_NormalMatrix * gl_Normal);
	normalPack = packSnorm2x16(OctEncodeSnorm(normal));
	#if defined MC_NORMAL_MAP
		vec3 tangent = mat3(gbufferModelViewInverse) * normalize(gl_NormalMatrix * at_tangent.xyz);
		tangentPack.x = packSnorm2x16(OctEncodeSnorm(tangent));
		tangentPack.y = (floatBitsToUint(at_tangent.w) & 0x80000000u) | 0x3F800000u;
	#endif
}
