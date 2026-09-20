// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.





#ifndef SSBO_DECLARED_TPYE
#define SSBO_DECLARED_TPYE readonly
#endif

layout (std430, binding = 0) SSBO_DECLARED_TPYE buffer GlobalData {
    float prevWorldTime;
    vec3 directIlluminance;
    vec3 skyUpIlluminance;
    vec3[9] skySH;
    float compensationAlpha;   // 当前补光强度（0~1）
    float lastSkyTime;
    // [2026-09-11 DoF 移植] 自动对焦距离（米），由 DOF Gather 的 DofUpdateFocus
    // 单线程每帧指数平滑写入（原版 Revelation 同名末尾字段；std430 追加在尾部不影响既有偏移）
    float dofFocusDistance;
    // [2026-09-20 大气 LUT 生命周期 v2——两阶段提交（修复 v1 黑洞块竞态）]
    // v1 的错误：工作帧末尾由 (0,0) 线程直接写版本号。同一 dispatch 内尚未被调度的
    // 工作组会读到"已完成"而提前 return，它们的 texel 永远不写入 LUT（image 为
    // clear=false 帧间持久）→ 首帧 LUT 只写一半、此后门控全跳过 → 天空中永久固定的
    // 巨大黑色像素块（地平线以下成片，即 dispatch 尾部工作组对应的 LUT 高行区域）。
    // v2 方案：门控只读 *已提交*（*Version / Prev*）字段；工作帧只写 *暂存*（*Pending*）
    // 字段；提交动作放在 *下一帧* dispatch 的开头（(0,0) 线程），此时 LUT 早已在上一
    // 帧由全部工作组完整写好。同帧竞态下无论读到提交前还是提交后都安全：读到提交后
    // → 跳过（LUT 完整，正确）；读到提交前 → 重做一遍（写逐位相同的值，无害）。
    // TLUT/MSLUT 的输入全部是编译期常量，指纹匹配时每帧重建结果逐位相同 → 跳过。
    // SkyView 除指纹外还跟踪太阳方向/相机绝对高度/wetness（Hosek 再加 moonlightMult），
    // 超阈值才重建；缓变量同样走暂存→次帧提交，防止同帧内晚调度的工作组看到新状态
    // 而提前跳过。TLUT/MSLUT 重建帧清零 skyViewVersion *与* skyViewPending（依赖失效：
    // SkyView 帧首 begin 跑在 setup10/11 之前，读到的是上一帧 LUT，须等 LUT 就绪后重算；
    // 连 pending 一起清，防止上一轮的旧暂存被下一帧误提交）。
    uint atmosTlutVersion;    // 已提交指纹
    uint atmosTlutPending;    // 工作帧暂存指纹（次帧 dispatch 开头提交）
    uint atmosMsVersion;
    uint atmosMsPending;
    uint skyViewVersion;
    uint skyViewPending;
    vec4 skyViewPrevState;    // 已提交：xyz = 重建时 worldSunDir, w = 重建时 atmosphereViewHeight
    float skyViewPrevWetness;
    float skyViewPrevMoonMult;   // [SKY_MODEL==1] Hosek 模型专用
    vec4 skyViewStatePending;    // 暂存：与 skyViewPending 同帧写入，次帧提交
    float skyViewWetnessPending;
    float skyViewMoonMultPending;
} global;

layout (std430, binding = 1) SSBO_DECLARED_TPYE buffer ExposureData {
    uint histogram[HISTOGRAM_BIN_COUNT];
    float value;
} exposure;

layout (std430, binding = 2) SSBO_DECLARED_TPYE buffer CloudData {
    mat4 shadowViewProj;
    mat4 shadowViewProjInv;
} cloud;
