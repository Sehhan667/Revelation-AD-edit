/*
    --------------------------------------------------------------------------------
        Revelation-AD-edit  -  modified derivative of "Revelation"
        Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro

        This file is an addition made for this derivative.
        Copyright 2026 AnotherCream

        Licensed under the Apache License, Version 2.0. See NOTICE at repo root.
    --------------------------------------------------------------------------------
*/

//================================================================================================//
// Voxel SkyLight — GI 方向天空光（原创实现，2026-08-10 重构为物理天空采样结构）
//
// 思路：
// - 光线出界/逃逸时，按方向直接调用 AtmosphereSkyView（大气 LUT，物理尺度）
//   ——与可见天空同源；不依赖 skyMapTex 在 GI pass 是否绑定（曾采样恒 0 的疑点）
// - 地平线衰减：只保留上半球（saturate(dir.y*25+0.5)），防朝下出界拿地面以下天光
// - 漏光门控：线性 skylight 缩放（saturate(lightmap*4.44)），洞穴≈0 → 0，
//   半遮挡（树冠/窗边）按比例保留，户外≥0.23 全开
// - 不再用平铺兜底/解析填充：天光只由追踪/IRC 自己传播，才能自然混合和产生 AO
//================================================================================================//

#ifndef VOXEL_SKY_REFERENCE
    #define VOXEL_SKY_REFERENCE 300.0
#endif

// [2026-08-17] 阳光颜色混合（SH 环境光同款，DeferredLight 的 AMBIENT_SUNLIGHT_TINT_RATIO）：
// 用暖阳色 sunIrradiance 的色度（归一化，只染色调不动亮度）；正午最强、日落/夜晚关闭。
// 同一滑条（屏幕 Compensation 菜单「漫反射阳光染色强度」）控制，两处观感一致。
#ifndef AMBIENT_SUNLIGHT_TINT_RATIO
    #define AMBIENT_SUNLIGHT_TINT_RATIO 1.0 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.5 3.0]
#endif

// [2026-08-19 恢复] 解析天光下限（SimpleSkyLighting，对齐参考实现）：阴影/闭塞体素的 IRC 底光，
// 由法线上下曲线 + 阳光小底 + lightmap*0.22 门控给出连续下限，经 IRC 自反弹传播成"阴影本身是亮的"。
// skylightColor = 天光辐照度色；shadowlightColor = 太阳/月亮直射色；亮度由 NdotU 曲线 + lightmap 门控决定。
vec3 SimpleSkyLighting(vec3 skylightColor, vec3 shadowlightColor, float NdotU, float lightmap) {
    // 昼夜感知直射色：白天用传入暖色，夜晚切冷蓝月光（配合月光方案）
    float dayAmt = smoothstep(0.0, 0.05, worldSunDir.y);
    vec3 nightChroma = vec3(0.022, 0.029, 0.055) * (1.0 - dayAmt);
    vec3 direct = shadowlightColor * dayAmt + nightChroma;

    vec3 skylight = skylightColor * (NdotU * 0.35 + 0.65);
    vec3 skySunLight = direct * (NdotU * 0.015 + 0.02);
    skylight += skySunLight;
    skylight = mix(skylight, direct * (NdotU * 0.003 + 0.005), wetness * 0.6);
    // 纯净线性 lightmap*0.22 门控（对齐参考实现，不放大写入下限）
    return skylight * max(float(isEyeInWater == 1) * 0.003, lightmap * 0.22);
}

// 地平线衰减：上半球全开，略低于地平线即截止（与通用光追天空采样一致）
float VoxelSkyHorizonFade(vec3 dir) {
    return saturate(dir.y * 25.0 + 0.5);
}

// 漏光门控：skylight 0.03-0.30 平滑过渡（洞穴≈0 → 0，半遮挡按比例保留，户外全开）
float VoxelSkyLeakGate(float lightmap) {
    return smoothstep(0.03, 0.30, lightmap);
}

// 方向天空辐射：AtmosphereSkyView（大气 LUT，调用方需先包含 atmosphere/Common.glsl）
// ÷ 尺度基准 → 0-1 光照尺度；若 LUT 在 GI pass 未绑定（恒 0），退回 MC skyColor
// × 同样的地平线衰减与门控（方向性兜底，避免全黑）。
// 函数内部已含地平线衰减与漏光门控，调用方不要再重复乘。
vec3 VoxelSkyColor(vec3 dir, float lightmap) {
    // 亮度：分时策略（用户实测校准）——
    // 白天 max 合并（LUT 物理值÷300 仅 ~0.4 < skyColor ~0.7，max 保证白天亮度），
    // 傍晚/夜晚用 LUT（物理变暗）。LUT 恒 0 时 skyColor 兜底。
    vec3 lutSky = max(AtmosphereSkyView(atmosphereViewPos, dir, worldSunDir), vec3(0.0)) * rcp(VOXEL_SKY_REFERENCE);
    float fade = VoxelSkyHorizonFade(dir);
    float gate = VoxelSkyLeakGate(lightmap);
    float dayBlend = saturate(worldSunDir.y * 6.0);
    vec3 sky = lutSky;
    if (luminance(sky) < 1e-4) sky = skyColor * 0.5;
    // [2026-08-18] 傍晚亮度底：非光追环境光有 灰白底(activeMinAmbient)+ 假反弹 撑亮度，
    // 网格内 GI 的 LUT 傍晚物理值很暗 → "暗淡的多"（用户实测）。加一个按天空可见度
    // 门控的 skyColor 底（傍晚/夜晚生效，白天被 dayBlend 盖掉），让网格内傍晚也有
    // 可见天光；色度随后用 SH 天顶统一，底只提亮度不染色。
    // [2026-08-18 傍晚过亮] 0.25 → 0.12 → 0.08 → 0.05：用户多次反馈傍晚偏亮，逐步调暗。
    vec3 skyColorFloor = skyColor * 0.05 * saturate(1.0 - worldSunDir.y * 2.5);
    sky = max(sky, skyColorFloor);
    sky = mix(sky, max(sky, skyColor), dayBlend);
    float skyLuma = luminance(sky);   // 先取亮度（保持分时策略的亮度）
    // [FIX 2026-08-18 网格内外色差] 色度与非光追环境光同源且同方向：
    // 非光追 = ConvolvedReconstructSH3(skySH, worldNormal)——worldNormal 对地面
    // 像素即天顶方向，傍晚重建出淡粉（用户实测网格外淡粉正常）。
    // GI 此前用射线方向 dir 重建：傍晚半球平均被 SH 展平 → 微蓝白"没颜色"
    // （用户实测网格内微微发蓝且暗淡）。改为固定天顶方向重建，与网格外
    // 地面像素完全同色；方向性由亮度（LUT fade/方向）承担，色度全域一致。
    vec3 shSky = ConvolvedReconstructSH3(global.skySH, vec3(0.0, 1.0, 0.0));
    vec3 shChroma = shSky / max(luminance(shSky), 1e-4);
    sky = shChroma * skyLuma;
    // [2026-08-18] 网格外环境光含"暖色假反弹"（DeferredLight L511：
    // ambientAccum += CalculateFakeBouncedLight * lm3 * lm3 * sunlightBase，
    // sunlightBase = 暖阳色 global.directIlluminance × 云影）→ 蓝被中和，
    // 而网格内 GI 天光是纯 SH 蓝 → 明显更蓝（用户实测）。用户方案：
    // 网格内也混入"假反弹的颜色"（暖阳色度），但不做假反弹的几何/亮度计算。
    // 色度取 global.directIlluminance（与网格外同一来源，含昼夜色温——正午暖白、
    // 傍晚橙红、夜晚暗蓝；比 settings.glsl 的 sunIrradiance 纯白更能中和蓝）。
    // 强度 = 太阳仰角权重（正午暖、傍晚弱、夜晚关），加性混入暖底模拟地面反弹阳光。
    // [2026-08-18 白天更暖] 0.18 → 0.30：用户要求白天天光混入更多阳光颜色。
    #ifndef DIMENSION_THE_END
        float bounceBlend = saturate(worldSunDir.y * 2.0) * 0.30;
        if (bounceBlend > 0.0) {
            vec3 directChroma = global.directIlluminance / max(luminance(global.directIlluminance), 1e-4);
            sky = mix(sky, directChroma * skyLuma, bounceBlend);
        }
    #endif
    // [2026-08-18] 阳光颜色混合（DeferredLight 环境光同款，用户要求）：
    // 让 GI 天光与网格外 SH 环境光同样受 AMBIENT_SUNLIGHT_TINT_RATIO 暖阳色染色——
    // 正午金黄、黄昏渐变、夜晚关闭。色度取 sunIrradiance 归一化（settings.glsl
    // 常量，与 DeferredLight 的 global.directIlluminance 色度相同，无 SSBO 依赖）。
    // 只染色调不动亮度；DEBUG 分支在其后，不影响红/黑判定。
    #ifndef DIMENSION_THE_END
        float timeBasedTint = saturate(worldSunDir.y * 2.5 - 0.15);
        float tintStrength = AMBIENT_SUNLIGHT_TINT_RATIO * timeBasedTint;
        if (tintStrength > 0.0) {
            vec3 sunColorTint = sunIrradiance / max(luminance(sunIrradiance), 1e-4);
            sky = mix(sky, sky * sunColorTint, tintStrength);
        }
    #endif
    // [2026-08-19 v2] 月光方向化：月亮方向≈-worldSunDir；只对朝月亮的出界方向增强。
    // 亮面有月光反射、背月面压暗 → 体素 GI 出界天光在夜晚有方向性与自然明暗(配 AO)。
    // [2026-08-20 下界无月光] 下界时间固定夜晚(worldSunDir.y<0 → moonAmt>0)，VoxelSkyColor
    // 会被 IRC"新暴露播种"路径调用（该路径无 worldId 守卫）。若不屏蔽，月光会作为下界
    // 新体素的 IRC 种子被写入并自反弹放大 → "下界月光漫反射反弹"。下界屏蔽整段方向月光
    //（主体方向化反弹已在 VoxelTracing/VoxelGI 用 worldId!=-1 屏蔽，此处补播种路径残漏）。
    #ifndef DIMENSION_NETHER
    float moonUp = saturate(-worldSunDir.y);
    float moonAmt = smoothstep(0.05, 0.35, moonUp);
    vec3 moonDir = -worldSunDir;
    float moonFace = saturate(dot(dir, moonDir));
    // 方向月光（朝月面 0.03·face）+ 背月面把均匀夜底压到 20%
    sky = max(sky, vec3(0.30, 0.42, 0.85) * moonAmt * 0.03 * moonFace);
    sky *= 1.0 - 0.80 * (1.0 - moonFace) * moonAmt;
    #endif
    sky = max(sky * fade * gate, vec3(0.0));
    sky *= 0.8;
    #ifdef DEBUG_VOXEL_SKY
        // [2026-08-17] 染红改为"门控放行且有值才红"：洞穴/浅洞 gate≈0 → 黑，
        // 区分"路径被拦截"与"真实吃到天光"（此前无条件红 → 室内也全红）。
        // 注：三元条件必须是标量 bool（vec3 比较是 bvec3，不能作条件）。
        return max(max(sky.r, sky.g), sky.b) > 0.01 ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
    #endif
    return sky;
}
