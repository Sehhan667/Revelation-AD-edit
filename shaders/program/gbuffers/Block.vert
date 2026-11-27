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

out vec4 vertColor;
out vec2 texCoord;
out vec2 lightmap;
flat out uint materialID;

out vec3 worldPos;

//======// Attribute //===========================================================================//

in vec4 at_tangent;

//======// Uniform //=============================================================================//

uniform int blockEntityId;

uniform mat4 gbufferModelView;
uniform mat4 gbufferModelViewInverse;

uniform vec2 taaJitter;

//======// Main //================================================================================//
void main() {
	vertColor = gl_Color;
	texCoord = mat2(gl_TextureMatrix[0]) * gl_MultiTexCoord0.xy + gl_TextureMatrix[0][3].xy;

	lightmap = saturate((gl_MultiTexCoord1.xy - 8.0) * rcp(232.0));

	materialID = uint(blockEntityId - 10000);

	vec3 viewPos = transMAD(gl_ModelViewMatrix, gl_Vertex.xyz);
	gl_Position = diagonal4(gl_ProjectionMatrix) * viewPos.xyzz + gl_ProjectionMatrix[3];
	worldPos = transMAD(gbufferModelViewInverse, viewPos);

	#ifdef TAA_ENABLED
		gl_Position.xy += taaJitterScaled * gl_Position.w;
	#endif

	#if RENDER_SCALE_1000X != 1000
		gl_Position.xy = gl_Position.xy * renderScale + (renderScale - 1.0) * gl_Position.w;
	#endif
}
