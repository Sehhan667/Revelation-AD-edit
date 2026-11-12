/*
--------------------------------------------------------------------------------

    Revelation Shaders - Grade Pipeline Core (shared library)

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.

    [2026-09-21 Grade+Final 合并] 原 composite31 (Grade.frag) 独立全屏 pass 的
    调色管线抽成本函数库：
      - composite31 (Grade.frag)：仅 CAS_ENABLED 档启用（properties 的
        program.*.composite31.enabled 门控），main 调 GradeSceneTexel 写 colortex0；
      - final (Final.frag)：CAS 关闭档（默认）内联调用——中心点/色差偏移点/
        glitch 采样点各自调 GradeSceneTexel / GradeSceneUV，省一整个全屏 pass
        的 colortex0 读写往返（1080p 约 32B/px）。
    两档共用同一份函数与选项，行为按档位一致。

    依赖（宿主须先 include）：Utility.glsl、Uniform.glsl、SSBO.glsl、Random.glsl。

    已知近似（仅 CAS 关闭档）：色差/glitch 的 UV 采样点先对原始 HDR 图双线性
    插值再调 Grade（Grade(lerp)），原版是先 Grade 再插值（lerp(Grade)）。tone
    map 非线性使两者在高对比边界有 sub-pixel 级差异；色差偏移 <=4px 邻域相似、
    glitch 仅受伤瞬间可见，实测无感。
--------------------------------------------------------------------------------
*/

// 【低端特供优化宏】
#define ULTRA_LOW_END_ALU_REDUCTION // 启用底层 RCP 指令和指令流乘加合并优化
// [2026-11-12] gamma 固定为 sqrt 近似（原 POTATO_GAMMA_APPROX 恒定义 ⇒ GAMMA_CORRECTION 滑条
// 从来不起作用，属于空旋钮，已随滑条一起删掉；这里保留常量只为说明 gamma 走的是 sqrt）。

#define TONE_MAPPER AcademyFit // [None AcademyFit AcademyFull AgX_Minimal AgX_Full Lottes GT GT7 Fast_Reinhard]

#define BLOOM_BLENDING_MODE 1 // [0 1 2]
#define BLOOM_INTENSITY 1.6 // [0.0 0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 3.0 4.0 5.0 7.0 10.0 15.0 20.0]
#define BLOOMY_FOG_INTENSITY 1.0 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.75 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.5 3.0 3.5 4.0 5.0]

#define PURKINJE_SHIFT
// #define PURKINJE_SHIFT_NOISE
#define PURKINJE_SHIFT_STRENGTH 0.3 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
#define PURKINJE_SHIFT_R 0.56 // [0.0 to 1.0]
#define PURKINJE_SHIFT_G 0.78 // [0.0 to 1.0]
#define PURKINJE_SHIFT_B 1.0  // [0.0 to 1.0]

#define VIGNETTE_ENABLED
#define VIGNETTE_STRENGTH 0.1 // [0.1 to 5.0]
#define VIGNETTE_ROUNDNESS 0.5 // [0.1 to 5.0]

vec3 Fast_Reinhard(in vec3 x) {
    return x * rcp(x + vec3(1.0));
}

// [2026-11-12 B1] 调色管线的「与通道无关」部分：泛光/雨幕/曝光/Purkinje/暗角。
// 这些项对同一个像素只是同一个仿射变换 x' = x * mul + add（泛光混合、曝光、Purkinje 的
// mix、暗角都是仿射的），所以色差的三次采样可以共用一份上下文，只把 tone map + gamma
// 留成逐通道。mul/add 的累乘顺序严格按原顺序（泛光 → 雨幕 → 曝光 → Purkinje → 暗角），
// 否则「先乘后加」会得到不同结果（例如暗角必须同时缩 mul 和 add）。
struct GradeCtx {
    vec3 mul;
    vec3 add;
};

// 泛光 + 雨幕的仿射系数：x' = x * mul + add。与场景色无关（只依赖屏幕位置与曝光），
// 因此三个色差通道完全一致。逐项对应原 CombineBloomAndFog 的三种混合模式。
void BloomAffine(out vec3 mul, out vec3 add, in vec2 screenCoord, in float activeExposure) {
    // 泛光数据 = colortex4 左上象限的 L0 画布（半分辨率 box 降采样 + 宽高斯）。
    // 旧代码在此之上又按 0.47 混了一层 tile2：单级管线从不向 colortex4 下半区
    // 写第二级降采样，那里只有 TAA 历史/上一帧残留 —— 会叠出错位、滞后一帧的
    // 重影（点光源呈四个分离小点/双影的元凶之一）。现只取当前帧 L0 画布。
    vec3 bloomData = textureLod(colortex4, screenCoord * 0.5, 0.0).rgb;

    float bloomIntensity = BLOOM_INTENSITY * 0.1;

    #ifdef BLOOMY_FOG
        float fogMask = textureLod(colortex0, screenCoord + taaJitter * 0.5, 0.0).w;
        bloomIntensity = max(bloomIntensity, fogMask * BLOOMY_FOG_INTENSITY);
    #endif

    bloomIntensity *= rcp(activeExposure + 2.0);

    #if BLOOM_BLENDING_MODE == 0
        mul = vec3(1.0);
        add = bloomData * bloomIntensity;
    #elif BLOOM_BLENDING_MODE == 1
        mul = vec3(1.0 - bloomIntensity);
        add = bloomData * bloomIntensity;
    #else
        float denom = rcp(1.0 + bloomIntensity * 0.5);
        mul = vec3(denom);
        add = bloomData * bloomIntensity * denom;
    #endif

    if (rainStrength > 1e-2) {
        float rainAlpha = textureLod(colortex6, screenCoord, 0.0).a;
        rainAlpha = (1.0 - rainAlpha) * RAIN_VISIBILITY;
        // mix(scene, bloomData * 1.25, rainAlpha)
        mul *= 1.0 - rainAlpha;
        add = add * (1.0 - rainAlpha) + bloomData * 1.25 * rainAlpha;
    }
}

// 构建调色上下文。sceneRef 只作 Purkinje 的亮度参考（色差三通道取中心采样即可）。
// skipBloom：调试视图会整屏覆盖 LUT 读数，此时不参与泛光混合（与原顺序等价：原来先混
// 泛光、随后 scene 被整个覆盖，等于泛光被丢掉）。
GradeCtx BuildGradeCtx(in vec3 sceneRef, in vec2 screenCoord, in float activeExposure,
                        in ivec2 texelPos, in bool skipBloom) {
    vec3 mul = vec3(1.0);
    vec3 add = vec3(0.0);

    #ifdef BLOOM
    if (!skipBloom) {
        BloomAffine(mul, add, screenCoord, activeExposure);
    }
    #endif

    // 曝光（仿射：mul 与 add 一起缩）
    mul *= activeExposure;
    add *= activeExposure;

    #ifdef PURKINJE_SHIFT
    {
        // Purkinje 的亮度取自「泛光 + 曝光之后」的参考色，与原 ScotopicVision 一致
        vec3 ref = sceneRef * mul + add;
        const vec3 tint = vec3(PURKINJE_SHIFT_R, PURKINJE_SHIFT_G, PURKINJE_SHIFT_B);

        float rodLuminance = dot(ref, vec3(0.05, 0.55, 0.40));

        #ifdef PURKINJE_SHIFT_NOISE
            rodLuminance *= 0.5 + SampleStbnVec1(texelPos, frameCounter);
        #endif

        float mesopicFactor = saturate((activeExposure * 0.25) * rcp(1.0 + rodLuminance));
        float amount = float(PURKINJE_SHIFT_STRENGTH) * mesopicFactor;

        // mix(scene, vec3(rodLuminance) * tint, amount)
        mul *= 1.0 - amount;
        add = add * (1.0 - amount) + vec3(rodLuminance) * tint * amount;
    }
    #endif

    #ifdef VIGNETTE_ENABLED
    {
        vec2 ndcCoord = screenCoord * 2.0 - 1.0;
        ndcCoord.x *= mix(1.0, aspectRatio, float(VIGNETTE_ROUNDNESS));
        float vig = saturate(1.0 - 0.5 * float(VIGNETTE_STRENGTH) * dot(ndcCoord, ndcCoord));
        mul *= vig;
        add *= vig;
    }
    #endif

    GradeCtx ctx;
    ctx.mul = mul;
    ctx.add = add;
    return ctx;
}

// 用上下文把一个通道推进到「tone map 之前」：只剩一个仿射变换。
vec3 ApplyAffine(in GradeCtx ctx, in vec3 scene) {
    return scene * ctx.mul + ctx.add;
}

// tone map + gamma。注意 AcademyFit 是**跨通道**的（AP0/AP1 矩阵 + 亮度去饱和），
// 所以「先拼通道再 tonemap」与「分别 tonemap 再取通道」不等价 —— 见色差路径的用法。
vec3 ToneMapGamma(in vec3 scene) {
    scene = TONE_MAPPER(scene);
    return saturate(sqrt(scene));
}

// 用上下文结算单个通道：仿射 -> tone map -> gamma。
vec3 FinishGrade(in GradeCtx ctx, in vec3 scene) {
    return ToneMapGamma(ApplyAffine(ctx, scene));
}

vec3 None(in vec3 x) { return x; }

vec3 Lottes(in vec3 x) {
    x *= 2.0;
    const vec3 a      = vec3(1.35);
    const vec3 d      = vec3(0.92);
    const vec3 hdrMax = vec3(8.0);
    const vec3 midIn  = vec3(0.2);
    const vec3 midOut = vec3(0.3);

    const vec3 ad = a * d;
    const vec3 curvedMidIn = pow(midIn, a);
    const vec3 curvedHdrMax = pow(hdrMax, a);
    const vec3 b = -curvedMidIn + curvedHdrMax * midOut;
    const vec3 c = pow(hdrMax, ad) * curvedMidIn - curvedHdrMax * pow(midIn, ad) * midOut;

    return sRGBToLinear(pow(x, a) * (pow(hdrMax, ad) - pow(midIn, ad)) * midOut * rcp(pow(x, ad) * b + c));
}

#include "/lib/post/ACES.glsl"
#include "/lib/post/AgX.glsl"
#include "/lib/post/GT.glsl"

// Grade 主管线：输入未调色场景色，输出 bloom 混合 / 曝光 / Purkinje / 暗角 /
// tone map / gamma 后的最终色。scene 原值来自 colortex0(MOTION_BLUR) 或 colortex1。
// 内部拆成「上下文（与通道无关，可被色差三通道复用）」+「逐通道结算」两步。
vec3 GradeScene(in vec3 scene, in vec2 screenCoord, in float activeExposure) {
    ivec2 texelPos = ivec2(screenCoord * viewSize);

    // 调试视图用 LUT 读数整屏替换场景色。此时不参与泛光混合 —— 与原顺序等价：
    // 原来先混泛光、随后整个 scene 被覆盖，等于泛光被丢掉。
    bool skipBloom = false;

    #ifdef DEBUG_SKY_MAP
        if (all(lessThan(texelPos, textureSize(skyMapTex, 0)))) {
            scene = texelFetch(skyMapTex, texelPos, 0).rgb;
            skipBloom = true;
        }
    #endif

    #ifdef DEBUG_ATMOSPHERE_LUTS
        ivec2 tempTexel = texelPos;
        if (all(lessThan(tempTexel, textureSize(skyViewTex, 0)))) {
            scene = texelFetch(skyViewTex, tempTexel, 0).rgb;
            skipBloom = true;
        }
        tempTexel.x -= textureSize(skyViewTex, 0).x;
        if (clamp(tempTexel, ivec2(0), textureSize(tLutTex, 0) - 1) == tempTexel) {
            scene = texelFetch(tLutTex, tempTexel, 0).rgb * 64.0;
            skipBloom = true;
        }
        tempTexel.x -= textureSize(tLutTex, 0).x;
        if (clamp(tempTexel, ivec2(0), textureSize(msLutTex, 0) - 1) == tempTexel) {
            scene = texelFetch(msLutTex, tempTexel, 0).rgb * 512.0;
            skipBloom = true;
        }
    #endif

    GradeCtx ctx = BuildGradeCtx(scene, screenCoord, activeExposure, texelPos, skipBloom);
    scene = FinishGrade(ctx, scene);

    #ifdef DEBUG_TONE_MAPPING_PLOT
        const float scale = 1.5;
        vec2 uv = screenCoord * vec2(aspectRatio, 1.0) * scale;
        float plot = smoothstep(0.0, scale * viewPixelSize.y, abs(uv.y - TONE_MAPPER(vec3(uv.x)).x));
        scene = vec3(0.25) * step(uv.x, 1.0);
        scene = mix(vec3(1.0), scene, plot);
    #endif

    return scene;
}

float ActiveExposure() {
    #if EXPOSURE_MODE == MANUAL
        return exp2(-MANUAL_EV);
    #else
        return exposure.value;
    #endif
}

// 整数 texel 路径（原 composite31 逐像素行为，逐位一致）
vec3 GradeSceneTexel(in ivec2 texelPos) {
    #ifdef MOTION_BLUR
        vec3 scene = texelFetch(colortex0, texelPos, 0).rgb;
    #else
        vec3 scene = texelFetch(colortex1, texelPos, 0).rgb;
    #endif
    return GradeScene(scene, (vec2(texelPos) + 0.5) * viewPixelSize, ActiveExposure());
}

// 连续 UV 取未调色场景色（色差三通道共享一份调色上下文时用）
vec3 SceneColorUV(in vec2 uv) {
    #ifdef MOTION_BLUR
        return texture(colortex0, uv).rgb;
    #else
        return texture(colortex1, uv).rgb;
    #endif
}

// 连续 UV 路径（色差偏移点 / glitch 采样点）
vec3 GradeSceneUV(in vec2 uv) {
    return GradeScene(SceneColorUV(uv), uv, ActiveExposure());
}
