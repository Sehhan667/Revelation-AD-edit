/*
--------------------------------------------------------------------------------
    Revelation Shaders
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Added for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Copyright 2026 AnotherCream.





    Pass: 实体受伤时长累积（击杀特效计时器，挂 composite5）
    colortex10.R = 每个像素处受伤实体的"持续变红时长"（秒），未受伤立即归零
    colortex10.G = 全局击杀脉冲剩余时间（秒），仅 (0,0) 处有效
    colortex10.B = (0,0) 处的「上一帧稀疏网格上存在受伤实体」标志（仅 0/1）

    触发逻辑：每帧仅由 (0,0) 像素对 colortex10.R 做 16x16 稀疏采样取最大值，
    超过阈值且当前无脉冲播放时触发一次新脉冲（可叠加触发，不打断已有脉冲）。

    [2026-09-20 实体故障门控] B 通道为 Final 的 ENTITY_AREA_GLITCH 提供帧级门控：
    R > 0 ⟺ 该像素当前帧是受伤实体（newTimer = isHurt ? prev + dt : 0），
    故 (0,0) 对 R 的稀疏采样最大值 > 0 即「屏幕上有受伤实体」。采样与击杀脉冲
    的触发检测复用同一个循环（每帧都跑，早退条件不变——达到 TRIGGER 即停，
    此时 B 照样置 1，因为 TRIGGER > 0）。标志晚一帧（Final 读到的是上一帧
    的聚合结果）+ 稀疏网格对小实体有漏检可能——实体故障本身是氛围特效，
    可接受。KILL_RIPPLE 关闭时 B 恒写 1，实体故障保持无门控的原行为。
--------------------------------------------------------------------------------

*/

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Config //==============================================================================//

#include "/config.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 10 */
layout (location = 0) out vec4 hurtDataOut;

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// Function //============================================================================//

#include "/lib/post/KillRipple.glsl"

void main() {
    ivec2 texelPos = ivec2(gl_FragCoord.xy);

    #ifdef KILL_RIPPLE
        // ---- 逐像素：受伤时长累计（时间反馈，读到的是上一帧数据） ----
        float prevTimer = clamp(texelFetch(colortex10, texelPos, 0).r, 0.0, KILL_RIPPLE_TIMER_CAP);

        uvec4 matPack = texelFetch(colortex7, texelPos, 0);
        uint matW = matPack.w;
        bool isHurtEntity = ((matW & 1u) != 0u) && ((matW & 2u) != 0u) && matPack.y != 1u;

        float newTimer = isHurtEntity ? min(prevTimer + frameTime, KILL_RIPPLE_TIMER_CAP) : 0.0;

        // ---- 全局脉冲状态：仅 (0,0) 像素计算（每帧一次），其余像素 G/B 通道写 0 ----
        float newPulse = 0.0;
        float hurtSeen = 0.0;
        if (texelPos == ivec2(0, 0)) {
            float prevPulse = clamp(texelFetch(colortex10, ivec2(0, 0), 0).g, 0.0, KILL_RIPPLE_DURATION);
            newPulse = max(0.0, prevPulse - frameTime);

            // 每帧一次：16x16 网格稀疏采样取最大受伤时长（读上一帧 R）。
            // [2026-09-20] 从「无脉冲播放时才采样」改为每帧采样：同一份 maxTimer 同时服务
            // 击杀脉冲触发（>= TRIGGER）与实体故障门控（> 0 即 B=1），循环本身无副作用，
            // 触发行为逐位不变；脉冲播放期间多花的采样有 TRIGGER 早退兜底。
            float maxTimer = 0.0;
            const int grid = KILL_RIPPLE_GRID;
            for (int gy = 0; gy < grid && maxTimer < KILL_RIPPLE_TRIGGER_TIME; ++gy) {
                int sy = min(int((gy + 0.5) * viewHeight / float(grid)), int(viewHeight) - 1);
                for (int gx = 0; gx < grid && maxTimer < KILL_RIPPLE_TRIGGER_TIME; ++gx) {
                    int sx = min(int((gx + 0.5) * viewWidth / float(grid)), int(viewWidth) - 1);
                    maxTimer = max(maxTimer, clamp(texelFetch(colortex10, ivec2(sx, sy), 0).r, 0.0, KILL_RIPPLE_TIMER_CAP));
                }
            }
            // 实体故障门控标志：网格上任一点 R > 0 ⟺ 上一帧该点是受伤实体。
            // 早退停在 TRIGGER 时 maxTimer >= TRIGGER > EPS，step 照样输出 1。
            hurtSeen = step(EPS, maxTimer);

            if (newPulse <= 0.0 && maxTimer >= KILL_RIPPLE_TRIGGER_TIME) {
                newPulse = KILL_RIPPLE_DURATION;
            }
        }

        hurtDataOut = vec4(newTimer, newPulse, hurtSeen, 0.0);
    #else
        // KILL_RIPPLE 关闭时不读 colortex7 / 不做检测（保持省钱分支）——B 恒写 1，
        // 让 ENTITY_AREA_GLITCH 维持无门控的原行为（两个特效可独立开关）。
        hurtDataOut = vec4(0.0, 0.0, 1.0, 0.0);
    #endif
}
