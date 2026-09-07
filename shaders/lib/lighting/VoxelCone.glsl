//================================================================================================//
// VoxelCone — 锥追踪加速实验档（低质量 VXGI，2026-09-06）
//
// 思路出处：Voxel Cone Tracing（Crassin et al., I3D 2011）+ NVIDIA VXGI 的"分层体素 + mip 滤波"。
// 在**规则网格**上落地：把 IRC 辐照度场（64³×1m，×100 存储）做成 mip 金字塔并**与占用合并为一张
// 图集**（Iris 全包 image 单元池上限 16，基线已 15 → 锥档只允许 1 张新图）。
//
// 图集布局（image.voxelConeMip，64×64×32 rgba16f，rgb=平均辐照度×100，a=平均固体占用）：
//   每层 4096 texel 一片（64×64）：层索引线性摊进片内（local = lin & 4095 → x=local%64, y=local/64）
//   奇偶组：parity0（偶数帧写）z 0..7 = 2m 层（32³ 的 8 片），z 8 = 4m 层（16³ 1 片），z 9 = 8m 层；
//           parity1（上一帧构建，读端用）镜像到 z 10..19。
// 竞争分析：
//   - 构建端只读"上一帧已写 IRC 块"（FetchVoxelRadiance 帧奇偶），写当前 parity 的切片；
//   - 采样端读另一 parity 切片 → 与 IRC 自反弹同级的 1 帧滞后，同 dispatch 读写不同纹理区域；
//   - 占用源 = voxelData（shadow pass 已写、deferred 阶段只读）。
//
// 开关：VOXEL_CONE_GI（GUI：Debug→Voxel）；校准：VOXEL_CONE_STRENGTH / VOXEL_CONE_OCC_K。
//================================================================================================//
#ifdef VOXEL_CONE_GI

// 构建任务数 = mip 格数 32³+16³+8³ = 37376（每帧由 deferred1_a 各线程分摊）
#define VOXEL_CONEMIP_L1TASKS 32768u
#define VOXEL_CONEMIP_L2TASKS 4096u
#define VOXEL_CONEMIP_L3TASKS 512u
#define VOXEL_CONEMIP_TASKS (VOXEL_CONEMIP_L1TASKS + VOXEL_CONEMIP_L2TASKS + VOXEL_CONEMIP_L3TASKS)
#define VOXEL_CONEMIP_SLICE_PX 4096u

layout (rgba16f) uniform writeonly image3D voxelConeMip;
uniform sampler3D voxelConeMipSampler;

//================================================================================================//
// 构建端
//================================================================================================//

bool VoxelConeValid(vec4 v) {
    return all(equal(v, v)) && !any(isinf(v));
}

// 任务线性号 → (level, level 内格坐标)
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

// level 格坐标 → 图集 texel（parity 0/1；level 1/2/3 = 32/16/8³）
ivec3 VoxelConeMipCoord(ivec3 cell, int level, uint parity) {
    uint n = (level == 1) ? 32u : ((level == 2) ? 16u : 8u);
    uint lin = (uint(cell.z) * n + uint(cell.y)) * n + uint(cell.x);
    uint group = lin / VOXEL_CONEMIP_SLICE_PX;      // L1: 0..7；L2/L3: 0
    uint local = lin % VOXEL_CONEMIP_SLICE_PX;
    int slice = int(parity * 10u) + ((level == 1) ? int(group) : ((level == 2) ? 8 : 9));
    return ivec3(int(local & 63u), int(local >> 6u), slice);
}

// 任务：一个 mip 格 = k³(k=2^level) 子体素的辐照度平均（rgb）+ 固体占用平均（a）
void VoxelMipBuildTask(uint task) {
    int  level = VoxelConeLevelOf(task);
    uint loc   = VoxelConeLinInLevel(task);
    uint n     = (level == 1) ? 32u : ((level == 2) ? 16u : 8u);
    ivec3 cell = ivec3(int(loc % n), int((loc / n) % n), int(loc / (n * n)));
    int  k     = 1 << level;

    vec3 accRad = vec3(0.0);
    float accOcc = 0.0;
    float cnt = 0.0;
    for (int zz = 0; zz < k; ++zz)
    for (int yy = 0; yy < k; ++yy)
    for (int xx = 0; xx < k; ++xx) {
        ivec3 g = cell * k + ivec3(xx, yy, zz);
        vec4 rv = FetchVoxelRadiance(g);             // 上一帧已写块（帧奇偶选择）
        if (!VoxelConeValid(rv)) { rv = vec4(0.0); }
        accRad += max(rv.rgb, vec3(0.0));
        accOcc += step(0.5, texelFetch(voxelDataSampler, g, 0).z);
        cnt += 1.0;
    }
    vec4 res;
    if (cnt < 1e-4) res = vec4(0.0);
    else            res = vec4(accRad * rcp(cnt), accOcc * rcp(cnt));

    uint parity = uint(frameCounter & 1);            // 偶数帧写 parity0
    imageStore(voxelConeMip, VoxelConeMipCoord(cell, level, parity), res);
}

//================================================================================================//
// 采样端（读另一 parity = 上一帧构建结果）
//================================================================================================//

// 采样一个 tap：level 0 = 基体素（64³ 上一帧块，返回 vec4(rgb×100, exposure)）；
// level 1/2/3 = 图集 2/4/8m 层（rgb×100, a=占用）。
vec4 VoxelConeTapFetch(ivec3 cell, int level, out bool oob) {
    if (level == 0) {
        oob = any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, ivec3(VOXEL_AREA)));
        if (oob) return vec4(0.0);
        return FetchVoxelRadiance(cell);
    }
    uint n = (level == 1) ? 32u : ((level == 2) ? 16u : 8u);
    oob = any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, ivec3(n)));
    if (oob) return vec4(0.0);
    uint readParity = 1u - uint(frameCounter & 1);   // 上一帧构建组
    return texelFetch(voxelConeMipSampler, VoxelConeMipCoord(cell, level, readParity), 0);
}

// 一条锥沿 dir 采样 4 档（近→远用越来越粗的层），占用 a 做软遮挡；出界按方向天空近似。
// 返回解码域（×0.01 后）的辐照度近似。
vec3 VoxelConeTrace(vec3 p0, vec3 dir, float skyGate) {
    const float s[4]  = float[4](1.5, 3.0, 6.0, 12.0);
    const int   lv[4] = int[4](0, 1, 2, 3);
    float transm = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 4; ++i) {
        vec3 p = p0 + dir * s[i];
        int level = lv[i];
        ivec3 cell = ivec3(p);
        if (level > 0) cell >>= level;               // level 格坐标（2m/4m/8m 格）
        bool oob = false;
        vec4 v = VoxelConeTapFetch(cell, level, oob);
        vec3 rad;
        float occ;
        if (level == 0) {
            // 基体素（64³）的 .a = 天空曝光度，占用须另查 voxelData（固体）
            occ = oob ? 0.0 : step(0.5, texelFetch(voxelDataSampler, cell, 0).z);
        } else {
            occ = oob ? 0.0 : clamp(v.a, 0.0, 1.0);  // 图集层 .a = 平均固体占用
        }
        if (oob) {
            rad = skyColor * saturate(dir.y * 4.0 + 0.5) * skyGate;
        } else {
            rad = VoxelConeValid(v) ? max(v.rgb, vec3(0.0)) : vec3(0.0);
            rad *= 0.01;                              // ×100 存储 → 解码
        }
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

    vec3 irr = vec3(0.0);
    irr += 2.0 * VoxelConeTrace(origin, normal,         skyGate);
    irr +=        VoxelConeTrace(origin, normalize(normal + t1), skyGate);
    irr +=        VoxelConeTrace(origin, normalize(normal - t1), skyGate);
    irr +=        VoxelConeTrace(origin, normalize(normal + t2), skyGate);
    irr +=        VoxelConeTrace(origin, normalize(normal - t2), skyGate);
    return irr * (1.0 / 6.0) * VOXEL_CONE_STRENGTH;
}

#endif
