#version 460 compatibility
// [2026-11-11 官方拓扑] NRD 路径下本槽位 = REBLUR HistoryFix。
// 官方派发顺序（Source/Reblur.cpp:145-186）：PREPASS → TA → **HISTORY_FIX** → BLUR → POST_BLUR → TS。
// GI_MODE==1（SSILVB/SVGF）仍需要 VarianceEstimate 算方差（它写 colortex3，供 DeferredLight 读）。
//
// [2026-11-11 修复 · "开降噪后 GI 全黑"的根因]
// 这里原来是 `#ifdef VOXEL_GI_NRD_ACTIVE`，但**判断发生在 #include 之前**：
// 该宏是 settings.glsl 里的派生宏（定义在 #if 块内），此刻尚未引入 ⇒ 恒假 ⇒ 永远走 else，
// 实际执行的是 VarianceEstimate（写 colortex3，**不写 colortex25**）。
// 于是 deferred6 读到一个从未被写过的 colortex25（=0）→ Blur/PostBlur 全 0 →
// GIHistoryStore 把 0 回写 colortex2 → 下一帧历史也是 0 ⇒ 链式死锁。
// 关降噪时 DeferredLight 直接读 colortex2，绕开这条链，所以"关掉就正常"。
//
// 修法：先 include settings.glsl 拿到派生宏再判断。settings.glsl 自带
// `INCLUDE_SETTINGS` guard，后面 GIHistoryFix/VarianceEstimate 经 Utility 再次 include
// 时会直接跳过，不会重复展开（也就不会重复执行里面那 25 个 #undef）。
#include "/settings.glsl"

#if defined VOXEL_GI_NRD_ACTIVE
#include "/program/diffuse/GIHistoryFix.comp"
#else
#include "/program/diffuse/VarianceEstimate.comp"
#endif
