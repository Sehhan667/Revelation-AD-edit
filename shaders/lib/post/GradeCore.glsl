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
#define POTATO_GAMMA_APPROX         // 启用土豆级 Gamma 逼近：单周期硬件 sqrt 近似替代昂贵的全局 pow

#define TONE_MAPPER AcademyFit // [None AcademyFit AcademyFull AgX_Minimal AgX_Full Lottes GT GT7 Fast_Reinhard]

#define GAMMA_CORRECTION 3.0 // [1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.1 2.2 2.3 2.4 2.5 2.6 2.7 2.8 2.9 3.0 3.1 3.2 3.3 3.4 3.5 3.6 3.7 3.8 3.9 4.0 4.1 4.2 4.3 4.4 4.5 4.6 4.7 4.8 4.9 5.0]

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

// 泛光混合。screenCoord 为采样点 UV（texel 路径 = (texel+0.5)*viewPixelSize，与
// 原 gl_FragCoord.xy * viewPixelSize 逐位一致）。
void CombineBloomAndFog(inout vec3 scene, in vec2 screenCoord, in float activeExposure) {
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
        scene += bloomData * bloomIntensity;
    #elif BLOOM_BLENDING_MODE == 1
        scene = mix(scene, bloomData, bloomIntensity);
    #else
        scene = (scene + bloomData * bloomIntensity) * rcp(1.0 + bloomIntensity * 0.5);
    #endif

    if (rainStrength > 1e-2) {
        float rainAlpha = textureLod(colortex6, screenCoord, 0.0).a;
        rainAlpha = (1.0 - rainAlpha) * RAIN_VISIBILITY;
        scene = mix(scene, bloomData * 1.25, rainAlpha);
    }
}

vec3 ScotopicVision(in vec3 colorData, in float activeExposure, in ivec2 texelPos) {
    const vec3 tint = vec3(PURKINJE_SHIFT_R, PURKINJE_SHIFT_G, PURKINJE_SHIFT_B);

    float rodLuminance = dot(colorData, vec3(0.05, 0.55, 0.40));

    float mesopicFactor = saturate((activeExposure * 0.25) * rcp(1.0 + rodLuminance));

    #ifdef PURKINJE_SHIFT_NOISE
        rodLuminance *= 0.5 + SampleStbnVec1(texelPos, frameCounter);
    #endif

    return mix(colorData, vec3(rodLuminance) * tint, float(PURKINJE_SHIFT_STRENGTH) * mesopicFactor);
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
vec3 GradeScene(in vec3 scene, in vec2 screenCoord, in float activeExposure) {
    ivec2 texelPos = ivec2(screenCoord * viewSize);

    #ifdef BLOOM
        CombineBloomAndFog(scene, screenCoord, activeExposure);
    #endif

    #ifdef DEBUG_SKY_MAP
        if (all(lessThan(texelPos, textureSize(skyMapTex, 0)))) {
            scene = texelFetch(skyMapTex, texelPos, 0).rgb;
        }
    #endif

    #ifdef DEBUG_ATMOSPHERE_LUTS
        ivec2 tempTexel = texelPos;
        if (all(lessThan(tempTexel, textureSize(skyViewTex, 0)))) {
            scene = texelFetch(skyViewTex, tempTexel, 0).rgb;
        }
        tempTexel.x -= textureSize(skyViewTex, 0).x;
        if (clamp(tempTexel, ivec2(0), textureSize(tLutTex, 0) - 1) == tempTexel) {
            scene = texelFetch(tLutTex, tempTexel, 0).rgb * 64.0;
        }
        tempTexel.x -= textureSize(tLutTex, 0).x;
        if (clamp(tempTexel, ivec2(0), textureSize(msLutTex, 0) - 1) == tempTexel) {
            scene = texelFetch(msLutTex, tempTexel, 0).rgb * 512.0;
        }
    #endif

    scene *= activeExposure;

    #ifdef PURKINJE_SHIFT
        scene = ScotopicVision(scene, activeExposure, texelPos);
    #endif

    #ifdef VIGNETTE_ENABLED
        vec2 ndcCoord = screenCoord * 2.0 - 1.0;
        ndcCoord.x *= mix(1.0, aspectRatio, float(VIGNETTE_ROUNDNESS));
        scene *= saturate(1.0 - 0.5 * float(VIGNETTE_STRENGTH) * dot(ndcCoord, ndcCoord));
    #endif

    {
        scene = TONE_MAPPER(scene);

        #ifdef POTATO_GAMMA_APPROX
            scene = saturate(sqrt(scene));
        #else
            scene = saturate(pow(scene, vec3(1.0 / (GAMMA_CORRECTION))));
        #endif
    }

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

// 连续 UV 路径（色差偏移点 / glitch 采样点）
vec3 GradeSceneUV(in vec2 uv) {
    #ifdef MOTION_BLUR
        vec3 scene = texture(colortex0, uv).rgb;
    #else
        vec3 scene = texture(colortex1, uv).rgb;
    #endif
    return GradeScene(scene, uv, ActiveExposure());
}
