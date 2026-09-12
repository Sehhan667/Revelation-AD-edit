// --- 阴影设置 ---
#define SHADOW_DISTORTION          // [OFF ON] 阴影形变开关
#define SHADOW_DISTORTION_STRENGTH 4.0 // [1.0 1.5 2.0 2.25 2.5 2.75 3.0 3.25 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0]

// [2026-09] 表驱动可分离 warp（RTWSM）。接口与表内容说明见 Warp.glsl。
// **默认开**：关掉（注释下面那一行）时下面两个函数走原有解析径向曲线，与改动前逐位一致。
// 开启后 Shadows 页会出现同名开关，可随时 GUI 切换。
//#define SHADOW_WARP_RTWSM
// [2026-09 第二阶段] 内容驱动强度：把阴影图分辨率往"需要分辨率的地方"挪。
//   0 = 密度只用解析底座（**与第一阶段逐点一致**，默认；测量照跑但不产生影响）
//   >0 = 密度 = 解析密度 × ShadowWarpDensityFactor(clamp(相对重要性, 0.1, 10))，再积分成 CDF
//        （**必须是乘法**：线性混合会把解析底座的形状稀释掉，反而让动态范围变小，
//          详见 program/setup/ShadowWarp.comp 的 DensityAt 说明）
// 注意两点：
//   ① 解析底座的中心加权会一直保留（Minecraft 里玩家就在中心，这个偏向不能丢）；
//   ② 这一项**不改变整幅阴影图的总覆盖**，只重分配局部斜率（CDF 最后整体归一化）。
// 另注：打开 SHADOW_WARP_RTWSM 后，下面的 SHADOW_DISTORTION_STRENGTH 只用于解析兜底曲线，
//   "warp 有多强"由本项与解析底座共同决定，不再由 SHADOW_DISTORTION_STRENGTH 控制。
#define RTWSM_CONTENT_STRENGTH 0.0 // [0.0 0.25 0.5 0.75 1.0 1.5 2.0 3.0 4.0]
// 表的时域平滑速度：每帧向上一步算出的目标靠近多少（1 = 不平滑，逐帧跳变）。
// 边缘密度是逐帧测量的，不平滑会看到阴影边缘"呼吸"。
#define RTWSM_TEMPORAL_SPEED 0.2 // [0.05 0.1 0.15 0.2 0.3 0.5 1.0]
// 重要性直方图 bin 数，**必须**同时等于：
//   SHADOW_WARP_TABLE_SIZE（表项数，填表端一个线程一个 bin）
//   测量端 shadow/../DeferredLight.frag 把 bin 限制到 [0, RTWSM_HIST_SIZE-1]
// 改一个就要改全部，否则表尾会出现没被写过的 bin（全 0 → 走解析兜底 → 表与兜底混用）。
#define RTWSM_HIST_SIZE 256
// 重要性公式：
//   importance = 1/(dist^RTWSM_DIST_FACTOR · 0.1 + 1) × (1 + RTWSM_FACING_FACTOR·saturate(N·(-V)))
// 距离衰减给出"玩家中心加权"，朝向因子让正对相机的面更重要。
// [2026-09] 这两个量取代了原来的"阴影图深度边缘计数"：后者几乎只反映地形复杂度，
// 沿轴很平坦，归一化后 CDF 不变，所以怎么调 k 都没反应。
#define RTWSM_DIST_FACTOR 1.3      // [1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0]
#define RTWSM_FACING_FACTOR 2.0    // [0.0 0.5 1.0 1.5 2.0 2.5 3.0]
// 重要性量化到整数的倍率（R32UI 图像只能原子加整数；归一化后这个倍率不影响结果）
#define RTWSM_IMPORTANCE_SCALE 1024.0
// [2026-09 诊断 · 第三次改版] 自检：**不看重要性，直接把表换成一条极端的固定 warp**。
// 目的：把"表→阴影"这条链路和"重要性数据"这两件事彻底分开判定。
//   画面出现明显形变（阴影整体被压向左侧、右侧边缘出现拖影/重复） ⇒ 表链路是活的 ✓
//   画面完全正常、零变化                                        ⇒ 表没被读/没被写 ✗
// 把下面一行取消注释即可。**注意**：这一模式下 k（RTWSM_CONTENT_STRENGTH）不参与，
// 所以"开了自检但改 k 没反应"是正常的 —— 它只回答"链路通不通"，不回答"k 有没有用"。
// 测完请注释回去。
// #define RTWSM_SELFTEST
// [2026-09 诊断 · 数据侧] 自检 2：把**测量到的重要性数据**作为偏离量直接写进 warp 位置
//   （W(i) = u*0.5 + 0.125*clamp(rel,0,4)/4）。第一项保证表合法（不会被回退成解析曲线），
//   第二项让"数据有没有结构"直接变成可见的阴影横向错位。
// 判据（与 k 无关，k 在此模式下不参与）：
//   物体阴影边界出现横向错位/被拉伸压缩，且随相机移动而变 ⇒ 数据有结构 ✓
//   画面与不开完全一样                                      ⇒ 数据全零/全平台 ✗
// 用它替换掉 SELFTEST（两者不要同时开）。
// 【2026-09 结论：使命已完成，关闭】探针结果是"极低分辨率 + 满屏条纹" ⇒ 证明两件事：
//   ① 表→阴影链路是通的（画面真的变了）✔
//   ② 原始 rel 的跨度极大、逐 bin 差几十倍 —— 但探针把 rel **直接当位置偏移**，绕过了 CDF 与
//      SLOPE 夹紧这两道天然低通，所以那些条纹是探针自己放大出来的，不代表生产路径也条纹
//      （生产路径数值实测是光滑的）。因此不再用它的画质结论，只保留"数据是活的"这一条。
// 想复查数据死活时可以再打开。
// #define RTWSM_DATA_PROBE
#include "/lib/lighting/shadow/Warp.glsl"

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
    #ifdef SHADOW_WARP_RTWSM
        // 表驱动：返回局部缩放 dW/du（表项的 .g），角色与原解析因子一致
        //（PCF 半径 / 深度偏置 / 半影搜索半径都用它做缩放）
        // [2026-09 排障] **下限取解析径向因子**：原实现的偏置是"已知够用"的，而可分离
        // warp 的面积尺度在角点只有它的约 0.38 倍 —— 偏置一旦比原来更小，就会直接变成
        // 大面积自阴影（开 RTWSM 后"移动时出现整块阴影"的最可能来源）。这里保证偏置
        // 不小于原实现；偏大只是多一点 peter-panning，比 acne 好得多。
        return max(ApplyShadowWarpTable(shadowClipPos).z, CalcAnalyticDistortionFactor(shadowClipPos));
    #else
        return CalcAnalyticDistortionFactor(shadowClipPos);
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
