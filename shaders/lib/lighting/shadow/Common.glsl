// --- 阴影设置 ---
#define SHADOW_DISTORTION          // [OFF ON] 阴影形变开关
#define SHADOW_DISTORTION_STRENGTH 2.75 // [1.0 1.5 2.0 2.25 2.5 2.75 3.0 3.25 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0]

// [2026-09] 表驱动可分离 warp（RTWSM 骨架）。接口与表内容说明见 Warp.glsl。
// **默认关**：关着时下面两个函数走原有解析径向曲线，与改动前逐位一致。
// 开启方式：取消下面那一行的注释（开启后 Shadows 页会出现同名开关，可随时 GUI 切换；
// 关闭状态下该 GUI 项无法解析，Iris 会打一条 warning，与本包其他未启用选项行为一致）。
// #define SHADOW_WARP_RTWSM
#include "/lib/lighting/shadow/Warp.glsl"

// 计算形变因子的函数
float CalcDistortionFactor(in vec2 shadowClipPos) {
    #ifdef SHADOW_WARP_RTWSM
        // 表驱动：返回局部缩放 dW/du（表项的 .g），角色与原解析因子一致
        //（PCF 半径 / 深度偏置 / 半影搜索半径都用它做缩放）
        return ApplyShadowWarpTable(shadowClipPos).z;
    #else
        #ifndef SHADOW_DISTORTION
            return 1.0; // 如果开关关闭，直接返回1.0，不进行任何形变计算
        #else
            // 原始形变算法
            float invClipLength = inversesqrt(sdot(shadowClipPos));
            float distortionCurve = log((exp(SHADOW_DISTORTION_STRENGTH) - 1.0) / invClipLength + 1.0);
            return distortionCurve * invClipLength * rcp(SHADOW_DISTORTION_STRENGTH);
        #endif
    #endif
}

// 形变应用函数（重载1）：调用方已算好 distortionFactor
vec3 DistortShadowSpace(in vec3 shadowClipPos, in float distortionFactor) {
    #ifdef SHADOW_WARP_RTWSM
        // 表驱动：xy 查表变形，z 保持原实现的 0.2 压缩（写入与查询两端一致即可）
        vec3 warped = ApplyShadowWarpTable(shadowClipPos.xy);
        return vec3(warped.xy, shadowClipPos.z * 0.2);
    #else
        #ifndef SHADOW_DISTORTION
            return shadowClipPos; // 开关关闭时，不乘以系数，保持原始坐标
        #else
            return shadowClipPos * vec3(vec2(distortionFactor), 0.2);
        #endif
    #endif
}

// 形变应用函数（重载2）：自己算 distortionFactor
vec3 DistortShadowSpace(in vec3 shadowClipPos) {
    #ifdef SHADOW_WARP_RTWSM
        vec3 warped = ApplyShadowWarpTable(shadowClipPos.xy);
        return vec3(warped.xy, shadowClipPos.z * 0.2);
    #else
        #ifndef SHADOW_DISTORTION
            return shadowClipPos; // 同上
        #else
            float distortionFactor = CalcDistortionFactor(shadowClipPos.xy);
            return shadowClipPos * vec3(vec2(distortionFactor), 0.2);
        #endif
    #endif
}
