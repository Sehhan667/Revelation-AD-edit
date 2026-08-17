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

// 地平线衰减：上半球全开，略低于地平线即截止（与通用光追天空采样一致）
float VoxelSkyHorizonFade(vec3 dir) {
    return saturate(dir.y * 25.0 + 0.5);
}

// 漏光门控：skylight 0.10-0.25 平滑过渡（洞穴/浅洞 <0.10 → 0，杜绝普遍泛蓝；
// 户外 ≥0.25 全开；树冠/半遮挡按比例保留）
float VoxelSkyLeakGate(float lightmap) {
    return smoothstep(0.10, 0.25, lightmap);
}

// 方向天空辐射：AtmosphereSkyView（大气 LUT，调用方需先包含 atmosphere/Common.glsl）
// ÷ 尺度基准 → 0-1 光照尺度；若 LUT 在 GI pass 未绑定（恒 0），退回 MC skyColor
// × 同样的地平线衰减与门控（方向性兜底，避免全黑）。
// 函数内部已含地平线衰减与漏光门控，调用方不要再重复乘。
vec3 VoxelSkyColor(vec3 dir, float lightmap) {
    vec3 sky = max(AtmosphereSkyView(atmosphereViewPos, dir, worldSunDir), vec3(0.0)) * rcp(VOXEL_SKY_REFERENCE);
    float fade = VoxelSkyHorizonFade(dir);
    float gate = VoxelSkyLeakGate(lightmap);
    // [2026-08-17] 门控必须作用到主 LUT 路径：此前只乘在 skyColor 兜底分支上，
    // 洞穴/室内 lightmap≈0 时 LUT 项仍全量通过 → 室内过亮、洞穴漏光（用户实测）。
    sky = max(sky * fade * gate, skyColor * fade * gate);
    sky *= 0.8;
    #ifdef DEBUG_VOXEL_SKY
        // [2026-08-17] 染红改为"门控放行且有值才红"：洞穴/浅洞 gate≈0 → 黑，
        // 区分"路径被拦截"与"真实吃到天光"（此前无条件红 → 室内也全红）。
        // 注：三元条件必须是标量 bool（vec3 比较是 bvec3，不能作条件）。
        return max(max(sky.r, sky.g), sky.b) > 0.01 ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
    #endif
    return sky;
}
