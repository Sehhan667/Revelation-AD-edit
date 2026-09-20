// --- 阴影设置 ---
// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.
#define SHADOW_DISTORTION          // [OFF ON] 阴影形变开关
#define SHADOW_DISTORTION_STRENGTH 4.0 // [1.0 1.5 2.0 2.25 2.5 2.75 3.0 3.25 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0]

// [2026-09-20 **RTWSM（表驱动可分离 warp）已从本分支移除**]
// 原因：内容驱动的 warp 在掠射阳光场景下会产生"阴影内部等宽亮线"（完整排查记录见
// rtwsm-fix 分支的 docs/RTWSM_HANDOVER.md §1~§10.14），且它占用 2 个自定义 image 槽位
//（Iris 上限 16 个）导致 cloudShadowTex 被静默丢弃。这里只保留原有的解析径向形变。

// 解析式（原实现）形变因子 —— 与 SHADOW_WARP_RTWSM 开关**无关**地保留一份。
// 作用：① 关掉 RTWSM 时 CalcDistortionFactor 直接用它（与改动前逐位一致）；
//      ② DEBUG_SHADOW_WARP_DIFF 用它做对拍（表驱动 vs 解析径向的实际差异）。
float CalcAnalyticDistortionFactor(in vec2 shadowClipPos) {
    #ifndef SHADOW_DISTORTION
        return 1.0; // 如果开关关闭，直接返回1.0，不进行任何形变计算
    #else
        // 原始形变算法
        float invClipLength = inversesqrt(sdot(shadowClipPos));
        float distortionCurve = log((exp(SHADOW_DISTORTION_STRENGTH) - 1.0) / invClipLength + 1.0);
        return distortionCurve * invClipLength * rcp(SHADOW_DISTORTION_STRENGTH);
    #endif
}

// 计算形变因子的函数
float CalcDistortionFactor(in vec2 shadowClipPos) {
    return CalcAnalyticDistortionFactor(shadowClipPos);
}

// 形变应用函数（重载1）：调用方已算好 distortionFactor
vec3 DistortShadowSpace(in vec3 shadowClipPos, in float distortionFactor) {
    #ifndef SHADOW_DISTORTION
        return shadowClipPos; // 开关关闭时，不乘以系数，保持原始坐标
    #else
        return shadowClipPos * vec3(vec2(distortionFactor), 0.2);
    #endif
}

// 形变应用函数（重载2）：自己算 distortionFactor
vec3 DistortShadowSpace(in vec3 shadowClipPos) {
    #ifndef SHADOW_DISTORTION
        return shadowClipPos; // 同上
    #else
        float distortionFactor = CalcDistortionFactor(shadowClipPos.xy);
        return shadowClipPos * vec3(vec2(distortionFactor), 0.2);
    #endif
}
