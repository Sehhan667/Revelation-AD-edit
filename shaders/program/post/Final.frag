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

// [2026-11-11 v2 启动面板 / 2026-11-12 v8] 毛玻璃背板来自 composite32/33/34 的 1/8 模糊链
// （见 program/post/StartupPanelBlur.comp），这里只做读取 + 一次显示变换。
// 输入是**未调色的线性 HDR**（colortex1 的 1/8 降采样高斯结果），
// 所以调色（曝光 / tone map / gamma / 暗角）只在这里做一次，且必须走 GradeScene ——
// 与面板外像素同一套参数，面板亮度才天然与周围一致（手写 sqrt 会缺 tone map，看着是暗块）。
// v8：1/8 结果存在**全分辨率缓冲左上角的象限画布**里（不再用 size.buffer 缩小缓冲，
// 那块在实机里读回来恒为 0 ⇒ 面板全黑），所以采样 UV 要乘 1/8。
// 只声明在这一个 program 里：加进 Uniform.glsl 会让每个 pass 都多占一个纹理单元。
uniform sampler2D colortex27;

// 兜底：模糊链万一没产出（画布读回 0），用 5 tap 十字平均给一层轻度雾面。
// 这个功能历史上反复栽在「面板变成一块纯黑」上，所以宁可糊得不够也不出黑块 ——
// 真出问题时的症状是「糊得不够」而不是「全黑」，一眼就能分清是链路还是外观。
// 采样源固定取 colortex1（TAA 输出的**未调色**线性 HDR），不按照 LoadGradedTexel 的口径
// 切 colortex0：CAS 档下 colortex0 已是调过色的显示空间图，再喂给 GradeScene 会二次调色。
// colortex1 两档下都还是未调色原图；兜底只求「不是黑块」，不追求与运动模糊逐像素一致。
vec3 StartupPanelFallbackBlur(in vec2 uv) {
    vec2 stepUV = viewPixelSize * 6.0;
    vec3 color = textureLod(colortex1, uv, 0.0).rgb * 2.0;
    color += textureLod(colortex1, uv + vec2(stepUV.x, 0.0), 0.0).rgb;
    color += textureLod(colortex1, uv - vec2(stepUV.x, 0.0), 0.0).rgb;
    color += textureLod(colortex1, uv + vec2(0.0, stepUV.y), 0.0).rgb;
    color += textureLod(colortex1, uv - vec2(0.0, stepUV.y), 0.0).rgb;
    return color / 6.0;
}

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

    // 启动 logo（[2026-10-08] 整幅淡入 → 保持 → 整幅淡出；不再逐笔描画）
    #ifdef STARTUP_LOGO
        // 时间轴（帧）：0 → LOGO_FADE_IN_FRAMES 淡入，(logoDuration - LOGO_FADE_OUT_FRAMES)
        // → logoDuration 淡出，中间是保持段。两条常量在 lib/post/StartupLogo.glsl 里（#ifndef 兜底）。
        // 总时长 240 帧 = 4 秒 @60fps（原 180 = 3 秒）；淡入 32 帧、淡出 80 帧
        // ⇒ 保持 128 帧。淡入/淡出都按 4/3 等比加长，节奏与原来一致。
        // 帧率不同则实际秒数不同（50fps 下 4.8 秒），与原实现同一口径：按帧计数。
        const int logoDuration = LOGO_DURATION_FRAMES;
        if (frameCounter < logoDuration) {
            float logoFrame = float(frameCounter);
            float fadeIn  = LOGO_FADE_IN_FRAMES  > 0.0 ? smoothstep(0.0, LOGO_FADE_IN_FRAMES, logoFrame) : 1.0;
            float fadeOut = 1.0 - smoothstep(float(logoDuration) - LOGO_FADE_OUT_FRAMES,
                                             float(logoDuration), logoFrame);
            float fade = fadeIn * fadeOut;
            vec2 screenUV = (vec2(texelPos) + 0.5) / vec2(viewWidth, viewHeight);

            // 毛玻璃面板：区域内只显示重度模糊后的当前画面，不做任何染色。
            // 顺序：面板先合成，logo 才是画在玻璃上的那张白字。
            float panelCoverage = StartupLogoPanelMask(screenUV, vec2(viewWidth, viewHeight));
            if (panelCoverage > 0.0 && fade > 0.0) {
                // 1/8 结果在 colortex27 左上角的象限画布里：采样 UV 乘 1/8。
                // clamp 到画布内 —— 画布右/下 1~2 个纹素不属于画布，双线性会带进来。
                vec2 panelSize = vec2(viewWidth, viewHeight);
                // 上限取 (tileSize - 1) * 纹素尺寸：采样点落在画布倒数第二列/行上，
                // 双线性只用画布内的纹素，永远不会碰到画布外那一圈 Iris 的清零值。
                vec2 canvasMax = max(StartupLogoPanelTileSize(panelSize) - 1.0, vec2(1.0)) * viewPixelSize;
                vec3 panelHDR = textureLod(colortex27, min(screenUV * LOGO_PANEL_BLUR_INV, canvasMax), 0.0).rgb;
                if (dot(panelHDR, vec3(1.0)) < 1e-5) panelHDR = StartupPanelFallbackBlur(screenUV);

                // 与面板外像素走同一条显示变换（曝光 / tone map / gamma / 暗角 / 泛光叠加）：
                // 面板亮度因此天然与周围同量级，不会出现「一块暗块 / 一块黑块」。
                // CAS 档下 colortex0 已调过色，但面板色仍是未调色的 HDR，所以这里同样只调一次。
                vec3 panelColor = saturate(GradeScene(panelHDR, screenUV, ActiveExposure()) * LOGO_PANEL_LIFT);
                finalOut = mix(finalOut, panelColor, panelCoverage * fade);
            }

            // 覆盖率：StartupLogoMask 现在返回完整字形（描画类动画时长都是 0）——
            // 时间上的变化全部由上面的 fade 负责，两者相互独立。
            float logoCoverage = StartupLogoMask(screenUV, vec2(viewWidth, viewHeight), logoFrame).x;
            // 纯白（按需求：与截图里的白色一致）
            finalOut = mix(finalOut, vec3(1.0), logoCoverage * fade);
        }
    #endif

    // ========== 实体区域故障 ==========
    #ifdef ENTITY_AREA_GLITCH
        // [2026-11-12 A1 帧级门控（重做）] `global.hurtEntitySeen` 由 gbuffers_entities 在本帧
        // 画到受伤实体像素时置 1、由 prepare(GlobalStorage) 每帧清零。场上没有受伤实体时整段跳过，
        // 省掉每像素 7 次 sin 链 + GLITCH_TEAR_LAYERS 层撕裂循环（约 17 SFU + ~120 ALU）、
        // 2 次 colortex7 取样和 2 次深度读（Firefox 抓帧里这是 final pass 的主要固定成本）。
        // 历史：2026-09-20 曾用 colortex10.b 做过同样的门控，2026-09-22 因为该标志的写入者
        // composite5(HurtTimer) 被 KILL_RIPPLE 门控（默认关）⇒ 标志恒 0 ⇒ **特效整个消失**，
        // 只能把门控整段撤掉。现在标志改走 SSBO，不依赖任何可关的 pass。
        // 门控只能是帧级：`:srcIsEntity` 判的是被位移的**源**像素（背景像素承载拖拽条带与补洞），
        // 按当前像素的 isEntity/isHurt 门控会把补洞那半效果丢掉。
    #endif
    #ifdef ENTITY_AREA_GLITCH
    if (global.hurtEntitySeen != 0u) {
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
    }   // if (global.hurtEntitySeen != 0u) —— 帧级门控，见本段开头
    #endif

    // ========== 全屏受伤故障（支持始终显示） ==========
    // [2026-10-06 按用户要求] 本段**不做**距离衰减：全屏受击屏闪是镜头/画面级效果，
    // 保持全屏等幅（近处远处一样），只有实体区域故障（上面那段）按距离衰减。
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

    // [2026-10-02 临时诊断] 顶左角 64×64：把**编译期宏值**画成确定颜色。
    // 放在最后一个 pass ⇒ 不受"天空像素提前返回 / 曝光 / 色调映射 / TAA"影响，颜色是准的。
    //   纯黑 (0,0,0) = 宏 = 默认 1.0（选项文件里的值没进 shader）
    //   纯红 (1,0,0) = 宏 ≥ 2 但 < 5
    //   纯黄 (1,1,0) = 宏 ≥ 5 但 < 24
    //   纯白 (1,1,1) = 宏 ≥ 24（即 txt 里的 32 已生效）
    //   紫 (1,0,1) 等其它组合按三个 step 叠加理解（R:≥2 G:≥5 B:≥24）
    #ifdef DEBUG_SUNBOUNCE_VIS
        if (all(lessThan(gl_FragCoord.xy, vec2(64.0)))) {
            finalOut = vec3(step(1.5, VOXEL_TRACE_SUN_STRENGTH),
                            step(4.0, VOXEL_TRACE_SUN_STRENGTH),
                            step(16.0, VOXEL_TRACE_SUN_STRENGTH));
        }
    #endif

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

    // [调试] GI 时域累积诊断：R = 累积帧数 / 上限（亮 = 历史长，暗 = 已掉回单帧样本），
    // G = 本帧该像素被判不可靠（越界 / historyReset / 几何不匹配）。放在最后一个 pass ⇒
    // 不受曝光/色调映射/TAA 影响，颜色可以直接当读数。
    // 用法：站在有问题的地方，静止时 R 应接近满值；一动就变暗 + G 亮 → 历史被拒（查重投影/判据），
    // 而不是去动降噪器。这正是 2026-11-07 "满天星" 问题的定位手段。
    #ifdef DEBUG_GI_ACCUM_STATS
        #ifdef VXGI_FULLRES
            ivec2 _giCanvasTexel = texelPos;
        #else
            // [2026-11-11 奇数分辨率] 画布宽 = viewSize/2，而 (W-1)>>1 在奇数 W 下会等于画布宽
            // ⇒ 最右列越界（texelFetch 返回 0，视图上是一条黑边）。与 GICanvasCoord 同口径夹住。
            // 这里不用 halfViewSize：语义检查器把「文件里出现 halfViewSize」当作画布 pass 的
            // 启发式判据，写进来会让本文件的全分辨率 texelPos 全被误报成画布坐标。
            ivec2 _giCanvasTexel = min(texelPos >> 1, ivec2(viewSize) / 2 - 1);
        #endif
        float _dbgAccum = texelFetch(colortex2, _giCanvasTexel, 0).a;
        float _dbgBad   = texelFetch(colortex14, _giCanvasTexel, 0).a;
        finalOut = vec3(saturate(_dbgAccum * rcp(max(SSILVB_MAX_ACCUM_FRAMES, 1.0))), _dbgBad, 0.0);
    #endif

    // ===== GI 诊断视图（GI_DEBUG_VIEW；0=关闭）=====
    // 放在最后一个 pass ⇒ 不受曝光/色调映射/TAA 影响，颜色可以直接当读数。
    // 每个模式都是"看一个具体量"，用来区分"闪"到底来自哪一环，而不是继续猜。
    #if GI_DEBUG_VIEW > 0
        #ifdef VXGI_FULLRES
            ivec2 _dbgT = texelPos;
        #else
            ivec2 _dbgT = min(texelPos >> 1, ivec2(viewSize) / 2 - 1);
        #endif
        vec4 _dbgHist  = texelFetch(colortex2, _dbgT, 0);      // rgb = 累积(未滤波), a = 帧数
        vec4 _dbgFilt  = texelFetch(colortex3, _dbgT, 0);      // rgb = 空间滤波后, a = 方差
        float _dbgFlag = texelFetch(colortex14, _dbgT, 0).a;   // 1 = 本帧被判不可靠
        float _dbgA    = _dbgHist.a;
        // 本帧真实累积上限：必须和 Accumulate.frag 的计算**逐项一致**，否则"绿"永远够不到。
        // 旧版漏了 `/ GI_EFFECTIVE_SPP`（上限被高估 2 倍）⇒ A 停在真上限时也只显示黄，永远没有绿。
        // [2026-11-11] 与 Accumulate 同步改用 GlobalStorage 的低通帧时间（同一 SSBO 字段），
        // 否则诊断读数的分母仍在逐帧抖，A/cap 会假性抽动。
        float _stableFrameTime = global.smoothedFrameTime > 1e-6
                               ? global.smoothedFrameTime
                               : max(frameTime, 1e-4);
        float _dbgCap = clamp(GI_ACCUM_TIME / (_stableFrameTime * max(GI_EFFECTIVE_SPP, 1.0)),
                              8.0, SSILVB_MAX_ACCUM_FRAMES);
#ifdef VOXEL_GI_DARK_ACCUM
        {
            // 暗处上限 ×4（Accumulate 用 lightmap 判定，这里同一来源、同一公式）
            uint _p = texelFetch(colortex7, texelPos, 0).x;
            float _lm = max(float(_p & 0xFFu), float((_p >> 8u) & 0xFFu)) * rcp(255.0);
            _dbgCap = mix(_dbgCap, _dbgCap * 4.0, 1.0 - smoothstep(0.10, 0.60, _lm));
        }
#endif
        // 各视图的隔离量在各自分支里算；不要在公共段放"滤波前后差值"之类会饱和的量。
        if (GI_DEBUG_VIEW == 1) {
            // 1：历史长度 + 不可靠标记 —— 蓝=年轻(刚出现)，绿=本帧被判不可靠，红=历史长度
            //    用法：转动视角盯住闪的地方。若该处**蓝/绿一直亮** ⇒ 历史没建立 ⇒ 查判据/重投影；
            //          若该处**红已满**却仍闪 ⇒ 问题在滤波或采样，不在历史。
            finalOut = vec3(saturate(_dbgA * rcp(_dbgCap)), _dbgFlag, 1.0 - saturate(_dbgA * 0.125));
        } else if (GI_DEBUG_VIEW == 2) {
            // 2：方差（对数压缩）—— 白=方差大（滤波会强），黑=方差小（滤波几乎不生效）
            //    用法：闪的地方如果**发黑** ⇒ 方差太低 ⇒ 边缘保持过强 ⇒ 噪点没被空间滤波抹掉。
            // 直接读 prepass 的方差（权威值）；colortex3.a 是滤波后的加权结果，可能被改写。
            // [2026-11-11] colortex24 已改作 TS 历史快照（存 colortex23 副本），方差迁到
            // colortex26.g —— 此前仍读 24，视图 2 显示的其实是「上一帧 TS 输出亮度」，
            // sqrt(Y)*30 几乎恒白，C 测试（天空 σ 应为纯黑）已无法判读。
            float _dbgVar = max(texelFetch(colortex26, _dbgT, 0).g, 1e-8);
            // 刻度改为直观的 σ（亮度百分比）：白 = σ ≥ 1% 亮度，黑 = σ 很小。
            // 旧刻度 (log2+20)/15 会把暗场景常见的 variance≈1e-6 映射成 0 ⇒ 误判成"方差为 0"。
            // 白 = σ ≥ 3.3% 亮度；暗场景 σ≈0.1% ⇒ 深灰（可分辨结构，不再全黑/全白）
            finalOut = vec3(saturate(sqrt(_dbgVar) * 30.0));
        } else if (GI_DEBUG_VIEW == 3) {
            // 3：孤立亮点（anti-firefly 的隔离量）—— 红 = 累积值显著高于 3x3 邻域均值，绿 = 正常。
            //    旧版用 |滤波输出 - 累积值| / 累积值：空间滤波本来就会改掉大半亮度，暗处分母又趋 0
            //    ⇒ 静止时恒饱和全红，E 测试无法判读（2026-11-10 实测）。改用相对邻域的离群量，
            //    只标火点；1e-3 地板避免极暗处被噪声误标。
            float _dbgMean = 0.0;
            ivec2 _dbgEnd = textureSize(colortex2, 0) - 1;
            for (int _dy = -1; _dy <= 1; ++_dy) {
                for (int _dx = -1; _dx <= 1; ++_dx) {
                    if (_dx == 0 && _dy == 0) continue;
                    ivec2 _dbgN = clamp(_dbgT + ivec2(_dx, _dy), ivec2(0), _dbgEnd);
                    _dbgMean += max(texelFetch(colortex2, _dbgN, 0).r, 0.0);
                }
            }
            _dbgMean *= 0.125;
            float _dbgExcess = max(_dbgHist.r - _dbgMean, 0.0) * rcp(max(_dbgMean, 1e-3));
            finalOut = vec3(saturate(_dbgExcess), saturate(1.0 - _dbgExcess), 0.0);
        } else if (GI_DEBUG_VIEW == 4) {
            // 4：三段对比整条链路（左→右）：prepass(colortex22) | 累积(colortex2) | 最终 GI(colortex23)
            // 三段必须用**同一增益 + 同一色调映射**，否则亮度差会被误读成结构差。
            // （旧版 22/23 用 400x、中间的累积用 8x ⇒ 中间早已剪切成白、只看得见细密残噪，
            //   两边在大增益下露出低频 ⇒ 看上去像"滤波制造了大团斑块"。刻度不一致比没视图更糟。）
            // 增益 64 + Reinhard：0.0025→0.14、0.01→0.39、0.1→0.86，跨两个数量级都可判读。
            const float _DBG_GAIN = 64.0;
            vec3 _dbgSeg;
            if (texelPos.x * 3 < int(viewSize.x)) {
#ifdef VOXEL_GI_NRD_ACTIVE
                _dbgSeg = texelFetch(colortex22, _dbgT, 0).rgb;
#else
                _dbgSeg = _dbgFilt.rgb;
#endif
            } else if (texelPos.x * 3 < int(viewSize.x) * 2) {
                _dbgSeg = _dbgHist.rgb;
            } else {
#ifdef VOXEL_GI_NRD_ACTIVE
                _dbgSeg = texelFetch(colortex23, _dbgT, 0).rgb;
#else
                _dbgSeg = _dbgFilt.rgb;
#endif
            }
            // 三段缓冲存的都是 YCoCg（r=Y，g/b=色差，可为负）。直接当 RGB 显示会串色/发黑，
            // 实测"画面太诡异看不清"（2026-11-10）。先转回 RGB，再走同一增益 + Reinhard。
            vec3 _dbgS = max(YCoCgToRGB(_dbgSeg), 0.0) * _DBG_GAIN;
            finalOut = _dbgS / (1.0 + _dbgS);
        } else if (GI_DEBUG_VIEW == 5) {
            // 5：三通道 —— 红 = A/cap，绿 = maxGeometryWeight，蓝 = 本帧被判不可靠（走兜底）。
            // 黄(红+绿)=历史长且可信；**绿(红低绿高)=新像素但可信，是正常响应**；
            // 蓝/青=走了"拒绝历史 + 用修复历史起步"的兜底路径；红(高红低绿)=历史长却不可信，异常。
            // 判读：黄↔蓝 交替闪 ⇒ 可靠性判定在逐帧翻；只有红在动、绿蓝都稳 ⇒ 计数器/上限问题。
            // 旧文档把本视图写成"历史长度分档配色"（绿满/红年轻），与实际三通道相反 ⇒ 实测误判，已统一。
            float _dbgConf = saturate(texelFetch(colortex21, _dbgT, 0).a);
            finalOut = vec3(saturate(_dbgA * rcp(_dbgCap)), _dbgConf, _dbgFlag);
        } else if (GI_DEBUG_VIEW == 6) {
            // 6：上一帧的「几何可信度 maxGeometryWeight」（存于 colortex21.a）
            //    白 = 1（完全接受历史）；灰 = 部分拒绝；黑 = 完全拒绝。
            //    累积帧数稳态 a* = 1/(1-w)：w=0.95 ⇒ a*=20，永远到不了满值。
            //    用法：噪/闪的地方**发灰** ⇒ 几何判据在扣权重（查深度/法线容差）；
            //          发白却仍噪 ⇒ 历史没问题，问题在采样或滤波。
            // 关键：`maxGeometryWeight = 1` 与"兜底路径"都显示为白，无法区分 ⇒ 兜底路径改存 -1，
            // 这里用**红色**标出"根本没用上历史"，灰阶才表示历史路径的实际权重。
            float _dbgW = texelFetch(colortex21, _dbgT, 0).a;
            finalOut = (_dbgW < 0.0) ? vec3(1.0, 0.0, 0.0) : vec3(saturate(_dbgW));
        }
    #endif
}