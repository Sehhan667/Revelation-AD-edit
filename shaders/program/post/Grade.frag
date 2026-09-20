/*
--------------------------------------------------------------------------------

    Revelation Shaders

    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.




    Pass: Post-processing compositing (tone mapping / bloom / vignette)

    [2026-09-21 Grade+Final 合并] 调色管线本体已抽到 lib/post/GradeCore.glsl，
    本 pass 仅在 CAS_ENABLED 档启用（shaders.properties 的
    program.world*/composite31.enabled = CAS_ENABLED 门控）：
      - CAS 开启：composite31 照旧把 graded 图写进 colortex0，final 的 9-tap
        CAS 邻域采样直接读 colortex0（内联 Grade 会让每个邻域 tap 重跑整条
        调色管线，11 倍代价，不划算）；
      - CAS 关闭（默认）：composite31 不调度，final 内联调用 GradeCore 完成调色，
        省一整个全屏 pass 的 colortex0 读写往返。
--------------------------------------------------------------------------------
*/

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 0 */
out vec3 color;

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// SSBO //================================================//

#include "/lib/universal/SSBO.glsl"

//======// Function //================================================//

#include "/lib/universal/Random.glsl"

#include "/lib/post/GradeCore.glsl"

//======// Main //================================================================================//
void main() {
    color = GradeSceneTexel(ivec2(gl_FragCoord.xy));
}
