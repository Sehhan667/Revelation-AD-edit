// [2026-11-12 P2] 半透明（水面/玻璃）的法线只在 colortex12.y（8bit oct, UNORM 编码），
// gbuffers_water 不再写 colortex8。colortex12.x 是哨兵：>0 = 水面（x = 水深/255），
// <0 = 玻璃（-1），== 0 = 非半透明（c12 每帧清 0）。所有读 c8 的地方都必须先走这里，
// 否则会读到「上一帧残留的陆地法线」。
bool FetchTranslucentNormal(in ivec2 texel, out vec3 normal) {
	vec4 info = texelFetch(colortex12, texel, 0);
	if (info.x != 0.0) {
		normal = OctDecodeUnorm(Unpack2x8(info.y));
		return true;
	}
	return false;
}

vec3 FetchGeometryNormal(in ivec2 texel) {
	vec3 n;
	if (FetchTranslucentNormal(texel, n)) return n;
	return OctDecodeSnorm(loadNormalPack(texel).xy);
}

vec3 FetchSurfaceNormal(in ivec2 texel) {
	vec3 n;
	if (FetchTranslucentNormal(texel, n)) return n;
	return OctDecodeSnorm(loadNormalPack(texel).zw);
}

void FetchNormalData(in ivec2 texel, out vec3 geometryNormal, out vec3 surfaceNormal) {
	vec3 transNormal;
	if (FetchTranslucentNormal(texel, transNormal)) {
		geometryNormal = transNormal;   // 水面/玻璃没有「几何法线 / 法线贴图」之分
		surfaceNormal = transNormal;
		return;
	}
	vec4 pack = loadNormalPack(texel);
	geometryNormal = OctDecodeSnorm(pack.xy);

	#if defined MC_NORMAL_MAP || defined PASS_TRANSLUCENT
		surfaceNormal = OctDecodeSnorm(pack.zw);
	#else
		surfaceNormal = geometryNormal;
	#endif
}

vec4 ExtractSpecularTex(in uvec4 pack) {
	return vec4(Unpack2x8U(pack.z), Unpack2x8U(pack.w));
}