/*
--------------------------------------------------------------------------------
    Revelation Shaders
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Pass: Deferred lighting and sky combination
    Optimized: Early sun-light culling, deferred bicubic sampling, constant folding.
    Added: SSS_DISABLE_BEYOND_SHADOW_DIST macro to skip SSS outside shadow distance.
    [2026-09] That macro is now a real GUI option (declared in settings.glsl, default off);
              by default SSS keeps running outside the shadow distance but its sun-driven
              terms fade out there (only the sky/ambient term remains).
    Added: SPECULAR_BLOOM_BOOST for enhancing specular bloom (glare).
    Added: Skip compensation in The End / Nether.
    Added: SUN_BRIGHTNESS_MULTIPLIER and MOON_BRIGHTNESS_MULTIPLIER for independent tuning.
    Added: AMBIENT_BRIGHTNESS_MULTIPLIER and AMBIENT_COLOR_TINT to control ambient/skylight.
    Added: AMBIENT_SUNLIGHT_TINT_RATIO with dynamic time‑based intensity (noon max, night off).
    Added: NIGHT_SHADOW_BOOST to deepen night shadows.
--------------------------------------------------------------------------------
*/

#define PASS_DEFERRED_LIGHTING

#ifndef SHADOW_CONTRAST_STRENGTH
    #define SHADOW_CONTRAST_STRENGTH 1.0 // [0.1 0.2 0.3 0.4 0.5 1.0 2.0 3.0 4.0 6.0 8.0 10.0]
#endif

// 启用补偿
#define COMPENSATION_ENABLED

// 补偿参数
#ifndef COMPENSATION_BOOST
    #define COMPENSATION_BOOST 0.5 // [0.0 0.05 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
#endif
#ifndef COMPENSATION_FADE_SPEED
    #define COMPENSATION_FADE_SPEED 0.2 // [0.1 0.2 0.3 0.4 0.5 1.0 2.0 3.0 4.0 6.0 8.0 10.0]
#endif
#ifndef COMPENSATION_DELAY
    #define COMPENSATION_DELAY 6.0 // [0.0 0.5 1.0 1.5 2.0 3.0 5.0 6.0 10.0 15.0]
#endif
#ifndef COMPENSATION_AO_BOOST
    #define COMPENSATION_AO_BOOST 1.5 // [0.0 0.1 0.2 0.3 0.5 0.7 1.0 1.5 2.0]
#endif

// ====== 次表面散射距离控制 ======
// [2026-09] 原来这里有一行无条件的 #define SSS_DISABLE_BEYOND_SHADOW_DIST，导致 GUI 里的
// 同名开关完全失效（用户设为关也不生效）。已删除，改为在 settings.glsl 里声明（默认注释掉）。
// 默认行为：阴影距离外不关 SSS，只把太阳项平滑淡出（见下方 SSS 段）。

// ====== 镜面高光泛光增强 ======
#ifndef SPECULAR_BLOOM_BOOST
    #define SPECULAR_BLOOM_BOOST 3.0 // [1.0 1.5 2.0 2.5 3.0 4.0 5.0]
#endif

// ====== 阳光 / 月光亮度控制 ======
#ifndef SUN_BRIGHTNESS_MULTIPLIER
    #define SUN_BRIGHTNESS_MULTIPLIER 1.0 // [0.0 0.5 1.0 1.5 2.0 3.0 5.0]
#endif
#ifndef MOON_BRIGHTNESS_MULTIPLIER
    #define MOON_BRIGHTNESS_MULTIPLIER 1.0 // [0.0 0.5 1.0 1.5 2.0 3.0 5.0]
#endif

// ====== 环境光/天空光亮度与颜色控制 ======
#ifndef AMBIENT_BRIGHTNESS_MULTIPLIER
    #define AMBIENT_BRIGHTNESS_MULTIPLIER 1.5 // [0.0 0.5 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0]
#endif
#ifndef AMBIENT_COLOR_TINT
    #define AMBIENT_COLOR_TINT vec3(1.0, 1.0, 1.0) // 减少蓝色可改为 vec3(1.0, 1.0, 0.85)
#endif

// 环境光阳光色调混合最大强度 (实际强度 = 此值 × 太阳高度因子，仅主世界)
#ifndef AMBIENT_SUNLIGHT_TINT_RATIO
    #define AMBIENT_SUNLIGHT_TINT_RATIO 1.1 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.5 3.0]
#endif

// ====== 夜间阴影增强 ======
#ifndef NIGHT_SHADOW_BOOST
    #define NIGHT_SHADOW_BOOST 4.5 // [1.0 1.5 2.0 2.5 3.0 4.0 5.0]
#endif

// ====== Precomputed Constants ======
#define INV_HAND_DEPTH (1.0 / MC_HAND_DEPTH)
#define HAND_DEPTH_OFFSET (0.5 - 0.5 * INV_HAND_DEPTH)
// [2026-09] 旧版 SSS 模型的阴影幂门控指数（重写版模型不使用它）。
// 之前随「SSS 与阴影门控解耦」被删过；现在旧版模型回归，这里一并恢复。
#define SSS_CONTRAST_POW (1.2 / SHADOW_CONTRAST_STRENGTH)

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"



//======// Output //==============================================================================//

/* RENDERTARGETS: 0 */
out vec3 sceneOut;

//======// Uniform //=============================================================================//

writeonly uniform uimage2D colorimg7;

// [2026-09 RTWSM] 逐 bin 重要性（256 x 2，R32UI；row0 = x 轴、row1 = y 轴）。
// 本 pass 用 imageAtomicMax 聚合（**不是累加**，理由见 main() 里的"修正 B"），
// 下一帧的 setup12 读走并清零。
// 非 writeonly（atomic 需要读写权限）⇒ 必须带格式限定符（见包内 Terrain.frag 的同类注释）。
layout (r32ui) uniform uimage2D shadowWarpHistImg;

#ifdef SUBSURFACE_SCATTERING_DIFFUSION
    // [2026-09] SSS 屏幕空间扩散的源项（半分辨率 RGBA16F，见 lib/lighting/Subsurface.glsl 与
    // post/SubsurfaceBlur.comp）。用 imageStore 写半分辨率：同一 2x2 全分辨率块只让左上片元写，
    // 这样既保证每帧完整覆盖、又避免 4 个片元写同一纹素的竞态（细节见 main() 末尾的注释）。
    // 相比全分辨率源缓冲省掉 15.2 MB -> 3.8 MB 的写入带宽。
    layout (rgba16f) writeonly uniform image2D colorimg18;
#endif
uniform sampler2D cloudOriginTex;

#include "/lib/universal/Uniform.glsl"

// 覆盖只读限制，使 GlobalData 可写
#undef SSBO_DECLARED_TPYE
#define SSBO_DECLARED_TPYE
#include "/lib/universal/SSBO.glsl"

//======// Struct //================================================//

#include "/lib/universal/Material.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"
#include "/lib/universal/Random.glsl"

#include "/lib/atmosphere/Common.glsl"
#include "/lib/atmosphere/Celestial.glsl"

#include "/lib/atmosphere/clouds/Render.glsl"
#include "/lib/atmosphere/clouds/Shadows.glsl"

#include "/lib/lighting/Common.glsl"
#include "/lib/lighting/shadow/Render.glsl"
#include "/lib/lighting/Subsurface.glsl"

// [P1 2026-09-02] 按 AO_ENABLED 值只 include 一种 AO 实现，避免 SSAO+GTAO 同时编译徒耗寄存器与编译时间
#if AO_ENABLED == 1 && !defined GI_ACTIVE_SSILVB
    #include "/lib/lighting/SSAO.glsl"
#endif
#if AO_ENABLED == 2 && !defined GI_ACTIVE_SSILVB
    #include "/lib/lighting/GTAO.glsl"
#endif

// [2026-09-02] 共享多反弹拟合，供 SSAO/GTAO 任一模式在 AO_MULTI_BOUNCE 时调用
#include "/lib/lighting/AOMultiBounce.glsl"

#include "/lib/SpatialUpscale.glsl"

#ifdef RAIN_PUDDLES
    #include "/lib/surface/RainPuddle.glsl"
#endif
#include "/lib/surface/Reflection.glsl"

//#ifdef ENABLE_VOXELIZATION
    #include "/lib/lighting/VoxelGI.glsl"
//#endif

// 方块图集（shaders.properties customTexture.atlas2D = blocks.png，与传播端/体素化同图集）
// 无显式 binding：交由 Iris 按名字自动绑定（显式 binding 会与普通贴图纹理单元冲突）
uniform sampler2D atlas2D;

// 每像素漫反射追踪已迁到 DiffuseIndirect.comp（棋盘半分辨率 1 SPP + SVGF 时域累积，
// 阶段④）；此处只读回信号，不再 include VoxelTracing.glsl。


//======// 阴影 warp 表的重要性测量 //=============================================================//

// RTWSM 的重要性（见 lib/lighting/shadow/Warp.glsl 与 program/setup/ShadowWarp.comp）：
// 把"相机看得见的地形"投影到**未平移、未形变**的 shadow clip 空间，落在哪个 bin 就给哪个 bin
// 一份重要性。三个因子：
//   距离项 1/(dist^RTWSM_DIST_FACTOR · 0.1 + 1)   —— 玩家中心加权（近处地形要更多阴影分辨率）
//   朝向项 1 + RTWSM_FACING_FACTOR·saturate(N·(-V)) —— 正对相机的面才重要（背面/掠射面看不见）
//   体素条带权重 见下
// 不需要读阴影图、不需要新 pass：本 pass 现成的世界坐标/法线/视距就够了。放在本文件（而不是
// Warp.glsl）是因为下面这条权重要用 VOXEL_SHADOW_RATIO / ENABLE_VOXELIZATION，那两个宏由
// VoxelLighting.glsl 提供，而本文件的 include 顺序里它晚于 shadow/Common.glsl。
float ShadowWarpImportanceAt(in vec3 worldPos, in vec3 worldNormal, in vec3 viewPos) {
    vec3 shadowClipPos = projMAD(shadowProjection, transMAD(shadowModelView, worldPos));
    if (!all(lessThan(abs(shadowClipPos.xy), vec2(1.0)))) return 0.0;

    float viewDist = length(viewPos);
    float distWeight = 1.0 / (pow(max(viewDist, 1.0), RTWSM_DIST_FACTOR) * 0.1 + 1.0);
    float facing = 1.0 + RTWSM_FACING_FACTOR * saturate(dot(worldNormal, -normalize(viewPos)));

    // [2026-09] 体素平铺条带的横向权重下限。
    // 开着体素化时阴影图**左侧一条 256 纹素宽的竖条**被体素立方体平铺占用（见
    // lib/lighting/VoxelLighting.glsl 的 VOXEL_TILE_* 与 ShiftShadowScreenPos），而 warp 是
    // 逐轴 CDF —— x 轴分不清"左边这条是体素条带、右边才是真阴影"，内容驱动的重分配会把它当成
    // 一块低重要性区域一路压缩，把体素几何挤成几个纹素宽（体素 GI 的太阳阴影会花掉）。
    // 所以对落在条带内的 x 给一个**下限比例**（0.6 = 明显低于该轴平均，但仍分得到分辨率），
    // 并且用渐变而不是阶跃：阶跃会在 bin 级产生一道密度跳变，正是 warp 条纹的来源。
    // 判据与 ShiftShadowScreenPos 同一套式子：screenX = (u·0.5 + 0.5)·RATIO + 1 − RATIO，
    // 体素条带 = screenX < RATIO，反解出 u < 2·(2·RATIO − 1)/RATIO = voxelTileEdgeClip。
    // y 轴不受影响（体素条带是竖向的，只占 x 的一小段）。
    float voxelTileWeight = 1.0;
    #ifdef ENABLE_VOXELIZATION
        // 分母 max(…, 1e-6)：分辨率被调到体素条带几乎吃满整幅阴影图时，这个边界会跑到 0 附近
        // （极端情况下 RATIO ≤ 0.5 时更会变负，该档位按 VoxelLighting 的注释本就不该用），
        // 夹一下保证权重是 [0.6, 1] 的单调渐变而不是乱掉。
        float voxelTileEdgeClip = 2.0 * (2.0 * VOXEL_SHADOW_RATIO - 1.0) / VOXEL_SHADOW_RATIO;
        voxelTileWeight = max(SHADOW_WARP_VOXEL_WEIGHT, clamp(shadowClipPos.x / max(voxelTileEdgeClip, 1e-6), 0.0, 1.0));
    #endif

    return distWeight * facing * voxelTileWeight;
}

//======// Main //================================================================================//
void main() {
    
    ivec2 texelPos = ivec2(gl_FragCoord.xy);
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;

    // [2026-09] RTWSM 重要性测量已移到下面（法线取到之后、天空分支之后），见那里的说明。

    vec3 screenPos = vec3(screenCoord, loadDepth0(texelPos));

    #if defined LOD_MOD
        bool lodMask = screenPos.z > 1.0 - EPS;
        if (lodMask) {
            screenPos.z = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth0Lod(texelPos)));
        }
    #endif

    if (screenPos.z < 0.56) {
        screenPos.z = screenPos.z * INV_HAND_DEPTH + HAND_DEPTH_OFFSET;
    }

    vec3 viewPos = ScreenToViewPos(screenPos);
    vec3 worldPos = mat3(gbufferModelViewInverse) * viewPos;
    // 相机相对世界坐标备份：L224 会把 worldPos 改成绝对坐标，但 gbufferModelViewInverse
    // 不含相机平移（Terrain.vert L98 证据），L224 加的不是 cameraPosition，其后 worldPos
    // 并非真正的绝对坐标——GI 查询/追踪/调试一律用本备份（确定正确的相机相对），
    // 不要再做 worldPos - cameraPosition（双重减 → 全越界 → GI 恒 0/全红诊断）。
    vec3 camRelPos = worldPos;
    vec3 worldDir = normalize(worldPos);

    // [2026-08-09] 原版方块光颜色（BLOCKLIGHT_COLOR_R/G/B）策略：
    // - 光追关闭：按玩家设置正常工作；
    // - 光追开启：体素网格内强制 0（原版方块光关闭，由体素 GI 提供方块光），
    //   网格外强制默认颜色 RGB=1（亮度保留玩家设置）——无 GI 数据的区域
    //   以非光追样式渲染。
    vec3 activeBlocklightColor = blocklightColor;
    // 是否位于体素网格内（网格内由 GI 提供方块光；网格外走原版方块光）
    bool blocklightInVoxelGrid = false;
    #ifdef GI_ACTIVE_VXGI
        vec3 blocklightVoxelCoord = camRelPos + cameraPositionFract + float(VOXEL_RADIUS);
        blocklightInVoxelGrid = all(greaterThanEqual(blocklightVoxelCoord, vec3(0.0))) && all(lessThan(blocklightVoxelCoord, vec3(float(VOXEL_AREA))));
        if (blocklightInVoxelGrid) {
            activeBlocklightColor = vec3(0.0);
        } else {
            activeBlocklightColor = vec3(BLOCKLIGHT_BRIGHTNESS);
        }
    #endif

    uvec4 materialPack = loadMaterialPack(texelPos);
    uint materialID = materialPack.y;
    vec3 albedo = sRGBToLinear(loadAlbedo(texelPos));
    float dither = BlueNoise(texelPos, frameCounter);

    sceneOut = vec3(0.0);
    #ifdef SUBSURFACE_SCATTERING_DIFFUSION
        // [2026-09] SSS 源项：由 main() 末尾（或天空分支）写进半分辨率 colortex18，
        // 每个 2x2 全分辨率块只写一次（见末尾的守卫说明）。非 SSS 像素写全 0，
        // 否则半分辨率纹素会保留上一帧的陈旧值，既被模糊卷进来，也污染中心 mask 门控。
        vec4 sssSourceOut = vec4(0.0);
    #endif

    // ========== Sky ==========
    if (materialID == 0u) {
        vec3 transmittance = AtmosphereTransmittanceToPoint(atmosphereViewPos, worldDir);
        vec3 skyRadiance = AtmosphereSkyView(atmosphereViewPos, worldDir, worldSunDir);
        sceneOut = skyRadiance;

        #ifdef CLOUDS
            #ifdef CLOUD_TAAU_ENABLED
                vec4 cloudData = texture(cloudReconstructTex, screenCoord);
            #else
                screenCoord += viewPixelSize * (dither - 0.5);
                vec4 cloudData = texture(cloudOriginTex, screenCoord);
            #endif
            CompositeClouds(sceneOut, cloudData, worldDir);
            transmittance *= cloudData.w;
        #endif

        if (dot(transmittance, vec3(1.0)) > EPS) {
            vec3 celestial = RenderSun(worldDir, worldSunDir);
            vec3 vanillaMoon = albedo * MOON_BRIGHTNESS_MULTIPLIER;   // 月光亮度控制
            #ifdef GALAXY
                celestial += mix(RenderGalaxy(worldDir), vanillaMoon, step(0.06, vanillaMoon.g));
            #else
                celestial += mix(RenderStars(worldDir), vanillaMoon, step(0.06, vanillaMoon.g));
            #endif
            sceneOut += celestial * transmittance;
        }
        imageStore(colorimg7, texelPos, uvec4(0));
        #ifdef SUBSURFACE_SCATTERING_DIFFUSION
            // 天空没有 SSS：必须写 0，不能留着陈旧值（同 main() 末尾的守卫：每 2x2 块只写一次）
            if (((texelPos.x & 1) == 0) && ((texelPos.y & 1) == 0)) {
                imageStore(colorimg18, texelPos >> 1, vec4(0.0));
            }
        #endif
        return;
    }

    // ========== Geometry ==========
    worldPos += gbufferModelViewInverse[3].xyz;
    vec3 geoNormal, worldNormal;
    FetchNormalData(texelPos, geoNormal, worldNormal);
    vec3 viewNormal = mat3(gbufferModelView) * worldNormal;
    vec2 lightmap = Unpack2x8U(materialPack.x);

    #if defined MC_SPECULAR_MAP
        vec4 specularTex = ExtractSpecularTex(materialPack);
    #else
        vec4 specularTex = vec4(0.0);
    #endif

    #ifdef RAIN_PUDDLES
        if (wetnessCustom > EPS) {
            if (materialID < 1000u || materialID > 1002u) {
                CalculateRainPuddles(albedo, worldNormal, specularTex.rgb, worldPos, geoNormal, lightmap.y);
                materialPack.z = Packup2x8U(specularTex.xy);
                imageStore(colorimg7, texelPos, materialPack);
            }
        }
    #endif

    Material material = GetMaterialData(specularTex);

    #ifdef SHADOW_WARP_RTWSM
        // ===== RTWSM 重要性测量 =====
        // 式子见上面的 ShadowWarpImportanceAt；这里只负责量化 + 逐 bin 取最大值。
        // 具体取哪个 bin：未平移、未形变的 shadow clip 空间（表就是按这个空间定义的）。
        if (materialID != 0u) {
            float importance = ShadowWarpImportanceAt(worldPos, worldNormal, viewPos);

            if (importance > 0.0) {
                vec3 shadowClipPos = projMAD(shadowProjection, transMAD(shadowModelView, worldPos));
                vec2 binF = clamp(shadowClipPos.xy * 0.5 + 0.5, 0.0, 1.0) * float(RTWSM_HIST_SIZE);
                ivec2 binXY = clamp(ivec2(binF), ivec2(0), ivec2(int(RTWSM_HIST_SIZE) - 1));
                uint quant = uint(importance * RTWSM_IMPORTANCE_SCALE);
                // [2026-09 修正 B] **取最大值，不是累加**：
                //   累加 = "落在该 bin 的屏幕像素数 × 平均权重"。而屏幕像素密度 ∝ 1/视距²、
                //   权重本身又 ∝ 1/视距^1.3 ⇒ bin 计数 ∝ 1/视距^3.3。实测（rdc_analysis/
                //   rtwsm_measure.py，1920x1080 平地对 128 宽的阴影 frustum）：近处 bin 收到
                //   约 22 万权重、远处 bin 约 0.03，跨度 1e4 以上。归一化再 clamp 到 [0.25,4]
                //   之后，**除了中心几个 bin 全是下限平台** ⇒ 内容信号被夹成平的 ⇒ 调高
                //   RTWSM_CONTENT_STRENGTH 看不出任何区别（用户实测"和 0 没区别"）。
                //   取 max 后 bin 值 = "这条切片上最需要分辨率的地方有多需要"，与采样密度无关，
                //   跨度只有几倍到几十倍（这才是可直接当密度比用的量）。
                //   量化成整数后用整数 imageAtomicMax（importance 恒 ≥ 0，正整数保序）。
                imageAtomicMax(shadowWarpHistImg, ivec2(binXY.x, 0), quant);
                imageAtomicMax(shadowWarpHistImg, ivec2(binXY.y, 1), quant);
            }
        }
    #endif

    float sssAmount = 0.0;
    
    // --- SSS ---
    #if SHADOW_SOFT_TYPE > 0
        #if SUBSURFACE_SCATTERING_MODE < 2
            switch (materialID) {
                case 1000u: case 1001u: case 1002u: case 1003u: case 27u: case 28u: sssAmount = 0.6; break;
                case 13u: sssAmount = 0.8; break;
                case 37u: case 39u: sssAmount = 0.5; break;
                case 38u: case 51u: sssAmount = 0.8; break;
                case 40u: sssAmount = 0.3; break;
            }
        #endif
        #if TEXTURE_FORMAT == 0 && SUBSURFACE_SCATTERING_MODE > 0 && defined MC_SPECULAR_MAP
            if (specularTex.b > 64.5 / 255.0) sssAmount = max(sssAmount, specularTex.b);
        #endif

        sssAmount = linearstep(64.0 / 255.0, 1.0, sssAmount) * eyeSkylightSmooth * SUBSURFACE_SCATTERING_STRENGTH;
    #endif

    // --- Optimized Direct Light & Shadow Calculation ---
    // 白天：天光按 lightmap 平滑门控（0.02 → 0.2），修复半透光室内主阴影/SSS 泄漏；
    // 夜晚：保留原逻辑（月亮阴影依赖原判定，不受影响）。
    float sunlightFactor = mix(
        saturate(lightmap.y * 1e6 + float(isEyeInWater)),
        saturate(smoothstep(0.02, 0.2, lightmap.y) + float(isEyeInWater)),
        step(0.0, worldSunDir.y)
    );
    // [2026-09-04 夜晚整体亮度] 夜晚系数：深夜=1、白天=0（世界太阳高度）。供下面月光/环境光共用。
    float nightAmt = 1.0 - smoothstep(-0.10, 0.00, worldSunDir.y);

    vec3 sunlightBase = vec3(0.0);
    float cloudShadow = 1.0;

    if (sunlightFactor > EPS) {
        #ifdef CLOUD_SHADOWS
            vec2 cloudShadowCoord = WorldToCloudShadowScreenPos(worldPos).xy + (dither - 0.5) / textureSize(cloudShadowTex, 0);
            cloudShadow = textureBicubic(cloudShadowTex, saturate(cloudShadowCoord)).x;
        #else
            cloudShadow = 1.0 - wetness * 0.96;
        #endif
        
        // ---------- 末地夜晚直接光（淡紫色、更暗）----------
        #ifdef DIMENSION_THE_END
            const vec3 nightDirectTint = vec3(0.75, 0.45, 0.80);
            const float nightDirectScale = 0.20; // 更暗
            sunlightBase = cloudShadow * sunlightFactor * global.directIlluminance * nightDirectTint * nightDirectScale;
        #else
            sunlightBase = cloudShadow * sunlightFactor * global.directIlluminance;
        #endif
    }
    sunlightBase *= SUN_BRIGHTNESS_MULTIPLIER; // 阳光亮度控制
    // [2026-09-04] 夜晚亮度：把 NIGHT_BRIGHTNESS 也作用到月光/直射（跟着月光一起亮）。
    // 白天(nightAmt=0)不变；可单独用 MOON_BRIGHTNESS_MULTIPLIER 调月面本身。
    sunlightBase *= mix(1.0, NIGHT_BRIGHTNESS, nightAmt);

    vec3 specularDirect = vec3(0.0);
    float worldDistSquared = sdot(worldPos);
    
    float distXZSq = dot(worldPos.xz, worldPos.xz);
    float distanceFade = linearstep(shadowDistance - 8.0, shadowDistance, approxSqrt(distXZSq));
    #if defined LOD_MOD
        distanceFade = saturate(distanceFade + float(lodMask));
    #endif

    float NdotL = saturate(dot(worldNormal, worldLightDir));

    // [2026-09 SSS] 两套模型共用的输入，在这里就地取出（见下方 SSS 段）：
    //   sssFrontVisibility = 正面阴影可见性（= 旧版的 sssMask）
    //   sssBackVisibility  = 沿光线方向跨过物体后的可见性（新版薄片背光透光用）
    //   sssContactShadow   = 屏幕空间接触阴影（只给旧版模型用；新版已与它解耦）
    //   sssBlockerDepth    = PCSS 的 blocker 深度（只给旧版模型的厚度项用；PCF 模式下恒为 0）
    float sssFrontVisibility = 0.0;
    float sssBackVisibility = 0.0;
    float sssContactShadow = 1.0;
    float sssBlockerDepth = 0.0;

    if (sunlightFactor > EPS && (NdotL + sssAmount > EPS)) {
        vec3 shadow = vec3(NdotL);
        // surfaceDepth 现在只作为 CalculatePCSS 的 blocker 深度输出（SHADOW_SOFT_TYPE==2 时
        // 决定 PCSS 搜索半径）；它不再是 SSS 的厚度——那是旧实现里恒为 0 的 bug。
        float surfaceDepth = 0.0;
        float normalOffsetBase = (approxSqrt(worldDistSquared) * 2e-3 + 2e-2) * (2.0 - NdotL);
        
        vec3 rawShadow = vec3(1.0);

        if (distanceFade < EPS) {
            rawShadow = CalculatePCSS(worldPos, geoNormal * normalOffsetBase, dither, surfaceDepth);
            sssBlockerDepth = surfaceDepth;   // 旧版 SSS 的厚度项（PCF 模式下为 0）
            
            #if SHADOW_SOFT_TYPE == 1
                shadow *= pow(rawShadow, vec3(SHADOW_CONTRAST_STRENGTH));
                shadow = smoothstep(-0.01, 1.01, shadow);
            #else
                shadow *= rawShadow;
            #endif
        }

        #ifdef SCREEN_SPACE_SHADOWS
            float contactShadow = 1.0;
            // [优化 2026-09-05 深阴影早退]（[2026-09 更新] contactShadow 的消费者有两处：
            //   ① 直接光 shadow *= contactShadow；② 旧版 SSS 模型 sss *= mix(1, contactShadow, ...)。
            //   两者都以「该像素不是深阴影」为前提，所以这个早退依旧成立。）
            //   直接光那条以 dot(shadow)>EPS 为门槛，深阴影内 shadow≈0 → contactShadow 乘不乘都一样。
            // 故阴影贴图平均亮度 < 0.01 的像素，contactShadow 对最终输出无可感知影响（最坏情形
            // PCF 平滑半影残留 ~3% 阳光的像素少乘一次 ≤1 的接触值，偏差 <1.5% 阳光），
            // 整段屏幕空间步进（约 SCREEN_SPACE_SHADOWS_SAMPLES 次深度采样/像素）可安全跳过。
            // 距离过渡区/阴影贴图外（distanceFade>0，rawShadow 恒 1）不受影响，保持原步进。
            if (dot(rawShadow, vec3(1.0)) >= 0.03) {   // 平均亮度 ≥ 0.01 才需要接触阴影
                #if SUBSURFACE_SCATTERING_MODEL == 0
                    // [2026-09] 旧版模型：还原原有耦合 —— 把 sssAmount 作为步进吸收系数
                    // （Render.glsl 的 absorption = exp2(-0.125 / (viewDistInv * sssAmount))），
                    // 于是 SSS 材质的接触阴影更软、非 SSS 材质（sssAmount=0）仍是硬遮挡。
                    // 副作用同样还原：SSS 强度选项会改变接触阴影外观，且低采样时的条带会
                    // 通过 sss *= mix(1, contactShadow, ...) 传到草/藤的 SSS 上。
                    contactShadow = ScreenSpaceShadow(screenPos, viewPos + viewNormal * normalOffsetBase, dither, sssAmount);
                #else
                    // 重写版模型：保持解耦（传 0.0）——接触阴影只由它自己的采样决定，
                    // SSS 选项不再影响它，SSS 也不再消费它。
                    contactShadow = ScreenSpaceShadow(screenPos, viewPos + viewNormal * normalOffsetBase, dither, 0.0);
                #endif
            }
            sssContactShadow = contactShadow;   // 旧版 SSS 模型会用它（见下方 SSS 段）
        #else
            const float contactShadow = 1.0;
        #endif

        // [2026-09 SSS 重构] 这里只取可见性，SSS 本体在环境光之后计算（需要 ambientAccum）。
        // 旧的 LdotV（只被 SSS 相位项使用）随重构删除。
        sssFrontVisibility = saturate(dot(rawShadow, vec3(0.3333)));

        // 薄片（树叶/草/藤）的背光可见性：沿光线方向跨过物体本身再采一次阴影贴图。
        // 用单次纹理查找而不是整套 PCF：这一项只是透光的软门控；在树叶密集的森林场景里
        // 保持 PCF 会成倍放大阴影开销。
        // [2026-09] 只有背光透光项打开时才需要它（该项默认 0 = 关），所以用宏条件直接编译掉，
        // 关掉时这里零开销。
        float sssThickness = GetSubsurfaceThickness(materialID);
        if (SUBSURFACE_SCATTERING_TRANSMISSION > EPS && sssThickness > 0.0 && sssThickness < SSS_THIN_CUTOFF) {
            vec3 backPos = worldPos + worldLightDir * GetSubsurfaceBackSampleOffset(materialID);
            float backDistortion;
            vec3 backScreenPos = WorldToShadowScreenSpace(backPos + geoNormal * normalOffsetBase, backDistortion);
            backScreenPos.z -= 3e-8 * (1.0 + dither) * shadowProjInv1y * backDistortion * SHADOW_BIAS_STRENGTH;
            sssBackVisibility = 1.0;
            if (saturate(backScreenPos) == backScreenPos) {
                // shadowtex1 在 shadowHardwareFiltering1 = true 时是 sampler2DShadow（见 config.glsl），
                // 只能做硬件深度比较（textureLod 的 vec3 形式），不能对 shadow sampler 用 texelFetch。
                // 返回 1.0 = 该点未被遮挡（与 lib/lighting/shadow/Render.glsl 的用法一致）。
                sssBackVisibility = textureLod(shadowtex1, vec3(backScreenPos.xy, backScreenPos.z), 0).x;
            }
        }

        if (dot(shadow, vec3(1.0)) > EPS) {
            // ---------- 夜间阴影增强 ----------
            // [2026-09-10 性能] isNight 是 step() 的结果（恒 0 或 1），旧式 pow(shadow,
            // mix(1.0, NIGHT_SHADOW_BOOST, isNight)) 在白天指数精确为 1.0 → pow(x,1.0) 是恒等变换，
            // 每个受光像素白付 3 次 pow（SFU 吞吐 1/4）。worldSunDir 是 uniform → 无 warp 分歧。
            float isNight = step(0.0, -worldSunDir.y);
            if (isNight > 0.5) shadow = pow(shadow, vec3(NIGHT_SHADOW_BOOST));

            shadow *= contactShadow * sunlightBase;
            #ifdef PARALLAX_SHADOW
                #if defined PARALLAX && !defined PARALLAX_DEPTH_WRITE
                    shadow *= oms(loadSceneMain(texelPos).x);
                #endif
            #endif

            vec3 halfway = normalize(worldLightDir - worldDir);
            float NdotV = abs(dot(worldNormal, worldDir)), NdotH = dot(worldNormal, halfway), LdotH = dot(worldLightDir, halfway);
            sceneOut += shadow * DiffuseBurley(LdotH, NdotV, NdotL, material.roughness);

            #if defined MC_SPECULAR_MAP
                vec3 f0 = GetMaterialF0(material.metalness, albedo);
            #else
                const vec3 f0 = vec3(DEFAULT_DIELECTRIC_F0);
            #endif
            specularDirect = shadow * SpecularGGX(LdotH, NdotV, NdotL, NdotH, material.roughness, f0);
            specularDirect *= SPECULAR_BLOOM_BOOST;
        }
    }

    // ====== Ambient Occlusion ======
    #if AO_ENABLED > 0 && !defined GI_ACTIVE_SSILVB
        float aoVal = 1.0;
        #if AO_ENABLED == 1
            aoVal = CalculateSSAO(screenCoord, viewPos, viewNormal, SampleStbnUnitvec2(texelPos, frameCounter));
        #else
            aoVal = CalculateGTAO(screenCoord, viewPos, viewNormal, SampleStbnVec2(texelPos, frameCounter));
        #endif
        
        vec3 ao;
        #ifdef AO_MULTI_BOUNCE
            ao = ApproxMultiBounce(aoVal, albedo);
        #else
            ao = vec3(aoVal);
        #endif
    #else
        const vec3 ao = vec3(1.0);
    #endif

    // ====== 末地 / 地狱跳过补偿逻辑 ======
    #ifdef DIMENSION_THE_END
        #undef COMPENSATION_ENABLED
    #endif
    #ifdef DIMENSION_NETHER
        #undef COMPENSATION_ENABLED
    #endif

    // ====== 补偿逻辑 ======
    float activeMinAmbient = MINIMUM_AMBIENT_BRIGHTNESS;
    float compensationAlpha = 0.0;

        #ifdef COMPENSATION_ENABLED
        if (texelPos == ivec2(0,0)) {
            bool skyVisible = false;
            const int grid = 4;
            for (int gy = 0; gy < grid && !skyVisible; gy++) {
                for (int gx = 0; gx < grid; gx++) {
                    vec2 uv = (vec2(gx, gy) + 0.5) / float(grid);
                    ivec2 sampleTexel = ivec2(uv * viewSize);
                    uint sampleMaterial = texelFetch(colortex7, sampleTexel, 0).y;
                    if (sampleMaterial == 0u) {
                        skyVisible = true;
                        break;
                    }
                }
            }

            float currentTime = frameTimeCounter;
            float lastTime = global.lastSkyTime;
            float alpha = global.compensationAlpha;

            // 夜晚关闭补偿：太阳在地平线下时 worldSunDir.y < 0，强制 alpha = 0
            float isNight = step(0.0, -worldSunDir.y);
            if (isNight > 0.5) {
                alpha = 0.0;
            } else {
                if (skyVisible) {
                    lastTime = currentTime;
                    alpha = clamp(alpha + COMPENSATION_FADE_SPEED * frameTime, 0.0, 1.0);
                } else {
                    if (currentTime - lastTime > COMPENSATION_DELAY) {
                        alpha = clamp(alpha - COMPENSATION_FADE_SPEED * frameTime, 0.0, 1.0);
                    }
                }
            }

            global.compensationAlpha = alpha;
            global.lastSkyTime = lastTime;
        }

        compensationAlpha = global.compensationAlpha;
        activeMinAmbient = MINIMUM_AMBIENT_BRIGHTNESS + COMPENSATION_BOOST * compensationAlpha;
    #endif

    // 环境光累积
    vec3 ambientAccum = vec3((worldNormal.y * 0.4 + 0.6) * max(activeMinAmbient, 5e-3 * nightVision));
    // [2026-09-03 SH 缓存复用] 网格内(L528)与网格外(L561)两处均以相同参数
    // (global.skySH, worldNormal) 调用 ConvolvedReconstructSH3。网格边缘像素
    // (voxelEdgeBlend>0 且 ambInVoxelGrid) 会同时命中两处 → 同像素重复重建 9 项 SH。
    // 提到此处一次计算，两处共用；无分支触发时仅多一次轻量重建，零画面影响。
    vec3 skySHIrradiance = ConvolvedReconstructSH3(global.skySH, worldNormal);
    // [2026-08-20 修复"傍晚背光侧方块底面冒光"] 朝下面几乎不收无向最小环境底光：
    // 原式对底面(worldNormal.y≈-1)仍给 0.2×activeMinAmbient 灰白底，傍晚再被夕阳 tint
    // 染成暖橙，在暗的背光侧异常扎眼。法线 y<0 时把这份底光渐进去除（一 0→-0.15 过渡），
    // 顶/侧/水平面保持原状，不碰夜视窄差底光。
    // [2026-08-21 洞穴死黑修复] 上述朝下抹除仅在"有天空光"时生效——关闭 VOXEL_GI 后
    // 洞穴内（lightmap≈0）环境光只剩 activeMinAmbient 底光，若朝下面也被抹掉就全黑
    //（用户实测：朝下死黑、其他面偏亮）。用 skyPresence 门控：洞穴保留底光、户外才抹除。
    float downFade = mix(1.0, 0.0, smoothstep(0.0, -0.15, worldNormal.y));
    // [2026-09-04 修"夜晚朝下很暗"] skyPresence 原只用 lightmap.y——夜里月光(≥0.2)也判成"有天空"
    // → downFade 把朝下环境光乘 0，叠加夜里天空 SH 对下方向≈0 → 朝下几乎黑。加阳光门控：
    // 仅白天(太阳在地平线附近/之上)才算"有天空"触发下向抹除；深夜 sun<0.1 → 0 → 朝下保留底光。
    float skyPresence = saturate(lightmap.y * 5.0) * saturate(worldSunDir.y * 10.0 + 1.0);
    ambientAccum *= mix(1.0, downFade, skyPresence);

    // [2026-08-18 网格边缘过渡] 网格外环境光平滑过渡进网格内几格：
    // 新方块进入 64³ 范围时，从"网格外 SH 环境光"瞬间切到"网格内 GI"，
    // 且 GI 是新暴露种子（暗）→ 边缘暗→亮的跳变（用户实测）。在网格内
    // 边缘 VOXEL_EDGE_BLEND_DISTANCE 格内，按到网格表面的距离渐进混入
    // 网格外的 SH 环境光（与非光追同款），外部光→内部 GI 平滑过渡。
    // voxelEdgeBlend：1=紧贴网格表面（全 SH 混合），0=深入网格
    // VOXEL_EDGE_BLEND_DISTANCE 格后（纯 GI，SH 完全淡出，不干扰内部方向性天光）。
    // [FIX 2026-08-18 关光追无环境光] 默认值必须是 1.0：关闭 GI_ACTIVE_VXGI
    // 时走到 #else（ambientInVoxelGrid=false），SH 环境光乘 voxelEdgeBlend——
    // 若默认 0 会把 SH 全乘 0 → 整个世界没环境光（用户实测）。
    // GI_ACTIVE_VXGI 开启时由下方分支按网格内外覆盖为正确值。
    float voxelEdgeBlend = 1.0;

    // 体素 GI(VXGI) 开启时：网格内由光追天光（skyMapTex 方向辐射）提供环境光，
    // 屏蔽原版 SH 平涂天光，避免方向性天光被环境光盖掉；体素外仍走非光追样式。
    // [2026-09-04 IRC_GI] IRC 逐格 GI 只出阳光+方块光（见 DiffuseIndirect 用天空曝光度门控），
    // **不**屏蔽 SH —— 天空/环境光仍由完整方向性 SH 提供。故此处仅 VOXEL_GI 走"网格内屏蔽 SH"分支。
    #ifdef GI_ACTIVE_VXGI
        vec3 ambientVoxelCoord = camRelPos + cameraPositionFract + float(VOXEL_RADIUS);
        bool ambientInVoxelGrid = all(greaterThanEqual(ambientVoxelCoord, vec3(0.0)))
                               && all(lessThan(ambientVoxelCoord, vec3(float(VOXEL_AREA))));
        // 网格内完全交给 GI（含最小环境光底）：否则平铺底光会把
        // 窗口逸散/遮挡 AO 的梯度盖成“死板固定亮度”（用户实测反馈）。
        // 仅保留夜视底光，避免夜视失效。
        // [2026-08-18] 最小环境光由 MINIMUM_AMBIENT_BRIGHTNESS 宏统一控制
        // （activeMinAmbient，法线权重与夜视同初始值），不再用 skyColor×lightmap
        // 硬编码保底——后者会绕过玩家滑条且与 GI 平涂冲突。
        if (ambientInVoxelGrid) {
            // [2026-08-19 光追模式网格内屏蔽原版环境光] 主世界/末地：环境光交给光追 GI(voxelGI)，
            // 屏蔽 activeMinAmbient 最小环境底（原版光照，与 GI 重复/污染），仅留夜视底。
            // [2026-08-20 下界网格内保底] 下界无天空（worldId==-1 屏蔽 GI 天光），GI 只有
            // 方块光/发光体——离光源稍远处网格内会黑死。下界网格内保留 MINIMUM_AMBIENT_BRIGHTNESS
            // 最暗保底（activeMinAmbient 在此维度已不含 compensation），与网格外一致。
            // [2026-08-21 网格内 SH 混入] 恢复体素范围内 SH 球谐光做环境底：GI 天光是方向性的
            //（朝上/侧面亮、朝下 0），朝下表面只靠 GI 自反弹（距离有限）易死黑。加法混入
            // SH 全空间辐照度（含下半球，昼夜/方向自动），由 VOXEL_GI_SH_MIX 控制强度——
            // 默认 0.15 轻微补底不破坏 GI 方向性；调 0 完全屏蔽（旧行为）。
            #ifdef DIMENSION_NETHER
                ambientAccum = vec3((worldNormal.y * 0.4 + 0.6) * max(activeMinAmbient, 5e-3 * nightVision));
            #else
                float nightVisionFloor = 5e-3 * nightVision;
                ambientAccum = vec3((worldNormal.y * 0.4 + 0.6)) * nightVisionFloor;
            #endif
            #if VOXEL_GI_SH_MIX > 0.0
                // SH 全空间辐照度（含下半球）→ 朝下表面吃到环境光，随昼夜自动正确
                ambientAccum += skySHIrradiance * VOXEL_GI_SH_MIX;
            #endif
        } else {
            // 网格外：光追范围外无 GI 数据，MINIMUM_AMBIENT_BRIGHTNESS 作为全局最暗保底，
            // 不随 lightmap 门控被压灭。此前主世界网格外洞穴/无光处 lightmap.y≈0 时，
            // smoothstep 把底光乘成 0，调大 MINIMUM_AMBIENT_BRIGHTNESS 看似无效（8/20）。
            // 天空 SH 平涂的洞穴漏光仍由下方 SH 块自身的 lightmap.y 门控拦截，此处只保
            // 底光；默认保底极小（0.05×AMBIENT_BRIGHTNESS_MULTIPLIER），不会大面积点亮。
        }
        // 网格内边缘的过渡权重（网格外恒 1.0 全 SH）
        if (ambientInVoxelGrid) {
            vec3 edgeDist = min(ambientVoxelCoord, vec3(float(VOXEL_AREA)) - ambientVoxelCoord);
            float minEdgeDist = min(min(edgeDist.x, edgeDist.y), edgeDist.z);
            // [2026-08-19 夜晚亮暗生硬] 线性渐隐在"网格外 SH(亮) ↔ 网格内 GI(暗)"落差大时仍显硬切，
        // 改 smoothstep 平滑淡出（两端更缓）。仍硬就把 VOXEL_EDGE_BLEND_DISTANCE 调大。
        voxelEdgeBlend = 1.0 - smoothstep(0.0, VOXEL_EDGE_BLEND_DISTANCE, minEdgeDist);
        } else {
            voxelEdgeBlend = 1.0;
        }
    #else
        bool ambientInVoxelGrid = false;
    #endif

    #ifndef GI_ACTIVE_SSILVB
        // [2026-08-18] 抛弃"网格内 SH 阴影补足"：SH 平涂与 GI 方向天光双重计数，
        // 方块表面出现 z-fighting 感（用户实测）。网格内天光完全交给 GI（出界射线
        // 注入 IRC + 自反弹传播），SH 只在网格外按非光追样式渲染。最小环境光底
        // （ambientAccum 的 skyColor×lightmap 项）保留作安全网；IRC alpha 曝光
        // 计算保留但不消费（供后续天光方案复用）。
        // [2026-08-18] 边缘过渡：ambientInVoxelGrid 内的边缘区域（voxelEdgeBlend>0）
        // 也混入网格外同款 SH 环境光，权重随边缘距离渐隐——新方块进网格不再暗→亮跳变。
        if (lightmap.y > EPS && (!ambientInVoxelGrid || voxelEdgeBlend > 0.0)) {
            float lm3 = cube(lightmap.y);
            ambientAccum += skySHIrradiance * lm3 * voxelEdgeBlend;
            ambientAccum += CalculateFakeBouncedLight(worldNormal) * lm3 * (lightmap.y * lightmap.y) * sunlightBase * voxelEdgeBlend;
        }
    #endif

    // ---------- 末地夜晚环境光调整（淡紫色、更暗）----------
    #ifdef DIMENSION_THE_END
        const vec3 nightAmbientTint = vec3(0.65, 0.45, 0.70);
        const float nightAmbientScale = 0.25;
        ambientAccum *= nightAmbientTint * nightAmbientScale;
    #endif

    vec3 finalAo = ao;
    #ifdef COMPENSATION_ENABLED
        float localDarkness = 1.0 - saturate(lightmap.y * 5.0);
        float aoEnhanceWeight = compensationAlpha * localDarkness;
        finalAo = pow(finalAo, vec3(1.0 + COMPENSATION_AO_BOOST * aoEnhanceWeight));
    #endif

    // ---- 动态阳光色调混合（仅非末地维度） ----
    #ifndef DIMENSION_THE_END
        float timeBasedTint = saturate(worldSunDir.y * 2.5 - 0.15);
        float tintStrength = AMBIENT_SUNLIGHT_TINT_RATIO * timeBasedTint;
        if (tintStrength > 0.0) {
            vec3 sunColorTint = global.directIlluminance / max(luminance(global.directIlluminance), EPS);
            ambientAccum = mix(ambientAccum, ambientAccum * sunColorTint, tintStrength);
        }
    #endif

    // 应用环境光亮度与颜色控制（还原旧版：完整 AO，无 mix 门控，无额外 skySH 叠加）
    // [2026-09-04 修"夜晚整体偏暗 + NIGHT_BRIGHTNESS 宏没效果"] 该宏在两版都只是空定义（一直没接上）。
    // 已接到夜晚环境光(下方)与月光直射(上面 sunlightBase)。想更亮/更暗直接调 NIGHT_BRIGHTNESS（GUI MiscLighting）。
    sceneOut += ambientAccum * finalAo * AMBIENT_BRIGHTNESS_MULTIPLIER * AMBIENT_COLOR_TINT
              * mix(1.0, NIGHT_BRIGHTNESS, nightAmt);

    // ====== 次表面散射（SSS）======
    // [2026-09] 两套模型，由 GUI 选项 SUBSURFACE_SCATTERING_MODEL 选择：
    //   0 = 旧版（默认，还原 2026-09 之前的实现）：sigmaS × phase（相位 75% 各向同性）×
    //       阴影幂门控 × 接触阴影；厚度项用 PCSS 的 blockerDepth（PCF 模式下恒为 0）。
    //   1 = 重写版（备选）：见 lib/lighting/Subsurface.glsl —— 材质分类的真实厚度、
    //       天光/环境项、背光透光（默认关，视角相关）、与屏幕空间阴影解耦、不含相机方向。
    // 阴影距离外（rawShadow 恒 1，阴影贴图在最后 8 格起就停采）两版的处理不同：
    //   旧版：**不做任何亮度限制**（曾试过倍率与亮度上限，都因远处显得假而移除），
    //         亮度与距离无关，明暗完全交给屏幕空间接触阴影 —— 它在贴图停采的那一刻与直接光同刻接管。
    //   重写版：其太阳项按 sssSunGate = 1 - distanceFade 平滑淡出，只保留自带的天光项。
    #if SHADOW_SOFT_TYPE > 0
        #ifdef SSS_DISABLE_BEYOND_SHADOW_DIST
            bool sssAllowed = (distanceFade < EPS);
        #else
            bool sssAllowed = true;
        #endif
        float sssSunGate = 1.0 - distanceFade;   // 只被重写版使用

        if (sssAllowed && sssAmount > EPS) {
            #if SUBSURFACE_SCATTERING_MODEL == 0
                // ---------- 旧版模型 ----------
                // sunlightFactor 是原实现的外层门槛（夜晚/未受天光的像素本来就整段跳过）。
                // [2026-09 修正] 旧版整项都是太阳驱动的，直接按 (1 - distanceFade) 淡出会让
                // 阴影距离外**完全没有** SSS。正确做法是把太阳那份降级而不是清零：
                //   近处：完全等价于原实现（radiance = sunlightBase）
                //   远处：太阳 × SUBSURFACE_SCATTERING_FAR_SCALE + 环境辐照
                // 即"不知道远处有没有被遮挡 → 取部分受光的保守值"，远处仍有可见的次表面感。
                if (sunlightFactor > EPS) {
                    vec3 beta = approxSqrt(normalize(albedo));
                    vec3 sigmaA = oms(beta) * 16.0 / (sssAmount * SUBSURFACE_SCATTERING_STRENGTH);
                    vec3 sigmaS = 4.0 * beta * sssAmount;
                    float LdotV = dot(worldLightDir, -worldDir);
                    float phase = HenyeyGreensteinPhase(-LdotV, 0.7) * 0.25 + uniformPhase * 0.75;
                    vec3 sss = sigmaS * phase * exp2(-rLOG2 * sssBlockerDepth * (sigmaS + sigmaA));

                    #if SHADOW_SOFT_TYPE == 1
                        sss *= pow(sssFrontVisibility, SSS_CONTRAST_POW);
                    #endif

                    float cutout = float(clamp(materialID, 1000u, 1003u) == materialID || clamp(materialID, 27u, 28u) == materialID);

                    // "全亮"假设下的贡献（未乘接触阴影）
                    vec3 sssLit = sunlightBase * sss * SUBSURFACE_SCATTERING_BRIGHTNESS;

                    // [2026-09] 入射因子 —— 修正"阴影距离外靠近太阳时异常发亮、失去阴影"：
                    // 旧版 SSS 公式里没有 N·L（平加性项），阴影距离内是靠 pow(rawShadow, ...) 的
                    // 贴图门控替它遮挡自阴影的。但两件事叠加后它就露出来了：
                    //   ① 阴影距离外不再有贴图（rawShadow 恒 1，门控恒为 1）；
                    //   ② "视角朝太阳"这个几何会让屏幕空间阴影退化 —— ScreenSpaceShadow 里
                    //      rayDir = ViewToScreenPos(viewLightDir * |viewPos.z| + viewPos) - rayPos，
                    //      太阳方向接近视线方向时该点几乎与像素重合 → rayDir → 0，随后的
                    //      除法/逆平方根发散，接触阴影返回 1（当作无遮挡）。
                    // 结果：朝太阳看时可见面多为背光面（N·L < 0，直接光本就是黑的），
                    // 贴图没了、接触阴影又失效，平加性 SSS 于是拿到满强度 → 异常发亮。
                    // 这里只补"背光抑制"：N·L ≥ 0 时恒为 1，因此受光面/掠射面与原实现逐位一致；
                    // N·L 从 0 降到 -0.4 期间平滑压到 0，正好盖住上面那个失效区间。
                    float sssEntry = saturate(dot(worldNormal, worldLightDir) * 2.5 + 1.0);
                    sssLit *= sssEntry;

                    // ---- 暗部来源：与直接光**同刻**换挡 ----
                    // CalculatePCSS 只在 distanceFade < EPS 时执行，直接光就是在那一刻失去贴图阴影的；
                    // SSS 的暗部也在同一刻完全交给屏幕空间接触阴影：
                    //   贴图范围内：max(0, cutout × 0.75) = 原实现的权重（非 cutout 材质不乘接触阴影）
                    //   跨过那一刻：系数 1，从此由接触阴影充当暗部
                    // 注意这里是"同刻切换"而不是渐变 —— 渐变会留下"直接光已切换、SSS 还没切换"的空白带。
                    float sssContactMix = max(float(distanceFade >= EPS), cutout * 0.75);

                    // [2026-09 已移除] 阴影距离外的亮度限制（曾用 SUBSURFACE_SCATTERING_FAR_LIMIT 夹上限，
                    // 更早还用过 FAR_SCALE 乘倍率）。上限会让远处 SSS 变成一个与当地光照无关的固定亮度，
                    // 看起来假；去掉后远处亮度与距离无关，明暗完全由屏幕空间阴影提供（见上面的换挡）。
                    sceneOut += sssLit * mix(1.0, sssContactShadow, sssContactMix);
                }
            #else
                // ---------- 重写版模型 ----------
                // 天光项不受 sssSunGate 影响（距离外只保留它）
                vec3 sss = CalculateSubsurfaceScattering(
                    materialID, sssAmount, albedo, worldNormal,
                    -worldDir, worldLightDir, sunlightBase * sssSunGate,
                    sssFrontVisibility, sssBackVisibility, ambientAccum, finalAo);
                #ifdef SUBSURFACE_SCATTERING_DIFFUSION
                    // 交给 composite1/composite3 两趟可分离模糊，再由 IntegrateScene 软门控合成。
                    // rgb 已经乘过 sssAmount（= mask），a 单独存 mask 供合成端的中心门控使用。
                    sssSourceOut = vec4(sss, saturate(sssAmount));
                #else
                    sceneOut += sss * SUBSURFACE_SCATTERING_BRIGHTNESS;
                #endif
            #endif // SUBSURFACE_SCATTERING_MODEL
        }
    #endif

    // ====== Emissive & Blocklight ======
    #if EMISSIVE_MODE > 0 && defined MC_SPECULAR_MAP
        sceneOut += material.emissiveness * dot(albedo, vec3(0.75));
    #endif
    #if EMISSIVE_MODE < 2
        // [2026-08-09] 自发光基色与玩家方块光颜色解耦：blocklightColor 在光追开启时
        // 被置 0（屏蔽原版方块光），但发光方块自身的表面自发光（萤石/菌光体/火把等）
        // 必须保留——用默认白 × 亮度作基色，不受玩家红绿蓝设置影响。
        vec3 emissiveBaseColor = blocklightColor;
        #ifdef GI_ACTIVE_VXGI
            emissiveBaseColor = vec3(1.0) * BLOCKLIGHT_BRIGHTNESS;
        #endif
        vec4 emissive = HardCodeEmissive(materialID, albedo, worldPos, emissiveBaseColor);
        #ifndef GI_ACTIVE_SSILVB
            if (emissive.a * lightmap.x > EPS) {
                lightmap.x = CalculateBlocklightFalloff(lightmap.x);
                // 体素 GI 开启时：仅在网格内按 VOXEL_GI_BLENDED_LIGHTMAP 屏蔽/混合原版方块光。
                // 网格外无 GI 数据，原版方块光必须全量保留（否则 VOXEL_GI_BLENDED_LIGHTMAP=0
                // 会把网格外方块光一起灭掉 → "网格外连方块光都没有"）。
                #ifdef GI_ACTIVE_VXGI
                    if (blocklightInVoxelGrid) lightmap.x *= VOXEL_GI_BLENDED_LIGHTMAP;
                #endif
                if (lightmap.x > EPS) {
                    sceneOut += lightmap.x * emissive.a * mix(finalAo, vec3(1.0), lightmap.x) * activeBlocklightColor;
                }
            }
        #endif
        sceneOut += emissive.rgb * EMISSIVE_BRIGHTNESS;
    #elif !defined GI_ACTIVE_SSILVB
        lightmap.x = CalculateBlocklightFalloff(lightmap.x);
        // 仅在网格内屏蔽/混合原版方块光；网格外全量保留（同上方 EMISSIVE_MODE<2 分支）
        #ifdef GI_ACTIVE_VXGI
            if (blocklightInVoxelGrid) lightmap.x *= VOXEL_GI_BLENDED_LIGHTMAP;
        #endif
        sceneOut += lightmap.x * mix(finalAo, vec3(1.0), lightmap.x) * activeBlocklightColor;
    #endif

    #ifdef HANDHELD_LIGHTING
        if (heldBlockLightValue + heldBlockLightValue2 > EPS) {
            float attenuation = rcp(1.0 + worldDistSquared) * saturate(dot(worldNormal, -worldDir));
            // 手持光源（玩家手上光源）在所有维度/网格内外都生效，不受原版方块光屏蔽影响：
            // blocklightColor 在光追开启时被置 0（屏蔽原版方块光光晕），手持光需独立取
            // 玩家设置的方块光颜色，否则连手持灯一起熄灭（2026-08-20）。
            vec3 heldLightColor = vec3(BLOCKLIGHT_COLOR_R, BLOCKLIGHT_COLOR_G, BLOCKLIGHT_COLOR_B) * BLOCKLIGHT_BRIGHTNESS;
            sceneOut += max(heldBlockLightValue, heldBlockLightValue2) * HELD_LIGHT_BRIGHTNESS * attenuation * heldLightColor;
        }
    #endif

    sceneOut += LightningContribution(worldPos, worldNormal);

    #if defined GI_ACTIVE_SSILVB || defined PROBE_GI_ENABLED || defined GI_ACTIVE_IRC
        #ifndef GI_ACTIVE_VXGI  // 与体素 GI 互斥（体素优先）：两者共用 colortex3 信号源，避免重复叠加
            #ifdef SVGF_ENABLED
                #if defined PROBE_GI_ENABLED || defined GI_ACTIVE_IRC
                    // 探针/IRC GI：平滑低频缓存，免降噪——SVGF 链不跑（此时 VOXEL_GI 关），直接读裸信号
                    vec3 radiance = texelFetch(colortex3, texelPos >> 1, 0).rgb;
                #else
                    vec3 radiance = UpscaleDiffuseIndirect(texelPos, worldNormal, length(viewPos), abs(dot(worldNormal, worldDir)));
                #endif
            #else
                vec3 radiance = texelFetch(colortex3, texelPos >> 1, 0).rgb;
            #endif
            sceneOut += YCoCgToRGB(radiance);
        #endif
    #endif

    // Final composition
        // ====== 反射获取 ======
    vec4 reflection = vec4(0.0, 0.0, 0.0, FP16_MAX);
    bool isReflective = (material.metalness >= 0.5 || materialID == 10050u);
    bool reflectHit = false;
    if (isReflective) {
        reflection = CalculateSpecularReflections(material, materialID, worldNormal, screenPos, worldDir, viewPos, lightmap.y, dither);
        reflectHit = (reflection.a < FP16_MAX && any(greaterThan(reflection.rgb, vec3(0.0))));
    }

    // ====== 最终合成 ======
    if (reflectHit) {
        // 反射命中：反射与金属自身纹理混合，避免反射完全屏蔽纹理
        // sceneOut 已包含环境光/发光等累积，乘 albedo 即为带光照的纹理底色
        sceneOut = mix(sceneOut * albedo, reflection.rgb, REFLECTION_METAL_MIX);
    } else {
        // 反射未命中或非反射块：标准光照
        // 若为金属但无反射，当作非金属着色，使其获得正常漫反射亮度
        if (material.metalness >= 0.5) {
            material.metalness = 0.0;          // 强制转为非金属
            specularDirect = vec3(0.0);        // 去掉金属高光
        }
        sceneOut *= albedo;
        material.metalness *= 0.2 * lightmap.y + 0.8;
        sceneOut *= oms(material.metalness);
        sceneOut += specularDirect;
        
        // 体素 GI（彩色光源）
        #ifdef GI_ACTIVE_VXGI
            #ifdef DEBUG_VOXEL_RADIANCE
            // 单点诊断：整屏显示"玩家所在体素"（网格坐标恒为 VOXEL_RADIUS）的传播缓存，
            // 逐帧演化 = 时间混合/衰减的直观读数（只回答"缓存是否在衰减"这一个问题）。
            // R = 传播缓存（×100 原始值 ×0.5：nRC≈0.08 → 4 饱和红；≈0.004 → 0.2 暗红）
            // B = 天空曝光度 alpha（0-1，光追自算；蓝调越亮 = 该格可见天空程度越高）
            // 注意：查询坐标系 = 相机相对 + VOXEL_RADIUS（与体素化端一致）。
            // 本函数的 worldPos 在 L215 已被改成绝对坐标，此处不能用；
            // 玩家相机自身在网格中的坐标恒为 VOXEL_RADIUS，直接查询即可。
            // 增益 0.15（原 0.5 过早饱和，nRC≥0.02 就纯红，看不出变暗幅度）：
            // nRC≈0.08 → rad.r*0.15≈1.2 近饱和红；≈0.02 → 0.3 暗红；≈0.005 → 0.075 接近黑。
            // 判断标准：小幅抖动=IRC 随机噪声（正常）；持续跌到接近黑=系统性衰减（bug）。
            vec4 rad = FetchVoxelRadiance(ivec3(VOXEL_RADIUS));
            sceneOut = vec3(rad.r * 0.15, 0.0, rad.a * 0.6);
        #else
                // 主 GI = 每像素漫反射追踪（阶段④：追踪输出，IRC 仅作内部数据——
                // 注入循环 + 追踪命中自反弹种子）。
                // 追踪已迁到 DiffuseIndirect.comp：棋盘半分辨率每帧 1 SPP（1/4 像素），
                // 经 SVGF 时域累积 + 边缘保持滤波后在此读回；此处补乘 albedo×强度，
                // 与旧全分辨率路径（VoxelTracePixel × albedo × STRENGTH）视觉语义一致。
                vec3 voxelGI = vec3(0.0);
                #ifdef GI_ACTIVE_VXGI
                    #ifdef VOXEL_GI_DENOISE
                        #ifdef SVGF_ENABLED
                            // UpscaleDiffuseIndirect 返回 YCoCg 空间信号（colortex3 全链路 YCoCg），须显式转回 RGB
                            voxelGI = YCoCgToRGB(UpscaleDiffuseIndirect(texelPos, worldNormal, length(viewPos), abs(dot(worldNormal, worldDir))));
                        #else
                            voxelGI = YCoCgToRGB(texelFetch(colortex3, texelPos >> 1, 0).rgb);
                        #endif
                    #else
                        // 光追降噪关闭：直接读 colortex3 半分辨率棋盘信号（未降噪）
                        voxelGI = YCoCgToRGB(texelFetch(colortex3, texelPos >> 1, 0).rgb);
                    #endif
                    voxelGI *= albedo * VOXEL_GI_TRACE_STRENGTH;
                #endif
                #ifdef DEBUG_VOXEL_GI
                    // [2026-08-19] 调试：按像素所在体素直读 voxelID，定位"目标方块有没有进体素 + ID 对不对 + 在不在正确格"。
                    // 青绿 = 活板门(201/205)/门(155-158) 已体素化；橙 = 其他形状块(155-294) 已体素化；
                    // 黄 = 非形状固体(1-154，全块/发光/反光/水玻璃叶) 已体素化；蓝 = 该格无固体数据(<=0，空气/漏写)；
                    // 红 = 像素在 64³ 网格外。判读水平活板门：其表面应显青绿；显蓝(空)或黄(落成全块) = 没正确体素化(写端)。
                    sceneOut = sceneOut * 0.15;
                    // 沿表面几何法线向内偏移 0.05 格：采样点落在像素所在方块【内部】，而非
                    // 面边界（camRelPos 恰在格边界，ivec3 截断会在"自身格 / 邻接空气格"间
                    // 逐帧跳变 → 黄蓝疯狂闪烁）。偏移后稳定读到该方块自己的体素。
                    ivec3 dbgCoord = ivec3(camRelPos - geoNormal * 0.05 + cameraPositionFract + float(VOXEL_RADIUS));
                    if (all(greaterThanEqual(dbgCoord, ivec3(0))) && all(lessThan(dbgCoord, ivec3(VOXEL_AREA)))) {
                        float dbgVoxelID = texelFetch(voxelDataSampler, dbgCoord, 0).z;
                        if (dbgVoxelID >= 155.0 && dbgVoxelID <= 294.0) {
                            bool doorOrTrapdoor = (dbgVoxelID >= 155.0 && dbgVoxelID <= 158.0)
                                               || dbgVoxelID == 201.0 || dbgVoxelID == 205.0;
                            sceneOut = doorOrTrapdoor ? vec3(0.0, 1.0, 0.5) : vec3(1.0, 0.6, 0.0);
                        } else if (dbgVoxelID > 0.5) {
                            sceneOut = vec3(1.0, 1.0, 0.0);
                        } else {
                            sceneOut = vec3(0.0, 0.4, 1.0);
                        }
                    } else {
                        sceneOut = vec3(1.0, 0.0, 0.0);       // 红：dbgCoord 越界
                    }
                #else
                    sceneOut += voxelGI;
                    #ifdef DEBUG_VOXEL_SKY
                    // [2026-08-17] 左上角 64×64 灰阶读数：本像素 voxelGI 亮度（×4 放大，8 级量化）
                    if (all(lessThan(gl_FragCoord.xy, vec2(64.0)))) {
                        float luma = clamp(dot(voxelGI, vec3(0.299, 0.587, 0.114)) * 4.0, 0.0, 1.0);
                        sceneOut = vec3(floor(luma * 7.999) / 7.0);
                    }
                    #endif
                    #ifdef DEBUG_VOXEL_SKY_LEVEL
                    // [2026-08-18] 方块表面标记有 GI 天光的体素：IRC 天空曝光度
                    // （voxelRadiance alpha，0-1 = 出界射线占比，即天光可见度）超过
                    // 阈值 → 染红；无天光（洞穴/闭塞）→ 保持正常场景不覆盖。
                    // 阈值 0.1 = 只要有少量射线见天（曝光度>10%）即算有天光 → 红。
                    // 0.5 太高：普通方块(ID==1)注入走全方向采样，向上出界占比常
                    // 收敛在 0.2-0.4，会被误判为"无天光"（用户实测大部分位置不红）。
                    ivec3 dbgSkyCoord = ivec3(camRelPos + cameraPositionFract + float(VOXEL_RADIUS));
                    if (all(greaterThanEqual(dbgSkyCoord, ivec3(0))) && all(lessThan(dbgSkyCoord, ivec3(VOXEL_AREA)))) {
                        // 移动时按 cDi 重投影到上一帧缓存位置（与注入端 prevC=c+cDi 同口径），
                        // 避免红块随移动以格为单位偏移（用户实测）。
                        ivec3 dbgPrev = dbgSkyCoord + (cameraPositionInt - previousCameraPositionInt);
                        float skyLevel = (all(greaterThanEqual(dbgPrev, ivec3(0))) && all(lessThan(dbgPrev, ivec3(VOXEL_AREA))))
                                       ? FetchVoxelRadiance(dbgPrev).a : 0.0;   // 0-1 曝光，非 ×100 域
                        if (skyLevel > 0.1)
                            sceneOut = vec3(1.0, 0.0, 0.0);                  // 有天光 → 红
                    } else {
                        sceneOut = vec3(1.0, 1.0, 1.0);                      // 网格外白色提示
                    }
                    #endif
                #endif
            #endif
        #else
            // 体素 GI 未启用（GI_ACTIVE_VXGI 宏未注入本编译单元）：DEBUG 时品红提示
            #ifdef DEBUG_VOXEL_GI
                sceneOut = vec3(1.0, 0.0, 1.0);
            #endif
        #endif
    }

#ifdef DEBUG_SHADOW_WARP
    // [2026-09] 阴影 warp 可视化（RTWSM 骨架）：
    //   R/G = 变形后的 shadow clip xy（-1..1 映射到 0..1）
    //   B   = 局部缩放 / 4（越亮说明此处从阴影图分到的分辨率越高）
    // SHADOW_WARP_RTWSM 开/关各看一次，即可直接对比"表驱动可分离 warp"与"解析径向 warp"。
    {
        vec3 shadowClip = projMAD(shadowProjection, transMAD(shadowModelView, worldPos));
        vec3 warpedClip = DistortShadowSpace(shadowClip);
        sceneOut = vec3(warpedClip.xy * 0.5 + 0.5,
                        saturate(CalcDistortionFactor(shadowClip.xy) * 0.25));
    }
#endif

#ifdef DEBUG_SHADOW_WARP_DIFF
    // [2026-09] 骨架验证用：**表驱动 warp vs 解析径向 warp 的实际差异**。
    // 这个视图不依赖 SHADOW_WARP_RTWSM 开关（表由 setup12 每帧无条件填写、
    // ApplyShadowWarpTable / CalcAnalyticDistortionFactor 两者都始终可用），
    // 所以可以先把开关**关着**看它，确认表本身是对的，再去开 warp。
    //   R = |Δxy| / 0.02 clip   （0.02 clip ≈ 10 纹素 @1024；10 纹素 ≈ 0.4 满量程）
    //   G = 0.5 × 表侧局部缩放 / 解析侧因子   （0.5 灰 = 两者相等；越亮 = 表侧局部更"放大"）
    //   B = **表项无效标记**（NaN / 全 0 / 越界）：整屏发蓝 = 表没被写进来（setup12 没跑
    //       或没绑上），此时 ApplyShadowWarpTable 会走解析兜底，画面看不出异常。
    //       [2026-09] 判废区间已与填表端的夹紧区间对齐（见 Warp.glsl 的 WarpEntryInvalid）：
    //       此前校验比写入更严，k 一大就有大片**合法**表项被判废、整屏发蓝，而那正是当时
    //       阴影边缘错位的原因；所以"整屏蓝"现在是真的没写表，不再有假阳性。
    //   A = 逐 bin 表项里的**局部缩放**（×0.05：0.05→1.0 全亮 = 该 bin 分到最多分辨率）。
    //       与上面的 R/G 一起看，可以直接读出"分辨率被挪到哪里去了"。
    // 判据：R 沿两条坐标轴应接近 0（表就是在轴上取的解析曲线，只剩 float16 量化），
    //       越靠角点越亮 —— 可分离 warp 无法复现径向 warp 的角点压缩，这是该近似的固有下限。
    // 这里用**原始表项**（不经过兜底）来判断，才能看出表本身的状态。
    {
        vec3 shadowClip = projMAD(shadowProjection, transMAD(shadowModelView, worldPos));
        vec2 rawX = SampleShadowWarpTable(shadowClip.x, 0.25);
        vec2 rawY = SampleShadowWarpTable(shadowClip.y, 0.75);
        float tableBad = (WarpEntryInvalid(rawX) || WarpEntryInvalid(rawY)) ? 1.0 : 0.0;

        vec3 warp = ApplyShadowWarpTable(shadowClip.xy);
        float analyticFactor = CalcAnalyticDistortionFactor(shadowClip.xy);
        vec2 analyticWarp = shadowClip.xy * analyticFactor;

        float dispDiff = saturate(length(warp.xy - analyticWarp) / 0.02);
        float scaleRatio = saturate(0.5 * warp.z / max(analyticFactor, 1e-3));
        float tableScale = saturate(0.05 * max(rawX.y, rawY.y));
        sceneOut = vec4(vec3(dispDiff, scaleRatio, tableBad), tableScale);
    }
#endif

#ifdef DEBUG_PROBE_GI_VIZ
    // [调试 2026-09-03 探针格覆盖] 纯色覆盖图：绿=探针格内、红=格外。直接 YCoCgToRGB，
    // 不乘强度、不再做伽马(避免双重伽马把绿色压没)——保持覆盖色准。
    sceneOut = YCoCgToRGB(texelFetch(colortex3, texelPos >> 1, 0).rgb);
#endif

#ifdef SUBSURFACE_SCATTERING_DIFFUSION
    // [2026-09] 半分辨率 SSS 源项：只让每个 2x2 全分辨率块的**左上片元**（x、y 均为偶数）写。
    // 两个原因：
    //   ① 覆盖性：colortex18 不清除，必须每帧被完整覆盖；每块恰好有一个偶数片元，且它总会写
    //      （非 SSS / 天空写全 0），因此不留陈旧值。
    //   ② 确定性：若不守卫，同一块的 4 个片元会写同一纹素，最终写进哪个由硬件/光栅顺序决定，
    //      边界处（块内既有 SSS 又有非 SSS 像素）源项可能在帧间跳变。
    // 代价是源项按点采样取块内左上像素（随后就要被模糊，且合成端的中心 mask 是双线性读取，
    // 边界处会自动过渡），远小于竞态带来的闪烁风险。
    if (((texelPos.x & 1) == 0) && ((texelPos.y & 1) == 0)) {
        imageStore(colorimg18, texelPos >> 1, sssSourceOut);
    }
#endif

}
