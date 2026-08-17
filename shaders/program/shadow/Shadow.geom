/*
--------------------------------------------------------------------------------
    Revelation Shaders
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Geometry Shader（GSH 实现，低配简化）：
    - 真阴影三角形：加 bias 防漏光 → ShiftShadowNdcPos 挤到右上区（仅 ENABLE_VOXELIZATION）
    - 体素三角形：三角形质心 → 世界对齐网格坐标 → VoxelTexel_From_VoxelCoord
      Y 型平铺到阴影贴图左条带。太阳方向固定 → 体素化内容不随相机转动，
      根治 gbuffers 时代"转头/移动重播种 → 方格闪烁"。
    ENABLE_VOXELIZATION 关闭时保持原样（全幅真阴影，不 Shift）。
--------------------------------------------------------------------------------
*/

//======// Utility //================================================================================//
// 必须先 include（settings.glsl 里定义 ENABLE_VOXELIZATION），
// 否则下方 #ifdef 声明块在预处理时被剥离 → C1503 undefined variable（与 Shadow.vert/frag 一致）

#include "/lib/Utility.glsl"

//======// Layout //================================================================================//

layout(triangles) in;
layout(triangle_strip, max_vertices = 45) out;

//======// Input //================================================================================//

in vec2 texCoord[];
in vec3 vectorData[];
flat in uint isWater[];

#ifdef ENABLE_VOXELIZATION
in vec3 g_voxelCoord[];      // 含 toCenter*0.001 偏移（供 GS 质心平均 → voxelCoord）
in vec3 g_voxelCoordBase[];  // 无偏移（供 posDiff 完整方块检测——不能有偏移，会腐蚀边长）
flat in float g_voxelID[];
flat in float g_notInVoxel[];
flat in vec2 g_mcLightLevel[];
in float g_posInvalid[]; // 每顶点（非 flat）：1=顶点偏离整数网格

uniform mat4 shadowProjection;
uniform int renderStage;
#endif

// 2D 点在三角形内（重心坐标；用于 near 级联格覆盖判定）
bool PointInTri2D(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 v0 = b - a, v1 = c - a, v2 = p - a;
    float d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1);
    float d20 = dot(v2, v0), d21 = dot(v2, v1);
    float inv = 1.0 / (d00 * d11 - d01 * d01);
    float v = (d11 * d20 - d01 * d21) * inv;
    float w = (d00 * d21 - d01 * d20) * inv;
    return v >= -1e-4 && w >= -1e-4 && (v + w) <= 1.0 + 1e-4;
}

//======// Output //================================================================================//

out vec2 texCoordOut;
out vec3 vectorDataOut;
flat out uint isWaterOut;

#ifdef ENABLE_VOXELIZATION
flat out vec3 v_voxelCoord;   // 体素格坐标（FSH 直接 imageStore 到 3D image）
flat out float v_cascade;     // 级联索引：0=near 1=mid 2=far（FSH 选 image 目标）
flat out float v_voxelID;     // 正=固体 / 负=透明（与 gbuffers 时代一致的编码）
flat out float v_emissive;    // 发光量（材料 ID 硬编码 [20,31]）
flat out float v_skylight;    // 天空光 lightmap（0-1）
flat out float v_blocklight;  // 方块光 lightmap（0-1）
flat out vec2 v_midCoord;     // 方块图集 UV 中心（xy=voxelData 通道）
flat out float v_isVoxel;     // 1=体素 tile 像素（FSH 走 image 路径）0=真阴影像素
#endif

//======// Main //==================================================================================//

void main() {
    #ifdef ENABLE_VOXELIZATION

        // ---- 真阴影分支：bias + Shift ----
        // 用无偏移 g_voxelCoordBase 计算边长（偏移版 g_voxelCoord 的 toCenter*0.001
        // 会让面三角每条边缩短 ~0.001 → 总和偏离 3.4142 达 0.003+
        // → 完整方块检测全失败 → 所有默认方块被丢弃 → 体素网格只剩光源没有墙）
        vec3 posDiff = vec3(
            distance(g_voxelCoordBase[0], g_voxelCoordBase[1]),
            distance(g_voxelCoordBase[1], g_voxelCoordBase[2]),
            distance(g_voxelCoordBase[2], g_voxelCoordBase[0])
        );

        bool shadowVaild = all(lessThan(abs(gl_in[0].gl_Position.xy), vec2(1.0)));
        shadowVaild = shadowVaild || all(lessThan(abs(gl_in[1].gl_Position.xy), vec2(1.0)));
        shadowVaild = shadowVaild || all(lessThan(abs(gl_in[2].gl_Position.xy), vec2(1.0)));

        if (shadowVaild) {
            float bias = saturate(max(posDiff.x, max(posDiff.y, posDiff.z)) * 0.5 - 1.0) * shadowProjection[0][0] * 0.3;

            for (int i = 0; i < 3; i++) {
                gl_Position = gl_in[i].gl_Position;
                gl_Position.z += bias;
                ShiftShadowNdcPos(gl_Position.xy);

                texCoordOut = texCoord[i];
                vectorDataOut = vectorData[i];
                isWaterOut = isWater[i];
                v_isVoxel = 0.0;
                EmitVertex();
            }
            EndPrimitive();
        }

        // ---- 体素分支：质心网格坐标 → 三级联 Y 型平铺左条带（ADR-0001）----
        // 各级联 cell 尺寸不同（near 0.5m / mid 1.0m / far 2.0m），
        // 由同一世界相对坐标 baseRel 换算：coord = baseRel / cell + VOXEL_RADIUS。
        vec3 baseCentroid = g_voxelCoord[0] * 0.33333333 + g_voxelCoord[1] * 0.33333333 + g_voxelCoord[2] * 0.33333333;
        vec3 baseRel = baseCentroid - vec3(float(VOXEL_RADIUS));
        vec3 voxelCoordNear = floor(baseRel * (1.0 / VOXEL_CASCADE_CELL_0) + vec3(float(VOXEL_RADIUS)));
        // [FIX 2026-08-17] mid 级联必须与查询/注入端一致地用 CELL_1 换算。
        // 旧代码 floor(baseCentroid) 硬编码 1.0m cell：VOXEL_DISTANCE=64 时 CELL_1 恰为 1.0 无事，
        // 调小距离后 CELL_1<1.0 → 写入端 1m 网格 vs 读取端 0.5m 网格 → 光与光源错位（用户实测）。
        vec3 voxelCoord     = floor(baseRel * (1.0 / VOXEL_CASCADE_CELL_1) + vec3(float(VOXEL_RADIUS)));
        vec3 voxelCoordFar  = floor(baseRel * (1.0 / VOXEL_CASCADE_CELL_2) + vec3(float(VOXEL_RADIUS)));

        if (all(bvec2(
            g_notInVoxel[0] + g_notInVoxel[1] + g_notInVoxel[2] < 0.5,
            // [FIX 2026-08-06] 发光地衣（materialID=32）是 CUTOUT 渲染阶段，原分支
            // （SOLID/TRANSLUCENT）会把它排除在体素外 → 地衣没有体素数据 → 不照亮周围。
            // 只对 CUTOUT 阶段的光源块（voxelID==32）放行；草/花/门等普通 CUTOUT 方块
            // 仍不进体素（避免幻影块，同语义）。
            renderStage == MC_RENDER_STAGE_TERRAIN_SOLID || renderStage == MC_RENDER_STAGE_TERRAIN_TRANSLUCENT
            || (renderStage == MC_RENDER_STAGE_TERRAIN_CUTOUT && g_voxelID[0] == 32.0)
        ))) {
            // midCoord = 三角形纹理包围盒中心（语义；消费端 GetAtlasCoord 做精确纹素定位）
            vec2 maxTexCoord = max(texCoord[0], max(texCoord[1], texCoord[2]));
            vec2 minTexCoord = min(texCoord[0], min(texCoord[1], texCoord[2]));
            vec2 midCoord = (maxTexCoord + minTexCoord) * 0.5;

            float voxelID = g_voxelID[0];
            // PT_FULLBLOCK_DETECTION：普通方块（voxelID==1，未列入
            // block.properties）的三角形须覆盖整格面（边长和 ≈ 3.41421356 = 2+√2，整块面
            // 三角 = 两单位边 + 面对角线）且三顶点全在整数网格（g_posInvalid 和=0）且非透明
            // 渲染阶段 → 才写入体素；半砖/楼梯/按钮等非整格面 → 跳过（"隐形幻影整块"根因）。
            // 发光(20-31)/形状(155-294)/透明负 ID 不受影响（各自独立路径）。
            if (voxelID == 1.0) {
                bool isFullBlock = abs(posDiff.x + posDiff.y + posDiff.z - 3.41421356)
                                   + g_posInvalid[0] + g_posInvalid[1] + g_posInvalid[2] < 0.001
                                   && renderStage != MC_RENDER_STAGE_TERRAIN_TRANSLUCENT;
                if (!isFullBlock) return;
            }
            // 发光检测：材料 ID 硬编码 [20,31]（block.properties block.10020-10031，不经 LabPBR 发射贴图）
            // [FIX 2026-08-06] 补充岩浆（7，TRANSLUCENT）与发光地衣（32，CUTOUT）为发射体素：
            // 原版方块光 lightmap 关闭时，岩浆/地衣不再靠 blocklight 反弹（依赖 albedo 中心色）发光，
            // 而是作为发射源像火把一样照亮周围。消费端 VoxelLightColor 已扩展对应颜色。
            float emissive = ((voxelID >= 20.0 && voxelID <= 31.0) || voxelID == 7.0 || voxelID == 32.0) ? 0.995 : 0.0;
            float skylight = g_mcLightLevel[0].y * 0.33333333 + g_mcLightLevel[1].y * 0.33333333 + g_mcLightLevel[2].y * 0.33333333;
            float blocklight = g_mcLightLevel[0].x * 0.33333333 + g_mcLightLevel[1].x * 0.33333333 + g_mcLightLevel[2].x * 0.33333333;

            const vec2[3] vertexOffset = vec2[3](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.5, 1.0));

            // 三级联各自 bounds check 后发射（公共数据 midCoord/voxelID/emissive 等只算一次）
            #define EMIT_VOXEL_CASCADE(CC, TY, CIDX) \
                { \
                    vec2 voxelTexel = VoxelTexel_From_VoxelCoord(CC); \
                    voxelTexel.y += TY; \
                    for (int i = 0; i < 3; i++) { \
                        gl_Position = vec4((voxelTexel + vertexOffset[i]) * (2.0 / VOXEL_SHADOW_RES) - 1.0, -0.75, 1.0); \
                        texCoordOut = texCoord[i]; \
                        vectorDataOut = vectorData[i]; \
                        isWaterOut = isWater[i]; \
                        v_voxelCoord = CC; \
                        v_cascade = CIDX; \
                        v_voxelID = voxelID; \
                        v_emissive = emissive; \
                        v_skylight = skylight; \
                        v_blocklight = blocklight; \
                        v_midCoord = midCoord; \
                        v_isVoxel = 1.0; \
                        EmitVertex(); \
                    } \
                    EndPrimitive(); \
                }

            // [2026-08-17] 全块逐格填充宏：三角形覆盖多个格时按 AABB + 法线主轴投影
            // 点内测试填满覆盖格（只写质心格会留下稀疏棋盘 → 光线穿墙 → 黑方格）。
            // near/mid/far 共用；AABB 覆盖格数超 24（约 45 顶点预算的保守一半，覆盖
            // D≥16 的 mid 面 AABB=16）时退化为质心单格。
            #define EMIT_FULLBLOCK_FILL(CELLC, TY, CIDX, CENT) \
                { \
                    vec3 n0 = (g_voxelCoordBase[0] - float(VOXEL_RADIUS)) / CELLC + float(VOXEL_RADIUS); \
                    vec3 n1 = (g_voxelCoordBase[1] - float(VOXEL_RADIUS)) / CELLC + float(VOXEL_RADIUS); \
                    vec3 n2 = (g_voxelCoordBase[2] - float(VOXEL_RADIUS)) / CELLC + float(VOXEL_RADIUS); \
                    vec3 nrm = cross(n1 - n0, n2 - n0); \
                    vec3 an = abs(nrm); \
                    bool projX = an.x >= an.y && an.x >= an.z; \
                    bool projY = an.y >= an.z; \
                    vec3 lo = min(min(n0, n1), n2); \
                    vec3 hi = max(max(n0, n1), n2); \
                    ivec3 iLo = ivec3(clamp(floor(lo), vec3(0.0), vec3(float(VOXEL_AREA) - 1.0))); \
                    ivec3 iHi = ivec3(clamp(ceil(hi), vec3(0.0), vec3(float(VOXEL_AREA) - 1.0))); \
                    if (projX) { if (nrm.x > 0.0) --iLo.x; else ++iHi.x; } \
                    else if (projY) { if (nrm.y > 0.0) --iLo.y; else ++iHi.y; } \
                    else { if (nrm.z > 0.0) --iLo.z; else ++iHi.z; } \
                    iLo = max(iLo, ivec3(0)); \
                    iHi = min(iHi, ivec3(int(VOXEL_AREA) - 1)); \
                    int cellCount = (iHi.x - iLo.x + 1) * (iHi.y - iLo.y + 1) * (iHi.z - iLo.z + 1); \
                    if (cellCount <= 24) { \
                        for (int ix = iLo.x; ix <= iHi.x; ++ix) \
                        for (int iy = iLo.y; iy <= iHi.y; ++iy) \
                        for (int iz = iLo.z; iz <= iHi.z; ++iz) { \
                            vec3 cc = vec3(ix, iy, iz) + 0.5; \
                            vec2 p  = projX ? cc.zy : projY ? cc.xz : cc.xy; \
                            vec2 a2 = projX ? n0.zy : projY ? n0.xz : n0.xy; \
                            vec2 b2 = projX ? n1.zy : projY ? n1.xz : n1.xy; \
                            vec2 c2 = projX ? n2.zy : projY ? n2.xz : n2.xy; \
                            if (PointInTri2D(p, a2, b2, c2) && dot(cc - n0, nrm) < 0.0) \
                                EMIT_VOXEL_CASCADE(vec3(ix, iy, iz), TY, CIDX); \
                        } \
                    } else { \
                        EMIT_VOXEL_CASCADE(CENT, TY, CIDX); \
                    } \
                }

            // near 级联（0.5m @D64）：只处理完整方块（ID==1）——逐格填充（宏）。
            // 形状/透明块不进 near（IsHitBlock 世界锚定后任意格尺寸均可，但 near 保持
            // 只收全块的原有语义，形状由 mid/far 按原语义处理）。
            if (all(bvec3(clamp(voxelCoordNear, vec3(0.0), vec3(float(VOXEL_AREA) - 1.0)) == voxelCoordNear))) {
                if (voxelID == 1.0) {
                    EMIT_FULLBLOCK_FILL(VOXEL_CASCADE_CELL_0, VOXEL_TILE_Y_0, 0.0, voxelCoordNear);
                }
            }
            // [2026-08-17] 形状块(155-294)只写 cell≤1.0m 的级联（>1m 质心锚定偏移）：
            // D=64: 只 mid(1m)；D=32: mid(0.5m)+far(1m) 全覆盖。
            // [2026-08-17] 全块(ID==1)在 mid/far 同样逐格填充：D<64 时格<1m，全块跨多格，
            // 只写质心格 → 网格稀疏 → 光线穿墙 → 不完整方块垂直表面黑方格（用户实测）。
            bool shapeBlock = voxelID > 154.0;
            if (all(bvec3(clamp(voxelCoord, vec3(0.0), vec3(float(VOXEL_AREA) - 1.0)) == voxelCoord))) {
                if (voxelID == 1.0)
                    EMIT_FULLBLOCK_FILL(VOXEL_CASCADE_CELL_1, VOXEL_TILE_Y_1, 1.0, voxelCoord)
                else if (!shapeBlock || VOXEL_CASCADE_CELL_1 <= 1.0)
                    EMIT_VOXEL_CASCADE(voxelCoord, VOXEL_TILE_Y_1, 1.0);
            }
            if (all(bvec3(clamp(voxelCoordFar, vec3(0.0), vec3(float(VOXEL_AREA) - 1.0)) == voxelCoordFar))) {
                if (voxelID == 1.0)
                    EMIT_FULLBLOCK_FILL(VOXEL_CASCADE_CELL_2, VOXEL_TILE_Y_2, 2.0, voxelCoordFar)
                else if (!shapeBlock || VOXEL_CASCADE_CELL_2 <= 1.0)
                    EMIT_VOXEL_CASCADE(voxelCoordFar, VOXEL_TILE_Y_2, 2.0);
            }

            #undef EMIT_VOXEL_CASCADE
        }

    #else

        // 体素化关闭：原样转发（全幅真阴影，无 Shift）
        for (int i = 0; i < 3; i++) {
            gl_Position = gl_in[i].gl_Position;
            texCoordOut = texCoord[i];
            vectorDataOut = vectorData[i];
            isWaterOut = isWater[i];
            EmitVertex();
        }
        EndPrimitive();

    #endif
}
