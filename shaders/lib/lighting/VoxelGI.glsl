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
// Voxel GI — IRC 缓存内部数据访问
//
// 架构：IRC（辐照度缓存）是**内部数据**，不直接渲染上屏。
// - 注入循环（VoxelGI.frag）每帧维护缓存
// - 每像素漫反射追踪（VoxelTracing.glsl）命中体素时，用本文件的 FetchVoxelRadiance
//   取命中点的前帧辐照度作为"自反弹种子"（对应漫反射追踪的 SampleIrradianceCache）
// - DEBUG_VOXEL_RADIANCE 单点诊断（玩家相机格）
// 主 GI 由每像素追踪提供（高分辨率、无 64³ 方格），IRC 不再直接上屏。
// 坐标系与 Terrain 体素化一致：worldPos(相机相对) + cameraPositionFract + VOXEL_RADIUS
// 注意：DeferredLight.frag 在 L224 会把 worldPos 改成"伪绝对坐标"，追踪/调试在 L182 后
// 备份了确定的相机相对坐标 camRelPos。
//================================================================================================//

// 无显式 binding：与传播端一致，交由 Iris 按名字自动绑定（显式 binding 会与
// Iris 分配的普通贴图纹理单元冲突，导致采样读不到数据——"全黑"根因之一）
uniform sampler3D voxelRadianceSampler;
uniform sampler3D voxelRadiance2Sampler;
// 体素化光数据（r32ui 打包：x=emissive y=sky z=block），DEBUG_VOXEL_GI 判断光源体素用
uniform usampler3D voxelLightSampler;
// 体素数据（rgba16f：z=voxelID 原值），仅 DEBUG_VOXEL_RADIANCE 诊断用
uniform sampler3D voxelDataSampler;

// 帧奇偶采样（与注入端写入一致：偶数帧写 voxelRadiance、读 voxelRadiance2）
vec4 FetchVoxelRadiance(ivec3 c) {
    return ((frameCounter & 1) == 0)
        ? texelFetch(voxelRadiance2Sampler, c, 0)
        : texelFetch(voxelRadianceSampler, c, 0);
}


// 真·三线性读取：入参是**连续**的体素空间位置（整数 = 格边界、+0.5 = 格心）。
// [2026-10-02 修 bug] 旧签名收 ivec3 整数格坐标：f = c + 0.5 → i = c → t 恒为 0.5，
// 插值根本插不起来 —— 实际是「命中格 + 其 +X/+Y/+Z 八分体」共 8 格等权平均：
//   等效半格偏移（方向还不对称）+ 2 格模糊，命中格自己的辐射被稀释成 1/8。
// 后果：方块光沿格边界/一格薄墙渗出来（自反弹是它唯一调用点，无光源场景里这条就是
// 唯一的方块光链路），光照中心整体偏向 +XYZ。改法：先减 0.5 对齐纹素中心再插值，
// t 随位置连续变化；格心处 t = 0 → 命中格权重 1（不再稀释），平滑只发生在 ±半格内。
vec3 FetchVoxelRadianceTrilinear(vec3 pos) {
    vec3 q = pos - 0.5;                 // texel c 的中心在纹理坐标 c + 0.5，减 0.5 后整数即纹素中心
    ivec3 i = ivec3(floor(q));
    vec3 t = q - vec3(i);
    vec3 acc = vec3(0.0);
    for (int k = 0; k < 8; ++k) {
        ivec3 off = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        ivec3 p = clamp(i + off, ivec3(0), ivec3(VOXEL_AREA - 1));
        float w = (off.x == 0 ? 1.0 - t.x : t.x)
                * (off.y == 0 ? 1.0 - t.y : t.y)
                * (off.z == 0 ? 1.0 - t.z : t.z);
        acc += FetchVoxelRadiance(p).rgb * w;
    }
    return acc * 0.01;
}
