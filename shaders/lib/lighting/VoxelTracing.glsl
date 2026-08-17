//================================================================================================//
// Voxel GI — 每像素漫反射追踪（阶段④）
//
// 与 IRC（辐照度缓存）互补：
// - IRC = 低频平滑间接光（时域累积，无方向性）
// - 本文件 = 每像素每帧投 1 条随机光线，DDA 穿过 64³ 网格，
//   命中体素后取"发射光 / 方块光 / 真阳光直射 / IRC 前帧值"，出界取天空，
//   提供锐利的一次弹射 GI（阳光的方向性反弹、近距离遮挡、彩色反弹）。
// 噪声靠 TAA 时域收敛（settings.glsl TAA_ENABLED 默认开）。
//
// 阶段④ 化（漫反射追踪实现）：
// - 共享 VoxelData.glsl：穿透式 DDA（发射光体素不挡光，球形光源平滑贡献后继续；
//   普通固体命中停止）+ 命中 albedo 用整块图集中心色（体素数据 xy=midCoord）
//   ——注意：不用 GetAtlasCoord 精确纹素（64³ 网格会把高对比纹理图案反弹到
//   相邻面 → "光源印子"，2026-08-04 实测；函数保留待形状求交阶段）
// - HemisphereUnitVector 均匀半球采样 + vertexNormal 回落：
//   采样方向若落到几何法线背面（法线贴图朝向过陡）→ 沿几何法线重采样
// - 起点沿几何法线偏移防自交（voxelPos += vertexNormal * (-viewPos.z * 0.0003)）
// - ×pdf 加权（hitSurface=pdf 约定：均匀采样 × 2cosθ = 漫反射辐照度核，
//   无 1/cos 发散、无 firefly；与 IRC 的 rcpPdf 教科书估计器不同——这是原始约定）
// - 出界天空 = skyMapTex 方向辐射 × 上半球权重 × 天空光泄漏衰减（SUNLIGHT_LEAK_FIX）
// - 发射光走 HitLightShpere 球形光源（平滑距离衰减 + 穿透）→ 修"贴光源表面
//   移动闪烁"（旧：DDA 命中发射体素 = 0/1 全强度开关）
//
// 坐标系约定（与体素化/IRC 一致）：
// - origin = 相机相对世界坐标（= DeferredLight 的 worldPos - cameraPosition）
// - 命中体素 → IRC 读取用 vc + cDi 重投影（网格跟随相机，见命中段注释）
//
// 已实现：透明单层吸收（isTranslucent：水3/玻璃4/叶13，光穿过被着色衰减一次）、
// 方块形状求交（完整版：楼梯/门/玻璃板/板条/活塞/墙/栅栏/栅栏门/
// 压力板/漏斗/活板门/堆肥桶/炼药锅/脚手架/铁砧等，形状 ID 155-294，见 VoxelShape.glsl）
// 未实现（留后续）：折射、半分辨率降采样、
// 追踪专用时域累积（现靠 TAA）。
//================================================================================================//

#include "/lib/lighting/VoxelData.glsl"
// GI 方向天空光（原创）
#include "/lib/lighting/VoxelSkyLight.glsl"
// 阳光阴影判定（SimpleShadow 实时阴影贴图 + SimpleShadowTracing 体素 DDA 短程遮挡）
#include "/lib/lighting/VoxelSunShadow.glsl"

// [FIX 2026-08-06] 命中体素是否被太阳直射（阴影贴图判定，复刻 VoxelGI.frag VoxelGI_SunVisible）：
// 追踪端阳光反弹此前无阴影判定，洞穴/背阴体素有微弱 skylight 残留（×444 门控阈值极低）
// → 8.0 倍阳光反弹 → "阳光散射到处都是，连地下都很亮"。加 sunVis 后只有真被太阳照亮的
// 体素才反弹阳光（与注入端一致）。camRelPos = 相机相对世界坐标（体素坐标 − Cf − R）。
// 依赖：shadow/Common.glsl（DistortShadowSpace）+ shadowtex1（DiffuseIndirect.comp 已声明）。
float VoxelTraceSunVisible(vec3 camRelPos) {
    if (sunPosition.y < 0.01) return 0.0;
    vec3 shadowClipPos = (shadowModelView * vec4(camRelPos, 1.0)).xyz;
    shadowClipPos = (shadowProjection * vec4(shadowClipPos, 1.0)).xyz;
    vec3 ssp = DistortShadowSpace(shadowClipPos) * 0.5 + 0.5;
    #ifdef ENABLE_VOXELIZATION
        ShiftShadowScreenPos(ssp.xy);
    #endif
    ssp.z -= 4e-5;
    if (all(equal(ssp, saturate(ssp)))) {
        return textureLod(shadowtex1, vec3(ssp.xy, ssp.z), 0.0).x > 0.5 ? 1.0 : 0.0;
    }
    return 1.0;
}

// 每像素漫反射追踪：
// origin = 相机相对起点；normal = 世界法线（可能含法线贴图）；vertexNormal = 几何法线；
// viewDist = 视距（-viewPos.z，供起点偏移）；skyLightmap = 像素天空 lightmap（泄漏衰减）；
// blockLightmap = 像素方块光 lightmap（出界 BlockLighting 底光）；
// 返回 0-1 尺度的"入射光"（已含命中体素 albedo 反射，未乘当前像素 albedo/强度）。
vec3 VoxelTracePixel(vec3 origin, vec3 normal, vec3 vertexNormal, float viewDist, float skyLightmap, float blockLightmap, inout uint seed) {
    // 世界对齐网格对齐：origin 为相机相对坐标，+cameraPositionFract 抵消小数 +VOXEL_RADIUS
    // 转网格坐标（[0,VOXEL_AREA)）——与 Terrain.vert 体素化 / VoxelGI.frag 注入端
    // （起点 vec3(c)+0.5）同一坐标系。漏加 VOXEL_RADIUS 会让起点落在 -32..32 的负半区，
    // VoxelTraceDDA 判出界 [0,64) 立即退出 → 命中永远不触发、全走天空路径（"只有噪点没有光"根因）
    origin += cameraPositionFract;
    origin += float(VOXEL_RADIUS);
    // 起点沿几何法线偏移防自交（随视距增大，自交风险更高）
    origin += vertexNormal * (viewDist * 0.0003);

    // [2026-08-09] 体素网格外（像素世界位置超出 64³ 网格）没有光追数据：
    // 直接返回 0，交由 DeferredLight 的非光追路径（lightmap / SH 环境光）接管，
    // 避免"起点出界 → 立即拿天空光"导致大型洞穴里网格外的区域反而发亮。
    if (any(lessThan(origin, vec3(0.0))) || any(greaterThanEqual(origin, vec3(float(VOXEL_AREA))))) {
        return vec3(0.0);
    }

    // 均匀半球采样：方向若落到几何法线背面 → 沿几何法线重采样（vertexNormal 回落）
    vec3 dir = VoxelHemisphereUnitVector(normal, seed);
    if (dot(dir, vertexNormal) <= 0.0)
        dir = VoxelHemisphereUnitVector(vertexNormal, seed);
    // 余弦 pdf：均匀采样 × 2cosθ = 漫反射辐照度核（无 1/cos 发散）
    float weight = saturate(dot(dir, normal)) * 2.0;

    // ---- 穿透式 DDA 步进 ----
    // - 空气（z<=0.5，含负 ID 透明体素）→ 穿透
    // - 发射光体素（lD.x>阈值）→ 球形光源平滑贡献 + 穿透不挡光（
    //   HitLightShpere * hitSurface；修"贴光源表面 0/1 命中闪烁"——光线对准球心
    //   才强、擦边平滑衰减，不再有命中/未命中的硬跳变）
    // - 普通固体 → 命中停止（albedo/方块光/阳光/IRC 前帧）
    vec3 voxelCoord = floor(origin);
    vec3 sdir = sign(dir);
    vec3 rdir = 1.0 / max(abs(dir), vec3(1e-8));
    vec3 totalStep = (sdir * (voxelCoord - origin + 0.5) + 0.5) * rdir;
    float rayLength = 0.0;
    vec3 contrib = vec3(0.0);
    bool exitGrid = false;
    // 透明吸收累积（hitSurface）：首次命中水/玻璃/树叶时着色衰减，其后贡献全乘此系数
    vec3 absorption = vec3(1.0);
    bool traceTranslucent = true;

    // ---- 起点格自发光（curEmissive；注入端 VoxelGI.frag
    // 已有、追踪端此前缺失）----
    // 贴光源的面（如贴火把的墙面）像素起点 = 面坐标 + vertexNormal 法线偏移（朝光源方向），
    // 会把起点推进光源格内；DDA 只检查"经过"的格、不检查起点格 → 光线从光源内部出发，
    // 拿不到光源自己的球形光 → "贴火把的面纯暗 / 停下来就灭"（2026-08-04 实测：火把格
    // 品红=发射数据在、火把格本身不挡光，但贴面暗）。起点在光源格内时直接加球形光：
    // 光源照亮其所在格的全部贴面（物理合理），且与 bob/坐标振荡无关 → 消除"走亮停灭"。
    ivec3 startVc = ivec3(voxelCoord);
    if (all(greaterThanEqual(startVc, ivec3(0))) && all(lessThan(startVc, ivec3(VOXEL_AREA)))) {
        vec4 svd = texelFetch(voxelDataSampler, startVc, 0);
        if (svd.z > 0.5) {
            vec3 slD = unpackUnorm4x8(texelFetch(voxelLightSampler, startVc, 0).r).rgb;
            if (slD.z > VOXEL_GI_EMISSIVE_THRESHOLD) {  // 新字节序：B=emissive
                contrib += VoxelHitLightSphere(origin, dir, vec3(startVc), VoxelLightColor(abs(svd.z)))
                         * absorption * VOXEL_GI_TRACE_LIGHT_STRENGTH;
            }
        }
    }

    for (int i = 0; i < VOXEL_TRACE_DISTANCE; ++i) {
        rayLength = VoxelMin3(totalStep);
        vec3 tracingNext = step(totalStep, vec3(rayLength));
        voxelCoord += tracingNext * sdir;
        totalStep += tracingNext * rdir;
        if (rayLength > float(VOXEL_TRACE_DISTANCE)) {
            exitGrid = true; // 射程用尽也走出界路径（exitTracing 语义：距离/越界统一出界）
            break;
        }

        if (any(lessThan(voxelCoord, vec3(0.0))) || any(greaterThanEqual(voxelCoord, vec3(VOXEL_AREA)))) {
            exitGrid = true;
            break;
        }

        ivec3 vc = ivec3(voxelCoord);
        vec4 hvd = texelFetch(voxelDataSampler, vc, 0);
        // 判空：voxelID 原值整数（>0 即固体，0=空气；半精度浮点整数精确）
        if (hvd.z <= 0.5) {
            // 透明体素：水/玻璃/树叶单层吸收着色（isTranslucent，只吸收一次；
            // 植物/传送门纯穿透）。hvd.xy = 图集中心 UV，采样取方块颜色与不透明度。
            if (traceTranslucent && VoxelIsTranslucentAbsorb(abs(hvd.z))) {
                vec4 tc = texture(atlas2D, hvd.xy);
                absorption *= VoxelAlbedoToAbsorption(tc.rgb, tc.a);
                traceTranslucent = false;
            }
            continue;
        }

        vec3 lD = unpackUnorm4x8(texelFetch(voxelLightSampler, vc, 0).r).rgb;

        if (lD.z > VOXEL_GI_EMISSIVE_THRESHOLD) {  // 新字节序：B=emissive
            // 发射光体素：球形光源平滑贡献 + 穿透（光源不阻挡光线）。
            // 发射色 = 按材料 ID 查固定光源色表（VoxelLightColor）：火把纹理中心是
            // 暗色木杆，用纹理 albedo 当发射色会又暗又灰（"光源周围黑印"主因之一），
            // 固定暖色让火把/灯笼发出正确亮光；64³ 下精确纹素采样也会把高对比纹理
            // 图案"印"到旁边面 → 固定色 = 均匀光斑。
            vec3 albE = VoxelLightColor(abs(hvd.z));
            // 追踪端发射光：× VOXEL_GI_TRACE_LIGHT_STRENGTH 压低脉冲（1 SPP 高方差采样，
            // 语义：发射光主体由 IRC 时域累积承载，追踪只补锐利弱光；强脉冲会导致
            // 贴光源面"命中/未命中"跳变闪烁，见 VoxelLighting.glsl 宏注释）
            contrib += VoxelHitLightSphere(origin, dir, vec3(vc), albE) * absorption * VOXEL_GI_TRACE_LIGHT_STRENGTH;
            continue;
        }

        // ---- 普通固体命中：形状求交（IsHitBlock 桥接）----
        // 全块（voxelID<=154，含熔岩/发光/反光）：整格命中，法线 = -tracingNext*sdir；
        // 形状块（155-294，楼梯/门/栅栏/墙…）：HitShape 子盒判定，光线穿过子盒
        // 空隙（未命中）→ 继续步进（穿透式 DDA 语义）。hitNormal 由 IsHitBlock 输出。
        VoxelRay vray;
        vray.ori = origin;
        vray.dir = dir;
        vray.rdir = rdir;
        vray.sdir = sdir;
        vec3 hitNormal;
        if (!IsHitBlock(vray, totalStep, tracingNext, voxelCoord, abs(hvd.z), rayLength, hitNormal))
            continue;

        // 反弹 albedo：固体格 r/g=染过色中心色 RG、w 高 8 位=染过色 B（Shadow.frag 草方块
        // tint 修复）；不再采样 atlas2D（64³ 无法表达 16px 细节，中心色=体素平均反照率）。
        vec3 alb = vec3(hvd.r, hvd.g, VoxelUnpack2xU8X(hvd.w));

        // 方块光兜底（普通固体格带原版方块光）
        // [FIX 2026-08-06] 薄片/流体光源（发光地衣/岩浆）voxelData 中心色可能为 0 →
        // albedo 乘进 blocklight 后趋 0 不发光；用 min albedo 底，不依赖采样色。
        if (lD.y > 0.01)  // 新字节序：G=blocklight
            contrib += max(alb, vec3(VOXEL_GI_BLOCK_MIN_ALBEDO)) * blocklightColor * lD.y * VOXEL_GI_BLOCK_STRENGTH * absorption;
        // 真阳光弹射：命中面法线方向项 + 天空 lightmap 平滑衰减（SUNLIGHT_LEAK_FIX）
        // 阳光色 = 物理直射辐照度 × rcp(VOXEL_SUN_REFERENCE)（0-1 尺度，自带昼夜明暗 + 暖色温）。
        // 不能用 skyColor——它是天空蓝（环境色），与出界天空路径同色 → 反弹混进环境光里
        // 看不出"阳光反弹"（2026-08-05 用户反馈）。
        // [FIX 2026-08-05] 阳光门限改用 voxelData.w 的写胜 skylight（对应漫反射追踪
        // 的 voxelDataW.y 语义，也对应本项目 IRC 的 VoxelUnpack2xU8Y）：lD.x 来自 voxelLightData 的
        // imageAtomicMax（sky 是最低字节，max 比较被 block/emissive 高位压掉 → 门限常为 0
        // → 阳光反弹全无，这是最终根因）。hvd = 命中体素数据（voxelDataSampler）。
        vec3 sunDir = mat3(shadowModelViewInverse) * vec3(0.0, 0.0, 1.0);
        float hitSkylight = VoxelUnpack2xU8Y(hvd.w);
        // [FIX 2026-08-05] hitSkylight 可能因 imageStore 写胜（最后一片段覆盖）被背阴面写成 0 →
        // 门限恒 0 → 阳光全无。用 max(体素sky, 像素自身skyLightmap) 兜底：体素 sky 可靠时仍用它，
        // 不可靠（0）时退回像素自己的天光（也是先用像素 lightmap.y 再更新）。
        // [FIX 2026-08-05] 阳光项改用本地重算的直射辐照度：诊断确认 global.directIlluminance
        // 在计算端（DiffuseIndirect）读到 0（SSBO 跨 pass 屏障/绑定问题）→ 阳光项整体乘 0
        // → 阴影纯黑。本地重算（同 GlobalStorage.comp）；若 SSBO 有值则优先用 SSBO。
        vec3 sunIlluminance = sunIrradiance * AtmosphereTransmittanceToSun(atmosphereViewPos, worldSunDir);
        vec3 moonIlluminance = sunIrradiance * AtmosphereTransmittanceToSun(atmosphereViewPos, -worldSunDir) * moonlightMult;
        vec3 directIlluminance = (sunIlluminance + moonIlluminance) * 128.0;
        directIlluminance *= smoothstep(0.0, 0.01, worldLightDir.y);
        if (max(max(global.directIlluminance.r, global.directIlluminance.g), global.directIlluminance.b) > 1e-4)
            directIlluminance = global.directIlluminance;
        // 白天兜底：SSBO/本地重算都算不出直射辐照度时用常数（排除该变量后如仍无阳光即非此因）
        if (max(max(directIlluminance.r, directIlluminance.g), directIlluminance.b) < 1e-4 && worldLightDir.y > 0.01)
            directIlluminance = vec3(128.0);
        float sunLighting = saturate(dot(sunDir, hitNormal)) * saturate(max(hitSkylight, skyLightmap) * 444.0);
        // [FIX 2026-08-06] 阴影判定（sunVis，与注入端 VoxelGI_SunVisible 同逻辑）：命中体素真被
        // 太阳直射才反弹阳光。此前无 sunVis，洞穴/背阴体素有微弱 sky 残留（×444 门控也放行）
        // → 8.0 倍阳光反弹 → 地下/背阴处到处都是阳光散射。
        // [2026-08-09] 用连续命中点（对应 SimpleShadow/SimpleShadowTracing
        // 的 hitVoxelPos）：整数格坐标会让阴影判定对体素化数据的逐帧更新非常敏感
        // （相机移动时网格内容变化 → sunVis 在 0/1 间跳变 → 阳光散射时有时无）。
        vec3 hitVoxelPos = origin + dir * rayLength;
        vec3 hitWorldPos = hitVoxelPos - cameraPositionFract - float(VOXEL_RADIUS);
        // 阳光可见性 = 实时阴影贴图（带命中面法线偏移防自阴影）
        // × 体素 DDA 短程遮挡（3 格内屋檐/树冠/墙角等网格内遮挡，阴影贴图分辨率外）。
        // 彩色阴影：实心挡=0，直射=1，穿玻璃=玻璃吸收色（反弹光线染色）
        vec3 sunVis = VoxelSunShadowMap(hitWorldPos, hitNormal)
                    * VoxelSunShadowTracing(hitVoxelPos, sunDir);

        // [2026-08-09 恢复] 追踪端阳光反弹已恢复（删除临时 *0.0）；sunVis 判定
        // 保证只有被太阳直射的体素才反弹阳光，洞穴/背阴处不会产生阳光散射。
        contrib += alb * (directIlluminance * rcp(VOXEL_SUN_REFERENCE))
                 * sunLighting * sunVis * VOXEL_TRACE_SUN_STRENGTH * absorption;
        // 间接光：命中体素处的 IRC 前帧缓存（相机重投影 +cDi，与注入端同款）
        ivec3 ircHit = vc + (cameraPositionInt - previousCameraPositionInt);
        if (all(greaterThanEqual(ircHit, ivec3(0))) && all(lessThan(ircHit, ivec3(VOXEL_AREA))))
            contrib += alb * FetchVoxelRadiance(ircHit).rgb * 0.01 * VOXEL_GI_SELF_BOUNCE * absorption;
        return contrib * weight;
    }

    // 出界（网格外且朝上）→ 天光 + 像素自身方块光底（
    // SkyLighting + BlockLighting(lightmap.x) + NOLIGHT）：
    // - 天空 × sat(skyLightmap*4.44)（SUNLIGHT_LEAK_FIX 阈值 0.23，与注入端同口径）
    // - blocklight 底 = 像素自己 lightmap 的方块光（光线出界不丢失光源信息）
    // - NOLIGHT 兜底：出界路径专有（NOLIGHT_BRIGHTNESS * saturate(rayLength*0.2)）
    // 射程用尽：仅返回发射光球形累积 + 底光。主底光仍由 IRC 阳光扩散提供。
    if (exitGrid) {
        // [2026-08-16 临时] 光追天光从未正常工作 → 移除出界天空光，
        // 天空照明由 DeferredLight 的球谐光（SH）接管。
        // [2026-08-09] 出界不再返回原版方块光底光：光追开启时体素网格内的原版方块光
        // （lightmap 光晕）应被屏蔽，由体素 GI 的方块光（命中/IRC 注入，lD.y 驱动）
        // 接管。保留此项会把 DeferredLight 已屏蔽的原版方块光又加回来（火把光晕
        // 双倍/未屏蔽）。"体素外以非光追样式渲染"由 DeferredLight 的 lightmap.x
        // 路径负责，与此处无关。
        // contrib += blocklightColor * blockLightmap * VOXEL_GI_BLOCK_STRENGTH * absorption;
    }
    contrib += vec3(0.97, 0.99, 1.18) * VOXEL_NOLIGHT_BRIGHTNESS * saturate(rayLength * 0.2) * absorption;
    return contrib * weight;
}

//================================================================================================//
// 级联漫反射追踪（ADR-0001）
//
// 跨级联连续追踪：从最细级联（near）开始，射线出界/射程用尽后按世界坐标进入下一级联
// 继续；命中即返回。near（0.5m）负责近景精细 GI，mid（1.0m）中景，far（2.0m）把覆盖
// 扩到 ±64m（原单 64³ 只有 ±32m）。像素起点超出 far 覆盖仍返回 0（非光追路径接管）。
// 简化：VoxelSunShadowTracing（3 格短程遮挡）仅 mid 级联启用；near/far 依赖阴影贴图判定。
//================================================================================================//

// 查询端级联取数（near/far 数据与方块光；mid 用 VoxelGI.glsl 已声明的 mid sampler）
uniform sampler3D voxelDataNearSampler;
uniform usampler3D voxelLightNearSampler;
uniform sampler3D voxelDataFarSampler;
uniform usampler3D voxelLightFarSampler;

vec4 FetchCascadeDataT(ivec3 c, int cascade) {
    if (cascade == 0) return texelFetch(voxelDataNearSampler, c, 0);
    if (cascade == 2) return texelFetch(voxelDataFarSampler, c, 0);
    return texelFetch(voxelDataSampler, c, 0);
}

vec4 FetchCascadeLightT(ivec3 c, int cascade) {
    if (cascade == 0) return unpackUnorm4x8(texelFetch(voxelLightNearSampler, c, 0).r);
    if (cascade == 2) return unpackUnorm4x8(texelFetch(voxelLightFarSampler, c, 0).r);
    return unpackUnorm4x8(texelFetch(voxelLightSampler, c, 0).r);
}

// 手动三线性采样级联 IRC（返回解码后 0-1 尺度）：
// 硬 texelFetch 会把相邻格辐射度跳变暴露成格边界暗纹（near 0.5m → 半块边长锯齿）。
// mid 维持原硬取语义（既有画面不变）；near/far 用平滑采样。
vec3 FetchVoxelRadianceSmoothed(ivec3 c, int cascade) {
    if (cascade == 1)
        return FetchVoxelRadianceC(c, cascade).rgb * 0.01;
    vec3 f = vec3(c) + 0.5;
    ivec3 i = ivec3(floor(f));
    vec3 t = f - vec3(i);
    vec3 acc = vec3(0.0);
    for (int k = 0; k < 8; ++k) {
        ivec3 off = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        ivec3 p = clamp(i + off, ivec3(0), ivec3(VOXEL_AREA - 1));
        float w = (off.x == 0 ? 1.0 - t.x : t.x)
                * (off.y == 0 ? 1.0 - t.y : t.y)
                * (off.z == 0 ? 1.0 - t.z : t.z);
        acc += FetchVoxelRadianceC(p, cascade).rgb * w;
    }
    return acc * 0.01;
}

vec3 VoxelTracePixelCascaded(vec3 origin, vec3 normal, vec3 vertexNormal, float viewDist, float skyLightmap, float blockLightmap, inout uint seed) {
    // 自交偏移（世界米，与单级联版一致）
    origin += vertexNormal * (viewDist * 0.0003);

    // 均匀半球采样 + 几何法线回落 + 余弦权重（同单级联版）
    vec3 dir = VoxelHemisphereUnitVector(normal, seed);
    if (dot(dir, vertexNormal) <= 0.0)
        dir = VoxelHemisphereUnitVector(vertexNormal, seed);
    float weight = saturate(dot(dir, normal)) * 2.0;

    // 世界对齐相对坐标（W - floor(C)），与体素化/注入端一致
    vec3 worldRel = origin + cameraPositionFract;
    // 超出 far 级联覆盖（±64m）→ 非光追路径接管（同原"网格外返回 0"语义）
    if (any(greaterThanEqual(abs(worldRel), vec3(VOXEL_CASCADE_RADIUS_2))))
        return vec3(0.0);

    vec3 contrib = vec3(0.0);
    vec3 absorption = vec3(1.0);
    bool traceTranslucent = true;
    bool hitSolid = false;
    float totalWorldLen = 0.0;

    // 级联查询配置: SKIP_NEAR=1(mid 起) SKIP_FAR=0(mid+far)
    #define VOXEL_QUERY_SKIP_NEAR 1
    #define VOXEL_QUERY_SKIP_FAR 0
    for (int cascade = VOXEL_QUERY_SKIP_NEAR; cascade < VOXEL_CASCADE_COUNT - VOXEL_QUERY_SKIP_FAR; ++cascade) {
        float cell = cascade == 0 ? VOXEL_CASCADE_CELL_0
                   : cascade == 1 ? VOXEL_CASCADE_CELL_1
                                  : VOXEL_CASCADE_CELL_2;

        // 网格坐标（[0,VOXEL_AREA)）；起点不在本级联覆盖内时首步即出界 → 自动进下一级联
        vec3 gridOrigin = worldRel / cell + float(VOXEL_RADIUS);
        vec3 voxelCoord = floor(gridOrigin);
        vec3 sdir = sign(dir);
        vec3 rdir = cell / max(abs(dir), vec3(1e-8));
        vec3 totalStep = (sdir * (voxelCoord - gridOrigin + 0.5) + 0.5) * rdir;
        float rayLen = 0.0;
        bool exitGrid = false;

        // 起点格自发光（同单级联版；贴光源面像素的起点会被法线偏移推进光源格）
        ivec3 startVc = ivec3(voxelCoord);
        if (all(greaterThanEqual(startVc, ivec3(0))) && all(lessThan(startVc, ivec3(VOXEL_AREA)))) {
            vec4 svd = FetchCascadeDataT(startVc, cascade);
            if (svd.z > 0.5) {
                vec3 slD = FetchCascadeLightT(startVc, cascade).rgb;
                if (slD.z > VOXEL_GI_EMISSIVE_THRESHOLD) {
                    contrib += VoxelHitLightSphere(gridOrigin, dir, vec3(startVc), VoxelLightColor(abs(svd.z)))
                             * absorption * VOXEL_GI_TRACE_LIGHT_STRENGTH;
                }
            }
        }

        for (int i = 0; i < VOXEL_TRACE_DISTANCE; ++i) {
            rayLen = VoxelMin3(totalStep);
            vec3 tracingNext = step(totalStep, vec3(rayLen));
            voxelCoord += tracingNext * sdir;
            totalStep += tracingNext * rdir;
            if (rayLen > float(VOXEL_TRACE_DISTANCE)) { exitGrid = true; break; }
            if (any(lessThan(voxelCoord, vec3(0.0))) || any(greaterThanEqual(voxelCoord, vec3(float(VOXEL_AREA))))) {
                exitGrid = true;
                break;
            }

            ivec3 vc = ivec3(voxelCoord);
            vec4 hvd = FetchCascadeDataT(vc, cascade);
            // 判空：voxelID 原值整数（>0 即固体，0=空气；半精度浮点整数精确）
            if (hvd.z <= 0.5) {
                if (traceTranslucent && VoxelIsTranslucentAbsorb(abs(hvd.z))) {
                    vec4 tc = texture(atlas2D, hvd.xy);
                    absorption *= VoxelAlbedoToAbsorption(tc.rgb, tc.a);
                    traceTranslucent = false;
                }
                continue;
            }

            vec3 lD = FetchCascadeLightT(vc, cascade).rgb;
            if (lD.z > VOXEL_GI_EMISSIVE_THRESHOLD) {
                vec3 albE = VoxelLightColor(abs(hvd.z));
                contrib += VoxelHitLightSphere(gridOrigin, dir, vec3(vc), albE) * absorption * VOXEL_GI_TRACE_LIGHT_STRENGTH;
                continue;
            }

            // 普通固体命中：形状求交（IsHitBlock 桥接）
            VoxelRay vray;
            vray.ori = gridOrigin;
            vray.dir = dir;
            vray.rdir = rdir;
            vray.sdir = sdir;
            vec3 hitNormal;
            if (!IsHitBlock(vray, totalStep, tracingNext, voxelCoord, abs(hvd.z), rayLen, hitNormal))
                continue;

            vec3 alb = vec3(hvd.r, hvd.g, VoxelUnpack2xU8X(hvd.w));

            // 方块光兜底（同单级联版）
            if (lD.y > 0.01)
                contrib += max(alb, vec3(VOXEL_GI_BLOCK_MIN_ALBEDO)) * blocklightColor * lD.y * VOXEL_GI_BLOCK_STRENGTH * absorption;

            // 真阳光弹射（同单级联版：本地重算直射辐照度 + sunVis 阴影判定）
            vec3 sunDir = mat3(shadowModelViewInverse) * vec3(0.0, 0.0, 1.0);
            float hitSkylight = VoxelUnpack2xU8Y(hvd.w);
            vec3 sunIlluminance = sunIrradiance * AtmosphereTransmittanceToSun(atmosphereViewPos, worldSunDir);
            vec3 moonIlluminance = sunIrradiance * AtmosphereTransmittanceToSun(atmosphereViewPos, -worldSunDir) * moonlightMult;
            vec3 directIlluminance = (sunIlluminance + moonIlluminance) * 128.0;
            directIlluminance *= smoothstep(0.0, 0.01, worldLightDir.y);
            if (max(max(global.directIlluminance.r, global.directIlluminance.g), global.directIlluminance.b) > 1e-4)
                directIlluminance = global.directIlluminance;
            if (max(max(directIlluminance.r, directIlluminance.g), directIlluminance.b) < 1e-4 && worldLightDir.y > 0.01)
                directIlluminance = vec3(128.0);
            float sunLighting = saturate(dot(sunDir, hitNormal)) * saturate(max(hitSkylight, skyLightmap) * 444.0);
            // 连续命中点（网格单位）→ 世界相对坐标（×cell 换算回米）
            vec3 hitVoxelPos = gridOrigin + dir * rayLen;
            vec3 hitWorldPos = (hitVoxelPos - float(VOXEL_RADIUS)) * cell - cameraPositionFract;
            vec3 sunVis = VoxelSunShadowMap(hitWorldPos, hitNormal);
            if (cascade == 1)
                sunVis *= VoxelSunShadowTracing(hitVoxelPos, sunDir);

            contrib += alb * (directIlluminance * rcp(VOXEL_SUN_REFERENCE))
                     * sunLighting * sunVis * VOXEL_TRACE_SUN_STRENGTH * absorption;
            // 间接光：命中级联的 IRC 前帧缓存（相机重投影，同单级联版）
            ivec3 ircHit = vc + (cameraPositionInt - previousCameraPositionInt);
            if (all(greaterThanEqual(ircHit, ivec3(0))) && all(lessThan(ircHit, ivec3(VOXEL_AREA))))
                contrib += alb * FetchVoxelRadianceSmoothed(ircHit, cascade) * VOXEL_GI_SELF_BOUNCE * absorption;
            hitSolid = true;
            break;
        }

        if (hitSolid) break;

        // 出界：累计世界距离后进入下一级联；射程用尽则直接走天空
        totalWorldLen += rayLen * cell;
        if (exitGrid && rayLen <= float(VOXEL_TRACE_DISTANCE)) {
            worldRel += dir * (rayLen * cell);
            continue;
        }
        break;
    }

    // 未命中 → 方向天空光 + NOLIGHT 兜底（同单级联版出界路径）
    if (!hitSolid) {
        // [2026-08-16 临时] 光追天光停用（球谐光接管）
        contrib += vec3(0.97, 0.99, 1.18) * VOXEL_NOLIGHT_BRIGHTNESS * saturate(totalWorldLen * 0.2) * absorption;
    }
    return contrib * weight;
}
