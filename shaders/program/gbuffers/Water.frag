/*
--------------------------------------------------------------------------------

    Revelation Shaders

    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.





    Optimized: reduced redundant screen coordinate computation.
               Added WATER_WAVE_SAMPLES macro for wave detail control.
--------------------------------------------------------------------------------

*/

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

// [2026-11-12 P2] 这个 pass 不再写 colortex8（法线缓冲）：水面与玻璃的法线都走
// colortex12.y（8bit oct, UNORM 编码），配 colortex12.x 的哨兵区分：
//   x > 0 = 水面（x 存 水深/255）、x < 0 = 玻璃（写 -1）、x == 0 = 非半透明（c12 每帧清 0）。
// 省下 8 B/px（水面/玻璃像素的 c8 写入），读取侧统一走 lib/universal/Fetch.glsl 的
// FetchTranslucentNormal —— c8 再也不会在半透明像素上被读到。
// [2026-11-12 试验] 先按用户要求把 c8（法线缓冲）还原：水/玻璃重新写 c8，
// c6（玻璃 albedo）与 c12（哨兵 + 8bit 法线）暂时都保留，便于逐个关掉定位。
// 恢复正常后再决定最终保留哪几路（当前是 28 B/px，比原来 24 B/px 多）。
/* RENDERTARGETS: 6,7,8,12 */
layout (location = 0) out vec4 albedoOut;    // c6：玻璃的真实 albedo（水写 0）
layout (location = 1) out uvec4 materialOut;
layout (location = 2) out vec4 normalOut;    // c8：法线（还原）
layout (location = 3) out vec4 waterOut;

//======// Uniform //=============================================================================//

uniform sampler2D tex;

#if defined MC_NORMAL_MAP
    uniform sampler2D normals;
#endif

#if defined MC_SPECULAR_MAP
    uniform sampler2D specular;
#endif

#include "/lib/universal/Uniform.glsl"

//======// SSBO //================================================================================//

#include "/lib/universal/SSBO.glsl"

//======// Input //===============================================================================//

flat in uint normalPack;
flat in uvec2 tangentPack;

in vec4 vertColor;
in vec2 texCoord;
in vec2 lightmap;
flat in uint materialID;

in vec3 worldPos;

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Random.glsl"

//#define PHYSICS_OCEAN_SUPPORT

// 🌊 波浪细节控制宏（可在外层 config 中定义，1~5，默认 2）
#ifndef WATER_WAVE_SAMPLES
    #define WATER_WAVE_SAMPLES 2 // [1 2 3 4 5]
#endif

#ifdef PHYSICS_OCEAN
    #define PHYSICS_FRAGMENT
    #include "/lib/water/PhysicsOceans.glsl"
#else
    #include "/lib/water/WaterWave.glsl"
#endif

//======// Main //================================================================================//
void main() {
    // 预先计算屏幕坐标，供后续水体分支复用
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;

    vec2 geometryNormalOct = unpackSnorm2x16(normalPack);
    normalOut.xy = geometryNormalOct;                 // c8：几何法线（还原）

    // 构建 TBN 矩阵
    vec3 tangent   = OctDecodeSnorm(unpackSnorm2x16(tangentPack.x));
    vec3 normal    = OctDecodeSnorm(geometryNormalOct);
    vec3 bitangent = cross(tangent, normal) * uintBitsToFloat(tangentPack.y);
    mat3 tbnMatrix = mat3(tangent, bitangent, normal);

    if (materialID == 3u) { // 水面
        ivec2 texel = ivec2(gl_FragCoord.xy);
        vec3 worldDir = normalize(worldPos - gbufferModelViewInverse[3].xyz);

        vec3 worldNormal;
        #ifdef PHYSICS_OCEAN
            WavePixelData wave = physics_wavePixel(physics_localPosition.xz, physics_localWaviness, physics_iterationsNormal, physics_gameTime);
            worldNormal = wave.normal;
        #else
            vec3 minecraftPos = worldPos + cameraPosition;
            #ifdef WATER_PARALLAX
                worldNormal = CalculateWaterNormal(minecraftPos, worldDir * tbnMatrix);
            #else
                worldNormal = CalculateWaterNormal(minecraftPos);
            #endif
            worldNormal = tbnMatrix * worldNormal;
        #endif

        float depth1 = loadDepth1(texel);
        vec3 viewPos1  = ScreenToViewPos(vec3(screenCoord, depth1));
        vec3 worldPos1 = transMAD(gbufferModelViewInverse, viewPos1);

        // [2026-11-12 P2] 波法线写进 c12.y（OctEncodeUnorm -> Packup2x8 是配套的 [0,1] 编码；
        // 原来写的是 OctEncodeSnorm 却用 Packup2x8/OctDecodeUnorm 解码，负数分量会被折返 ——
        // 这也顺手修掉了 TRANSLUCENT_SKY_REF 里那份潜在的错法线。
        albedoOut = vec4(0.0);   // 水面不需要 albedo（水体着色由 Translucent 做）
        vec2 waterOct = OctEncodeSnorm(worldNormal);
        normalOut.zw = waterOct;                  // c8：波法线（还原）
        waterOut = vec4(distance(worldPos, worldPos1) * rcp255,
                        Packup2x8(OctEncodeUnorm(worldNormal)), 0.0, 1.0);
    } else { // 不透明 / 半透明物体
        vec4 albedo = texture(tex, texCoord) * vertColor;

        if (albedo.a < 0.1) { discard; return; }

        vec3 glassNormal;
        #if defined MC_NORMAL_MAP
            vec3 normalTex = texture(normals, texCoord).rgb;
            DecodeNormalTex(normalTex);
            glassNormal = tbnMatrix * normalTex;
        #else
            glassNormal = normal;
        #endif

        // [2026-11-12 W6] 玻璃颜色改走标准 albedo 缓冲 c6（以前只塞在 c7.zw 的打包里，
        // 一旦打包/解包链路有任何问题就表现为「染色玻璃没颜色」）。alpha 强制 1.0：
        // 玻璃纹理的 alpha 不该被当成染色指数用。
        albedoOut = vec4(albedo.rgb, 1.0);
        normalOut.zw = OctEncodeSnorm(glassNormal);   // c8：玻璃法线（还原）
        materialOut.z = Packup2x8U(albedo.xy);
        materialOut.w = Packup2x8U(albedo.zw);
        // 玻璃：x = -1 哨兵（非水面），法线同样走 c12.y
        waterOut = vec4(-1.0, Packup2x8(OctEncodeUnorm(glassNormal)), 0.0, 1.0);
    }

    materialOut.x = PackupDithered2x8U(lightmap, bayer4(gl_FragCoord.xy));
    materialOut.y = materialID;

    // [2026-09-22] 清除 colortex7.w 的低 2 位（实体 bit0 / 受伤 bit1），防止打包的
    // albedo 数据泄露成标志位。与 Block.frag / Terrain.frag 已有的处理一致。
    // 水面 materialID=3u，不会被实体故障的 `materialID != 1u` 排除 ⇒ 漏清会让约
    // 1/4 的水面像素被误判成"受伤实体"，进而被故障特效硬替换成位移采样（画面变暗）。
    materialOut.w &= 0xFCu;
}