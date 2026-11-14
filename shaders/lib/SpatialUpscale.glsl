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
    // [2026-11-10 2.5] 奇数分辨率：画布宽 = trunc(viewWidth/2)，而 (viewWidth-1)>>1 会等于画布宽
    // ⇒ 最右/最下那一列 texelFetch 越界（读到未定义内容 = 黑边/串色）。统一在这里夹住。
    return min(texelPos >> 1, ivec2(halfViewSize) - 1);
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
// 兜底值必须与 settings.glsl 的 GUI 默认值一致（它已定义 ⇒ 本段不生效，只防误导）。
#ifndef SVGF_QUALITY
    #define SVGF_QUALITY 1 // 半分辨率 GI 的上采样档位：0=仅取中心值（2x2 块状），1=4 邻域深度感知上采样 [0 1]
#endif

// 上采样的相对深度阈值陡度：相对视距差 1% → 0.64，3% → 0.13，5% → 0.01
#define GI_UPSAMPLE_DEPTH_STEEP   64.0

// srcTex：GI 画布（降噪开=colortex3 的滤波结果；降噪关=colortex2 的时域累积结果）。
// 两者坐标口径一致（都按 GI 画布 texel 索引），故只换纹理即可共用同一套上采样。
// viewDepth：中心像素的线性视深（= viewPos.z，负值）。
//
// [2026-11-11 官方口径] NRD README（IQ VS PERFORMANCE: TRACING AND DENOISING RESOLUTION）对
// 半/四分之一分辨率的要求是两句：
//   1) "From NRD's point of view this is full-resolution input, so checkerboarding is disabled"
//      —— 喂给降噪器的输入/guide 全部是**降噪分辨率**（我们是半分辨率 colortex14）✓；
//   2) "bind downsampled guides to NRD but **retain the original full-resolution guides for the
//      application-side resolve**"
//      —— 应用侧上采样必须用**全分辨率** guide。
// 旧实现两条都用了半分辨率 colortex14（深度 z + 八面体法线）：权重只在画布格点上取值，
// 全分辨率像素之间的差异完全体现不出来 ⇒ 退化成 2×2 的软混合，GI 边缘跟着画布格点走。
// 现在权重改用全分辨率 depthtex0 + 法线包，与中心像素自己的全分辨率视深/法线比较。
vec3 UpscaleDiffuseIndirectFrom(sampler2D srcTex, in ivec2 texelPos, in float viewDepth) {
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
    // 全分辨率 guide：中心像素的几何法线（世界空间，与 tap 同源）
    vec3 centerN = FetchGeometryNormal(clamp(texelPos, ivec2(0), ivec2(viewSize) - 1));
    float invDepth = rcp(max(-viewDepth, 0.001));

    for (int i = 0; i < 4; ++i) {
        ivec2 samplePos = clamp(halfPos + offsets[i], ivec2(1), texelEnd);
        vec3 color = texelFetch(srcTex, samplePos, 0).rgb;

        // 该画布纹素对应的**屏幕**采样位置。guide 必须按这个位置取全分辨率值。
        // 半分辨率：画布纹素 (x,y) 的信号取自屏幕 (2x, 2y)（画布相位固定 0，见 lib/utility/Offset.glsl）；
        // 全分辨率模式（VXGI_FULLRES）下画布纹素**就是**屏幕纹素，不能再 ×2。
#ifdef VXGI_FULLRES
        ivec2 tapScreen = clamp(samplePos, ivec2(0), ivec2(viewSize) - 1);
#else
        ivec2 tapScreen = clamp(samplePos * 2, ivec2(0), ivec2(viewSize) - 1);
#endif
        float tapZ = ScreenToViewDepth(loadDepth0(tapScreen));
        vec3 tapN = FetchGeometryNormal(tapScreen);

        // 相对深度权重：两侧都是线性视深（负值），差值再按 |视深| 归一。
        float depthWeight = exp2(-abs(tapZ - viewDepth) * invDepth * GI_UPSAMPLE_DEPTH_STEEP);
        // 法线权重（两侧同为几何法线，保证边缘不跨物体）
        float ndot = saturate(dot(tapN, centerN));
        float weight = ndot * depthWeight;

        sum += color * weight;
        sumWeight += weight;
    }

    return sum * rcp(sumWeight);
}

vec3 UpscaleDiffuseIndirect(in ivec2 texelPos, in float viewDepth) {
    return UpscaleDiffuseIndirectFrom(colortex3, texelPos, viewDepth);
}

// 关降噪：读时域累积结果（colortex2 由 Accumulate 写入），跳过空间滤波但仍做上采样
vec3 UpscaleDiffuseIndirectAccum(in ivec2 texelPos, in float viewDepth) {
    return UpscaleDiffuseIndirectFrom(colortex2, texelPos, viewDepth);
}

#endif
#endif