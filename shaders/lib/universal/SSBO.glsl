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
    // [2026-09-20 大气 LUT 生命周期] 三个大气 LUT 的参数指纹 + SkyView 上次重建的运行时输入。
    // TLUT/MSLUT 的输入全部是编译期常量，指纹匹配时每帧重建结果逐位相同 → 跳过；
    // 指纹不匹配（首帧 / SSBO 刚分配 / 改 GUI 参数重编译 / 切换维度）→ 重建一次并写回。
    // SkyView 除指纹外还跟踪太阳方向 / 相机绝对高度 / wetness 三样缓变量，超阈值才重建。
    // TLUT/MSLUT 重建时会清零 skyViewVersion（依赖失效：SkyView 帧首 begin 跑在
    // setup10/11 之前，读到的是上一帧 LUT，必须等 LUT 就绪后重算一次）。
    uint atmosTlutVersion;
    uint atmosMsVersion;
    uint skyViewVersion;
    vec4 skyViewPrevState;  // xyz = 上次重建时的 worldSunDir, w = 上次重建时的 atmosphereViewHeight
    float skyViewPrevWetness;
    float skyViewPrevMoonMult;  // [SKY_MODEL==1] 上次重建时的 moonlightMult（Hosek 模型专用）
} global;

layout (std430, binding = 1) SSBO_DECLARED_TPYE buffer ExposureData {
    uint histogram[HISTOGRAM_BIN_COUNT];
    float value;
} exposure;

layout (std430, binding = 2) SSBO_DECLARED_TPYE buffer CloudData {
    mat4 shadowViewProj;
    mat4 shadowViewProjInv;
} cloud;
