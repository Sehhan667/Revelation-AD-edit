/*
--------------------------------------------------------------------------------
    Revelation Shaders - Hybrid Temporal Reprojection Anti-Aliasing
    Mode 0 (High Quality): Playdead's variance-clipping & perceptual YCoCg TAA
    Mode 1 (High Performance): MakeUp Fast RGB TAA (fixed history weight)
--------------------------------------------------------------------------------






    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.
*/

//======// 配置与宏定义 //=======================================================================//

// [2026-09-02] GUI/profile 的 TAA_QUALITY_MODE 应优先生效：改为 #ifndef 包裹的默认值，
// 仅当编译行/profile 未注入时才用此处默认 1。原裸 #define 会覆盖 profile 注入的 0 →
// GUI 选"高画质"不生效、始终跑高性能模式。
#ifndef TAA_QUALITY_MODE
    #define TAA_QUALITY_MODE 1 // [0 1] 0: 高画质模式 (原版 Playdead) | 1: 高性能模式 (MakeUp Fast TAA)
#endif

// [2026-09-02] 移除硬性 #undef：TAA_SHARPEN 曾被此段强制锁死，无论 GUI/profile 如何设置都不生效。
// 现交由 settings/profile 的 TAA_SHARPEN 开关控制，开启时历史采样走 Catmull-Rom 抗振铃锐化。

//======// 基础引用 //===========================================================================//

#include "/lib/Utility.glsl"

/* RENDERTARGETS: 1,4 */
layout(location = 0) out vec4 temporalOut;
layout(location = 1) out vec3 clearOut;

#ifdef MOTION_BLUR
    /* RENDERTARGETS: 1,4,3 */
    layout(location = 2) out vec2 motionVectorOut;
#endif

#include "/lib/universal/Uniform.glsl"
#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"

//======// 共享辅助函数 //========================================================================//

vec3 CrossClosestFragment(in ivec2 texelPos, in float depth) {
    vec3 closest = vec3(vec2(texelPos), depth);

    ivec2 t1 = texelPos + ivec2( 1,  1);
    ivec2 t2 = texelPos + ivec2(-1,  1);
    ivec2 t3 = texelPos + ivec2( 1, -1);
    ivec2 t4 = texelPos + ivec2(-1, -1);

    float d1 = loadDepth0(t1);
    float d2 = loadDepth0(t2);
    float d3 = loadDepth0(t3);
    float d4 = loadDepth0(t4);

    closest = closest.z > d1 ? vec3(vec2(t1), d1) : closest;
    closest = closest.z > d2 ? vec3(vec2(t2), d2) : closest;
    closest = closest.z > d3 ? vec3(vec2(t3), d3) : closest;
    closest = closest.z > d4 ? vec3(vec2(t4), d4) : closest;

    closest.xy *= viewPixelSize;
    return closest;
}

//======// 方案 0：高画质模式专属函数 (Playdead YCoCg) //==========================================//
#if TAA_QUALITY_MODE == 0

vec3 perceptualWeight(vec3 colorYCoCg) {
    return colorYCoCg * rcp(1.0 + colorYCoCg.x);
}

vec3 perceptualWeightInv(vec3 colorYCoCg) {
    return colorYCoCg * rcp(1.0 - colorYCoCg.x);
}

vec3 historyClipAABB(in vec3 history, in vec3 center, in vec3 extent) {
    vec3 delta = history - center;
    float maxUnit = maxOf(abs(delta / extent));

    if (maxUnit > 1.0) {
        return center + delta / maxUnit;
    }
    return history;
}

#endif

//======// 方案 1：高性能模式专属函数 (MakeUp RGB ConvexHull，优化版) //===================================//
#if TAA_QUALITY_MODE == 1

// 直接返回裁剪后的 RGB，不再需要 a 通道
vec3 convexHull(
    vec3 c, vec3 previous, vec3 up, vec3 down, vec3 left, vec3 right,
    vec3 ul, vec3 ur, vec3 dl, vec3 dr
) {
    vec3 sum = c + up + down + left + right + ul + ur + dl + dr;
    vec3 sum_sq = c * c + up * up + down * down + left * left + right * right + ul * ul + ur * ur + dl * dl + dr * dr;

    vec3 mean = sum * 0.1111111111111111;
    vec3 variance = abs(sum_sq * 0.1111111111111111 - mean * mean);
    vec3 stdDev = sqrt(variance);
    vec3 minValid = mean - stdDev;
    vec3 maxValid = mean + stdDev;

    return clamp(previous, minValid, maxValid);
}

#endif

// ----------------------------------------------------------------------------
// 核心时序重投影函数
// ----------------------------------------------------------------------------
vec4 TemporalReprojection(in vec2 screenCoord, in vec2 motionVector) {
    ivec2 texel = uvToTexel(screenCoord + taaJitter * 0.5);
    vec2 prevCoord = screenCoord - motionVector;

    // [2026-10-15 TAA_PREV_JITTER] 历史采样位置对齐开关。历史缓冲里存的是上一帧的**抖动采样**
    // （像素 k 的内容 = 采样点 c_k + taaJitterPrev*0.5 处的着色；抖动是子像素的、不跨像素），
    // 而 prevCoord 是未抖动网格坐标。两种自洽约定只差不到半个像素：
    //   A) 按「上一帧实际采样位置」取历史 = 加 taaJitterPrev*0.5（canonical TAA 写法，与
    //      program/diffuse/Accumulate.frag 里 prevNDCPos += taaJitterPrev 同源）⇒ 本开关；
    //   B) 按「同一像素索引」取历史 = 现状（子像素抖动下像素索引基本不变，等价于取该像素上
    //      一次采样）。
    // 默认关（= B，逐位不变现状）。A 与 B 谁更干净必须实机 A/B：A 的顾虑是双线性坐标的偏移会
    // 把邻居权重带进来（等价于多一点模糊）。推理与证据见 docs/TAA_REVIEW_2026-10-15.md P1-3。
    // 本开关只改历史采样位置；重投影原点仍按未抖动的像素中心处理（与 Main 的 motionVector 一致）。
    #ifdef TAA_PREV_JITTER
        vec2 prevSampleCoord = prevCoord + taaJitterPrev * 0.5;
    #else
        vec2 prevSampleCoord = prevCoord;
    #endif

    // --- 模式 1：高性能 MakeUp Fast TAA（固定高历史权重） ---
    #if TAA_QUALITY_MODE == 1
        vec3 currentRGB = YCoCgToRGB(loadSceneMain(texel));   // colortex0 存 YCoCg，转回 RGB

        // [2026-10-15 TAA_HISTORY_RESET] historyReset = 世界时间跳变/维度切换（Uniform.glsl 的
        // 定义与注释）。此时历史整段作废：与越界早退同形，计数归 1 → 下一帧从当前帧重新累积。
        // 不接这段时默认档会按固定 0.9 混入上一帧历史（凸包夹逼能挡住大部分，但不是全部）。
        #ifdef TAA_HISTORY_RESET
            if (historyReset) return vec4(currentRGB, 1.0);
        #endif

        if (saturate(prevSampleCoord) != prevSampleCoord)
            return vec4(currentRGB, 1.0);

        vec4 temporalData = texture(colortex1, prevSampleCoord);
        vec3 previousRGB = temporalData.rgb;                  // colortex1 存 RGB

        // [2026-09-03 修复凸包色彩] colortex0 存 YCoCg；邻居与中心同样要 YCoCg->RGB
        // 后再做凸包裁剪。凸包是逐通道 clamp，必须在 RGB（感知线性）空间进行——
        // 在 YCoCg 空间对各通道独立 clamp 会破坏 RGB 耦合，低亮度红区(R高/B≈0)时
        // Co/Cg 被强夹，转回 RGB 后 B 被挤出成蓝色拖影（性能模式专有）。
        #define FETCH_NEIGHBOUR(off) YCoCgToRGB(texelFetch(colortex0, texel + (off), 0).rgb)
        vec3 up    = FETCH_NEIGHBOUR(ivec2( 0,  1));
        vec3 down  = FETCH_NEIGHBOUR(ivec2( 0, -1));
        vec3 left  = FETCH_NEIGHBOUR(ivec2(-1,  0));
        vec3 right = FETCH_NEIGHBOUR(ivec2( 1,  0));
        vec3 ul    = FETCH_NEIGHBOUR(ivec2(-1,  1));
        vec3 ur    = FETCH_NEIGHBOUR(ivec2( 1,  1));
        vec3 dl    = FETCH_NEIGHBOUR(ivec2(-1, -1));
        vec3 dr    = FETCH_NEIGHBOUR(ivec2( 1, -1));
        #undef FETCH_NEIGHBOUR

        vec3 previousClipped = convexHull(currentRGB, previousRGB, up, down, left, right, ul, ur, dl, dr);

        float accumFrames = min(++temporalData.a, TAA_MAX_ACCUM_FRAMES);

        // 固定历史权重 0.9，新帧 0.1，极大减轻噪点
        const float historyWeight = 0.9;
        #ifdef MOTION_BLUR
            float velocity = length(prevCoord - screenCoord) * 10.0;
            float blendFactor = clamp(historyWeight - velocity * 0.02, 0.0, 1.0);
        #else
            float blendFactor = historyWeight;
        #endif

        return vec4(mix(currentRGB, previousClipped, blendFactor), temporalData.a);

    // --- 模式 0：高画质 Playdead YCoCg TAA（裁剪默认关闭） ---
    #else
        vec3 currData = loadSceneMain(texel);

        // [2026-10-15 TAA_HISTORY_RESET] 同模式 1：世界时间跳变/维度切换时丢弃历史（计数归 1）。
        #ifdef TAA_HISTORY_RESET
            if (historyReset) return vec4(YCoCgToRGB(currData), 1.0);
        #endif

        if (saturate(prevSampleCoord) != prevSampleCoord) 
            return vec4(YCoCgToRGB(currData), 1.0);

        #ifdef TAA_SHARPEN
            vec4 temporalData = textureCatmullRomFastAntiRing(colortex1, prevSampleCoord);
        #else
            vec4 temporalData = texture(colortex1, prevSampleCoord);
        #endif

        vec3 prevData = RGBToYCoCg(temporalData.rgb);

        float currLum = currData.x, prevLum = prevData.x;
        float temporalContrast = saturate(abs(currLum - prevLum) / max(currLum, prevLum));

        // 默认不裁剪（原版行为），拖影问题因此消失
        #ifdef TAA_CLIPPING
            vec3 moment1 = currData;
            vec3 moment2 = currData * currData;

            for (uint i = 0u; i < 8u; ++i) {
                vec3 sampleData = texelFetch(colortex0, texel + offset3x3N[i], 0).rgb;
                moment1 += sampleData;
                moment2 += sampleData * sampleData;
            }
            moment1 *= rcp(9.0);
            moment2 *= rcp(9.0);

            vec3 clipStdDev = sqrt(abs(moment2 - moment1 * moment1)) * TAA_AGGRESSION;

            // [2026-10-15 裁切标准差下限] 平坦 3x3 邻域（天空、纯色墙面；fp16 下很常见）标准差
            // 逐通道可为 0，收敛后 prevData == moment1 时下面 prevData / clipStdDev 就是 0/0 = NaN，
            // 而 saturate(NaN) 在 GLSL 里未定义（不同 GPU 可能返回 NaN 并顺着后面的除法扩散成
            // 局部黑/白噪点）。默认 0.0 ⇒ max(x, 0) 对非负的 clipStdDev 逐位恒等，默认观感不变。
            clipStdDev = max(clipStdDev, vec3(TAA_CLIP_STDDEV_MIN));

            // 椭球交集裁剪
            prevData -= moment1;
            prevData *= saturate(inversesqrt(sdot(prevData / clipStdDev)));
            prevData += moment1;
        #endif

        // 次像素锐化（用实际采样位置算亚像素相位，与历史取样位置保持同一套坐标）
        prevData = mix(prevData, currData, sdot(fract(prevSampleCoord * viewSize) - 0.5) * 0.5);

        float blendWeight = min(++temporalData.a, TAA_MAX_ACCUM_FRAMES);
        // [2026-09-02] 抗闪烁：contrast 增大时抱紧历史（blendWeight 增大 → rcp 减小）。
        blendWeight *= 1.0 + sqr(temporalContrast) * TAA_ANTIFLICKER;
        // [2026-09-02 运动抗拖影] 运动速度大时降低历史权重、加速让位当前帧，缓解动
        // 物体拖影。clamp 下界 1.0 保证 rcp(blendWeight)<=1，mix 不会外插 → 不重复蓝溢。
        float motionPixels = length(motionVector * viewSize);
        blendWeight = max(blendWeight * (1.0 - saturate(motionPixels * 0.02)), 1.0);

        currData = mix(perceptualWeight(prevData), perceptualWeight(currData), rcp(blendWeight));
        return vec4(YCoCgToRGB(perceptualWeightInv(currData)), temporalData.a);
    #endif
}

//======// 主函数入口 //==========================================================================//
void main() {
    clearOut = vec3(0.0);

    ivec2 screenTexel = ivec2(gl_FragCoord.xy);
    float depth = loadDepth0(screenTexel);
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;

    #if RENDER_MODE == 1
        vec2 motionVector;
        #if defined LOD_MOD
            uint materialID = loadMaterialPack(screenTexel).y;
            if (depth > 1.0 - EPS && materialID != 0u) {
                float lodDepth = loadDepth0Lod(screenTexel);
                motionVector = screenCoord - ReprojectScreenPosLod(vec3(screenCoord, lodDepth)).xy;
            } else
        #endif
        {
        #ifdef TAA_CLOSEST_FRAGMENT
            vec3 closestFragment = CrossClosestFragment(screenTexel, depth);
            motionVector = closestFragment.xy - ReprojectScreenPos(closestFragment).xy;
        #else
            motionVector = screenCoord - ReprojectScreenPos(vec3(screenCoord, depth)).xy;
        #endif
        }

        #ifdef MOTION_BLUR
            motionVectorOut = depth < 0.56 ? motionVector * 0.25 : motionVector;
        #endif

        #ifdef TAA_ENABLED
            temporalOut = TemporalReprojection(screenCoord, motionVector);
        #else
            temporalOut = vec4(loadSceneMain(screenTexel), 1.0);
        #endif
    #else
        // RENDER_MODE 0（离线渲染/出图）的静止相机累积路径。
        // 注：这里**故意不**套用 TAA_PREV_JITTER 的历史偏移——本路径只在相机完全不动的帧生效，
        // 未抖动的像素中心恰好命中同一个纹素（distance < EPS），让每个像素累积自己的抖动相位
        // 才是「抖动超采样」的本意；加上半个抖动像素的双线性偏移只会把邻居权重带进来、把静帧搞糊。
        ivec2 srcTexel = uvToTexel(screenCoord + taaJitter * 0.5);
        temporalOut = vec4(loadSceneMain(srcTexel), 1.0);

        vec2 prevCoord = ReprojectScreenPos(vec3(screenCoord, depth)).xy;
        if (distance(prevCoord, screenCoord) < EPS) {
            vec4 prevData = texture(colortex1, prevCoord);
            temporalOut.rgb = mix(prevData.rgb, temporalOut.rgb, rcp(++prevData.a));
            temporalOut.a = prevData.a;
        }
    #endif
}