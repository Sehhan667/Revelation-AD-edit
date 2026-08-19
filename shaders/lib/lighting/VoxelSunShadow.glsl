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
    vec3 result = vec3(1.0);
    if (sunPosition.y < 0.01) return vec3(0.0);
    vec3 shadowClipPos = (shadowModelView * vec4(camRelPos, 1.0)).xyz;
    shadowClipPos = (shadowProjection * vec4(shadowClipPos, 1.0)).xyz;
    vec3 ssp = DistortShadowSpace(shadowClipPos) * 0.5 + 0.5;
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

    // [FIX 2026-08-19 楼梯凹陷发光] 起始体素内形状遮挡检查（itrp SimpleShadowTracing
    // 同款 check-then-step 的起始格检查部分）。原实现 step-then-check 跳过起始格 →
    // 形状块（楼梯/活板门等）同体素内的实心部分不会遮挡阳光射线 → 楼梯凹陷处
    // （y∈[0.5,1.0] 空缺区）的阳光射线穿过同格上层台阶（实心部分）未被检测到 →
    // sunVis=1 → 凹陷处仍反弹阳光 → "楼梯中间凹陷部分发亮"。
    // 对形状块（voxelID>154）：沿阳光方向偏移起点（防自交：起点在命中面上，偏移
    // 使其离开命中子盒表面），检查阳光射线是否在本格内命中其他子盒 → 遮挡。
    // 全块（<=154）跳过：起点在命中固体本身表面，全格自交无意义（itrp 用
    // rayLength>0.0 门控起始格全块跳过同款）。
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
    }
    return 1.0;
}
