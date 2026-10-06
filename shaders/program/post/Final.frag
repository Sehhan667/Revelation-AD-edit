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

// [2026-10-06 撕裂距离衰减] 需要 ScreenToViewDepth 把深度换算成视距（lib/universal/Transform.glsl）。
// 该文件在 LOD_MOD（Voxy / DH）分支下引用的 lod* 别名在 Uniform.glsl 三档都已定义，故可安全引入。
#include "/lib/universal/Transform.glsl"

#include "/lib/post/GradeCore.glsl"
#include "/lib/post/KillRipple.glsl"
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

// ---------- 撕裂位移的距离衰减（两个半径；外圈 0 = 关闭衰减 = 旧行为） ----------
// 内圈内满幅，内外圈之间线性降到 0，外圈之外**完全不撕**。见 GlitchTearDistanceFade 的长注释。
#define GLITCH_TEAR_REF_DISTANCE 4.0  // [0 1 2 3 4 6 8 12 16 24 32]
#define GLITCH_TEAR_FADE_DISTANCE 24.0 // [0 4 8 12 16 20 24 32 48 64]

// 手部/贴脸像素的 raw depth 阈值（与包内既有判手部写法同源：KillRipple 与 SSILVB_HAND_DEPTH_THRESHOLD
// 都用 0.56）。手部深度是压缩编码，直接当视距换算会读成"很远"，必须单独放行。
#define GLITCH_HAND_DEPTH 0.56

// ---------- 调试：撕裂距离衰减读数（默认关；GUI「调试」页也能开） ----------
// 打开后整屏变成读数：R = 视距/64 m（越红越远）；G = 撕裂位移系数（亮=满幅、黑=此处完全不撕）；
// B = 材质标志位（0.5 = 实体位，再 +0.5 = 受伤位）。
// 用法：看远处生物那一块 —— R 应很红、B 应有蓝、G 应很暗。G 仍亮 = 衰减没作用到它身上。
//#define DEBUG_GLITCH_TEAR

uniform bool is_hurt;

// ---------- 撕裂位移的距离衰减 ----------
// 撕裂本来是纯屏幕空间位移（|offsetAccum| ≤ 0.15 屏宽 × 强度），与距离完全无关。
// [2026-10-06 第三次修订，改语义] 前两版都按 1/距离缩放，用户反馈"还是不行、远处照撕"——原因是
// **屏幕尺寸本身 ∝ 1/距离**：位移按同一比例缩，等于相对物体永远一样大，观感根本没变。
// 要"自然减小"必须**收敛到 0**，所以改成距离窗口：
//     内圈 GLITCH_TEAR_REF_DISTANCE 内      → 100%
//     内外圈之间                            → 线性降到 0
//     外圈 GLITCH_TEAR_FADE_DISTANCE 之外   → 完全不撕
// 外圈设 0（或 ≤ 内圈）＝ 关闭衰减 ＝ 旧的全屏等幅行为。
// 视距取 depthtex1（含半透明 = 看得见的表面；水面/彩色玻璃才吃到自己的深度，DOF 也用这张）。
// raw depth < GLITCH_HAND_DEPTH 的像素（手部、贴脸几何）恒满幅：手部深度是压缩编码，
// 直接当视距换算会读成很远（见 DeferredLight.frag 的 HAND_DEPTH_OFFSET）。
// 判断"关闭"用运行期比较，不用 #if 比浮点 —— 实测 Iris 的 jcpp 只按整数部分比较浮点。
// 作用范围：实体区域故障两个分支；全屏受伤屏闪按用户要求保持等幅。
float GlitchTearDistanceFade(in ivec2 texel) {
    if (loadDepth0(texel) < GLITCH_HAND_DEPTH) return 1.0;
    // [2026-10-06 符号修正（前三次"没用"的真因）] ScreenToViewDepth 返回的是**视空间 z（负数）**，
    // 不是距离：GL 视空间相机前方 z < 0。所以负数直接和 4.0 比会**恒为真**（永远"在内圈"）⇒ 恒满幅。
    // 包内取距离的写法都带负号（DOF/Prepare.comp:58、DOF/Gather.comp:224 都是 -ScreenToViewDepth...），
    // 这里照做。以后改这段务必先确认符号，或直接看 GUI 的「撕裂距离衰减读数」。
    float viewDist = -ScreenToViewDepth(loadDepth1(texel));
    if (viewDist <= GLITCH_TEAR_REF_DISTANCE) return 1.0;
    if (GLITCH_TEAR_FADE_DISTANCE <= GLITCH_TEAR_REF_DISTANCE) return 1.0;
    return clamp((GLITCH_TEAR_FADE_DISTANCE - viewDist) / (GLITCH_TEAR_FADE_DISTANCE - GLITCH_TEAR_REF_DISTANCE), 0.0, 1.0);
}

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
        // [2026-09-20 帧级门控] colortex10 的 (0,0).B = HurtTimer（composite5）每帧聚合的
        // 「上一帧稀疏网格上存在受伤实体」标志（R > 0 ⟺ 受伤实体 mask）。常态（无受伤
        // 实体）下整段跳过——否则全屏每像素无条件白付 7 次 sin 链 + GLITCH_TEAR_LAYERS
        // 层撕裂循环（约 27 次 SFU sin + ~40 ALU）。标志晚一帧（受击首帧故障延迟一帧
        // 显示，无感）；KILL_RIPPLE 关闭时 B 恒 1，本特效保持无门控的原行为。
        // [2026-09-22 门控修复] 原帧级门控 `if (texelFetch(colortex10, ivec2(0,0),0).b > 0.5)` 已移除。
        // 原因：B 由 composite5(HurtTimer) 写入，而 composite5 被 properties 的
        // `program.world0/composite5.enabled = KILL_RIPPLE` 门控、KILL_RIPPLE 默认关闭
        // ⇒ 该 pass 根本不调度 ⇒ colortex10 既不写也不清（colortex10Clear = false）
        // ⇒ B 恒为未初始化值（实测 0）⇒ 门控恒假 ⇒ **实体受伤特效整个消失**。
        // 故本段改回无条件执行（本次只改这一处，KILL_RIPPLE / colortex10 / 8 个文件全部保持原样）。
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
            // [2026-10-06 距离衰减] 位移先乘 tearScale（按受伤实体自身的视距，见 GlitchTearDistanceFade）。
            // 先按当前像素的 k 定位源像素；若源是受伤实体，说明真正的被撕对象在那一侧，
            // 改用源的 k 重算并重取一次 —— 「被拖走的条带」与「补洞」必须共用同一个 k，
            // 否则遮罩判定和取色会错开；同时避免近处实体叠在远背景/天空上时被背景的视距把位移砍掉。
            float rawShift = offsetAccum * intensity;
            float tearScale = GlitchTearDistanceFade(texelPos);
            ivec2 srcTexel = texelPos;
            srcTexel.x -= int(round(rawShift * tearScale * float(viewWidth)));
            srcTexel.x = clamp(srcTexel.x, 0, int(viewWidth) - 1);
            uvec4 srcPack = texelFetch(colortex7, srcTexel, 0);
            uint srcW = srcPack.w;
            bool srcIsEntity = ((srcW & 1u) != 0u) && ((srcW & 2u) != 0u) && srcPack.y != 1u;
            if (srcIsEntity) {
                float srcScale = GlitchTearDistanceFade(srcTexel);
                if (srcScale != tearScale) {
                    tearScale = srcScale;
                    srcTexel = texelPos;
                    srcTexel.x -= int(round(rawShift * tearScale * float(viewWidth)));
                    srcTexel.x = clamp(srcTexel.x, 0, int(viewWidth) - 1);
                    uvec4 srcPack2 = texelFetch(colortex7, srcTexel, 0);
                    // 重取后要重新判定（含手部排除 srcPack.y != 1，与第一遍的判据保持一致）
                    srcIsEntity = ((srcPack2.w & 1u) != 0u) && ((srcPack2.w & 2u) != 0u) && srcPack2.y != 1u;
                }
            }
            if (tearScale > 0.0 && (srcIsEntity || (isEntity && isHurt && matPack.y != 1u))) {
                float shiftUv = rawShift * tearScale;
                float chroma = 0.1 * tearScale;   // 色散偏移也同比例衰减，否则远处不撕裂却仍掉色边
                float uvR = loop(uv.x - (shiftUv + r6 * chroma));
                float uvG = loop(uv.x - shiftUv);
                float uvB = loop(uv.x - (shiftUv - r7 * chroma));

                vec3 glitchColor;
                glitchColor.r = LoadGradedUV(vec2(uvR, uv.y)).r;
                glitchColor.g = LoadGradedUV(vec2(uvG, uv.y)).g;
                glitchColor.b = LoadGradedUV(vec2(uvB, uv.y)).b;

                finalOut = glitchColor;
            }
        #else
            // ===== 旧撕裂：仅实体内部颜色错位，轮廓保持不动 =====
            // [2026-10-06 距离衰减] 位移整体乘 tearScale；这里是当前像素本身即受伤实体，取其视距即可
            float tearScale = GlitchTearDistanceFade(texelPos);
            if (tearScale > 0.0 && isEntity && isHurt && matPack.y != 1u) {
                float uvR = loop(uv.x + (offsetAccum - r6 * 0.1) * intensity * tearScale);
                float uvG = loop(uv.x + offsetAccum * intensity * tearScale);
                float uvB = loop(uv.x + (offsetAccum + r7 * 0.1) * intensity * tearScale);

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

    // ========== 击杀特效：实体持续变红超时 → 手部物品脉冲 ==========
    #ifdef KILL_RIPPLE
    float killPulse = texelFetch(colortex10, ivec2(0, 0), 0).g;
    if (killPulse > 0.0) {
        // 手部识别：materialID==1u（手）且深度足够近（排除近处雨雪）
        uvec4 handPack = texelFetch(colortex7, texelPos, 0);
        bool isHand = (handPack.y == 1u) && (loadDepth0(texelPos) < KILL_RIPPLE_HAND_DEPTH);

        // 脉冲进度 0→1，fade 用二次曲线让末尾快速消失
        float killProgress = 1.0 - clamp(killPulse / KILL_RIPPLE_DURATION, 0.0, 1.0);
        float killFade = (1.0 - killProgress) * (1.0 - killProgress);

        // 1) 手部物品整体泛白提亮
        if (isHand) {
            finalOut = mix(finalOut, vec3(1.0), KILL_RIPPLE_HIGHLIGHT * killFade);
        }

        // 2) 扩散涟漪：以当前半径为距离向 8 个方向采样手部 mask，命中即为环上的点
        int ringR = int(round(killProgress * KILL_RIPPLE_RANGE));
        if (ringR > 0) {
            const ivec2 ringDir[8] = ivec2[8](
                ivec2( 1,  0), ivec2(-1,  0), ivec2( 0,  1), ivec2( 0, -1),
                ivec2( 1,  1), ivec2( 1, -1), ivec2(-1,  1), ivec2(-1, -1)
            );
            for (int i = 0; i < 8; ++i) {
                ivec2 ringTexel = texelPos + ringDir[i] * ringR;
                if (clamp(ringTexel, ivec2(0), ivec2(int(viewWidth), int(viewHeight)) - 1) == ringTexel) {
                    uvec4 rp = texelFetch(colortex7, ringTexel, 0);
                    if (rp.y == 1u && loadDepth0(ringTexel) < KILL_RIPPLE_HAND_DEPTH) {
                        finalOut = mix(finalOut, vec3(1.0), killFade);
                        break;
                    }
                }
            }
        }
    }
    #endif

    // ========== 调试：显示击杀特效稀疏采样点 ==========
    #ifdef DEBUG_KILL_RIPPLE_GRID
        const int debugGrid = KILL_RIPPLE_GRID;
        int dgx = clamp(int(floor(float(texelPos.x) * float(debugGrid) / viewWidth)), 0, debugGrid - 1);
        int dgy = clamp(int(floor(float(texelPos.y) * float(debugGrid) / viewHeight)), 0, debugGrid - 1);
        int dsx = min(int((dgx + 0.5) * viewWidth / float(debugGrid)), int(viewWidth) - 1);
        int dsy = min(int((dgy + 0.5) * viewHeight / float(debugGrid)), int(viewHeight) - 1);
        if (all(lessThanEqual(abs(texelPos - ivec2(dsx, dsy)), ivec2(1)))) {
            float debugT = clamp(texelFetch(colortex10, texelPos, 0).r / KILL_RIPPLE_TRIGGER_TIME, 0.0, 1.0);
            finalOut = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), smoothstep(0.5, 1.0, debugT));
        }
    #endif

    // [2026-09 A/B 结论] 静态 Bayer(bayer16/64) 会在雾这类平滑渐变上留下固定
    // 矩阵条纹（等亮度轮廓沿矩阵阈值线排列，静止不动、随雾亮度场锚定）。
    // 改为逐帧 STBN 时空蓝噪声：帧间图案去相关 → 无固定条纹，同时压 8-bit 量化带。
    // 若静止画面仍有可见量化带，把振幅 rcp255 后乘 1.5~2.0；若嫌时间噪声明显则乘 0.75。
    finalOut += (SampleStbnVec1(texelPos, frameCounter) - 0.5) * rcp255;

    // [2026-10-06 调试] 撕裂距离衰减读数（GUI「调试」页可开，源码里也能取消注释）。
    //   R = 视距/64 m（越红越远）  G = 撕裂位移系数（亮=满幅、黑=完全不撕）  B = 材质标志位（实体+0.5 / 受伤+0.5）
    // 排查"远处仍然撕得很远"：看远处生物/水面所在的位置 —— R 应很红、B 应有蓝、G 应很暗。
    // G 仍然亮 ⇒ 衰减没作用到那个像素（视距读错或不是这条路径）。放在最后 ⇒ 不被其它段覆盖。
    #ifdef DEBUG_GLITCH_TEAR
        uint dbgMat = texelFetch(colortex7, texelPos, 0).w;
        float dbgFlags = 0.5 * float((dbgMat & 1u) != 0u) + 0.5 * float((dbgMat & 2u) != 0u);
        finalOut = vec3(saturate(-ScreenToViewDepth(loadDepth1(texelPos)) / 64.0),
                        GlitchTearDistanceFade(texelPos),
                        dbgFlags);
    #endif
}