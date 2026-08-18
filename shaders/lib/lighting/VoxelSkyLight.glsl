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
    #define AMBIENT_SUNLIGHT_TINT_RATIO 1.1 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.5 3.0]
#endif

// [2026-08-18] itrp 同款解析天光下限（SimpleSkyLighting，完整照搬）：
// 阴影/闭塞体素的 IRC 底光不依赖"射线出界"——由法线上下曲线 + 阳光小底 +
// lightmap 门控给出连续下限，经 IRC 自反弹传播成"阴影本身是亮的"。
// skylightColor = 天光辐照度色；shadowlightColor = 太阳/月亮直射色；两者仅取色度，
// 亮度由 NdotU 曲线和 lightmap*0.22 门控决定（与 itrp 系数一致，不做本地化换算）。
vec3 SimpleSkyLighting(vec3 skylightColor, vec3 shadowlightColor, float NdotU, float lightmap) {
    vec3 skylight = skylightColor * (NdotU * 0.35 + 0.65);
    vec3 skySunLight = shadowlightColor * (NdotU * 0.015 + 0.02);
    skylight += skySunLight;
    skylight = mix(skylight, shadowlightColor * (NdotU * 0.003 + 0.005), wetness * 0.6);
    // [FIX 2026-08-18 暗处过亮/过渡生硬] 原 step(0.15) 硬门槛 + 线性 ×50：
    // lightmap=0.5 → 0.5×0.22×50=5.5 保色压缩到 1.0，与白天(11→1)同样饱和
    // → 暗处和明处一样亮、0.15 处硬跳变（用户实测）。改为：
    // - 软门槛 smoothstep(0.15,0.40)：洞穴残留(<0.15)仍归零，过渡平滑
    // - lightmap² 曲线：白天(≈1)仍饱和到 1.0（视觉与 ×50 一致，用户确认值），
    //   暗处按平方衰减有梯度（0.6→0.63、0.4→0.28、0.2→0.07），不过量
    float caveGate = smoothstep(0.15, 0.40, lightmap);
    return skylight * max(float(isEyeInWater == 1) * 0.003, lightmap * lightmap * 0.22 * caveGate) * 8.0;
}

// 地平线衰减：上半球全开，略低于地平线即截止（与通用光追天空采样一致）
float VoxelSkyHorizonFade(vec3 dir) {
    return saturate(dir.y * 25.0 + 0.5);
}

// 漏光门控：skylight 0.03-0.30 平滑过渡（2026-08-17 放宽：原 0.10-0.25 阈值太陡，
// 室内/半遮挡出现硬分界线——低于 0.10 直接 0、高于 0.25 直接满，而 skylight 每格只降
// 1/15，过渡带仅 1-2 格。放宽后部分遮挡（走廊/树冠）按比例保留天光，边界柔和。
// 洞穴（≈0）仍为 0，不漏光。）
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
    sky = mix(sky, max(sky, skyColor), dayBlend);
    float skyLuma = luminance(sky);   // 先取亮度（保持分时策略的亮度）
    // [FIX 2026-08-18 傍晚发绿] 色度按 dayBlend 分时段取：
    // - 白天：SH 色度（global.skySH 与 DeferredLight 环境光同源，正午蓝正确）
    // - 傍晚/夜晚：LUT 色度（物理天空，AtmosphereSkyView 直接给出橙粉/蓝紫）
    // 全用 SH 时傍晚发绿：SH 是 3 阶低频球谐，会把太阳周围粉色光晕展平、
    // 与蓝色天顶混成青绿（用户实测）。LUT 是逐方向精确物理采样，无此问题。
    vec3 shSky = ConvolvedReconstructSH3(global.skySH, dir);
    vec3 shChroma = shSky / max(luminance(shSky), 1e-4);
    vec3 lutChroma = lutSky / max(luminance(lutSky), 1e-4);
    vec3 chroma = mix(lutChroma, shChroma, dayBlend);
    sky = chroma * skyLuma;
    // [2026-08-18] 网格外环境光含"暖色假反弹"（DeferredLight L511：
    // ambientAccum += CalculateFakeBouncedLight * lm3 * lm3 * sunlightBase，
    // sunlightBase = 暖阳色 global.directIlluminance × 云影）→ 蓝被中和，
    // 而网格内 GI 天光是纯 SH 蓝 → 明显更蓝（用户实测）。用户方案：
    // 网格内也混入"假反弹的颜色"（暖阳色度），但不做假反弹的几何/亮度计算。
    // 色度取 global.directIlluminance（与网格外同一来源，含昼夜色温——正午暖白、
    // 傍晚橙红、夜晚暗蓝；比 settings.glsl 的 sunIrradiance 纯白更能中和蓝）。
    // 强度 = 太阳仰角权重（正午暖、傍晚弱、夜晚关），加性混入暖底模拟地面反弹阳光。
    #ifndef DIMENSION_THE_END
        float bounceBlend = saturate(worldSunDir.y * 2.0) * 0.18;
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
