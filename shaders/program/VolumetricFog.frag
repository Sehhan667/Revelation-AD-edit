/*
--------------------------------------------------------------------------------

    Revelation Shaders - Volumetric Light (God Rays)

    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Pass: Quarter-resolution screen-space ray marching for volumetric light.
    - Renders to colortex11 (RGBA16F, 1/4 res): scattering (RGB) + transmittance (A)
    - Steps from the camera to the scene depth, sampling the shadow map per step
      so sunbeams pierce through leaves / windows / openings.
    - Colored stained glass tint via shadowcolor0 (COLORED_SHADOWS).
    - Daylight beams use global.directIlluminance; night moonlight beams get a
      directional boost (VOXEL_MOON_STRENGTH), same convention as voxel GI.
    - Noise is reduced by the existing full-res TAA pass after upscale blending.
--------------------------------------------------------------------------------
*/

#define PASS_VOLUMETRIC_FOG

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 11 */
layout (location = 0) out vec4 volumeData; // RGB = scattering, A = transmittance

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// SSBO //================================================================================//

#include "/lib/universal/SSBO.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"
#include "/lib/universal/Random.glsl"

#include "/lib/atmosphere/Common.glsl"

// 阴影形变（DistortShadowSpace）+ 体素平铺 Shift（ShiftShadowScreenPos）
#include "/lib/lighting/shadow/Common.glsl"
#include "/lib/lighting/VoxelLighting.glsl"

// 体积光阴影采样：shadowtex1 硬件深度比较（白天太阳 / 夜晚月亮自动切换），
// 穿过半透明物体（玻璃）时按 shadowcolor0 颜色染色（COLORED_SHADOWS）。
uniform sampler2DShadow shadowtex1;
uniform sampler2D shadowtex0;
uniform sampler2D shadowcolor0;

// 阴影贴图约定：shadowModelView 需要相机相对坐标（camRelPos = worldPos - cameraPosition），
// 与 VoxelSunShadow.glsl 一致；直接传世界坐标会整体偏移阴影采样，光束遮挡位置错乱。
vec3 SampleVolumetricShadow(in vec3 camRelPos) {
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
        float soildShadow = textureLod(shadowtex1, vec3(ssp.xy, ssp.z), 0.0);
        if (soildShadow > 0.5) {
            // 透明深度：没被透明物体挡 → 全亮
            float translucentShadow = step(ssp.z, textureLod(shadowtex0, ssp.xy, 0.0).x);
            result += vec3(translucentShadow);

            // 被透明物体（玻璃）挡的部分 → 采样染色，光束带上玻璃颜色
            float coloredShadow = saturate(soildShadow - translucentShadow);
            if (coloredShadow > 1e-3) {
                vec4 shadowColorSample = textureLod(shadowcolor0, ssp.xy, 0.0);
                result += sRGBToLinear(shadowColorSample.rgb) * shadowColorSample.a * coloredShadow;
            }
        }
    }
    return result;
}

//======// Main //================================================================================//
void main() {
    // colortex11 为 1/4 分辨率 → 还原全屏 UV
    vec2 uv = gl_FragCoord.xy * viewPixelSize * 4.0;

    volumeData = vec4(0.0, 0.0, 0.0, 1.0);

    // 水下/岩浆：雾由 AnalyticWaterFog 处理，体积光不参与
    if (isEyeInWater != 0) return;
    // 下界无太阳/月亮：无光束
    if (worldId == -1) return;

    float depth = loadDepth0(uvToTexel(uv));
    // 天空方向（depth≈1.0）也参与步进：透过树叶/窗口缝隙望向天空时的光束
    // 正是 God rays 最明显的场景。天空像素步进距离用固定远端 256。
    // 世界方向仅由屏幕 UV 决定（透视下与深度无关），统一用一个视图点归一化即可。
    vec3 viewPos = ScreenToViewPos(vec3(uv, min(depth, 1.0 - 1e-4)));
    vec3 worldDir = normalize(mat3(gbufferModelViewInverse) * viewPos);
    float rayLength;
    if (depth > 1.0 - 1e-4) {
        rayLength = 256.0;
    } else {
        vec3 endWorld = transMAD(gbufferModelViewInverse, viewPos) + cameraPosition;
        rayLength = min(length(endWorld - cameraPosition), 256.0);
    }

    float dither = BlueNoise(ivec2(gl_FragCoord.xy), frameCounter);

    // 光源：白天太阳（global.directIlluminance 含色温）；夜晚月光单独补项
    //（global.directIlluminance 夜晚 ≈ 0，因 moonlightMult 压制）
    vec3 lightColor = global.directIlluminance;
    float moonAmt = smoothstep(-0.10, -0.25, worldSunDir.y);
    // Mie 前向散射相位（光束核心）：白天沿日向，夜晚沿月向（-worldSunDir），
    // 放大前向 lobe 让光束更明显
    vec3 lightDir = worldLightDir;
    if (moonAmt > 0.0) {
        lightColor += vec3(0.30, 0.42, 0.85) * moonAmt * VOXEL_MOON_STRENGTH * 2.0;
        lightDir = -worldSunDir;
    }
    float miePhase = AtmospherePhase(dot(lightDir, worldDir)).y * 4.0;

    // 均匀低密度（纯光束形态：光束由阴影图案主导，而非整体雾）
    const float volumeDensity = 1.2e-4;
    const float volumeExtinction = 1.2e-4;

    float stepLen = rayLength / float(VF_VOLUME_MAX_STEPS);
    vec3 startWorld = cameraPosition;
    vec3 stepDir = worldDir;
    float densityStep = volumeDensity * stepLen;

    vec3 scattering = vec3(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < VF_VOLUME_MAX_STEPS; ++i) {
        float t = (float(i) + dither) * stepLen;
        vec3 samplePos = startWorld + stepDir * t;

        vec3 sunVis = SampleVolumetricShadow(samplePos - cameraPosition);

        scattering += transmittance * lightColor * miePhase * sunVis * densityStep;
        transmittance *= exp(-volumeExtinction * stepLen);

        if (transmittance < 0.02) break;
    }

    // [2026-08-21] 体积光随体积雾"时段过渡"共同衰减：VF_TIME_FADE 开启时复用
    // AtmosphericFog.glsl 同款时段密度因子（正午最弱 → 傍晚/午夜渐强，降雨保底），
    // 使体积光与体积雾在同一时段曲线上联动；VF_VOLUME_INTENSITY 仍作为独立倍率。
    #ifdef VF_TIME_FADE
        scattering *= max(wetness, 1.5 - approxSqrt(max(timeNoon, 0.0)) * 1.5 - timeSunset * 0.75 - timeMidnight * 0.5);
    #endif
    volumeData = vec4(scattering * VF_VOLUME_INTENSITY, transmittance);
}
