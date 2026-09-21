/*
--------------------------------------------------------------------------------
    Revelation Shaders
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.





    Pass: Contrast adaptive sharpening and final output 
          (Startup Logo + Screen Hurt FX + Entity Area Glitch)
    Uses low 2 bits of materialOut.w for entity/hurt flags.
    Added: GLITCH_TEAR_LAYERS, ALWAYS_GLITCH macro.
--------------------------------------------------------------------------------

*/

//======// Utility //=============================================================================//
#include "/lib/Utility.glsl"
//======// Config //==============================================================================//
#include "/config.glsl"
//======// Output //==============================================================================//
out vec3 finalOut;
//======// Uniform //=============================================================================//
#include "/lib/universal/Uniform.glsl"
//======// SSBO //================================================================================//
#define SSBO_DECLARED_TPYE restrict
#include "/lib/universal/SSBO.glsl"
//======// Function //============================================================================//
#include "/lib/universal/Random.glsl"

#include "/lib/post/GradeCore.glsl"
#include "/lib/post/StartupLogo.glsl"

// [2026-09-21 Grade+Final 合并] CAS 关闭档（默认）下 composite31 不调度，本 pass
// 内联执行完整调色管线（GradeCore.glsl，与原 Grade pass 同一份函数与选项）；
// CAS 开启档 composite31 照旧运行、colortex0 已是 graded 图，直接采样。
#ifdef CAS_ENABLED
    vec3 LoadGradedTexel(in ivec2 texel) { return texelFetch(colortex0, texel, 0).rgb; }
    vec3 LoadGradedUV(in vec2 uv) { return texture(colortex0, uv).rgb; }
#else
    vec3 LoadGradedTexel(in ivec2 texel) { return GradeSceneTexel(texel); }
    vec3 LoadGradedUV(in vec2 uv) { return GradeSceneUV(uv); }
#endif

// [2026-09] 启动 logo 改为矢量绘制：形状与绘制动画都在 lib/post/StartupLogo.glsl 里，
// 原来是采样 shaders/texture/logo.png（128x128 位图放大 5 倍，边缘全是方块）。
// STARTUP_LOGO 关掉时整段不参与编译，与改动前一致。
// 注意：logo.png 现在不再被 shader 引用（文件保留没删，方便对照形状）。
#define STARTUP_LOGO

// ---------- 调试：始终显示全屏故障（取消注释即生效） ----------
//#define ALWAYS_GLITCH

// ---------- 全屏受伤故障 ----------
#define GLITCH_VISUAL
#define HURT_GLITCH_INTENSITY 0.4 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]

// ---------- 实体区域故障 ----------
#define ENTITY_AREA_GLITCH
#define ENTITY_AREA_GLITCH_INTENSITY 0.3 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]

// ---------- 撕裂层数（推荐 2~6） ----------
#define GLITCH_TEAR_LAYERS 10 // [2 3 4 5 6 7 8 9 10 11 12 13 14 15 16]

// ---------- 实体撕裂模式 ----------
#define ENTITY_GLITCH_OUTLINE_TEAR // [注释以关闭] 开启：实体轮廓随条带一起撕裂（缺口用邻近背景近似填充）；关闭：旧版仅内部颜色错位

uniform bool is_hurt;

vec3 FFXCasFilter(in ivec2 texel, in float sharpness) {
    #define CasLoad(offset) LoadGradedTexel(texel + (offset))
    #ifndef CAS_ENABLED
        return CasLoad(ivec2(0, 0));
    #endif
    vec3 e = CasLoad(ivec2( 0,  0));
    vec3 b = CasLoad(ivec2( 0, -1));
    vec3 d = CasLoad(ivec2(-1,  0));
    vec3 f = CasLoad(ivec2( 1,  0));
    vec3 h = CasLoad(ivec2( 0,  1));
    vec3 minCol = min(min(min(d, e), min(f, b)), h);
    vec3 maxCol = max(max(max(d, e), max(f, b)), h);
    vec3 a = CasLoad(ivec2(-1, -1));
    vec3 c = CasLoad(ivec2( 1, -1));
    vec3 g = CasLoad(ivec2(-1,  1));
    vec3 i = CasLoad(ivec2( 1,  1));
    minCol += min(min(min(a, c), min(g, i)), minCol);
    maxCol += max(max(max(a, c), max(g, i)), maxCol);
    vec3 amp = sqrt(saturate(min(minCol, 2.0 - maxCol) / maxCol));
    vec3 w = amp * -(1.0 / mix(8.0, 5.0, sharpness));
    return saturate(((b + d + f + h) * w + e) / (1.0 + 4.0 * w));
}

#include "/lib/universal/TextRenderer.glsl"
void HistogramDisplay(inout vec3 color, in ivec2 texel) {
    const int binWidth = 2;
    if (all(lessThan(texel, ivec2(HISTOGRAM_BIN_COUNT * binWidth, 256)))) {
        int binIndex = texel.x / binWidth;
        uint binValue = exposure.histogram[binIndex];
        color = vec3(step(texel.y + 1, binValue));
    }
}

// ---------- 横向色差（Chromatic Aberration）：镜头终点一次性整体效果 ----------
// 对已 tone-map 完成的 colortex0 做径向 RGB 通道分离：R 略向外、B 略向内、G 不动。
// 强度 CHROMATIC_ABERRATION_STRENGTH 定义为四角最大偏移像素数，随到中心距离线性增长
// （中心无色散，符合真实镜头）。这个效果不新增 pass，只在本 pass 采样时生效。
vec3 LoadChromaticScene(in ivec2 texel) {
    vec3 e = FFXCasFilter(texel, CAS_STRENGTH);
#ifdef CHROMATIC_ABERRATION
    vec2 uv = (vec2(texel) + 0.5) * viewPixelSize;
    vec2 c = uv - 0.5;
    float dist = length(c);
    float distNorm = dist * rcp(0.70710678118); // 除以半对角，四角归一为 1.0
    vec2 dir = c * rcp(maxEps(dist));
    vec2 off = dir * (CHROMATIC_ABERRATION_STRENGTH * distNorm) * viewPixelSize;
    return vec3(
        LoadGradedUV(uv + off).r,
        e.g,
        LoadGradedUV(uv - off).b
    );
#else
    return e;
#endif
}

float loop(float x) {
    x = mix(x, x - 1.0, float(x > 1.0));
    x = mix(x, x + 1.0, float(x < 0.0));
    return x;
}

// [2026-09-20 hash 统一] 三段故障特效（实体区域 / 全屏 ALWAYS / 全屏 is_hurt）共用同一份
// 随机序列 + 多层撕裂偏移场——原先三段各抄一遍完整 sin 链（触发时每像素 27+ 次 sin）。
// 抽出为函数后数学逐位等价（同一 sin 链、同一撕裂循环、同一求和顺序）。
// r1..r7 由帧种子（frameTimeCounter * 16 取整）驱动，为帧内常数；撕裂循环按 uv.y 分层
// 采样出条带位移 offsetAccum ∈ [-0.15, 0.15]；r6/r7 供 RGB 三通道的色散微偏移。
// 各消费段只需要 offsetAccum / r6 / r7 三个输出（r1-r5 仅在链内部使用）。
void ComputeGlitchField(in vec2 uv, out float offsetAccum, out float r6, out float r7) {
    float seed = floor(frameTimeCounter * 16.0);
    float r1 = fract(sin(seed * 0.012989) * 43758.5453123);
    float r2 = fract(sin(r1 * 2.0 * 0.012989) * 43758.5453123);
    float r3 = fract(sin(r2 * 3.0 * 0.012989) * 43758.5453123);
    float r4 = fract(sin(r3 * 4.0 * 0.012989) * 43758.5453123);
    float r5 = fract(sin(r4 * 5.0 * 0.012989) * 43758.5453123);
    r6 = fract(sin(r5 * 6.0 * 0.012989) * 43758.5453123);
    r7 = fract(sin(r6 * 7.0 * 0.012989) * 43758.5453123);

    // 多层撕裂
    const int layers = GLITCH_TEAR_LAYERS;
    offsetAccum = 0.0;
    for (int i = 0; i < layers; i++) {
        float fi = float(i);
        float threshold = fract(sin(r1 * (12.9898 + fi) + r2 * (78.233 - fi)) * 43758.5453);
        threshold = threshold * 0.6 + 0.2;
        float seg = mix(r3, mix(r4, r5, step(threshold, uv.y)), step(1.0 - threshold, uv.y));
        offsetAccum += seg;
    }
    offsetAccum /= float(layers);
    offsetAccum = (offsetAccum * 2.0 - 1.0) * 0.15;
}

void main() {
    ivec2 texelPos = ivec2(gl_FragCoord.xy);
    if (texelPos == ivec2(0)) { global.prevWorldTime = worldTime; }

    #ifdef DEBUG_BLOOM_TILES
        finalOut = texelFetch(colortex4, texelPos, 0).rgb;
    #else
        finalOut = LoadChromaticScene(texelPos);
    #endif

    // 启动 logo（矢量绘制 + 逐笔描画 + 淡出）
    #ifdef STARTUP_LOGO
        // 时间轴：主字形 0~48 帧扫出来，文字 34~58 帧接上，
        // 画完后**停 110 帧**再开始淡出，180 帧结束。
        // （停顿时长就是这里的 logoFadeStart；原来是 80，按要求多了 0.5 秒 = 30 帧。）
        const int logoDuration = 180, logoFadeStart = 110;
        if (frameCounter < logoDuration) {
            float fade = 1.0 - smoothstep(float(logoFadeStart), float(logoDuration), float(frameCounter));
            vec2 screenUV = (vec2(texelPos) + 0.5) / vec2(viewWidth, viewHeight);
            float logoCoverage = StartupLogoMask(screenUV, vec2(viewWidth, viewHeight), float(frameCounter)).x;
            // 纯白（按需求：与截图里的白色一致）
            finalOut = mix(finalOut, vec3(1.0), logoCoverage * fade);
        }
    #endif

    // ========== 实体区域故障 ==========
    #ifdef ENTITY_AREA_GLITCH
        // [2026-09-21] 帧级门控已移除（随 KILL_RIPPLE 一起删除）。
        // 该门控读 colortex10.b = HurtTimer（composite5）写入的「屏幕上存在受伤实体」标志，
        // 而 composite5 在 properties 里被 `composite5.enabled = KILL_RIPPLE` 门控、
        // KILL_RIPPLE 默认关闭（profile.Default 是 !KILL_RIPPLE）⇒ 该 pass 根本不调度、
        // colortex10 既不写也不清（colortex10Clear = false）⇒ B 恒为未初始化值（实测 0）
        // ⇒ 门控恒假 ⇒ **实体受伤特效整个消失**（这就是本轮报的 bug）。
        // 现在 KILL_RIPPLE 已整体移除、colortex10 随之废弃 ⇒ 本段回到 ddd28690 之前的
        // 无条件执行。代价：常态下全屏每像素白付 7 次 sin 链 + GLITCH_TEAR_LAYERS 层撕裂循环。
        uvec4 matPack = texelFetch(colortex7, texelPos, 0);
        uint matW = matPack.w;
        bool isEntity = ((matW & 1u) != 0u);          // bit0
        bool isHurt   = ((matW & 2u) != 0u);          // bit1

        float intensity = ENTITY_AREA_GLITCH_INTENSITY;
        vec2 uv = (vec2(texelPos) + 0.5) / vec2(viewWidth, viewHeight);
        float offsetAccum, r6, r7;
        ComputeGlitchField(uv, offsetAccum, r6, r7);

        #ifdef ENTITY_GLITCH_OUTLINE_TEAR
            // ===== 新撕裂：实体轮廓随条带一起水平位移，缺口用邻近背景近似填充 =====
            // 内容来源像素 = 当前像素 - 条带位移（像素）。来源处是受伤实体则被拖拽到当前位置；
            // 当前是实体但来源不是（条带移走后的缺口），则用来源处的背景像素近似填充
            ivec2 srcTexel = texelPos;
            srcTexel.x -= int(round(offsetAccum * intensity * float(viewWidth)));
            srcTexel.x = clamp(srcTexel.x, 0, int(viewWidth) - 1);
            uvec4 srcPack = texelFetch(colortex7, srcTexel, 0);
            uint srcW = srcPack.w;
            bool srcIsEntity = ((srcW & 1u) != 0u) && ((srcW & 2u) != 0u) && srcPack.y != 1u;
            if (srcIsEntity || (isEntity && isHurt && matPack.y != 1u)) {
                float shiftUv = offsetAccum * intensity;
                float uvR = loop(uv.x - (shiftUv + r6 * 0.1));
                float uvG = loop(uv.x - shiftUv);
                float uvB = loop(uv.x - (shiftUv - r7 * 0.1));

                vec3 glitchColor;
                glitchColor.r = LoadGradedUV(vec2(uvR, uv.y)).r;
                glitchColor.g = LoadGradedUV(vec2(uvG, uv.y)).g;
                glitchColor.b = LoadGradedUV(vec2(uvB, uv.y)).b;

                finalOut = glitchColor;
            }
        #else
            // ===== 旧撕裂：仅实体内部颜色错位，轮廓保持不动 =====
            if (isEntity && isHurt && matPack.y != 1u) {
                float uvR = loop(uv.x + (offsetAccum - r6 * 0.1) * intensity);
                float uvG = loop(uv.x + offsetAccum * intensity);
                float uvB = loop(uv.x + (offsetAccum + r7 * 0.1) * intensity);

                vec3 glitchColor;
                glitchColor.r = LoadGradedUV(vec2(uvR, uv.y)).r;
                glitchColor.g = LoadGradedUV(vec2(uvG, uv.y)).g;
                glitchColor.b = LoadGradedUV(vec2(uvB, uv.y)).b;

                finalOut = mix(finalOut, glitchColor, intensity);
            }
        #endif
    #endif

    // ========== 全屏受伤故障（支持始终显示） ==========
    #ifdef GLITCH_VISUAL
        // ALWAYS_GLITCH 开启时无视 is_hurt，强制显示故障
        #ifdef ALWAYS_GLITCH
            const float intensity = HURT_GLITCH_INTENSITY;
            vec2 uv = (vec2(texelPos) + 0.5) / vec2(viewWidth, viewHeight);
            float offsetAccum, r6, r7;
            ComputeGlitchField(uv, offsetAccum, r6, r7);

            float uvR = loop(uv.x + (offsetAccum - r6 * 0.1) * intensity);
            float uvG = loop(uv.x + offsetAccum * intensity);
            float uvB = loop(uv.x + (offsetAccum + r7 * 0.1) * intensity);

            vec3 glitchColor;
            glitchColor.r = LoadGradedUV(vec2(uvR, uv.y)).r;
            glitchColor.g = LoadGradedUV(vec2(uvG, uv.y)).g;
            glitchColor.b = LoadGradedUV(vec2(uvB, uv.y)).b;

            finalOut = mix(finalOut, glitchColor, intensity);
        #else
            if (is_hurt) {
                const float intensity = HURT_GLITCH_INTENSITY;
                vec2 uv = (vec2(texelPos) + 0.5) / vec2(viewWidth, viewHeight);
                float offsetAccum, r6, r7;
                ComputeGlitchField(uv, offsetAccum, r6, r7);

                float uvR = loop(uv.x + (offsetAccum - r6 * 0.1) * intensity);
                float uvG = loop(uv.x + offsetAccum * intensity);
                float uvB = loop(uv.x + (offsetAccum + r7 * 0.1) * intensity);

                vec3 glitchColor;
                glitchColor.r = LoadGradedUV(vec2(uvR, uv.y)).r;
                glitchColor.g = LoadGradedUV(vec2(uvG, uv.y)).g;
                glitchColor.b = LoadGradedUV(vec2(uvB, uv.y)).b;

                finalOut = mix(finalOut, glitchColor, intensity);
            }
        #endif
    #endif

    // 调试纹理显示
    #ifdef DEBUG_CLOUD_SHADOWS
        if (all(lessThan(texelPos, textureSize(cloudShadowTex, 0)))) {
            finalOut = vec3(texelFetch(cloudShadowTex, texelPos, 0).x);
        }
    #endif
    #ifdef DEBUG_CLOUD_MAP
        ivec2 tempTexel = texelPos;
        if (all(lessThan(tempTexel, textureSize(cloudMapTex, 0)))) {
            finalOut = vec3(texelFetch(cloudMapTex, tempTexel, 0).x);
        }
        tempTexel.x -= textureSize(cloudMapTex, 0).x;
        if (clamp(tempTexel, ivec2(0), textureSize(cloudMapTex, 0) - 1) == tempTexel) {
            finalOut = vec3(texelFetch(cloudMapTex, tempTexel, 0).y);
        }
    #endif
    #ifdef DEBUG_CLOUD_NOISE
        if (all(lessThan(texelPos, textureSize(baseNoiseTex, 0).xy))) {
            finalOut = vec3(texelFetch(baseNoiseTex, ivec3(texelPos, 0), 0).x);
        }
    #endif

    // [2026-09 A/B 结论] 静态 Bayer(bayer16/64) 会在雾这类平滑渐变上留下固定
    // 矩阵条纹（等亮度轮廓沿矩阵阈值线排列，静止不动、随雾亮度场锚定）。
    // 改为逐帧 STBN 时空蓝噪声：帧间图案去相关 → 无固定条纹，同时压 8-bit 量化带。
    // 若静止画面仍有可见量化带，把振幅 rcp255 后乘 1.5~2.0；若嫌时间噪声明显则乘 0.75。
    finalOut += (SampleStbnVec1(texelPos, frameCounter) - 0.5) * rcp255;
    
}