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
} global;

layout (std430, binding = 1) SSBO_DECLARED_TPYE buffer ExposureData {
    uint histogram[HISTOGRAM_BIN_COUNT];
    float value;
} exposure;

layout (std430, binding = 2) SSBO_DECLARED_TPYE buffer CloudData {
    mat4 shadowViewProj;
    mat4 shadowViewProjInv;
} cloud;
