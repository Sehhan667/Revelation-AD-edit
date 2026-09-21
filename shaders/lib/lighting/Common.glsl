// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.







#include "/lib/surface/BRDF.glsl"

// [2026-09-21 **水下环境项豁免**（修"深水里背光面死黑"）] 见 settings.glsl 的 UW_AMBIENT_* 说明。
// 游戏在水下把天光 lightmap 每格降 1 级（15 级制）、约 15 格归零；**直射光早已豁免**
//（DeferredLight 的 sunlightFactor 里有 + float(isEyeInWater)），环境光原来没有 ⇒ 背光面死黑。
// 这里给环境项一个"等效天光"：按**水的消光**随相机水深衰减。相机水深与
// lib/water/WaterFog.glsl 的 EstimateCameraWaterDepth 同一套近似。
// **非水下时两个函数都原样返回入参** ⇒ 水面上行为逐位不变（这是本改动的硬约束）。
//
// 水下光柱透射：绿通道最易穿透，用它定标；UW_AMBIENT_DEPTH_MULT = 路径倍率。
float AmbientSkyThru() {
    float depth = saturate(1.0 - pow(max(eyeSkylightSmooth, 1e-4), 0.25)) * 15.0;
    return exp2(-rLOG2 * waterExtinction.g * depth * UW_AMBIENT_DEPTH_MULT);
}

// **线性版**：用于原本就用 lightmap.y 一次方的场合（skyPresence / localDarkness 等）。
float AmbientSkyLinear(in float lm) {
    if (isEyeInWater != 1) return lm;
    return max(lm, UW_AMBIENT_STRENGTH * AmbientSkyThru());
}

// **门控版**：替代原来的 cube(lightmap.y)。水下**不能立方** ——
// 深度 10 格时等效天光≈0.15，0.15³=0.0034 仍然等于黑（这正是"把强度调到 1 还是黑"的原因）。
float AmbientSkyGate(in float lm) {
    if (isEyeInWater != 1) return cube(lm);
    return max(cube(lm), UW_AMBIENT_STRENGTH * AmbientSkyThru());
}

//================================================================================================//

float CalculateFakeBouncedLight(in vec3 normal) {
	float bounce = saturate(dot(worldLightDir, vec3(0.01, 0.025, 0.01)));

	return approxSqrt(bounce * oms(0.75 * normal.y)) * uniformPhase;
}

float CalculateBlocklightFalloff(in float blocklight) {
	blocklight = mix(blocklight, sqr(blocklight), 0.75);
	return blocklight * blocklight * blocklight;
}

vec4 HardCodeEmissive(in uint materialID, in vec3 albedo, in vec3 worldPos, in vec3 blocklightColor) {
    float albedoLuminance = length(albedo);

    switch (materialID) {
        // Total glowing
        case 20u:
            return vec4(vec3(albedoLuminance), 0.1);
        // Torch like
        case 21u:
            return vec4(blocklightColor * (4.0 * float(albedo.r > 0.6 || albedo.r > albedo.g * 2.0)), 0.2);
        // Fire
        case 7u: case 22u:
            return vec4(blocklightColor * (2.0 * albedoLuminance), 0.1);
        // Glowstone like
        case 23u:
            return vec4(blocklightColor * (3.0 * cube(albedoLuminance)), 0.1);
        // Sea lantern like
        case 24u:
            return vec4(vec3(4.0 * cube(albedoLuminance)), 0.0);
        // Redstone
        case 25u: {
            float mcPosFractY = fract(worldPos.y + cameraPosition.y);
            if (mcPosFractY > 0.18) return vec4(vec3(2.1, 0.9, 0.9) * step(0.4, albedo.r), 1.0);
            else return vec4(vec3(2.1, 0.9, 0.9) * step(1.25, albedo.r / (albedo.g + albedo.b)) * step(0.2, albedo.r), 1.0);
        }
        // Soul fire
        case 26u:
            return vec4(vec3((albedoLuminance + 0.5) * step(0.2, albedo.b)), 0.5);
        // Amethyst
        case 27u:
            return vec4(vec3(albedoLuminance * 0.1), 1.0);
        // Glowberry
        case 28u:
            return vec4(saturate(dot(saturate(albedo - 0.1), vec3(1.0, -0.6, -0.99))) * vec3(28.0, 25.0, 21.0), 0.4);
        // Rails
        case 29u:
            return vec4(vec3(2.1, 0.9, 0.9) * (albedoLuminance * step(albedo.g * 4.0, albedo.r)), 1.0);
        // Beacon core
        case 30u: {
            vec3 midBlockPos = abs(fract(worldPos + cameraPosition) - 0.5);
            if (maxOf(midBlockPos) < 0.4 && albedo.b > 0.5) return vec4(vec3(6.0 * albedoLuminance), 0.0);
            else return vec4(vec3(0.0), 1.0);
        }
        // Sculk
        case 31u:
            return vec4(vec3(0.05 * sqr(albedoLuminance) * float((albedo.b * 2.0 > albedo.r + albedo.g) && albedo.b > 0.25)), 1.0);
        // Glow lichen
        case 32u:
            return vec4(albedo.r > albedo.b * 1.25 ? vec3(3.0) : vec3(albedoLuminance * 0.1), 1.0);
        // Partial glowing
        case 33u:
            return vec4(32.0 * albedoLuminance * cube(saturate(albedo - 0.5)), 0.5);
        // Middle glowing
        case 34u: {
            vec2 midBlockPosXZ = abs(fract(worldPos.xz + cameraPosition.xz) - 0.5);
            return vec4(vec3(step(maxOf(midBlockPosXZ), 0.063) * albedoLuminance), 1.0);
        }
        // Copper torch & lantern (green flame)
        case 35u:
            return vec4(vec3(0.4, 0.9, 0.55) * (2.5 * albedoLuminance + 0.2), 0.2);
        // Copper bulb (warm white, lit) - fixed bright tint so the block surface reads as a lamp
        case 36u:
            return vec4(vec3(1.0, 0.85, 0.6) * (2.0 + 2.5 * albedoLuminance), 0.2);
        // End glowing
        case 46u:
            return vec4(vec3(1e2 * albedoLuminance), 0.0);
        // Lightning bolt
        case 2000u:
            return vec4(vec3(16.0), 0.0);
        // Default
        default:
            return vec4(vec3(0.0), 1.0);
    }
}
