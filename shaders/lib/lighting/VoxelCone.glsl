//================================================================================================//
// VoxelCone — 锥追踪加速实验档（低质量 VXGI，2026-09-06）
//
// 思路出处：Voxel Cone Tracing（Crassin et al., I3D 2011）+ NVIDIA VXGI 的"分层体素 + mip 滤波"
// 思想，在**规则网格**上落地：把 IRC 辐照度场（64³×1m，×100 存储）做 mip 金字塔
// （32/16/8³ = 2/4/8m 平均辐照度），并另建"固体占用"金字塔（voxelData 平均）作软遮挡。
// 开启后（VOXEL_CONE_GI，默认关）每像素不再做 ≤24 步 DDA，改为沿法线半球 5 条锥 × 4 档
// mip 采样 → 单像素体素访存大幅下降，代价是近距/细节/锐利度下降（低质量加速档，可 A/B）。
//
// 数据流与竞争分析：
//   - 注入端（deferred23/VoxelGI.frag）按帧奇偶写 voxelRadiance/voxelRadiance2；
//   - 本文件的构建端只读"上一帧已写块"（FetchVoxelRadiance，帧奇偶选择），
//     写 mip 的当前奇偶组（偶数帧写 A 组/奇数写 B 组）；
//   - 采样端读另一奇偶组 → 与 IRC 自反弹同级的一帧滞后，构建与采样同一 dispatch 也不冲突；
//   - 占用金字塔源 = voxelData（shadow pass 本帧已写，deferred 阶段只读）→ 无竞争。
//
// 资源：shaders.properties 新增 image.voxelRadMip2A/B、4A/B、8A/B 与 image.voxelOccMip2A/B…
// （32/16/8³ rgba16f）。开关：VOXEL_CONE_GI；校准：VOXEL_CONE_STRENGTH。
//================================================================================================//
#ifdef VOXEL_CONE_GI

// 构建任务数：rad mips 32³+16³+8³=37376；occ 同 → 74752（每帧由 deferred1_a 各线程分块）
#define VOXEL_CONEMIP_L1TASKS 32768u
#define VOXEL_CONEMIP_L2TASKS 4096u
#define VOXEL_CONEMIP_L3TASKS 512u
#define VOXEL_CONEMIP_RADTASKS (VOXEL_CONEMIP_L1TASKS + VOXEL_CONEMIP_L2TASKS + VOXEL_CONEMIP_L3TASKS)
#define VOXEL_CONEMIP_TASKS    (VOXEL_CONEMIP_RADTASKS * 2u)

// ---- 写端 images（A/B = 帧奇偶组：偶数帧写 A，奇数帧写 B）----
layout (rgba16f) uniform writeonly image3D voxelRadMip2A;
layout (rgba16f) uniform writeonly image3D voxelRadMip4A;
layout (rgba16f) uniform writeonly image3D voxelRadMip8A;
layout (rgba16f) uniform writeonly image3D voxelRadMip2B;
layout (rgba16f) uniform writeonly image3D voxelRadMip4B;
layout (rgba16f) uniform writeonly image3D voxelRadMip8B;
layout (rgba16f) uniform writeonly image3D voxelOccMip2A;
layout (rgba16f) uniform writeonly image3D voxelOccMip4A;
layout (rgba16f) uniform writeonly image3D voxelOccMip8A;
layout (rgba16f) uniform writeonly image3D voxelOccMip2B;
layout (rgba16f) uniform writeonly image3D voxelOccMip4B;
layout (rgba16f) uniform writeonly image3D voxelOccMip8B;

// ---- 读端 samplers（Iris 按 properties image.<key> = <key>Sampler 名字自动绑定）----
uniform sampler3D voxelRadMip2ASampler;
uniform sampler3D voxelRadMip4ASampler;
uniform sampler3D voxelRadMip8ASampler;
uniform sampler3D voxelRadMip2BSampler;
uniform sampler3D voxelRadMip4BSampler;
uniform sampler3D voxelRadMip8BSampler;
uniform sampler3D voxelOccMip2ASampler;
uniform sampler3D voxelOccMip4ASampler;
uniform sampler3D voxelOccMip8ASampler;
uniform sampler3D voxelOccMip2BSampler;
uniform sampler3D voxelOccMip4BSampler;
uniform sampler3D voxelOccMip8BSampler;

//================================================================================================//
// 构建端
//================================================================================================//

bool VoxelConeValid(vec4 v) {
    return all(equal(v, v)) && !any(isinf(v));
}

// 每级块内的线性索引 → 格坐标（level 1/2/3 = 32/16/8³）
ivec3 VoxelConeCellCoord(uint lin, int level) {
    uint n = (level == 1) ? 32u : ((level == 2) ? 16u : 8u);
    return ivec3(int(lin % n), int((lin / n) % n), int(lin / (n * n)));
}

int VoxelConeLevelOf(uint lin) {
    if (lin < VOXEL_CONEMIP_L1TASKS) return 1;
    if (lin < VOXEL_CONEMIP_L1TASKS + VOXEL_CONEMIP_L2TASKS) return 2;
    return 3;
}

uint VoxelConeLinInLevel(uint lin) {
    if (lin < VOXEL_CONEMIP_L1TASKS) return lin;
    if (lin < VOXEL_CONEMIP_L1TASKS + VOXEL_CONEMIP_L2TASKS) return lin - VOXEL_CONEMIP_L1TASKS;
    return lin - VOXEL_CONEMIP_L1TASKS - VOXEL_CONEMIP_L2TASKS;
}

// 一个构建任务：rad 或 occ 的一个 mip 格（k = 2^level 个子体素平均）
void VoxelMipBuildTask(uint task) {
    bool radTask = task < VOXEL_CONEMIP_RADTASKS;
    uint lin  = radTask ? task : (task - VOXEL_CONEMIP_RADTASKS);
    int  level = VoxelConeLevelOf(lin);
    uint loc   = VoxelConeLinInLevel(lin);
    int  k     = 1 << level;
    ivec3 cell = VoxelConeCellCoord(loc, level);

    vec4 acc = vec4(0.0);
    float cnt = 0.0;
    for (int zz = 0; zz < k; ++zz)
    for (int yy = 0; yy < k; ++yy)
    for (int xx = 0; xx < k; ++xx) {
        ivec3 g = cell * k + ivec3(xx, yy, zz);
        if (radTask) {
            vec4 v = FetchVoxelRadiance(g);          // 上一帧已写块（帧奇偶选择）
            if (!VoxelConeValid(v)) continue;
            acc += vec4(max(v.rgb, vec3(0.0)), max(v.a, 0.0));
            cnt += 1.0;
        } else {
            acc.r += step(0.5, texelFetch(voxelDataSampler, g, 0).z);   // 固体占用
            cnt += 1.0;
        }
    }

    vec4 out;
    if (cnt < 1e-4)      out = vec4(0.0);
    else if (radTask)    out = vec4(acc.rgb, acc.a) * rcp(cnt);
    else                 out = vec4(acc.r * rcp(cnt), 0.0, 0.0, 1.0);

    bool even = ((uint(frameCounter) & 1u) == 0u);   // 偶数帧写 A 组（与注入端同号）
    if (radTask) {
        if (even) {
            if (level == 1) imageStore(voxelRadMip2A, cell, out);
            else if (level == 2) imageStore(voxelRadMip4A, cell, out);
            else imageStore(voxelRadMip8A, cell, out);
        } else {
            if (level == 1) imageStore(voxelRadMip2B, cell, out);
            else if (level == 2) imageStore(voxelRadMip4B, cell, out);
            else imageStore(voxelRadMip8B, cell, out);
        }
    } else {
        if (even) {
            if (level == 1) imageStore(voxelOccMip2A, cell, out);
            else if (level == 2) imageStore(voxelOccMip4A, cell, out);
            else imageStore(voxelOccMip8A, cell, out);
        } else {
            if (level == 1) imageStore(voxelOccMip2B, cell, out);
            else if (level == 2) imageStore(voxelOccMip4B, cell, out);
            else imageStore(voxelOccMip8B, cell, out);
        }
    }
}

//================================================================================================//
// 采样端（读另一奇偶组 = 上一帧构建结果）
//================================================================================================//

// level=0：基体素（IRC 64³，FetchVoxelRadiance 已含帧奇偶 = 上一帧块）；level 1/2/3 = 2/4/8m
vec4 VoxelConeRadFetch(ivec3 c, int level, out bool oob) {
    if (level == 0) {
        oob = any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, ivec3(VOXEL_AREA)));
        if (oob) return vec4(0.0);
        return FetchVoxelRadiance(c);
    }
    int n = (level == 1) ? 32 : ((level == 2) ? 16 : 8);
    oob = any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, ivec3(n)));
    if (oob) return vec4(0.0);
    bool even = ((uint(frameCounter) & 1u) == 0u);   // 采样端读另一组
    if (even) {
        if (level == 1) return texelFetch(voxelRadMip2BSampler, c, 0);
        else if (level == 2) return texelFetch(voxelRadMip4BSampler, c, 0);
        else return texelFetch(voxelRadMip8BSampler, c, 0);
    } else {
        if (level == 1) return texelFetch(voxelRadMip2ASampler, c, 0);
        else if (level == 2) return texelFetch(voxelRadMip4ASampler, c, 0);
        else return texelFetch(voxelRadMip8ASampler, c, 0);
    }
}

vec4 VoxelConeOccFetch(ivec3 c, int level, out bool oob) {
    int n = (level == 0) ? VOXEL_AREA : ((level == 1) ? 32 : ((level == 2) ? 16 : 8));
    oob = any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, ivec3(n)));
    if (oob) return vec4(0.0);
    if (level == 0)
        return vec4(step(0.5, texelFetch(voxelDataSampler, c, 0).z));
    bool even = ((uint(frameCounter) & 1u) == 0u);
    if (even) {
        if (level == 1) return texelFetch(voxelOccMip2BSampler, c, 0);
        else if (level == 2) return texelFetch(voxelOccMip4BSampler, c, 0);
        else return texelFetch(voxelOccMip8BSampler, c, 0);
    } else {
        if (level == 1) return texelFetch(voxelOccMip2ASampler, c, 0);
        else if (level == 2) return texelFetch(voxelOccMip4ASampler, c, 0);
        else return texelFetch(voxelOccMip8ASampler, c, 0);
    }
}

// 一条锥沿 dir 采样 4 档（近→远用越来越粗的 mip），透射率按占用衰减；出界按天空处理。
// 返回解码域（×0.01 后）的"辐照度近似"。
vec3 VoxelConeTrace(vec3 p0, vec3 dir, float skyGate) {
    const float s[4] = float[4](1.5, 3.0, 6.0, 12.0);
    const int   lv[4] = int[4](0, 1, 2, 3);
    float transm = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 4; ++i) {
        vec3 p = p0 + dir * s[i];
        int level = lv[i];
        bool oob = false;
        // 占用（本档网格）→ 透射率
        ivec3 cc = ivec3(p);
        if (level > 0) cc >>= level;
        vec4 occv = VoxelConeOccFetch(cc, level, oob);
        float occ = oob ? 0.0 : clamp(occv.r, 0.0, 1.0);
        // 辐照度（本档网格）
        vec4 radv = VoxelConeRadFetch(cc, level, oob);
        vec3 rad;
        if (oob) {
            // 出界 = 天光方向（compute 安全：只用 skyColor，不用大气 LUT）
            rad = skyColor * saturate(dir.y * 4.0 + 0.5) * skyGate;
        } else {
            rad = VoxelConeValid(radv) ? max(radv.rgb, vec3(0.0)) : vec3(0.0);
            rad *= 0.01;                                     // ×100 存储 → 解码
        }
        // 软遮挡：占用越高透射越低（每档近似指数衰减）
        if (!oob) transm *= exp2(-VOXEL_CONE_OCC_K * occ);
        acc += rad * transm;
        if (transm < 0.02) break;
    }
    return acc;
}

// 半球 5 条锥（正法线 1 条 + 45° 环 4 条，权重 2:1:1:1:1 / 6）的粗略余弦积分。
// origin = 体素空间连续坐标（已做表面偏移）；normal 需归一化；skyGate = 像素 lightmap.y。
vec3 VoxelConeIrradiance(vec3 origin, vec3 normal, float skyGate) {
    vec3 u = (abs(normal.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t1 = normalize(cross(normal, u));
    vec3 t2 = cross(normal, t1);
    vec3 d0 = normal;
    vec3 d1 = normalize(normal + t1);
    vec3 d2 = normalize(normal - t1);
    vec3 d3 = normalize(normal + t2);
    vec3 d4 = normalize(normal - t2);

    vec3 irr = vec3(0.0);
    irr += 2.0 * VoxelConeTrace(origin, d0, skyGate);
    irr +=        VoxelConeTrace(origin, d1, skyGate);
    irr +=        VoxelConeTrace(origin, d2, skyGate);
    irr +=        VoxelConeTrace(origin, d3, skyGate);
    irr +=        VoxelConeTrace(origin, d4, skyGate);
    return irr * (1.0 / 6.0) * VOXEL_CONE_STRENGTH;
}

#endif
