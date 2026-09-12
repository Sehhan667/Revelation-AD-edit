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
// Probe GI — 方向性探针辐照度缓存（完整 DDGI，2026-09-03 重写）查询层
//
// 架构：探针 GI 是**独立于 VXGI/SSILVB 的第三套间接光信号源**。
// - 探针缓存（image.probeIrradiance/probeDistance，16³ 八面体图集）由 DiffuseIndirect.comp
//   每帧按随机方向采样 + 重时域滞后累积维护；辐照度按方向(八面体贴图)存储 + 距离场(均值/方差)
//   做遮挡加权 → 真正方向性、可穿墙遮挡、低频免降噪。
// - 本文件只做八面体编解码 + 图集坐标换算 + DDGI 查询，供计算端（DiffuseIndirect.comp 探针
//   分支）按需 include。探针线追踪/写端见 DiffuseIndirect.comp 的 ProbeUpdateSlice。
//
// 坐标系：vc = camRel + cameraPositionFract + VOXEL_RADIUS（[0,VOXEL_AREA)）。
// 探针格 16³ × 4m = 64m = VOXEL_AREA；探针 i 的格心 vc=(i+0.5)*4。
//
// DDGI 要点（对照 RTXGI Irradiance.hlsl / ProbeBlending.hlsl）：
//   - 每探针一整块 O×O 八面体贴图(O=PROBE_OCT_SIZE+2,含 1 像素边界)，内部 N=PROBE_OCT_SIZE。
//   - 写端把每条探针线的辐照度按 cos(线方向, 纹素方向) 权重融进各纹素，重时域滞后累积；
//     另存每条线命中距离的均值/方差 → 遮挡场。
//   - 查询端对 8 邻探针：三线性位置权重 × wrap-shading × chebyshev 遮挡权重，
//     在各探针的"法线方向"纹素上取辐照度，归一化 × 2π 完成半球蒙特卡洛估计。
//================================================================================================//

#ifndef PROBE_GI_GRID_SIZE
    #define PROBE_GI_GRID_SIZE 16          // 探针网格边长（格数）
#endif
#ifndef PROBE_SPACING
    #define PROBE_SPACING 4.0              // 探针间距(m)；16×4=64 = VOXEL_AREA
#endif
#ifndef PROBE_OCT_SIZE
    #define PROBE_OCT_SIZE 6               // 八面体内边数（不含边界）
#endif
#define PROBE_OCT_BORDER (PROBE_OCT_SIZE + 2)   // 每探针块边长（含 1-texel 边界）
#define PROBE_GRID_SPAN (float(PROBE_GI_GRID_SIZE) * PROBE_SPACING)   // 覆盖总边长(=VOXEL_AREA)

// 八面体图集：每 z-slice = 一个探针平面；x/y = (probeCell * O + octTexel)。
// 纹理尺寸(G*O)×(G*O)×G，与 shaders.properties 的 image.probeIrradiance/2、probeDistance/2 对齐。
#define PROBE_ATLAS_W (PROBE_GI_GRID_SIZE * PROBE_OCT_BORDER)

// 乒乓读/旧采样器（与写端每一帧写 A/写 B 反相读另一块）。仅查询端用。
uniform sampler3D probeIrradianceSampler;
uniform sampler3D probeIrradiance2Sampler;
uniform sampler3D probeDistanceSampler;
uniform sampler3D probeDistance2Sampler;

//================================================================================================//
// 八面体编解码（Cigolle et al. 2014；RTXGI DDGIGetOctahedralCoordinates/Direction）
//================================================================================================//
vec2 ProbeOctSign(vec2 v) {
    vec2 s = sign(v);
    // sign(0)→1（避免 fold 处归零）。用 vec2(bool) 转 0/1，避免 mix(x,y,bvec) 的 HLSL 翻译歧义。
    return mix(s, vec2(1.0), vec2(equal(s, vec2(0.0))));
}

// 方向 → [-1,1]² 八面体 UV（前方半球的相反侧折叠到同方块）
vec2 ProbeOctEncode(vec3 d) {
    float l1 = abs(d.x) + abs(d.y) + abs(d.z);
    vec2 uv = d.xy / max(l1, 1e-8);
    if (d.z < 0.0) uv = (1.0 - abs(uv.yx)) * ProbeOctSign(uv.xy);
    return uv;
}

// [-1,1]² 八面体 UV → 方向（Write 端用：纹素方向）
vec3 ProbeOctDecode(vec2 uv) {
    vec3 d = vec3(uv, 1.0 - abs(uv.x) - abs(uv.y));
    if (d.z < 0.0) d.xy = (1.0 - abs(d.yx)) * ProbeOctSign(d.xy);
    return normalize(d);
}

// 探针格坐标 + 块内 octTexel(0..O-1) → 图集 3D texel 坐标
ivec3 ProbeOctAtlasCoord(ivec3 probeCell, ivec2 octTexel) {
    return ivec3(probeCell.x * PROBE_OCT_BORDER + octTexel.x,
                 probeCell.y * PROBE_OCT_BORDER + octTexel.y,
                 probeCell.z);
}

// 纹素(块内 octTexel，0..O-1) → 该纹素对应的八面体方向（Write 端：算 texelDir 用）
vec3 ProbeOctTexelDir(ivec2 octTexel) {
    // 映射到内部 N×N（去 1-texel 边界）：interior = octTexel - 1 ∈ [0,N)
    vec2 interior = vec2(octTexel - 1);
    vec2 normOct = (interior + 0.5) * rcp(float(PROBE_OCT_SIZE)) * 2.0 - 1.0;   // [-1,1)
    return ProbeOctDecode(normOct);
}

// 八面体图集双线性采样（手动 texelFetch，含 1-texel 边界 → 跨缝可正确折叠）。
// 坐标约定：内部纹素 0..N-1（块内 1..N）的中心角方向 = Write 端 ProbeOctTexelDir；
// 查询时把方向映射到"块内连续坐标 t=(oct*0.5+0.5)*N ∈[0,N]"，再 +0.5 落到块内 1..N 中心准
// （中心处 f=0 得权重 1，不再 50/50 糊化）。t∈[0,N] → tb∈[0.5,N+0.5]，采样邻域含左右边界 0/N+1，
// 左右折叠对称、跨缝正确（边界由 ProbeBorderInterior 镜像拷贝）。
vec4 ProbeOctSample(sampler3D s, ivec3 probeCell, vec3 dir) {
    vec2 oct = ProbeOctEncode(dir);
    vec2 t = (oct * 0.5 + 0.5) * float(PROBE_OCT_SIZE);   // [0,N] 内部坐标
    vec2 tb = t + 0.5;                                    // [0.5,N+0.5] 含边界（中心在整数）
    ivec2 i0 = ivec2(floor(tb));
    vec2 f = tb - vec2(i0);
    vec4 acc = vec4(0.0);
    for (int k = 0; k < 4; ++k) {
        ivec2 off = ivec2(k & 1, (k >> 1) & 1);
        ivec2 q = clamp(i0 + off, ivec2(0), ivec2(PROBE_OCT_BORDER - 1));
        vec2 w = mix(vec2(1.0) - f, f, vec2(off));
        acc += texelFetch(s, ProbeOctAtlasCoord(probeCell, q), 0) * (w.x * w.y);
    }
    return acc;
}

//================================================================================================//
// DDGI 查询：vc(体素空间连续坐标) + 世界法线 + 相机视线 → 线性入射辐照度（未乘 albedo）
//================================================================================================//
float ProbeLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ProbeMaxComp(vec3 c) { return max(max(c.r, c.g), c.b); }

vec3 ProbeSampleRadiance(vec3 vc, vec3 worldNormal, vec3 cameraDir) {
    const float G = float(PROBE_GI_GRID_SIZE);
    const float GRID_HALF = G * 0.5;
    const float spacing = PROBE_SPACING;
    const float twoPi = 6.2831853;

    // 查询点世界位置 + 上帧网格锚(gridOriginPrev)
    vec3 worldPos = vc + vec3(cameraPositionInt) - float(VOXEL_RADIUS);
    vec3 gridOriginPrev = (round(previousCameraPosition * rcp(spacing)) - GRID_HALF) * spacing;

    // [FIX 2026-09-03 网格边缘无限外延] DDGI 体积衰减：探针体积(最外层探针中心 ±(G-1)/2·spacing)
    // 之外，一个探针间距内淡出到 0。否则边缘探针的光被 clamp+alpha=1 等值外推到体积外所有表面 →
    // 光沿 4m 探针轴向无限延伸（方向随玩家-光源相对位置变，正是用户所见）。
    vec3 centerV = gridOriginPrev + GRID_HALF * spacing;
    vec3 edgeIn = vec3(float(PROBE_GI_GRID_SIZE) * 0.5 - 0.5) * spacing;      // 最外探针中心距离
    vec3 fadeV = vec3(1.0) - smoothstep(edgeIn, edgeIn + vec3(spacing),
                                        abs(worldPos - centerV));
    float volFade = fadeV.x * fadeV.y * fadeV.z;

    // DDGI 表面偏置：突出表面避免数值不稳，把采样点推入探针体素内部
    vec3 surfaceBias = (worldNormal * PROBE_NORMAL_BIAS) + (-cameraDir * PROBE_VIEW_BIAS);
    vec3 biasedPos = worldPos + surfaceBias;

    // Standard DDGI center-based interpolation. Probe 0 is centered at +0.5 cell,
    // so subtract 0.5 before floor/fract and keep room for the +1 neighbor.
    vec3 probeGridPos = (biasedPos - gridOriginPrev) * rcp(spacing) - 0.5;
    ivec3 baseProbe = clamp(ivec3(floor(probeGridPos)),
                            ivec3(0), ivec3(PROBE_GI_GRID_SIZE - 2));
    vec3 alpha = clamp(probeGridPos - vec3(baseProbe), vec3(0.0), vec3(1.0));

    // 采样器（上一帧内容的那块，即与写端反相）。直接按帧奇偶把 sampler 传给函数（不做采样器局部变量）。
    bool even = ((uint(frameCounter) & 1u) == 0u);

    vec3 irradiance = vec3(0.0);
    float accWeight = 0.0;
    float accUnoccludedWeight = 0.0;
    float gammaHalf = PROBE_IRRADIANCE_GAMMA * 0.5;

    for (int i = 0; i < 8; ++i) {
        ivec3 adjOffset = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
        ivec3 adjCell = clamp(baseProbe + adjOffset, ivec3(0), ivec3(PROBE_GI_GRID_SIZE - 1));
        vec3 adjProbeWorld = gridOriginPrev + (vec3(adjCell) + 0.5) * spacing;

        vec3 worldPosToAdj = normalize(adjProbeWorld - worldPos);
        vec3 biasedPosToAdj = normalize(adjProbeWorld - biasedPos);
        float biasedDist = length(adjProbeWorld - biasedPos);

        // wrap-shading：探针朝向与法线的对齐（避免"小细节法线把互见探针全排除"）
        float wrapShading = (dot(worldPosToAdj, worldNormal) + 1.0) * 0.5;
        float weight = (wrapShading * wrapShading) + 0.2;

        // 遮挡：采样"探针→采样点"方向的距离场，做 chebyshev 权重（防穿墙漏光）
        vec4 distSample = even
            ? ProbeOctSample(probeDistance2Sampler, adjCell, -biasedPosToAdj)
            : ProbeOctSample(probeDistanceSampler, adjCell, -biasedPosToAdj);
        vec2 filteredDist = 2.0 * distSample.rg;   // 写端 ÷2，读回乘 2
        // 未写入/NaN/垃圾 → 视作"无遮挡"(mean 大)；方差给下限避免 chebyshev 变硬开关(硬边缘)。
        bool distOK = all(equal(filteredDist, filteredDist));
        float meanDist = (distOK && filteredDist.x >= 0.0 && filteredDist.x < 100.0)
                       ? filteredDist.x : 100.0;
        float meanSq = (distOK && filteredDist.y >= 0.0 && filteredDist.y < 20000.0)
                     ? filteredDist.y : (meanDist * meanDist);
        float variance = max(abs(meanDist * meanDist - meanSq), 0.25);
        float cheb = 1.0;
        if (biasedDist > meanDist) {
            float v = biasedDist - meanDist;
            cheb = variance / max(variance + v * v, 1e-6);
            cheb = max(cheb * cheb * cheb, 0.0);
        }
        // Keep a tiny probe contribution floor to avoid regular black probe
        // cells when the biased surface point lies just behind the distance
        // estimate. The absolute visibility ratio below still suppresses
        // genuinely occluded walls.
        weight *= max(0.02, clamp(cheb, 0.0, 1.0));
        const float crush = 0.2;
        if (weight < crush) weight *= (weight * weight) * (1.0 / (crush * crush));

        // 三线性权重最后乘（对八探针累加归一化正是 DDGI 的探针间三线性插值）
        vec3 trilinear = max(vec3(0.001), mix(vec3(1.0) - alpha, alpha, vec3(adjOffset)));
        float trilinearWeight = trilinear.x * trilinear.y * trilinear.z;
        accUnoccludedWeight += ((wrapShading * wrapShading) + 0.2) * trilinearWeight;
        weight *= trilinearWeight;

        // 采样辐照度（法线方向纹素）；先判有效性/NaN（写端 alpha=1 标记；首帧另一块未写入 → 跳过）。
        vec4 irrSample = even
            ? ProbeOctSample(probeIrradiance2Sampler, adjCell, worldNormal)
            : ProbeOctSample(probeIrradianceSampler, adjCell, worldNormal);
        if (irrSample.a < 0.5 || !all(equal(irrSample.rgb, irrSample.rgb))) continue;
        vec3 probeIrr = pow(max(irrSample.rgb, vec3(0.0)), vec3(gammaHalf));

        irradiance += weight * probeIrr;
        accWeight += weight;
    }

    if (accWeight <= 1e-6) return vec3(0.0);
    irradiance *= rcp(accWeight);
    // Do not let normalization amplify a tiny fully-occluded remainder back to
    // full brightness. Preserve the absolute visibility fraction.
    irradiance *= saturate(accWeight * rcp(max(accUnoccludedWeight, 1e-6)));
    irradiance *= irradiance;   // 还原线性（写端 ^ (1/gamma)，读端 ^(gamma/2) 再平方）
    irradiance *= twoPi;
    irradiance *= volFade;      // 体积衰减：网格外无 GI（不无限外延）
    return max(irradiance, vec3(0.0));
}
