//================================================================================================//
// SVGF Upscale Diffuse Indirect (轻量稳定版，已移除体积雾及非必要宏)
//================================================================================================//
// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.
#if defined PASS_DEFERRED_LIGHTING
// GI 画布 texel 坐标（半分辨率 = 全分辨率坐标 >>1，画布在左上象限；全分辨率 = 原样）。
// 放在上采样可用性宏之外：DeferredLight 的所有 GI 读回都用它（含不走上采样的分支）。
ivec2 GICanvasCoord(in ivec2 texelPos) {
#ifdef VXGI_FULLRES
    return texelPos;
#else
    return texelPos >> 1;
#endif
}
// [FIX 2026-08-06] 用简单 #if defined 控制（原复合条件 `#if defined SVGF_ENABLED &&
// (defined GI_ACTIVE_SSILVB || defined GI_ACTIVE_VXGI)` 会破坏 Iris 对布尔宏 SVGF_ENABLED 的
// 扫描 → GUI 开关无法真正注释/取消注释 settings.glsl 的 #define → 关掉 SVGF 降噪仍生效）。
// [2026-08-28 方案B] 本上采样函数被两条路径共用：SSILVB(SVGF_ENABLED) 与 VXGI(VOXEL_GI_DENOISE)，
// 两套降噪开关相互独立。用两个独立简单 #ifdef 分支设置可用标记，避免复合条件再次破坏 Iris 扫描。
#ifdef SVGF_ENABLED
    #define SVGF_UPSCALE_AVAILABLE
#endif
#ifdef VOXEL_GI_DENOISE
    #define SVGF_UPSCALE_AVAILABLE
#endif
// 关降噪时 VXGI 读的是 colortex2（时域累积结果，不经 VarianceEstimate 搬进 colortex3），
// 但上采样（含 SVGF_QUALITY=1 的深度感知档）仍要可用 → VXGI 一律标记可用。
#ifdef GI_ACTIVE_VXGI
    #define SVGF_UPSCALE_AVAILABLE
#endif
#ifdef SVGF_UPSCALE_AVAILABLE
#ifndef SVGF_QUALITY
    #define SVGF_QUALITY 0 // 半分辨率 GI 的上采样档位：0=仅取中心值（2x2 块状），1=4 邻域深度感知上采样 [0 1]
#endif

// 【唯一保留的可调参数】
// 深度容差平滑度：越接近 0.0 跨越物体的边界越平滑（越不闪），越负则边缘越锐利但易闪烁。
#define SSILVB_DEPTH_FALLBACK   -0.05   // 推荐范围 [-0.01, -0.10]

// srcTex：GI 画布（降噪开=colortex3 的滤波结果；降噪关=colortex2 的时域累积结果）。
// 两者坐标口径一致（都按 GI 画布 texel 索引），故只换纹理即可共用同一套上采样。
vec3 UpscaleDiffuseIndirectFrom(sampler2D srcTex, in ivec2 texelPos, in vec3 worldNormal, in float viewDistance) {
    ivec2 halfPos = GICanvasCoord(texelPos);
#ifdef VXGI_FULLRES
    ivec2 texelEnd = ivec2(viewSize) - 2;
#else
    ivec2 texelEnd = ivec2(halfViewEnd) - 1;
#endif

    vec3 centerCol = texelFetch(srcTex, halfPos, 0).rgb;
    float sumWeight = 1.0;
    vec3 sum = centerCol;

    // 质量 0 直接返回中心值，跳过所有采样
    #if SVGF_QUALITY == 0
        return sum;
    #endif

    // 十字采样偏移（4 邻域，保持基本的方向覆盖）
    const ivec2 offsets[4] = ivec2[](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));
    float falloff = SSILVB_DEPTH_FALLBACK;

    for (int i = 0; i < 4; ++i) {
        ivec2 samplePos = clamp(halfPos + offsets[i], ivec2(1), texelEnd);

        // 辅助纹理：rg = 八面体编码法线，b = 线性深度
        vec3 aux = texelFetch(colortex14, samplePos, 0).rgb;
        vec3 color = texelFetch(srcTex, samplePos, 0).rgb;

        // 深度权重：原生 exp2（旧的本地位技巧把 log2(e) 的浮点位型当整数比例用，
        // 深度差 1 格就把权重压到 0.013、差 20 格以上还会溢出成 NaN）
        float depthWeight = exp2(abs(aux.z - viewDistance) * falloff);

        // 法线权重（解码八面体法线并与中心法线点积，保证边缘不跨物体）
        float ndot = saturate(dot(OctDecodeSnorm(aux.xy), worldNormal));
        float weight = ndot * depthWeight;

        sum += color * weight;
        sumWeight += weight;
    }

    return sum * rcp(sumWeight);
}

vec3 UpscaleDiffuseIndirect(in ivec2 texelPos, in vec3 worldNormal, in float viewDistance) {
    return UpscaleDiffuseIndirectFrom(colortex3, texelPos, worldNormal, viewDistance);
}

// 关降噪：读时域累积结果（colortex2 由 Accumulate 写入），跳过空间滤波但仍做上采样
vec3 UpscaleDiffuseIndirectAccum(in ivec2 texelPos, in vec3 worldNormal, in float viewDistance) {
    return UpscaleDiffuseIndirectFrom(colortex2, texelPos, worldNormal, viewDistance);
}

#endif
#endif