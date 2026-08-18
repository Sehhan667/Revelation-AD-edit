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
    // [2026-08-18] ×50 临时调试值已还原（阴影死黑根因是追踪端射程用尽未出界，
    // 非下限强度不足）：×50 会让洞穴体素残留 skylight（vd.w 写胜值 ≈0.05-0.15）
    // ×0.22×50 ≈ 0.55-1.65 直接拉亮 IRC 下限 → 洞穴过亮（用户实测）。
    // 还原为 itrp 原式 lightmap×0.22，阴影由射程修复后的真实出界天光承担。
    return skylight * max(float(isEyeInWater == 1) * 0.003, lightmap * 0.22);
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
    vec3 lutSky = max(AtmosphereSkyView(atmosphereViewPos, dir, worldSunDir), vec3(0.0)) * rcp(VOXEL_SKY_REFERENCE);
    float fade = VoxelSkyHorizonFade(dir);
    float gate = VoxelSkyLeakGate(lightmap);
    // [FIX 2026-08-18 傍晚过亮/不变色] 合并 LUT 与 skyColor 兜底必须"LUT 优先、兜底补位"，
    // 不能逐分量 max：白天 LUT 亮蓝 > skyColor 无影响，但傍晚 LUT 物理变暗变粉后
    // max 逐分量取大 → 取到仍亮的蓝紫 skyColor → 傍晚天光不衰减、不变粉（用户实测）。
    // 正确语义：LUT 恒 0（GI pass 未绑定/未生成）时 skyColor 兜底，其余一律用 LUT。
    vec3 sky = lutSky;
    if (luminance(lutSky) < 1e-4) sky = skyColor;   // 兜底判定用亮度，非逐分量 max
    sky = max(sky * fade * gate, vec3(0.0));
    sky *= 0.8;
    // [2026-08-17] 阳光颜色混合（SH 环境光同款机制，用户需求）：天光随太阳高度染暖阳色，
    // 正午金黄、黄昏渐变、夜晚关闭——消除"到处发蓝"。sunIrradiance 色度（settings.glsl 常量，
    // 两个编译单元都可见；DeferredLight 版用 global.directIlluminance，色度相同）。
    // 只染色调不动亮度；DEBUG 分支在其后，不影响红/黑判定。
    #ifndef DIMENSION_THE_END
        float timeBasedTint = saturate(worldSunDir.y * 2.5 - 0.15);
        float tintStrength = AMBIENT_SUNLIGHT_TINT_RATIO * timeBasedTint;
        if (tintStrength > 0.0) {
            vec3 sunColorTint = sunIrradiance / max(luminance(sunIrradiance), 1e-4);
            sky = mix(sky, sky * sunColorTint, tintStrength);
        }
    #endif
    #ifdef DEBUG_VOXEL_SKY
        // [2026-08-17] 染红改为"门控放行且有值才红"：洞穴/浅洞 gate≈0 → 黑，
        // 区分"路径被拦截"与"真实吃到天光"（此前无条件红 → 室内也全红）。
        // 注：三元条件必须是标量 bool（vec3 比较是 bvec3，不能作条件）。
        return max(max(sky.r, sky.g), sky.b) > 0.01 ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
    #endif
    return sky;
}
