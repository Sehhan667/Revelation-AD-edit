/*
--------------------------------------------------------------------------------
    Revelation Shaders – Screen Space Reflection & Sky Fallback
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.


    Added: Custom reflective block ID 10050 (no fallback).
    Metal fallback is now handled in the main deferred pass.
    Added: Selectable reflectivity criteria (metalness / roughness / both).
    Mode 2 now means "either metalness OR roughness" (not both).
    Added: NONMETAL_REFLECTION_BRIGHTNESS to boost non-metal reflections.
    Added: Non-metal materials now always skip sky reflection (only SSR).
    Added: Poisson-disk multi-sample Rough Reflections (8-tap, contact hardening, configurable steps & blur).
--------------------------------------------------------------------------------
*/

#include "/lib/surface/SSRT.glsl"

#ifndef METAL_SSR_MODE
    #define METAL_SSR_MODE 1 // [0 1 2]
#endif

// ====== 反射判定模式 ======
#ifndef METAL_REFLECT_MODE
    #define METAL_REFLECT_MODE 2   // [0 1 2]  0=仅金属度, 1=仅粗糙度, 2=金属度或粗糙度满足其一
#endif
#ifndef METALNESS_THRESHOLD
    #define METALNESS_THRESHOLD 0.1 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
#endif
#ifndef ROUGHNESS_THRESHOLD
    #define ROUGHNESS_THRESHOLD 0.1 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
#endif

// ====== 粗糙反射 (宏开关) ======
          // 开启粗糙反射
#ifndef ROUGH_REFLECTIONS_MAX
    #define ROUGH_REFLECTIONS_MAX 0.9 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0] 粗糙反射的最高界限
#endif
#ifndef ROUGH_REFLECTION_STEPS
    #define ROUGH_REFLECTION_STEPS 6 // [2 4 6 8 10 12 16 24 32] 单独设置粗糙物体的 SSR 追踪步数（较低即可）
#endif
#ifndef ROUGH_REFLECTION_BLUR_STRENGTH
    #define ROUGH_REFLECTION_BLUR_STRENGTH 20.0 // [0.2 0.5 0.8 1.0 1.2 1.5 2.0 3.0 10.0 20.0 30.0 40.0 50.0 60.0 80.0 100.0 150.0] 粗糙反射的模糊强度倍率
#endif
#ifndef ROUGH_REFLECTION_BLUR_SAMPLES
    #define ROUGH_REFLECTION_BLUR_SAMPLES 6 // [4 6 8 12 16 20 24 32] 粗糙反射的圆盘抽样数（越多"分界"越细、越平滑；性能开销线性增长）
#endif
// [2026-10-08] 环境光泽倍率：混合系数 = saturate(roughness × 本值)。
// 1.0 = 线性（roughness 0.5 的物体一半是屏幕空间模糊结果、一半是低阶环境光泽）；
// 2.0 ⇒ roughness ≥0.5 基本只剩"一片均匀光泽"（且这一档会跳过泊松多采样，零额外采样）；
// 0.0 = 只用屏幕空间模糊（想要"糊但仍能认出内容"时用）。
// 低阶环境 = ConvolvedReconstructSH3(global.skySH, N)（余弦卷积过的环境，天然低频），
// 并用 skylight 门控，室内不会被天光抬亮。
#ifndef ROUGH_REFLECTION_SHEEN
    #define ROUGH_REFLECTION_SHEEN 1.0 // [0.0 0.5 1.0 1.5 2.0 3.0] 环境光泽倍率（越大越糊成一片均匀光泽）
#endif
// [2026-10-08] 粗糙反射的**叶瓣方向采样数**：>1 时按 GGX 可见法线分布在一个像素内投 N 条射线、
// 把各自命中的颜色平均 —— 这是唯一能真正抹掉"反射物体轮廓"的办法（单条镜面射线的命中映射在
// 轮廓处是跳变的，源空间模糊抹不掉）。1 = 关闭，走旧的"单射线 + 源空间模糊"（与旧版逐位一致）。
#ifndef ROUGH_REFLECTION_DIR_SAMPLES
    #define ROUGH_REFLECTION_DIR_SAMPLES 1 // [1 2 4 8] 粗糙反射叶瓣方向采样数（越大轮廓越糊，代价是每像素 N 次追踪）
#endif
// [2026-10-08] 模糊中心"回拉量"（0 = 以命中点为中心【旧行为】；1 = 以本像素自己的屏幕位置为中心）。
// 为什么需要它：轮廓之所以糊不掉，是因为模糊以**命中点**为中心，而命中映射在物体轮廓处是**跳变**的
// （射线打中物体 vs 跳到背后），相邻像素各糊各的区域 ⇒ 边界仍在。把中心朝"像素自身位置"拉，
// 相邻像素的取样区域就会重叠，轮廓随之变软；拉到 1.0 时等价于"本像素邻域的平均"——
// 轮廓消失，且亮度/色调来自真实场景（既不会像天光 SH 那样偏亮/偏色，也**不增加任何追踪开销**）。
// 这是"轻量低配"路线：1 次追踪 + N 次纹理抽样，与旧的源空间模糊同价。
#ifndef ROUGH_REFLECTION_PULL
    #define ROUGH_REFLECTION_PULL 0.0 // [0.0 0.25 0.5 0.75 1.0] 模糊中心回拉量（越大轮廓越糊、越像邻域平均）
#endif
// [2026-10-08] 粗糙反射亮度衰减曲线：反射亮度 ×= (1 - roughness)^本值。
// 1.0 = 与原实现等价；>1 ⇒ 粗糙面更暗（金属与电介质都生效）；<1 ⇒ 更亮。
// 目的：让"粗糙反射"明显比"普通（光滑）反射"暗，粗糙面只留一点光泽而不是糊而刺眼。
#ifndef ROUGH_REFLECTION_DIM
    #define ROUGH_REFLECTION_DIM 1.0 // [0.5 1.0 1.5 2.0 3.0] 粗糙反射亮度衰减指数（越大越暗）
#endif
    //#define ROUGH_REFLECTION_CONTACT_HARDENING  // [注释以关闭] 接触硬化：近处清晰、远处模糊；关闭后使用固定模糊程度
    // [2026-10-08 修复拼写] 原名 ROUGH_REFLECTION_ON_METAL（单数 REFLECTION）与 GUI 条目 /
    // shaders.properties / lang 里的 ROUGH_REFLECTIONS_ON_METAL（复数）不一致 ⇒ 那个 GUI 开关此前是死的
    // （与之前 SSRT_USE_HIZ 拼错名同类问题）。统一为复数名。
    //#define ROUGH_REFLECTIONS_ON_METAL          // [注释以关闭] 粗糙反射模糊也对金属表面生效
#ifndef REFLECTION_METAL_ATTENUATION
    #define REFLECTION_METAL_ATTENUATION 1.0 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0] 所有金属反射的固定衰减倍率（降低以透出金属本身纹理）
#endif
#ifndef REFLECTION_METAL_MIX
    #define REFLECTION_METAL_MIX 0.9 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0] 金属反射与纹理的混合权重（1.0=纯反射, 0.0=纯纹理）
#endif

// ====== 反射亮度控制 ======
#ifndef REFLECTION_FALLBACK_BRIGHTNESS
    #define REFLECTION_FALLBACK_BRIGHTNESS 1.0 // [0.0 0.2 0.4 0.6 0.8 1.0 1.2 1.5 2.0]
#endif
#ifndef NONMETAL_REFLECTION_BRIGHTNESS
    #define NONMETAL_REFLECTION_BRIGHTNESS 2.5 // [1.0 1.5 2.0 2.5 3.0 4.0 5.0]  增强非金属反射亮度
#endif

// 反射权重上限（防自激）：反射源 colortex4 存的是**上一帧已含反射**的画面，权重 ≥1 时
// 「反射自己 / 反射另一个反光面」的光路每帧放大一次（增益 >1 发散，表现为掠射带爆亮）。
// 0.85 ⇒ 回路增益 <1、极限放大 1/(1-0.85)≈6.7 倍；调小更稳、调到 1.0 以上则不复位。
#ifndef REFLECTION_LOOP_WEIGHT_MAX
    #define REFLECTION_LOOP_WEIGHT_MAX 0.85
#endif
#ifndef REFLECTION_FALLBACK_BASE
    #define REFLECTION_FALLBACK_BASE 0.0 // 不再使用
#endif

#ifndef REFLECTION_NORMAL_BIAS
    #define REFLECTION_NORMAL_BIAS 0.0 // [0.0 0.0001 0.0003 0.0005 0.001 -0.001 -0.0005 -0.0001]
#endif

#define REFLECTION_GLOBAL
//#define REFLECTION_SKY

// [2026-10-08] **临时诊断宏**（硬编码，不经 Iris 选项机制）。0 = 关闭（正常渲染）。
// 置 1 会把反射颜色替换成"来源热图"：R = 模糊半径/300px；G = 左侧绿条（条宽 = 抽样数/64 屏宽）；
// B≈0 = 粗糙路径、0.7 = 锐利路径；并由 DeferredLight 端绝对替换像素色。
// 已用它查清"半径随 roughness 缩小"这一根因（见下方半径公式处的注释）⇒ 保留为可选调试手段，
// 不再每次使用；需要时置 1 即可。
#define SSR_DEBUG_SOURCE_MAP 0

// ---------- 快速 SSR 追踪器（模式 2）----------
#if METAL_SSR_MODE == 2
#ifdef SSRT_REFINEMENT
    const uint rayTraceBiSteps = uint(SSRT_REFINEMENT_STEPS);
#else
    const uint rayTraceBiSteps = 0u;
#endif

// [2026-10-08] 快速 SSR（模式 2）的深度采样：改用**不透明**深度 depthtex2 + texelFetch。
// 原来用 `textureLod(depthtex0, uv, 0)`：depthtex0 含半透明（水/玻璃会被当成实体 ⇒ 假命中），
// 且双线性会在轮廓处插值出中间深度（同样假命中）。模式 1 一直用 loadDepth2，现在两者一致。
float ssrSampleOpaqueDepth(in vec2 screenUv) {
    return loadDepth2(ivec2(screenUv * viewSize));
}

// 修改为动态接收 steps，以便常规反射和粗糙反射使用不同的步数
vec3 rayTraceScene(in vec3 screenPos, in vec3 viewPos, in vec3 rayDir, in float dither, in uint steps) {
    if (rayDir.z > -viewPos.z) return vec3(0.0);
    vec3 targetScreen = ViewToScreenPosRaw(viewPos + rayDir);
    float stepInv = 1.0 / float(steps);
    vec3 screenPosRayDir = normalize(targetScreen - screenPos) * stepInv;
    vec3 startPos = screenPos + screenPosRayDir * dither;
    
    for (uint i = 0u; i < steps; i++) {
        startPos += screenPosRayDir;
        if (startPos.x < 0.0 || startPos.y < 0.0 || startPos.x > 1.0 || startPos.y > 1.0) return vec3(0.0);
        float currDepth = ssrSampleOpaqueDepth(startPos.xy);
        if (currDepth <= 0.56) return vec3(0.0);
        bool intersection = currDepth < startPos.z;
        if (intersection) {
            #if rayTraceBiSteps > 0
                for (uint j = 0u; j < rayTraceBiSteps; j++) {
                    if (ssrSampleOpaqueDepth(startPos.xy) >= 1.0) return vec3(0.0);
                    screenPosRayDir *= 0.5;
                    startPos += intersection ? -screenPosRayDir : screenPosRayDir;
                    currDepth = ssrSampleOpaqueDepth(startPos.xy);
                    intersection = currDepth < startPos.z;
                }
            #else
                if (ssrSampleOpaqueDepth(startPos.xy) >= 1.0) return vec3(0.0);
            #endif
            return vec3(startPos.xy, 1.0);
        }
    }
    return vec3(0.0);
}
#endif

vec4 CalculateSpecularReflections(Material material, uint materialID, vec3 worldNormal, vec3 screenPos, vec3 worldDir, vec3 viewPos, float skylight, float dither) {
    #ifndef REFLECTION_GLOBAL
        return vec4(vec3(skylight * 1.3), 1.0);
    #endif

    // ---- 反射资格判定 ----
    bool isCustom = (materialID == 10050u);
    bool isReflective = isCustom;

    if (!isCustom) {
        #if METAL_REFLECT_MODE == 0
            isReflective = (material.metalness >= METALNESS_THRESHOLD);
        #elif METAL_REFLECT_MODE == 1
            isReflective = (material.roughness <= ROUGHNESS_THRESHOLD);
        #elif METAL_REFLECT_MODE == 2
            isReflective = (material.metalness >= METALNESS_THRESHOLD || material.roughness <= ROUGHNESS_THRESHOLD);
        #endif
    }

    // ---- 粗糙反射资格判定 ----
    bool isRoughReflective = false;
    #ifdef ROUGH_REFLECTIONS
        #ifdef ROUGH_REFLECTIONS_ON_METAL
        if (material.roughness > ROUGHNESS_THRESHOLD && material.roughness <= ROUGH_REFLECTIONS_MAX) {
            isRoughReflective = true;
        }
        #else
        if (!isReflective && material.roughness > ROUGHNESS_THRESHOLD && material.roughness <= ROUGH_REFLECTIONS_MAX) {
            isRoughReflective = true;
        }
        #endif
    #endif

    if (!isReflective && !isRoughReflective) return vec4(0.0);

    viewPos += mat3(gbufferModelView) * worldNormal * (length(viewPos) * REFLECTION_NORMAL_BIAS);

    // 天空方向 / SSR 方向：两者其实是同一个向量
    // （reflect(worldDir, worldNormal) == worldDir + worldNormal*2*abs(dot(N, worldDir))），
    // 保留两个名字只是让天空回退段与 SSR 段各自可读。
    vec3 skyLightDir = reflect(worldDir, worldNormal);
    float NdotV = abs(dot(worldNormal, -worldDir));
    vec3 ssrRayDir = worldDir + worldNormal * (NdotV * 2.0);

    // [2026-10-08] 删死代码：原 `if (dot(worldNormal, skyLightDir) < EPS) return vec4(0.0);` 恒不成立
    // —— dot(N, R) = NdotV > 0，永远走不到 return。

    float fresnel = FresnelDielectricN(NdotV, 1.5);

    vec3 reflection = vec3(0.0);
    float reflectionDist = FP16_MAX;
    bool hasSky = false;
    bool hasSSR = false;
    float debugBlurRadiusPx = 0.0;   // 仅诊断用（见 SSR_DEBUG_SOURCE_MAP）：粗糙路径实际算出的模糊半径

    // ---- 天空反射 ----
    #ifdef REFLECTION_SKY
        if (skylight > EPS && isEyeInWater == 0 ) {
            #if defined(DIMENSION_THE_END) || defined(DIMENSION_NETHER)
                reflection = AtmosphereSkyView(atmosphereViewPos, skyLightDir, worldSunDir);
            #else
                reflection = textureBicubic(skyMapTex, saturate(ProjectSky(skyLightDir))).rgb;
            #endif
            // [2026-09-03 方案1] 彻底移除 sunFace：此前用它压太阳光斑，但它按
            // dot(normal, sunDir) 把竖向墙面（法线水平，dot≈0）的天空反射也压成 0，
            // 导致"开启天空反射也不出天空"（半透明+不透明都有该问题）。恢复 1.0.2b
            // 的纯 skylight 门控，保证天空反射在任何角度可见。
            reflection *= smoothstep(0.3, 0.7, skylight) * REFLECTION_FALLBACK_BRIGHTNESS;
            
            if (isRoughReflective) reflection *= max(1.0 - material.roughness * 1.5, 0.1);
            
            hasSky = true;
        }
    #endif

    // ---- 屏幕空间反射 (SSR) ----
    #if METAL_SSR_MODE >= 1
        vec3 viewReflectDir = mat3(gbufferModelView) * ssrRayDir;
        bool traceHit = false;
        vec2 hitCoord;

        // 统一时空抖动噪声
        float ssrDither = SampleStbnVec2(ivec2(gl_FragCoord.xy), frameCounter).x;

        // 动态配置追踪步数：独立控制粗糙反射的采样数
        uint currentSteps = uint(SSRT_MAX_SAMPLES);
        #ifdef ROUGH_REFLECTIONS
            if (isRoughReflective) currentSteps = uint(ROUGH_REFLECTION_STEPS);
        #endif

        // ---- 叶瓣多方向采样（ROUGH_REFLECTION_DIR_SAMPLES > 1 时启用，默认 1 = 关闭）----
        // [2026-10-08] 为什么需要它：单条镜面射线的**命中映射**在反射物体的轮廓处是**跳变**的 ——
        // 射线打中物体就取物体的颜色、扫过轮廓就跳到背后的天空/远处。于是"在源空间做模糊"只会把
        // 物体内部摊平成一块平均色（细节消失），而轮廓两侧各自平均、边界照旧存在（用户实测：
        // "细节全没、轮廓仍清晰"）。只有让同一像素的射线**在叶瓣内散开**、各自落到轮廓两侧再平均，
        // 轮廓才会真正被抹开，而且颜色/亮度仍全部来自真实反射。
        // 方向用 GGX 可见法线分布（BRDF.glsl 的 SampleGGXVNDF，此前全仓无人调用）。
        // 注：SPECULAR_IMPORTANCE_SAMPLING_BIAS（默认 0.5）会把叶瓣收窄；想要更散的模糊可调到 0。
        vec3 lobeAvgColor = vec3(0.0);
        float lobeHits = 0.0;
        bool lobeSampled = false;
        #ifdef ROUGH_REFLECTIONS
        #if ROUGH_REFLECTION_DIR_SAMPLES > 1
        if (isRoughReflective) {
            lobeSampled = true;
            for (int k = 0; k < ROUGH_REFLECTION_DIR_SAMPLES; k++) {
                vec3 dirK = viewReflectDir;                 // k = 0 用镜面方向，保证与不粗糙时一致
                if (k > 0) {
                    vec2 uK  = SampleStbnVec2(ivec2(gl_FragCoord.xy), frameCounter + 7 + k);
                    vec3 wmK = SampleGGXVNDF(uK, -worldDir, material.roughness, worldNormal);
                    vec3 LwK = reflect(worldDir, wmK);
                    if (dot(LwK, worldNormal) <= 0.0) continue;   // 叶瓣落到表面下方 ⇒ 丢弃该样本
                    dirK = normalize(mat3(gbufferModelView) * LwK);
                }
                vec3 lobePos = screenPos;
                bool hitK = false;
                #if METAL_SSR_MODE == 1
                    hitK = ScreenSpaceRaytrace(viewPos, dirK, ssrDither, currentSteps, lobePos);
                #elif METAL_SSR_MODE == 2
                    vec3 trK = rayTraceScene(screenPos, viewPos, dirK, ssrDither, currentSteps);
                    if (trK.z > 0.5) { hitK = true; lobePos = trK; }
                #endif
                if (!hitK) continue;
                vec2 uvK = clamp(lobePos.xy, vec2(0.0), vec2(1.0) - viewPixelSize) * 0.5;
                lobeAvgColor += texture(colortex4, uvK).rgb;
                lobeHits  += 1.0;
                traceHit   = true;        // 任一方向命中即算命中
                hitCoord   = lobePos.xy;  // 供 edgeFade / reflectionDist 使用（近似：取最后一个命中点）
            }
            if (lobeHits > 0.0) lobeAvgColor /= lobeHits;
        } else
        #endif
        #endif
        {   // ← 原单射线路径（DIR_SAMPLES == 1 或不粗糙时，行为与旧版逐位一致）
        #if METAL_SSR_MODE == 1
            vec3 ssrScreenPos = screenPos;
            if (ScreenSpaceRaytrace(viewPos, viewReflectDir, ssrDither, currentSteps, ssrScreenPos)) {
                traceHit = true;
                hitCoord = ssrScreenPos.xy;
            }
        #elif METAL_SSR_MODE == 2
            vec3 traceResult = rayTraceScene(screenPos, viewPos, normalize(viewReflectDir), ssrDither, currentSteps);
            if (traceResult.z > 0.5) {
                traceHit = true;
                hitCoord = traceResult.xy;
            }
        #endif
        }

        if (traceHit) {
            float edgeFade = hitCoord.x * hitCoord.y * oms(hitCoord.x) * oms(hitCoord.y);
            edgeFade *= 1e2 + cube(saturate(1.0 - gbufferModelViewInverse[2].y)) * 1e3;

            // [2026-10-08 P0-2] 深度与视图位置必须用**屏幕**坐标（depthtex0 是全分辨率、全屏），
            // 只有采样 colortex4 才需要 ×0.5 —— 它的左上象限是半分辨率画布（ReprojectScene.comp
            // 用 workGroupsRender=0.5 写入）。
            // 原代码把象限坐标一路用到深度读取与 viewPos 重建上：uvToTexel(hitCoord*0.5) 取到了
            // 屏幕坐标一半处的深度，ScreenToViewPos(vec3(hitCoord*0.5, d)) 的 ndc = hitCoord-1 ∈ [-1,0]
            // 只对屏幕左上象限成立 ⇒ reflectionDist 完全错误（接触硬化、以及后续任何按命中距离
            // 加权的降噪/模糊都会拿到错距离）。clamp 是防 hitCoord == 1.0 时 texelFetch 越界。
            vec2 hitUv = clamp(hitCoord, vec2(0.0), vec2(1.0) - viewPixelSize);
            float hitDepth = loadDepth0(uvToTexel(hitUv));
            vec3 reflectViewPos = ScreenToViewPos(vec3(hitUv, hitDepth));
            reflectionDist = distance(reflectViewPos, viewPos);

            vec2 sampleUv = hitCoord * 0.5;

            // ==== 粗糙反射核心：屏幕空间多采样模糊 + 低阶环境光泽 ====
            #ifdef ROUGH_REFLECTIONS
            vec3 roughBlurredColor = vec3(0.0);
            if (isRoughReflective && !lobeSampled) {   // 走叶瓣多方向采样时不做源空间模糊（已由方向散开完成）
                // 接触硬化：近处清晰，远处模糊（可通过宏开关切换为固定模糊）
                #ifdef ROUGH_REFLECTION_CONTACT_HARDENING
                float contactHardening = clamp(reflectionDist * 0.1, 0.0, 1.0);
                #else
                float contactHardening = 1.0;
                #endif

                // [2026-10-08 目标观感：粗糙面 =「一片大概的光泽」，认不出反射内容]
                // ② 混合系数：越粗糙越接近"一片均匀光泽"。
                //    ROUGH_REFLECTION_SHEEN 是倍率：1.0 = 按 roughness 线性混（0.5 粗 → 一半光泽）；
                //    2.0 ⇒ roughness ≥0.5 基本全糊；0 = 只用屏幕空间模糊。
                //    skylight 门控：室内/阴影里不掺环境光泽（防室内漏光，且避免"环境≈0 时反而变暗"）。
                float sheenMix = saturate(material.roughness * ROUGH_REFLECTION_SHEEN)
                               * smoothstep(0.2, 0.6, skylight);

                // ① 屏幕空间模糊半径按 **roughness²** 放大（像素单位）。半径基准取"反射射线自身的
                //    屏幕长度" ⇒ 掠射/远距离反射糊得更厉害，正视的近处反射相对清晰。
                //    上限 = 屏幕对角线的 15%：到这一档已是"一片光泽"，而不是把整屏平均成灰。
                vec2 hitPix = hitCoord * viewSize;
                float rayLenPx = length(hitPix - gl_FragCoord.xy);
                // [2026-10-08 定稿] 半径与 roughness 解耦 —— 实测教训：
                // 原式半径 ∝ roughness²（我加的下限也 ∝ roughness），于是 roughness 0.1~0.3 的表面半径只有
                // 20~50px，看起来"内容糊了、轮廓却清晰"（诊断读数验证：半屏红≈0、半屏红满，半径完全由
                // 该像素的 roughness 决定）。现在改为按"在粗糙带里的位置 roughT"给屏幕尺度的半径：
                //   roughT≈0（刚进带）→ 6% 屏（轻微糊），roughT≈1（很粗糙）→ 30% 屏（只剩一片光泽）
                // 再叠射线长度项（掠射/远距离更糊）。ROUGH_REFLECTION_BLUR_STRENGTH 只做 ±2 倍微调，
                // 并对"选项是否真的生效"免疫（即使它没被注入，半径依然够大）。
                float roughT = saturate(material.roughness / maxEps(ROUGH_REFLECTIONS_MAX));
                float scaleMod = clamp(ROUGH_REFLECTION_BLUR_STRENGTH / 20.0, 0.5, 2.0);
                float blurRadiusPx = max(0.8 * rayLenPx * roughT * contactHardening,
                                         mix(0.06, 0.30, roughT) * length(viewSize)) * scaleMod;
                // colortex4 是半分辨率象限画布：1 个全屏像素 = 0.5 画布 UV ⇒ 换算时乘 0.5
                vec2 blurRadiusUv = vec2(blurRadiusPx) * viewPixelSize * 0.5;
                // 上限：0.2 画布 UV = 全屏 40%；再大所有抽样点会被 clamp 到画布边缘、退化成一圈边缘色
                blurRadiusUv = min(blurRadiusUv, vec2(0.2));
                debugBlurRadiusPx = blurRadiusPx;   // 供 SSR_DEBUG_SOURCE_MAP 诊断读取

                // [2026-10-08 轻量路线] 模糊中心从"命中点"朝"本像素自身屏幕位置"回拉：
                //   0.0 = 旧的源空间模糊（轮廓糊不掉：命中映射在轮廓处跳变，相邻像素各糊各的）
                //   1.0 = 本像素邻域平均（轮廓消失，亮度/色调取自真实场景；**零额外追踪开销**）
                // 中间值 = 两者按比例混合，用它就能连续控制"轮廓有多软"。
                vec2 blurCenterUv = mix(hitCoord, gl_FragCoord.xy * viewPixelSize,
                                        saturate(ROUGH_REFLECTION_PULL)) * 0.5;

                // [2026-10-08] 抽样核改为 **Vogel/golden-angle 螺旋**（面积均匀的圆盘分布），
                // 取代原先手写的 12 点表：
                //  · 任意 N 都均匀（表只到 12 点，而"12 点摊在大圆盘上"本质是 12 票投票 ——
                //    物体轮廓处会留下清晰分界，用户实测"粗糙反射能看见锐利边缘"）；
                //  · 螺旋的覆盖是渐进的（半径从小到大），比固定表的成簇分布更接近平滑核。
                // 半径已在像素空间按 viewPixelSize 做各向异性换算（x/y 各自除以分辨率）⇒ 不需要
                // 旧的 aspectScale 手工修正。每帧再用 STBN 旋转整条螺旋（去相关）。
                float angle = SampleStbnVec2(ivec2(gl_FragCoord.xy), frameCounter + 3).x * 6.2831853;
                const float goldenAngle = 2.39996323;
                for (int i = 0; i < ROUGH_REFLECTION_BLUR_SAMPLES; i++) {
                    float fi = float(i);
                    float r  = sqrt((fi + 0.5) * rcp(float(ROUGH_REFLECTION_BLUR_SAMPLES)));
                    float th = fi * goldenAngle + angle;
                    vec2  offset = vec2(cos(th), sin(th)) * r;
                    vec2  sampleCoord = blurCenterUv + offset * blurRadiusUv;
                    sampleCoord = clamp(sampleCoord, 0.001, 0.499);
                    roughBlurredColor += texture(colortex4, sampleCoord).rgb;
                }
                roughBlurredColor /= float(ROUGH_REFLECTION_BLUR_SAMPLES);

                // ② 环境光泽：**只借"形状/色度"，亮度跟随真实（模糊后）反射**。
                //    直接用 SH 辐照度会让粗糙面按天光取亮 ⇒ 普遍偏亮（2026-10-08 用户反馈"太亮"）。
                //    这里做比值修正（ratio estimator 的简化形态）：把 sheen 的亮度拉到与 blurred 相同，
                //    于是"糊"由环境提供、"亮多少"由**真实反射画面**决定 ⇒ 反射暗的物体不会凭空变亮。
                //    注：因为需要 blurred 的亮度作基准，多采样不再能跳过（每个粗糙像素 4~6 次抽样）。
                vec3 envSheen = ConvolvedReconstructSH3(global.skySH, worldNormal);
                float lBlur = luminance(roughBlurredColor);
                float lEnv  = luminance(envSheen);
                vec3  sheen = envSheen * (lBlur * rcp(max(lEnv, 1e-4)));
                sheen = min(sheen, vec3(lBlur * 4.0));   // 环境极暗/极亮时限制放大倍数
                roughBlurredColor = mix(roughBlurredColor, sheen, sheenMix);
            }
            #endif

            // [2026-10-08] 粗糙反射亮度衰减：**粗糙度越高越暗**（用户要求"粗糙反射应比普通反射更暗"）。
            // 曲线 = (1-roughness)^ROUGH_REFLECTION_DIM：
            //   DIM = 1.0 与原实现等价（电介质那条 `max(1-roughness, 0.1)`）；
            //   DIM > 1 更暗（"粗糙 = 只留一点光泽"）；DIM < 1 更亮。
            // 关键修正：衰减对**金属也生效** —— 原实现只乘在电介质分支上，于是粗糙金属与光滑金属一样亮
            // （配合大半径模糊就显得"糊而刺眼"）。
            float roughDim = pow(max(1.0 - material.roughness, 0.0), ROUGH_REFLECTION_DIM);
            float clampedFresnel = fresnel;
            if (material.metalness >= METALNESS_THRESHOLD) {
                // 金属：固定衰减，透出金属本身纹理
                clampedFresnel = fresnel * REFLECTION_METAL_ATTENUATION;
                if (isRoughReflective) clampedFresnel *= roughDim;
            } else {
                clampedFresnel = min(fresnel, 0.5);
                if (isRoughReflective) {
                    clampedFresnel *= roughDim;
                }
                // 下面统一乘 NONMETAL_REFLECTION_BRIGHTNESS（非金属增强），这里按那个倍率预先折算，
                // 使画布项的最终权重不超过上限 —— 否则增强会把权重顶到 1.25 而自激（见该宏处注释）。
                clampedFresnel = min(clampedFresnel, REFLECTION_LOOP_WEIGHT_MAX * rcp(NONMETAL_REFLECTION_BRIGHTNESS));
            }
            
            // SSR 颜色：叶瓣多方向平均 / 粗糙圆盘模糊 / 常规单次采样
            #ifdef ROUGH_REFLECTIONS
            vec3 ssrColor = (lobeSampled ? lobeAvgColor
                                         : (isRoughReflective ? roughBlurredColor : texture(colortex4, sampleUv).rgb)) * clampedFresnel;
            #else
            vec3 ssrColor = texture(colortex4, sampleUv).rgb * clampedFresnel;
            #endif
            reflection = mix(reflection, ssrColor, saturate(edgeFade));
            hasSSR = true;
        }
    #endif

    // ---- 非金属反射亮度增强 ----
    if ((isReflective || isRoughReflective) && material.metalness < METALNESS_THRESHOLD) {
        reflection *= NONMETAL_REFLECTION_BRIGHTNESS;
    }

    if (!hasSky && !hasSSR) {
        return vec4(0.0, 0.0, 0.0, FP16_MAX);
    }

    if (!hasSSR) reflectionDist = FP16_MAX;

    #if SSR_DEBUG_SOURCE_MAP == 2
        // ===== [S2 诊断] 直接显示 pass 链的**覆盖率**（硬编码，不依赖任何选项机制）=====
        //   R = colortex22（纵向模糊结果）的 a     G = colortex11（DeferredLight 写的锐利信号）的 a
        //   两个都黑 ⇒ S1 写端没生效（缓冲是空的）；G 亮 R 黑 ⇒ 模糊 pass 没跑（门控/接线问题）
        //   两个都亮 ⇒ 链是通的，那"清晰"就只是半径太小（调 ROUGH_REFLECTION_BLUR_STRENGTH）
        if (isRoughReflective) {
            reflection = vec3(texture(colortex22, screenPos.xy).a,
                              texture(colortex11, screenPos.xy).a, 0.0);
            reflectionDist = 1.0;
        }
    #endif

    #if SSR_DEBUG_SOURCE_MAP == 1
        // ===== 临时诊断（2026-10-08，用完删除本段与顶部宏）=====
        // 把反射颜色替换成"来源热图"，用来一次性回答"模糊到底有没有生效、半径多大"：
        //   · 深蓝          = 走了**单次锐利采样**（未进模糊分支）
        //   · 暖色（橙黄）  = 走了**粗糙模糊**分支，亮度 ∝ 实际模糊半径（300px 及以上全亮）
        //   · 黑            = 没有反射命中（trace miss 且无天空命中）
        // 除以 clampedFresnel 是为了让电介质（F≈0.04）也看得见 —— 消费端对电介质是**加算**
        // （sceneOut*albedo*(1-F) + reflection.rgb），不除的话诊断色会被压到 4% 几乎不可见。
        vec3 dbg = isRoughReflective
                 ? vec3(saturate(debugBlurRadiusPx / 300.0),                       // R = 半径/300px（整片均匀）
                        // G = 屏幕左侧绿条：条宽 = 抽样数/64 屏宽 ⇒ 一眼读出**实际**抽样数
                        (gl_FragCoord.x * viewPixelSize.x < float(ROUGH_REFLECTION_BLUR_SAMPLES) / 64.0) ? 1.0 : 0.0,
                        0.05)                                                      // B≈0 = 粗糙路径
                 : vec3(0.0, 0.0, 0.7);                                            // 深蓝 = 单次锐利采样
        reflection = dbg;
        reflectionDist = 1.0;
    #endif

    return vec4(reflection, reflectionDist);
}