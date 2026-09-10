/*
--------------------------------------------------------------------------------
    Revelation Shaders
    - 阴影 warp：表驱动可分离（RTWSM 骨架） -

    [2026-09] 现状：lib/lighting/shadow/Common.glsl 里的 warp 是一条**固定解析的径向
    指数曲线**（CalcDistortionFactor），按"离阴影图中心的距离"分配分辨率，与场景内容无关。

    RTWSM（Rectilinear Texture Warped Shadow Maps，Baran 等 / Tokuyoshi & Silva SIGGRAPH 2014）
    的思路是把这条固定曲线换成**逐帧由内容驱动的可分离 1D warp**：x、y 各一条一维表，
    表的内容按"哪里更需要分辨率"（深度边缘密度等）分配。

    本文件是这套东西的**骨架**（第一阶段）：
      - 表存在一张 256 x 2 的 RGBA16F 自定义贴图里（row0 = x 轴、row1 = y 轴），
        每项存 (变形后坐标, 局部缩放 dW/du)，由 program/setup/ShadowWarp.comp 每帧填写；
      - 打开 SHADOW_WARP_RTWSM 时，Common.glsl 的两个 warp 函数改走这里的表；
      - 表的内容目前是"现有解析曲线在坐标轴上的可分离类比"（见 ShadowWarp.comp 的说明），
        目的是先把"写入 / 查询 / bias 缩放"三处管线打通并可视化，而不是立刻换观感。
      - DEBUG_SHADOW_WARP 可视化 warp 场，用于 A/B 对比开关前后的变形。

    前置条件（包内已满足，故可行）：
      Shadow.vert 用 DistortShadowSpace() 把几何写进阴影图，所有查询点（PCF/PCSS、
      体积雾、大气雾、体素太阳阴影、IntegrateScene）也用同一个函数反算 —— 两端都在包内，
      所以换掉这个函数就等于换掉整套 warp，引擎不参与。
--------------------------------------------------------------------------------
*/

#ifndef SHADOW_WARP_GLSL
#define SHADOW_WARP_GLSL

#ifndef SHADOW_WARP_TABLE_SIZE
    #define SHADOW_WARP_TABLE_SIZE 256
#endif

// row0 = x 轴表，row1 = y 轴表；.r = 变形后的 shadow clip 坐标，.g = 局部缩放 dW/du
// 无条件声明：表采样函数是无条件定义的，若把声明放进 #ifdef，关闭开关时就会引用未声明的
// sampler 而编译失败。关闭开关时这些函数只是死代码（不会被调用，无运行时开销）。
uniform sampler2D shadowWarpTex;

// 采样一条 1D 表：u ∈ [-1,1]（未变形的 shadow clip 坐标）→ vec2(变形后坐标, 局部缩放)
// rowV 传 0.25（row0 纹素中心）或 0.75（row1 纹素中心），避免行间线性插值。
vec2 SampleShadowWarpTable(in float u, in float rowV) {
    float size = float(SHADOW_WARP_TABLE_SIZE);
    float t = clamp(u * 0.5 + 0.5, 0.0, 1.0);
    float x = t * (size - 1.0) + 0.5;
    return textureLod(shadowWarpTex, vec2(x / size, rowV), 0.0).rg;
}

// 可分离 warp：vec2(未变形 shadow clip xy) → vec3(变形后 x, 变形后 y, 局部缩放)
// 局部缩放取两轴较大者，用于 PCF 半径 / 深度偏置的放大（与原实现里 distortionFactor 的角色一致）。
vec3 ApplyShadowWarpTable(in vec2 shadowClipXY) {
    vec2 wx = SampleShadowWarpTable(shadowClipXY.x, 0.25);
    vec2 wy = SampleShadowWarpTable(shadowClipXY.y, 0.75);
    return vec3(wx.x, wy.x, max(wx.y, wy.y));
}

#endif // SHADOW_WARP_GLSL
