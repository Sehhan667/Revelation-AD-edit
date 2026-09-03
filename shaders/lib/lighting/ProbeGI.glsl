//================================================================================================//
// Probe GI — 探针辐照度缓存（DDGI 风格）查询层
//
// 架构：探针 GI 是**独立于 VXGI/SSILVB 的第三套间接光信号源**。
// - 探针缓存（image.probeRadiance，16³）由 ProbeUpdate.comp 每帧按 STBN 随机方向采样、
//   EMA 时域累积维护，值 = 平滑低频入射辐照度 → 天然免降噪。
// - 本文件只做探针缓存的三线性查询 + 探针格坐标换算，供计算端（DiffuseIndirect 探针
//   分支）/片端按需 include。探针线追踪见 ProbeTrace.glsl（仅 ProbeUpdate.comp 使用）。
//
// 坐标系与体素化一致：vc = camRel + cameraPositionFract + VOXEL_RADIUS（[0,VOXEL_AREA)）。
// 探针格 16³ × 4m = 64m = VOXEL_AREA，与体素网格对齐；归一化采样坐标 = vc / PROBE_GRID_SPAN。
// 探针 i 的格心 vc=(i+0.5)*4 → 归一化 (i+0.5)/16，恰在纹素中心 → sampler3D LINEAR 即三线性。
//================================================================================================//

#ifndef PROBE_GI_GRID_SIZE
    #define PROBE_GI_GRID_SIZE 16          // 探针网格边长（格数）
#endif
#ifndef PROBE_SPACING
    #define PROBE_SPACING 4.0              // 探针间距(m)；16×4=64 = VOXEL_AREA
#endif
#define PROBE_GRID_SPAN (float(PROBE_GI_GRID_SIZE) * PROBE_SPACING)   // 覆盖总边长(=VOXEL_AREA)
#define PROBE_GRID_RCP  (1.0 / float(PROBE_GI_GRID_SIZE))

// 无显式 binding（项目铁律：显式 binding 与 Iris 分配的纹理单元冲突 → 全黑根因）。
// image.probeRadiance / probeRadiance2（shaders.properties）的采样器端（乒乓双缓冲）。
uniform sampler3D probeRadianceSampler;
uniform sampler3D probeRadiance2Sampler;

// 手动三线性（texelFetch 8 tap，FetchVoxelRadianceTrilinear 同款做法——自定义 image 的
// 采样器过滤状态不可靠，不依赖硬件 LINEAR）。probeCoord 为连续探针格坐标（格心 = 整数 + 0.5）。
vec4 ProbeFetchTrilinear(sampler3D s, vec3 probeCoord) {
    vec3 p = probeCoord - 0.5;
    ivec3 i0 = ivec3(floor(p));
    vec3 t = p - vec3(i0);
    vec4 acc = vec4(0.0);
    for (int k = 0; k < 8; ++k) {
        ivec3 off = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        ivec3 q = clamp(i0 + off, ivec3(0), ivec3(PROBE_GI_GRID_SIZE - 1));
        vec3 w3 = mix(vec3(1.0) - t, t, vec3(off));
        acc += texelFetch(s, q, 0) * (w3.x * w3.y * w3.z);
    }
    return acc;
}

// 探针缓存查询：vc(体素空间连续坐标) → trilinear 平滑入射辐照度（0-1 尺度，未乘 albedo）。
// [2026-09-03 VXGI 同构时序] ProbeUpdate 挂在 deferred50（晚于本查询 deferred1_a），查询永远
// 读上一帧写入完成的缓存：其锚 = 上一帧 cameraPositionInt。故查询坐标补 +cDi =
// (cameraPositionInt - previousCameraPositionInt) 对齐本帧世界，与 VoxelTracing.glsl 消费
// IRC 的 ircHit = vc + cDi 逐字同构。曾试写 pass 前移做同帧写后读直读；直写诊断证明移动仍
// 闪回 —— 连续 compute 跨 pass imageStore 可见性滞后 1-2 帧，不依赖同帧可见性的本时序才稳。
// 乒乓相位：deferred50 偶帧写 A/奇帧写 B；查询在读之前、须反相读上帧块 → 偶读 B、奇读 A。
vec3 ProbeSampleRadiance(vec3 vc) {
    // [DDGI 式网格锚定读取] 查询点世界位置 → 上帧网格索引。网格锚 gridOriginPrev 对齐到 4m 格，
    // 与写端 ProbeUpdateSlice 的世界锚定一致（内容钉世界，无累积漂移/回卷）。
    const float GRID_HALF = float(PROBE_GI_GRID_SIZE) * 0.5;
    vec3 gridOriginPrev = (round(previousCameraPosition * rcp(PROBE_SPACING)) - GRID_HALF) * PROBE_SPACING;
    vec3 probeWorld = vc + vec3(cameraPositionInt) - float(VOXEL_RADIUS);   // 查询点世界位置
    vec3 probeCoord = (probeWorld - gridOriginPrev) * rcp(PROBE_SPACING);   // 上帧网格索引
    vec4 rad = ((frameCounter & 1) == 0)
        ? ProbeFetchTrilinear(probeRadiance2Sampler, probeCoord)
        : ProbeFetchTrilinear(probeRadianceSampler,  probeCoord);
#ifdef DEBUG_PROBE_PLUMBING
    // [管线自检 2026-09-03 v3] 写端健康标记：三分哨兵，一次重载即可二分写端状态。
    //   a<0.5（从未被写端写过）     → 亮红  —— deferred50 写端没在跑/绑定错/调度错
    //   a≈1 但 rgb≈0（写过但内容空）→ 亮绿  —— 写端在跑 a=1，但 RGB 是 0（真实光照≈0，
    //                                         或写端 DEBUG 分支未生效走了真实光照路径）
    //   正常渐变（≈右半直算参照）   → 写端 debug 渐变已写入，读回一致
    if (rad.a < 0.5) return vec3(2.0, 0.05, 0.05);
    if (max(max(rad.r, rad.g), rad.b) < 1e-4) return vec3(0.05, 2.0, 0.05);
#endif
    // NaN 防御：缓存里若残留 NaN（DDA/求交/未绑定采样器兜底路径），读端也归零，避免 NaN 上屏。
    if (!all(equal(rad.rgb, rad.rgb))) return vec3(0.0);
    return max(rad.rgb, vec3(0.0));
}