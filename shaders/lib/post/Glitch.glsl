/*
    --------------------------------------------------------------------------------
        Revelation-AD-edit  -  modified derivative of "Revelation"
        Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro

        This file is an addition made for this derivative.
        Copyright 2026 AnotherCream

        Licensed under the Apache License, Version 2.0. See NOTICE at repo root.
    --------------------------------------------------------------------------------
*/

//================================================================================================//
// 故障特效（Glitch）共享数学
//
// 同一份故障场被两处消费，保证「可见的撕裂」与「泛光里的光晕」严格对齐：
//   1) program/post/Final.frag             —— 可见畸变 + 提亮（tonemap 之后的 LDR 空间）
//   2) program/post/bloom/Downsample.comp  —— 发光项（线性 HDR，写进泛光缓冲 L0）
//
// 设计约束（改本文件前务必先读）：
//   * 本文件**只放纯函数**：不采样任何纹理、不依赖任何全局 uniform。
//     frameTimeCounter 由调用方作为参数传进来 —— 本文件**不能**声明它，
//     否则会与 lib/universal/Uniform.glsl 的声明重复（GLSL 同一 TU 内重复声明是错误）。
//   * 选项 #define 放在本文件：Iris 是从「预处理后的源码」里认选项的，include 链里的
//     #define 同样生效，所以 Final 与 Downsample 都能看见同一份配置，不会各配一套。
//   * 两个消费端必须用同一份判据函数，否则光晕会和可见撕裂错位。
//================================================================================================//

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

// ---------- 故障发光强度 ----------
// 线性增益：故障像素的颜色经 GlitchBrighten 提亮（保色相，见该函数）。这一份增益
// **同时**决定泛光里注入的发光量（Downsample.comp 只加「增量」= 颜色 × GLITCH_GLOW，
// 基础亮度已由降采样带进来，不重复加）⇒ 调它会同时影响「自身提亮」与「光晕强度」。
// 0.0 = 关闭发光（回到纯畸变）。
// 默认 1.0（×2）：再高会让大部分中调表面被夹到 1.0，中性色（石/土/木）就开始发白。
#define GLITCH_GLOW 1.0 // [0.0 0.25 0.5 0.75 1.0 1.5 2.0 2.5 3.0 4.0 5.0]

// ---------- 撕裂条带判据（全屏故障的发光范围） ----------
// |offsetAccum| 达到它才算「被撕裂的条带」⇒ 只有这些横条发光，避免受伤时整屏发白。
// offsetAccum 的理论上限是 0.15（见 ComputeGlitchField 末尾乘的系数）。
#define GLITCH_GLOW_BAND_MIN 0.05

// ---------- 调试：始终显示全屏故障（取消注释即生效） ----------
//#define ALWAYS_GLITCH

//================================================================================================//
// 工具
//================================================================================================//

float GlitchLoop(float x) {
    x = mix(x, x - 1.0, float(x > 1.0));
    x = mix(x, x + 1.0, float(x < 0.0));
    return x;
}

// 保色相提亮（[2026-09-21] 修「发光发白」）。
//
// 直接写 `saturate(c * gain)` 是错的：通道会**逐个**触顶，比例被破坏 ⇒ 发白。
// 例：石头色 (0.40, 0.40, 0.40) × 3 = (1.2, 1.2, 1.2) ⇒ 夹成纯白。
//
// 这里改成把缩放系数卡到「最亮通道刚好到 1.0」：s = min(gain, 1/max(c))。
//   * 有色表面：三通道比例**完全不变** ⇒ 色相与饱和度都保住，只是整体变亮 ✓
//     例：草绿 (0.25, 0.45, 0.15)，max=0.45 ⇒ s = min(3, 2.22) = 2.22
//         ⇒ (0.56, 1.00, 0.33)：亮绿，不是白 ✓
//   * 中性色（灰）：三通道相等 ⇒ 只能整体推向白。**数学上无法避免** ——
//     灰没有色相可保，任何「按自身颜色提亮」都会把它推向白。要灰面也不发白
//     只能给发光加色调（当前未做，用户裁定）。
// 输出保证落在 [0,1]（输入 glitchColor 已是 graded LDR 色），无需再 saturate。
vec3 GlitchBrighten(in vec3 c, in float gain) {
    float m = max(max(c.r, c.g), c.b);
    // m 极小（近黑）时 1/m 会爆掉，此时直接按 gain 缩放（结果也极小，无副作用）
    float s = (m > 1e-5) ? min(gain, 1.0 / m) : gain;
    return c * s;
}

//================================================================================================//
// 故障场
//================================================================================================//

// [2026-09-20 hash 统一] 三段故障特效（实体区域 / 全屏 ALWAYS / 全屏 is_hurt）共用同一份
// 随机序列 + 多层撕裂偏移场——原先三段各抄一遍完整 sin 链（触发时每像素 27+ 次 sin）。
// 抽出为函数后数学逐位等价（同一 sin 链、同一撕裂循环、同一求和顺序）。
// r1..r7 由帧种子（frameTimeCounter * 16 取整）驱动，为帧内常数；撕裂循环按 uv.y 分层
// 采样出条带位移 offsetAccum ∈ [-0.15, 0.15]；r6/r7 供 RGB 三通道的色散微偏移。
// 各消费段只需要 offsetAccum / r6 / r7 三个输出（r1-r5 仅在链内部使用）。
void ComputeGlitchField(in float frameTimeCounter, in vec2 uv, out float offsetAccum, out float r6, out float r7) {
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

//================================================================================================//
// 判据（纯函数：调用方自己采样 colortex7，把 .y / .w 传进来）
//================================================================================================//

// 实体区域故障判据（ENTITY_GLITCH_OUTLINE_TEAR 开启 = 新撕裂）。
//   matW / matID = colortex7 的 .w / .y，取自「当前像素」
//   srcW / srcID = 同一组数据，取自「内容来源像素」（当前像素沿 x 位移后的位置）
// 返回 true = 该像素被撕裂覆盖：来源处是受伤实体（内容被拖拽过来），
// 或自己是受伤实体的缺口（条带移走后的空位，用来源处的背景近似填充）。
// materialID == 1u 是手，排除在外。
bool EntityTearHit(in uint matW, in uint matID, in uint srcW, in uint srcID) {
    bool isEntity = ((matW & 1u) != 0u);          // bit0
    bool isHurt   = ((matW & 2u) != 0u);          // bit1
    bool srcIsEntity = ((srcW & 1u) != 0u) && ((srcW & 2u) != 0u) && srcID != 1u;
    return srcIsEntity || (isEntity && isHurt && matID != 1u);
}

// 发光范围判据：**只有「超出实体轮廓边界」的像素才发光**。
//   = 内容来源处是受伤实体（srcIsEntity），但当前像素本身不属于实体（!isEntity）
//     ⇒ 被撕裂拖到轮廓之外的溢出部分。
// 实体自己的像素（isEntity）与条带移走后留下的缺口（!srcIsEntity，填的是背景）都不发光。
// 注意：本判据蕴含 EntityTearHit（srcIsEntity 就是它的一个析取项），所以调用方不必再判一次。
bool EntitySpillGlow(in uint matW, in uint srcW, in uint srcID) {
    bool isEntity = ((matW & 1u) != 0u);
    bool srcIsEntity = ((srcW & 1u) != 0u) && ((srcW & 2u) != 0u) && srcID != 1u;
    return srcIsEntity && !isEntity;
}

// 旧撕裂模式（ENTITY_GLITCH_OUTLINE_TEAR 关闭）的判据：仅实体内部颜色错位，轮廓不动。
bool EntityTearHitInnerOnly(in uint matW, in uint matID) {
    bool isEntity = ((matW & 1u) != 0u);
    bool isHurt   = ((matW & 2u) != 0u);
    return isEntity && isHurt && matID != 1u;
}

// 实体撕裂的内容来源像素：当前像素沿 x 位移（位移量由故障场给出）。
ivec2 EntityTearSrcTexel(in ivec2 texelPos, in float offsetAccum, in float intensity, in int widthPx) {
    int shift = int(round(offsetAccum * intensity * float(widthPx)));
    return ivec2(clamp(texelPos.x - shift, 0, widthPx - 1), texelPos.y);
}

// 全屏故障的「撕裂条带」判据：位移足够大的横条才算。
// 二值（满强度）⇒ 发光时只有这些条带亮，其余画面保持原样。
bool FullScreenTearHit(in float offsetAccum) {
    return abs(offsetAccum) >= GLITCH_GLOW_BAND_MIN;
}
