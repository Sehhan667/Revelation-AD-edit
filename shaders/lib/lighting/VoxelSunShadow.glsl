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
// Voxel Sun Shadow — 阳光 GI 阴影判定（2026-08-09）
//
// - VoxelSunShadowMap：实时阴影贴图判定——
//   命中点世界坐标 → 阴影贴图屏幕坐标（失真 + 体素平铺 Shift），沿命中面法线
//   做微小屏幕偏移避免体素表面自阴影（阴影边缘 0/1 跳变 → 块状闪烁/漏光），
//   shadowtex1 硬件深度比较；穿过半透明物体（玻璃）时按 shadowcolor0 颜色
//   和不透明度计算吸收色，反弹光线带上玻璃染色。
// - VoxelSunShadowTracing：体素 DDA 短程遮挡判定——
//   从命中体素向太阳方向步进 3 格，撞到固体/形状 → 0（阳光被挡）。
//   捕捉阴影贴图分辨率外的网格内小遮挡（屋檐/树冠缝隙/墙角）。
//
// 依赖：VoxelData.glsl + VoxelShape.glsl（VoxelMin3/VoxelRay/IsHitBlock）、
//       shadow/Common.glsl（DistortShadowSpace）、VoxelLighting.glsl（ShiftShadowScreenPos），
//       调用方须已声明 uniform sampler2DShadow shadowtex1（本文件补充 shadowtex0/shadowcolor0）。
//================================================================================================//

uniform sampler2D shadowtex0;
uniform sampler2D shadowcolor0;

// 实时阴影贴图判定：
// 返回彩色阴影 vec3——1=全亮直射；0=被实心挡；穿过半透明物体（玻璃）时
// = AlbedoToAbsorption(玻璃颜色, 不透明度)，反弹光线带上玻璃染色。
vec3 VoxelSunShadowMap(vec3 camRelPos, vec3 normal) {
    // [2026-09-23] 初值由 vec3(1.0) 改为 vec3(0.0)：所有"未能完成深度比较"的路径
    //（法线微偏移把采样点推出阴影图范围等）都应保守判为**无阳光**，而不是"全亮"。
    // 原初值 1.0 正是上面那个瓦片带误采样的帮凶——只要没走到计算分支就返回"直射"。
    vec3 result = vec3(0.0);
    // [FIX 2026-08-20] sunPosition 是 eye space（视图空间，见 Uniform.glsl），背对太阳时 .y
    // 会掉到 0 以下 → 此门控把 sunVis 全判 0 → 整个世界阳光反弹消失（亮面也黑）。
    // 改用世界空间太阳方向 worldSunDir.y（白天>0 / 夜晚<0，与月光弹射的平滑门控衔接）。
    if (worldSunDir.y < 0.0) return vec3(0.0);
    vec3 shadowClipPos = (shadowModelView * vec4(camRelPos, 1.0)).xyz;
    shadowClipPos = (shadowProjection * vec4(shadowClipPos, 1.0)).xyz;
    vec3 ssp = DistortShadowSpace(shadowClipPos) * 0.5 + 0.5;
    // [2026-09-23 修复：范围检查必须在 ShiftShadowScreenPos **之前**]
    // 原实现把 `all(equal(ssp, saturate(ssp)))` 放在 shift 之后。但 ShiftShadowScreenPos 是
    // `coord * VOXEL_SHADOW_RATIO + (1 - VOXEL_SHADOW_RATIO)` —— 它把阴影图有效区压缩到右侧
    // [1-R, 1]，左侧 [0, 1-R) 那条带（宽 VOXEL_TILE_WIDTH = 256px）是**体素化瓦片区**，
    // 里面存的是体素瓦片深度而非阴影深度。于是原始坐标落在 [-(1-R)/R, 0)（阴影视锥左外侧
    // 的一条带）时，shift 后恰好被压进体素瓦片带、却仍能通过 saturate 检查
    // ⇒ 深度比较读到体素化数据（多为"未被遮挡"）⇒ sunVis = 1
    // ⇒ 阳光反弹在阴影范围外误触发 ⇒ 被太阳直射的彩色方块反弹出亮度极高、颜色为反照率
    // 原色的溢出像素（实测纯红 187,0,0），且随相机移动扫过世界不同区域
    //（走开消失 / 精确回原位复现 / 重载后换位置）。
    // 注入端 VoxelGI.frag:300 与本函数共用 ⇒ DEBUG_VOXEL_GI 里缓存也呈该颜色。
    // 修法：范围外一律保守判 0（无阳光反弹）—— 阴影范围外本就拿不到遮挡数据，
    // 宁可少反弹，也不要用体素瓦片数据当成"直射"。
    if (!all(equal(ssp, saturate(ssp)))) return vec3(0.0);
    #ifdef ENABLE_VOXELIZATION
        ShiftShadowScreenPos(ssp.xy);
    #endif
    // 沿阴影空间命中法线做微小屏幕偏移（SimpleShadow NDC 0.00025 ≈ 屏幕 0.000125），
    // 避免体素命中面自阴影导致 sunVis 恒 0（阴影边缘块状闪烁/漏光）
    ssp.xy += (mat3(shadowModelView) * normal).xy * 0.000125;
    if (all(equal(ssp, saturate(ssp)))) {
        result = vec3(0.0);
        ssp.z -= 4e-5;

        // 实心深度（shadowtex1，sampler2DShadow 硬件深度比较）：vec3 = xy + 参考深度，
        // 返回值即可见性（1=未被实心挡，0=被挡），无需再 step
        float soildShadow = textureLod(shadowtex1, vec3(ssp.xy, ssp.z), 0.0);
        if (soildShadow > 0.5) {
            // 透明深度（shadowtex0）：没被透明物体挡 → 全亮
            float translucentShadow = step(ssp.z, textureLod(shadowtex0, ssp.xy, 0.0).x);
            result += vec3(translucentShadow);

            // 被透明物体（玻璃）挡住的部分 → 采样颜色，按不透明度算吸收色
            float coloredShadow = saturate(soildShadow - translucentShadow);
            if (coloredShadow > 1e-3) {
                vec4 shadowColorSample = textureLod(shadowcolor0, ssp.xy, 0.0);
                if (shadowColorSample.a > 0.003) {
                    shadowColorSample.rgb = VoxelAlbedoToAbsorption(sRGBToLinear(shadowColorSample.rgb), shadowColorSample.a);
                    result += shadowColorSample.rgb * coloredShadow;
                }
                // 水吸收分支省略：当前项目 shadowcolor0 不写水数据（水走 shadowcolor1）
            }
        }
    }
    return result;
}

// 体素 DDA 短程阳光遮挡判定（SimpleShadowTracing）：1=阳光可见，0=被网格内固体挡住
float VoxelSunShadowTracing(vec3 voxelPos, vec3 sunDir) {
    vec3 voxelCoord = floor(voxelPos);
    vec3 sdir = sign(sunDir);
    // [FIX 2026-08-19 rdir 符号根因] rdir 必须为有符号（1/sunDir），IsHitBox 的 slab
    // 算法用 ray.rdir * boxMin/boxMax 计算每轴进出时间——有符号才能对负方向轴得到
    // 正确符号的 t；无符号（1/|sunDir|）会把负方向射线的 t 整体取反 → 负方向轴
    // tExit<0 → 命中被误判为"未命中"→ 漏光（朝阳/背阴方向的阳光射线穿透形状块
    // 的子盒空隙，活板门/楼梯/栅栏等半块完全不挡阳光）。
    // DDA 步进用 abs(rdir) 保持正步距；零分量用 1e-30 替代避免 inf/NaN。
    // [FIX 2026-08-19 零分量值根因] 同 VoxelTracing.glsl：原 1e-8 → rdir=1e8 →
    // totalStep 零分量轴极小 → VoxelMin3 返回错误退出距离 → 轴向阳光射线（正上方
    // 太阳）子盒求交范围≈0 → 楼梯凹陷等形状块内遮挡漏判。改用 1e-30 修正。
    vec3 rdir = 1.0 / mix(sunDir, vec3(1e-30), lessThanEqual(abs(sunDir), vec3(1e-8)));
    vec3 totalStep = (sdir * (voxelCoord - voxelPos + 0.5) + 0.5) * abs(rdir);

    // [FIX 2026-08-19 楼梯凹陷发光] 起始体素内形状遮挡检查（check-then-step
    // 的起始格检查部分）。原实现 step-then-check 跳过起始格 →
    // 形状块（楼梯/活板门等）同体素内的实心部分不会遮挡阳光射线 → 楼梯凹陷处
    // （y∈[0.5,1.0] 空缺区）的阳光射线穿过同格上层台阶（实心部分）未被检测到 →
    // sunVis=1 → 凹陷处仍反弹阳光 → "楼梯中间凹陷部分发亮"。
    // 对形状块（voxelID>154）：沿阳光方向偏移起点（防自交：起点在命中面上，偏移
    // 使其离开命中子盒表面），检查阳光射线是否在本格内命中其他子盒 → 遮挡。
    // 全块（<=154）跳过：起点在命中固体本身表面，全格自交无意义（用
    // rayLength>0.0 门控起始格全块跳过）。
    {
        vec4 startHvd = texelFetch(voxelDataSampler, ivec3(voxelCoord), 0);
        if (startHvd.z > 154.5) {
            // 沿阳光方向偏移 1e-3：命中面朝向太阳时偏移离开表面（防自交）；
            // 命中面背向太阳时偏移进入固体（自交命中），但 dot(sunDir,hitNormal)
            // ≤0 → sunLighting=0 → 不影响最终阳光贡献（调用方已门控）。
            vec3 offsetOri = voxelPos + sunDir * 1e-3;
            vec3 offsetVC = floor(offsetOri);
            // 偏移后仍在同格内才检查（偏移跳格 = 起点在格边界，罕见，跳过）
            if (all(equal(offsetVC, voxelCoord))) {
                VoxelRay vray;
                vray.ori = offsetOri;
                vray.dir = sunDir;
                vray.rdir = rdir;
                vray.sdir = sdir;
                vec3 offsetTS = (sdir * (offsetVC - offsetOri + 0.5) + 0.5) * abs(rdir);
                float exitDist = VoxelMin3(offsetTS);
                vec3 offsetNext = step(offsetTS, vec3(exitDist));
                vec3 hitNormal;
                if (IsHitBlock(vray, offsetTS, offsetNext, offsetVC, abs(startHvd.z), exitDist, hitNormal)) {
                    return 0.0;
                }
            }
        }
    }

    for (int i = 0; i < 3; ++i) {
        // 先步进到下一格（起点格已在上方形状检查中处理，不算遮挡）
        float rayLength = VoxelMin3(totalStep);
        vec3 tracingNext = step(totalStep, vec3(rayLength));
        vec3 prevVC = voxelCoord;                       // [2026-10-02] 记下步进前的格（供接触格补测）
        voxelCoord += tracingNext * sdir;
        totalStep += tracingNext * abs(rdir);
        if (any(lessThan(voxelCoord, vec3(0.0))) || any(greaterThanEqual(voxelCoord, vec3(float(VOXEL_AREA))))) break;

        vec4 hvd = texelFetch(voxelDataSampler, ivec3(voxelCoord), 0);
        if (hvd.z > 0.5) {
            VoxelRay vray;
            vray.ori = voxelPos;
            vray.dir = sunDir;
            vray.rdir = rdir;
            vray.sdir = sdir;
            vec3 hitNormal;
            float hitLength = rayLength;
            if (IsHitBlock(vray, totalStep, tracingNext, voxelCoord, abs(hvd.z), hitLength, hitNormal)) {
                return 0.0;
            }
        }

        // [2026-10-02 根治"零厚度接触线漏光"] 本步若多轴同时推进（tie），说明光线恰好穿过
        // 格与格共用的**棱或角**：此时 DDA 只跳到了对角格，中间那几格**从不被采样**。
        // 若两个方块是斜向贴着的（接触面积 = 0，只剩一条零宽度的棱/一个点），这块"接触处"
        // 就永远测不到 ⇒ 阳光顺着这条缝漏进室内（用户实测）。
        // 补测：把本步发生 tie 的每个轴各自回退一格，得到光线真正擦过的那些"侧格"
        //（2 轴 tie → 2 个侧格；3 轴 tie → 3 个棱格，恰好构成角点周围除对角格以外的全部格），
        // 其中任一格是**整块固体**即判遮挡 —— 物理上两格在棱/点上确实相接，光不该穿过。
        // 只测整块（abs(z)<=154）：它们没有子盒，命中语义无歧义；形状块（楼梯/半砖等）
        // 的子盒在棱接触时不构成封闭，交给 IsHitBlock 主路径，不在此重复判定。
        if (dot(tracingNext, tracingNext) > 1.0) {
            for (int a = 0; a < 3; ++a) {
                if (tracingNext[a] > 0.5) {
                    vec3 cand = voxelCoord;
                    cand[a] = prevVC[a];                // 仅回退 a 轴 → 侧格
                    if (any(lessThan(cand, vec3(0.0))) || any(greaterThanEqual(cand, vec3(float(VOXEL_AREA)))))
                        continue;
                    vec4 chvd = texelFetch(voxelDataSampler, ivec3(cand), 0);
                    if (chvd.z > 0.5 && abs(chvd.z) <= 154.0) return 0.0;
                }
            }
        }
    }
    return 1.0;
}
