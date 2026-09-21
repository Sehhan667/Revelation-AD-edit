/*
--------------------------------------------------------------------------------

    Revelation Shaders (Ultra Performance Edition - Horizon Fix Removed)

    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.





    Pass: Compute refraction, combine translucent and fog
    Optimizations: 
      - Sky-bypass early Z culling.
      - Zero-iteration screen space projection refraction.
      - Full-resolution inline analytical fog (Zero bandwidth upscale).
      - Removed unused LdotV calculation.
    Note: Horizon blending (edgeFactor) removed for performance / compatibility.
--------------------------------------------------------------------------------

*/

#define PASS_COMPOSITE

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 0 */
layout (location = 0) out vec4 sceneOut;

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// SSBO //================================================================================//

#include "/lib/universal/SSBO.glsl"

//======// Struct //==============================================================================//

#include "/lib/universal/Material.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"
#include "/lib/universal/Random.glsl"

#include "/lib/atmosphere/Common.glsl"

#include "/lib/atmosphere/AtmosphericFog.glsl" 
#include "/lib/atmosphere/GroundScattering.glsl"
#include "/lib/atmosphere/CommonFog.glsl"
#include "/lib/SpatialUpscale.glsl"

#include "/lib/water/WaterFog.glsl"
#include "/lib/surface/BRDF.glsl"
#include "/lib/surface/SSRT.glsl"

// 雾中光束（VOLUMETRIC_LIGHT）需要阴影采样：阴影形变 + 体素平铺 Shift
//（与体素 GI 同约定）。
#include "/lib/lighting/shadow/Common.glsl"
#include "/lib/lighting/VoxelLighting.glsl"

//======// SSS 屏幕空间扩散 ======================================================================//

#ifdef SUBSURFACE_SCATTERING_DIFFUSION
    // SSS 源项（半分辨率，未模糊）与纵向模糊结果，均由 DeferredLight/composite1/composite3 写入
    uniform sampler2D colortex18;
    uniform sampler2D colortex20;
#endif

// 雾中光束的阴影采样（实心挡=0，直射=1；COLORED_VOLUMETRIC_FOG 开启时穿玻璃=玻璃吸收色）
uniform sampler2DShadow shadowtex1;
uniform sampler2D shadowtex0;
uniform sampler2D shadowcolor0;
// 水面波法线（oct 编码 + 水掩码，Shadow.frag 写入）—— 波纹焦散光柱读取
uniform sampler2D shadowcolor1;

vec2 CalculateRefractedCoord(in ivec2 texelPos, in vec3 viewPos, in vec3 screenPos, in bool waterMask) {
    vec3 viewNormal = mat3(gbufferModelView) * FetchSurfaceNormal(texelPos);
    float viewLengthInv = inversesqrt(sdot(viewPos));
    vec3 viewDir = viewPos * viewLengthInv;

    vec3 refractedDir;
    if (waterMask) {
        vec3 viewGeometryNormal = mat3(gbufferModelView) * FetchGeometryNormal(texelPos);
        refractedDir = refract(viewDir, viewNormal - viewGeometryNormal * 0.95, 1.0 / WATER_IOR);
    } else {
        refractedDir = refract(viewDir, viewNormal, 1.0 / GLASS_IOR);
    }

    // 零步进屏幕空间投影折射
    float estimatedThickness = waterMask ? 3.0 : 0.3; 
    refractedDir *= estimatedThickness * REFRACTION_STRENGTH;
    
    vec2 refractedCoord = ViewToScreenPos(viewPos + refractedDir).xy;

    float refractedDepth = loadDepth1(uvToTexel(refractedCoord));
    refractedCoord = mix(refractedCoord, screenPos.xy, step(refractedDepth, screenPos.z));

    vec2 edgeFade = smoothstep(0.8, 1.0, abs(refractedCoord * 2.0 - 1.0));
    return mix(refractedCoord, screenPos.xy, edgeFade);
}

// [2026-08-20] 屏幕上太阳可见性：把世界太阳方向投影到屏幕，采样不透明深度。
// 该处天空（≈1）→ 可见；被地形挡/出屏/在相机背后 → 不可见。
// 供雾的太阳光晕遮蔽使用，替代 shadow map 精确采样（更轻、无 include 依赖）。
// [2026-08-20 平滑过渡] 太阳位置周边 9 点软采样，跨地形轮廓 0→1 渐变，消除光晕瞬间亮灭。
float CalcSunScreenVisibility() {
    vec3 sunView = mat3(gbufferModelView) * worldSunDir;
    if (sunView.z >= 0.0) return 0.0;                 // 太阳在相机背后/地平线下
    vec2 sunUv = ViewToScreenPosRaw(sunView).xy;
    // [2026-08-20] 太阳滑近屏幕边缘 → 平滑淡出（取代硬 if 的瞬间跳变，对齐太阳本体的滑动过程）
    vec2 edge = min(sunUv, vec2(1.0) - sunUv);
    float edgeFade = smoothstep(0.0, 0.08, min(edge.x, edge.y));
    if (edgeFade <= 0.0) return 0.0;

    const float r = 0.02;                              // 软采样半径（决定过渡的角宽度）
    vec2 uvMax = vec2(1.0) - viewPixelSize;
    float occ  = step(1.0 - 1e-4, loadDepth1(uvToTexel(sunUv)));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2( r, 0.0), vec2(0.0), uvMax))));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2(-r, 0.0), vec2(0.0), uvMax))));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2(0.0,  r), vec2(0.0), uvMax))));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2(0.0, -r), vec2(0.0), uvMax))));
    // [P1 2026-09-02] 9 点 -> 5 点（十字，去掉对角线采样）：每像素省 4 次深度读取；光晕过渡由 edgeFade 平滑，几乎无感
    return edgeFade * occ * (1.0 / 5.0);
}

// [2026-09-12 雾中光束] 单点阴影可见度：1 = 未被实心方块挡（或超出阴影范围），
// 0 = 被实心方块挡；开了 COLORED_VOLUMETRIC_FOG 时穿过玻璃会返回玻璃吸收色。
// camRelPos 为相机相对世界坐标，viewDist 为该点到相机的距离（用于距离淡出）。
// 超出 shadowDistance（含阴影贴图范围外）按"未遮挡"处理，并在最后 8 格内连续淡出
// —— 与 DeferredLight 的 distanceFade 同一约定，避免阴影图边界处出现一道硬边。
vec3 SampleFogSunShadow(in vec3 camRelPos, in float viewDist) {
    float rangeFade = linearstep(shadowDistance - 8.0, shadowDistance, viewDist);
    if (rangeFade >= 1.0) return vec3(1.0);

    vec3 shadowClipPos = (shadowModelView * vec4(camRelPos, 1.0)).xyz;
    shadowClipPos = (shadowProjection * vec4(shadowClipPos, 1.0)).xyz;
    vec3 ssp = DistortShadowSpace(shadowClipPos) * 0.5 + 0.5;
    #ifdef ENABLE_VOXELIZATION
        ShiftShadowScreenPos(ssp.xy); // 体素平铺布局：真阴影在右上区
    #endif

    vec3 result = vec3(1.0);
    if (all(equal(ssp, saturate(ssp)))) {
        result = vec3(0.0);
        ssp.z -= 4e-5; // 消除自阴影深度偏差
        // 实心深度（硬件深度比较）：1 = 未被实心挡，0 = 被挡
        float solidShadow = textureLod(shadowtex1, vec3(ssp.xy, ssp.z), 0.0);
        if (solidShadow > 0.5) {
            #ifdef COLORED_VOLUMETRIC_FOG
                // 玻璃染色是可选开销：每采样点多 2 次纹理读取（shadowtex0 + shadowcolor0）。
                // 默认关 —— 光束的可见度只需要"挡/不挡"，染色是锦上添花。
                float translucentShadow = step(ssp.z, textureLod(shadowtex0, ssp.xy, 0.0).x);
                float coloredShadow = saturate(solidShadow - translucentShadow);
                result = vec3(translucentShadow);
                if (coloredShadow > 1e-3) {
                    vec4 shadowColorSample = textureLod(shadowcolor0, ssp.xy, 0.0);
                    result += sRGBToLinear(shadowColorSample.rgb) * shadowColorSample.a * coloredShadow;
                }
            #else
                result = vec3(1.0);
            #endif
        }
        result = mix(result, vec3(1.0), rangeFade);
    }
    return result;
}

#ifndef UW_WAVE_SHAFTS_FOCUS
    #define UW_WAVE_SHAFTS_FOCUS 4.0
#endif
// [2026-09-21 波纹焦散光柱] 水面波纹对水下直射光束的聚焦调制：与 SampleFogSunShadow
// 同一投影（阴影形变 + 体素平铺 Shift，超阴影距离返回 1 不调制），读 shadowcolor1 的
// 水面波法线，折射汇聚公式与水底焦散 CalculateWaterCaustics 逐项同源 —— 因此光柱
// 正好落在水底舞动的光斑上，图案随太阳角度移动，夜晚月光同款（阴影贴图光源自动切月）。
// 与水底版的差异：单 tap 无 4 点抗锯齿盘（体积步进的 BlueNoise + TAA 负责时域平均）；
// 无水体深度衰减项（WaterFogPointSource 的 sunTransmittance 已按逐点水深衰减，避免
// 双重变暗）。返回值乘进 vis，而 vis 在 WaterFogPointSource 里只乘直射相位项 ——
// 均匀多散射环境项不受影响（焦散是聚焦的直射光，环境光是已散开的）。
// 非水面（掩码 0，如正上方有船/桥挡住阳光路径）返回 1 不调制——那类遮挡由
// SampleFogSunShadow 的实心判定负责。eta < 1 无全反射；极端波面倾角只会让
// 折射终点偏到无穷远 → saturate 归 0（变暗），不产生 NaN。
#ifdef UW_WAVE_SHAFTS
float SampleWaterSurfaceCaustics(in vec3 camRelPos, in float viewDist) {
    float rangeFade = linearstep(shadowDistance - 8.0, shadowDistance, viewDist);
    if (rangeFade >= 1.0) return 1.0;

    vec3 shadowClipPos = (shadowModelView * vec4(camRelPos, 1.0)).xyz;
    shadowClipPos = (shadowProjection * vec4(shadowClipPos, 1.0)).xyz;
    vec3 ssp = DistortShadowSpace(shadowClipPos) * 0.5 + 0.5;
    #ifdef ENABLE_VOXELIZATION
        ShiftShadowScreenPos(ssp.xy);
    #endif

    if (all(equal(ssp, saturate(ssp)))) {
        vec4 surfaceData = textureLod(shadowcolor1, ssp.xy, 0.0);
        if (surfaceData.w > EPS) {
            vec3 waveNormal = OctDecodeUnorm(surfaceData.xy);
            vec3 refractDir = refract(vec3(0.0, 1.0, 0.0), waveNormal, 1.0 / WATER_IOR);
            // 折射方向朝下：除以 y 归一成「垂直下降 1 格」的位移，波面倾角把折射
            // 终点横向偏移，偏移越小越亮 —— 与水底焦散同一启发式
            vec3 refractedPos = camRelPos - refractDir / refractDir.y;
            vec3 surfacePos = camRelPos - vec3(0.0, 1.0, 0.0);
            // [2026-09-21] 12.0 是硬编码的聚焦松紧，实测过严（典型波面倾角的偏移 0.1~0.3 格
            // 就判成 0）⇒ 光柱细到看不见。改为旋钮 UW_WAVE_SHAFTS_FOCUS，默认 4.0。
            float caustics = saturate(1.0 - UW_WAVE_SHAFTS_FOCUS * distance(surfacePos, refractedPos));
            // 平滑下限 0.1 + 亮度倍率 = 水底焦散同款（倍率进 GUI，默认 2.0）
            return UW_WAVE_SHAFTS_BRIGHTNESS * (-smin(-caustics, -0.1, 0.15));
        }
    }
    return 1.0;
}
#endif

// [2026-09-12 雾中光束] 估计"这条视线上的平均阴影可见度"：沿射线分层取
// VF_VOLUME_SHADOW_SAMPLES 个点，每点采样阴影贴图；采样点带逐像素/逐帧抖动
// （dither 来自 BlueNoise），噪声交给 TAA 时域平均（与旧体积光 pass 同一套路，
// 只是采样点少得多）。0 = 关（返回全亮 = 没有光束）。
// 放在 IntegrateScene 而不是 AtmosphericFog.glsl：阴影相关的 include 顺序与声明都在
// 这边，雾那边只接收一个逐射线系数 —— 密度/透射率的闭式积分完全不受影响。
vec3 ComputeFogSunVisibility(in vec3 worldDir, in float rayLength, in float dither) {
    #if VF_VOLUME_SHADOW_SAMPLES > 0
        vec3 visSum = vec3(0.0);
        for (int i = 0; i < VF_VOLUME_SHADOW_SAMPLES; ++i) {
            float t = rayLength * (float(i) + dither) / float(VF_VOLUME_SHADOW_SAMPLES);
            visSum += SampleFogSunShadow(worldDir * t, t);
        }
        return visSum / float(VF_VOLUME_SHADOW_SAMPLES);
    #else
        return vec3(1.0);
    #endif
}

// [2026-09-21 水下体积雾 + 体积光] 相机在水下时的雾（UW_VOLUMETRIC_FOG）。
// 透射保持闭式 exp2(-σ·d) —— σ 取相机深度定标的均匀值（深水整体更浓），与采样位置/
// 抖动无关，无噪声无条带；散射按 UW_FOG_SAMPLES 段步进，每段权重 = 段两端透射之差
//（均匀 σ 下的精确段积分：无抖动时逐段求和恰好望远镜回 (1-T_total) 的原闭式结果，
// 抖动只影响源强的采样位置）。每段中点求：
//   · 逐点水深（相机估计深度 - 相对相机高度）→ 阳光穿水柱衰减 + 深水增浓
//    （浅水青绿亮、深水浓蓝黑）；
//   · 阴影可见度 SampleFogSunShadow（UW_VOLUMETRIC_LIGHT，桥/洞顶把光束切开；
//     水面本身不进 shadowtex1，不挡光）。
// 步进中心带 BlueNoise 抖动防光束条带，噪声交 TAA（与雾中光束同一套路）。
// 旧版的整体 skylight 门控改为逐点水下光衰减（物理等效，避免双重衰减）。
mat2x3 RaymarchWaterFog(in float skylight, in float waterDepth, in vec3 worldDir,
                        in float LdotV, in float sunVisFactor, in float dither, in vec3 lightEnergy) {
    float camDepth = EstimateCameraWaterDepth(skylight);

    // 整条射线的等效消光：以相机深度定标（深水 = 场景衰减与散射权重同步更浓）
    float densityAtCam = mix(1.0, UW_FOG_DEEP_DENSITY, saturate(camDepth / UW_FOG_DEEP_RANGE));
    vec3 extinction = waterExtinction * densityAtCam;

    vec3 transmittance = exp2(-rLOG2 * extinction * waterDepth);

    float halfSeg = 0.5 * waterDepth / float(UW_FOG_SAMPLES);

    vec3 scattering = vec3(0.0);
    for (int i = 0; i < UW_FOG_SAMPLES; ++i) {
        // 段中心抖动（BlueNoise + 逐帧），段宽固定 = 总长/段数；首尾段夹回 [0, D]
        float tMid = waterDepth * (float(i) + dither) / float(UW_FOG_SAMPLES);
        float t0 = max(tMid - halfSeg, 0.0);
        float t1 = min(tMid + halfSeg, waterDepth);
        if (t1 <= t0) continue;

        // 段权重 = 段两端透射之差（σ 均匀 → 精确段积分，无累积漂移）
        vec3 T0 = exp2(-rLOG2 * extinction * t0);
        vec3 T1 = exp2(-rLOG2 * extinction * t1);

        // 该点有效水深：相机深度 - 相对相机高度（向上看变浅、向下看变深）
        float pointDepth = max(camDepth - worldDir.y * tMid, 0.0);

        vec3 vis = vec3(1.0);
        #ifdef UW_VOLUMETRIC_LIGHT
            vis = SampleFogSunShadow(worldDir * tMid, tMid);
            // [2026-09-21 波纹焦散光柱] vis 在 WaterFogPointSource 里只乘直射相位项，
            // 波面聚焦调制乘进 vis 即只影响光束，不碰均匀多散射环境项
            #ifdef UW_WAVE_SHAFTS
                vis *= SampleWaterSurfaceCaustics(worldDir * tMid, tMid);
            #endif
        #endif

        scattering += (T0 - T1) * WaterFogPointSource(pointDepth, LdotV, sunVisFactor, vis, lightEnergy);
    }

    return mat2x3(scattering, transmittance);
}

void main() {
    ivec2 texelPos = ivec2(gl_FragCoord.xy);
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;

    float depth = loadDepth0(texelPos);

    vec3 screenPos = vec3(screenCoord, depth);
    vec3 viewPos = ScreenToViewPos(screenPos);
    #if defined LOD_MOD
        if (depth > 1.0 - EPS) {
            depth = screenPos.z = loadDepth0Lod(texelPos);
            viewPos = ScreenToViewPosLod(screenPos);
        }
    #endif

    vec3 sceneColor;
    float fogMask = 1.0;
    
    vec3 worldPos = mat3(gbufferModelViewInverse) * viewPos;
    vec3 worldDir = normalize(worldPos);

    float viewDistance = 0.0;
    if (depth < 1.0 || isEyeInWater == 1) {
        viewDistance = length(viewPos);
    }

    // ====================================================================================
    // 天空 / 半透明物体处理
    // ====================================================================================
    if (depth >= 1.0) {
        sceneColor = loadSceneMain(texelPos);
    } else {
        uvec4 materialPack = loadMaterialPack(texelPos);
        uint materialID = materialPack.y;
        bool glassMask = materialID == 2u;
        bool waterMask = materialID == 3u;

        ivec2 refractedTexel = texelPos;
        if (glassMask || waterMask) {
            refractedTexel = uvToTexel(CalculateRefractedCoord(texelPos, viewPos, screenPos, waterMask));
        }

        sceneColor = loadSceneMain(refractedTexel);

        // [2026-09-10 性能] 半透明解码下沉：translucent/albedo 只在 materialID==500、
        // 玻璃、水这三种情况下被消费（见下方两个分支），对绝大多数不透明像素是无用功
        //（ExtractSpecularTex + sRGBToLinear(3 次真 pow) [+ 可能的 colortex6 回退取样]）。
        // 包进与消费者完全相同的条件里 → 输出逐位相同。
        if (glassMask || waterMask || materialID == 500u) {
            vec4 translucent = ExtractSpecularTex(materialPack);
            vec3 albedo = sRGBToLinear(translucent.rgb);

            // 安全回退：部分玻璃实体（掉落物/展示实体）可能未把 albedo 打包进 materialPack.zw，
            // zw 为 0 时 log2(0) 得到 -inf/NaN，会让玻璃乘出纯黑不可见。
            // 此时回退使用 colortex6 中的真实 albedo，保证物体至少可见。
            if (maxOf(translucent.rgb) < 0.001 || translucent.a < 0.001) {
                vec4 fallbackAlbedo = texelFetch(colortex6, texelPos, 0);
                translucent = vec4(sRGBToLinear(fallbackAlbedo.rgb), max(fallbackAlbedo.a, 0.75));
                albedo = translucent.rgb;
            }

            if (materialID == 500u) {
                vec3 diffuseLight = texelFetch(colortex3, texelPos, 0).rgb;
                sceneColor = mix(sceneColor, albedo * diffuseLight, translucent.a);
            }

            if (glassMask || waterMask) {
                if (glassMask) {
                    sceneColor *= exp2(log2(albedo) * approxSqrt(translucent.a));
                    sceneColor += (2.0 * EMISSIVE_BRIGHTNESS) * Unpack2x8UX(materialPack.x) * mean(albedo) * albedo;
                }
                vec4 specularLight = texelFetch(colortex3, texelPos, 0);
                sceneColor = sceneColor * specularLight.a + specularLight.rgb;
            }
        }

        #ifdef BORDER_FOG
            if (isEyeInWater == 0) {
                float xzDistSq = sdot(worldPos.xz) * (1.0 / (2048.0 * 2048.0));
                // [2026-09-10 性能] 距离门控：density ∝ (d/2048)^8，在 d=355 格处权重仅 ~8.1e-7
                //（transmittance = 1 - 2e-6 → mix 偏差 ~1e-6 相对量，远低于 1/255 量化步长）。
                // 本机视距 12 区块 = 192 格（xzDistSq = 8.8e-3）→ 该分支恒不进入，等于整块被跳过；
                // 大视距（DH/Voxy）下 xzDistSq 变大，边界雾照常生效，行为不变。
                if (xzDistSq > 3e-2) {
                    float xzDistPow4 = xzDistSq * xzDistSq;
                    float density = exp2(-0.1 * max0(worldPos.y - 63.0)) * (xzDistPow4 * xzDistPow4);
                    float transmittance = exp2(-BORDER_FOG_FALLOFF * density);

                    vec3 skyRadiance = AtmosphereSkyView(atmosphereViewPos, worldDir, worldSunDir);
                    sceneColor = mix(skyRadiance, sceneColor, transmittance);
                }
            }
        #endif
    }

    // ====================================================================================
    // 体积雾 / 水下雾（统一处理，并修复天空所有方向的雾）
    // ====================================================================================
    mat2x3 fogData = mat2x3(vec3(0.0), vec3(1.0));

    // 地面大气散射的透射率（1 = 未参与）。仅主世界几何体像素会被赋值，最后并入 fogMask：
    // 泛光雾与 colortex0.a 的"雾量"通道因此也认这层空气透视（远景同样起泛光雾）。
    float groundScatteringTransmittance = 1.0;

    // ====================================================================================
    // 次表面散射（屏幕空间扩散合成）
    // ====================================================================================
    // [2026-09 SSS 重构第 2 步] DeferredLight 把 SSS 源项写进半分辨率 colortex18，
    // composite1/composite3 做横向+纵向可分离模糊（深度感知 + 抖动），结果在 colortex20。
    // 源项未归一化（rgb 已乘 mask），非 SSS 邻域自然趋近 0。门控有两层：
    //   ① 中心像素自身的 mask（直接读 colortex18.a）—— 防止渗色跑到天空/石头等非 SSS 材质上，
    //      这是必须的：只靠邻域 mask 的话，SSS 物体在天空前的轮廓会带一圈光晕；
    //   ② 邻域 mask（模糊后的 colortex20.a）—— 平滑边界过渡。
    // 双线性上采样（半分辨率 -> 全分辨率）。
    #ifdef SUBSURFACE_SCATTERING_DIFFUSION
        vec4 sssSource = texture(colortex18, screenCoord);
        vec4 sssDiffuse = texture(colortex20, screenCoord);
        float sssGate = saturate(sssSource.a * 4.0) * saturate(sssDiffuse.a * 2.0);
        sceneColor += sssDiffuse.rgb * (SUBSURFACE_SCATTERING_BRIGHTNESS * sssGate);
    #endif

    // 定向光能量：白天 = 太阳辐照度。夜晚 global.directIlluminance ≈ 0（moonlightMult 压制），
    // 补一个月光项 —— 与 SUN_HALO 同一套色相与强度约定（淡蓝、跟随 VOXEL_MOON_STRENGTH）。
    // 没有它，夜晚雾中光束/水下体积光会在入夜后整个消失。水下与大气雾两分支共用。
    float fogMoonAmt = smoothstep(-0.10, -0.25, worldSunDir.y);
    vec3 fogLightEnergy = global.directIlluminance
                        + vec3(0.30, 0.42, 0.85) * fogMoonAmt * VOXEL_MOON_STRENGTH;

    if (isEyeInWater == 1) {
        float LdotV = dot(worldLightDir, worldDir);
        #if defined UW_VOLUMETRIC_FOG
            // 水下体积雾 + 体积光：深度渐变散射（浅水青绿亮、深水浓蓝黑）+ 逐点阴影光束
            fogData = RaymarchWaterFog(eyeSkylightSmooth, viewDistance, worldDir, LdotV,
                                       CalcSunScreenVisibility(), BlueNoise(texelPos, frameCounter), fogLightEnergy);
        #else
            fogData = AnalyticWaterFog(eyeSkylightSmooth, viewDistance, LdotV, CalcSunScreenVisibility());
        #endif
    } else {
        // 太阳屏幕可见度：体积雾的太阳光晕与地面大气散射的太阳项共用，每像素只求一次。
        #if defined VOLUMETRIC_FOG || (defined GROUND_SCATTERING && !defined DIMENSION_NETHER && !defined DIMENSION_THE_END)
            float sunVis = CalcSunScreenVisibility();
        #endif

        #ifdef VOLUMETRIC_FOG
            float dither = BlueNoise(texelPos, frameCounter);
            
            bool skyMask = (depth >= 1.0 - EPS);
            vec3 fogEndPos = worldPos;

            if (skyMask) {
                // 天空像素：强制使用几何路径，固定有限距离，覆盖全方向
                skyMask = false;
                const float skyFogDist = 256.0;           // 控制天空雾的浓度（调小变浓）
                fogEndPos = vec3(0.0) + worldDir * min(length(worldPos), skyFogDist);
            } else {
                // 非天空：检查后方是否实际是天空（例如半透明区域）
                float opaqueDepth = loadDepth1(texelPos);
                #if defined LOD_MOD
                    if (opaqueDepth > 1.0 - EPS) opaqueDepth = loadDepth1Lod(texelPos);
                #endif
                if (opaqueDepth >= 1.0 - EPS) {
                    skyMask = true;          // 实际为天空，同样使用有限距离
                    const float skyFogDist = 512.0;
                    fogEndPos = vec3(0.0) + worldDir * min(length(worldPos), skyFogDist);
                }
            }
            
            // [2026-09-12 雾中光束] 这条视线的阴影可见度（VOLUMETRIC_LIGHT 关掉时恒为 1
            // = 与合并前完全一致的"无光束"行为）。射线从相机出发，故射线长度 = |fogEndPos|。
            vec3 fogSunShadow = vec3(1.0);
            #ifdef VOLUMETRIC_LIGHT
                fogSunShadow = ComputeFogSunVisibility(worldDir, length(fogEndPos), dither);
            #endif

            fogData = RaymarchAtmosphericFog(vec3(0.0), fogEndPos, dither, skyMask, sunVis, fogSunShadow, fogLightEnergy);
        #endif

        // [2026-09 新增] 地面大气散射（空气透视）：与体积雾相互独立的一层，只作用于主世界
        // 的地面/水面像素。depth < 1 表示该像素最终落在几何体上 —— 纯天空像素交给天空模型
        // （天空 LUT 已含大气散射），不下沉这层空气透视，否则天空会被叠第二遍散射而变灰。
        // 水下/lava/细雪走各自的水雾分支，不叠加。放在 ApplyFog 之前 → 体积雾仍在其之上。
        #if defined GROUND_SCATTERING && !defined DIMENSION_NETHER && !defined DIMENSION_THE_END
            if (isEyeInWater == 0 && depth < 1.0 - EPS) {
                mat2x3 groundScattering = AnalyticGroundScattering(worldDir, viewDistance, eyeSkylightSmooth, sunVis);
                sceneColor = ApplyFog(sceneColor, groundScattering);
                groundScatteringTransmittance = mean(groundScattering[1]);
            }
        #endif
    }

    sceneColor = ApplyFog(sceneColor, fogData);
    // [2026-09] 地面大气散射的透射率并入 fogMask：远景的空气透视同样计入"雾量"（泛光雾 /
    // colortex0.a）。未启用该功能时保持原式不变（关闭即与旧版逐位相同）。
    #ifdef GROUND_SCATTERING
        fogMask = mix(1.0, mean(fogData[1]) * groundScatteringTransmittance, eyeSkylightSmooth);
    #else
        fogMask = mix(1.0, mean(fogData[1]), eyeSkylightSmooth);
    #endif

    if (viewDistance == 0.0) viewDistance = length(viewPos);
    RenderVanillaFog(sceneColor, fogMask, viewDistance);

    // [2026-09 独立日晕] 太阳/月亮保底光晕：不依赖体积雾浓度、也不依赖体积光开关
    // （VOLUMETRIC_FOG/VOLUMETRIC_LIGHT 均关也生效），由 SUN_HALO 独立总控。
    // 只在天空像素上绘制（地形/实体轮廓自然遮挡）；白天能量 ≈ directIlluminance×0.03，
    // 夜晚月光补蓝项按 ×0.5 档；强度 SUN_HALO_STRENGTH（0=关）、角宽 SUN_HALO_WIDTH、
    // 低角暖金→正午白。
    #ifdef SUN_HALO
    {
        float isSkyH = step(1.0 - 1e-4, depth);
        if (isSkyH > 0.5) {
            float moonAmtH = smoothstep(-0.10, -0.25, worldSunDir.y);
            vec3 haloDir = worldLightDir;
            float haloAlt = smoothstep(-0.03, 0.05, worldSunDir.y);
            float haloMoon = 0.0;
            if (moonAmtH > 0.0) {
                haloDir = -worldSunDir;
                haloAlt = smoothstep(-0.03, 0.05, -worldSunDir.y);
                haloMoon = 1.0;
            }
            float cosH = dot(worldDir, haloDir);
            if (cosH > 0.0 && haloAlt > 1e-4) {
                float expoH = 48.0 / (SUN_HALO_WIDTH * SUN_HALO_WIDTH);
                float shapeH = pow(cosH, expoH);
                float warmH = 1.0 - smoothstep(0.03, 0.30, max(worldSunDir.y, 0.0));
                vec3 haloColor = mix(vec3(1.0, 0.60, 0.25), vec3(1.0, 0.97, 0.92), 1.0 - warmH);
                if (haloMoon > 0.5) haloColor = vec3(0.8, 0.9, 1.0);
                vec3 haloEnergy = global.directIlluminance;
                if (haloMoon > 0.5) haloEnergy += vec3(0.30, 0.42, 0.85) * VOXEL_MOON_STRENGTH;
                float haloScale = mix(0.03, 0.5, haloMoon);
                sceneColor += haloColor * haloEnergy * (haloScale * shapeH)
                           * SUN_HALO_STRENGTH * haloAlt;
            }
        }
    }
    #endif


    #if defined TAA_ENABLED && RENDER_MODE == 1
        sceneColor = RGBToYCoCg(sceneColor);
    #endif

    #if DEBUG_NORMALS == 1
        sceneColor = FetchSurfaceNormal(texelPos) * 0.5 + 0.5;
    #elif DEBUG_NORMALS == 2
        sceneColor = FetchGeometryNormal(texelPos) * 0.5 + 0.5;
    #endif

    sceneOut = vec4(sceneColor, saturate(1.0 - fogMask));
}