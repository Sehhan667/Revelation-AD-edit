/*
--------------------------------------------------------------------------------
    Revelation Shaders
    - 阴影 warp：表驱动可分离 -

    [2026-09] 原来的 warp 是一条**固定解析的径向指数曲线**（CalcDistortionFactor），按"离阴影图
    中心的距离"分配分辨率，与场景内容无关。

    RTWSM（Rectilinear Texture Warped Shadow Maps，Baran 等 / Tokuyoshi & Silva SIGGRAPH 2014）
    把这条固定曲线换成**逐帧由内容驱动的可分离 1D warp**：x、y 各一条一维表，表的内容按
    "哪里更需要分辨率"分配。

    数据流：
      DeferredLight.frag   逐片元测量重要性 → imageAtomicMax 写 image.shadowWarpHistImg（256×2）
      setup/ShadowWarp.comp（setup12，跑在 shadow pass 之前）读走上一帧的直方图并清零
                           → 沿轴平滑 → 密度 = 解析底座 × 有界内容因子 → 积分成 CDF
                           → 拉伸铺满 [-1,1]，写 image.shadowWarpImg（256×2 RGBA16F）
      本文件               查询端：Common.glsl 的两个 warp 函数在这里取"变形后坐标 + 局部缩放"
                           （局部缩放 dW/du 给深度偏置 / PCF 半径 / 半影搜索半径做缩放）
    即表用的是**上一帧**的测量结果（本帧的测量发生在 shadow pass 之后），所以有时间平滑。

    前置条件（包内已满足，故可行）：
      Shadow.vert 用 DistortShadowSpace() 把几何写进阴影图，所有查询点（PCF/PCSS、
      体积雾、大气雾、体素太阳阴影、IntegrateScene）也用同一个函数反算 —— 两端都在包内，
      所以换掉这个函数就等于换掉整套 warp，引擎不参与。

    诊断：DEBUG_SHADOW_WARP 看 warp 场本身，DEBUG_SHADOW_WARP_DIFF 看"表 vs 解析曲线"的
      差异场与表项合法性（两个都不依赖 SHADOW_WARP_RTWSM，可先关着 warp 验表）。
--------------------------------------------------------------------------------


    Added for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Copyright 2026 AnotherCream.
*/

#ifndef SHADOW_WARP_GLSL
#define SHADOW_WARP_GLSL

#ifndef SHADOW_WARP_TABLE_SIZE
    #define SHADOW_WARP_TABLE_SIZE 256
#endif

// 每步密度（= 局部缩放 dW/du）的合法区间。填表端（program/setup/ShadowWarp.comp）的 CDF 就按
// 这两条夹紧，所以**表里只可能出现区间内的值**。放在这里是为了让"写表"和"校表"共用同一个区间：
// 早先校验函数里写的是 [0.01, 64]（凭印象定的），而填表端允许 [0.05, 32] —— 校验比写入更严，
// 于是 k 调大后大量**完全合法**的表项被误判成坏数据、逐点回退成解析曲线。回退曲线和表在
// 归一化上并不一致，两者交界处就是一道 warp 突变（阴影边缘出现错位/条纹）。
#define SHADOW_WARP_SLOPE_MIN 0.05
#define SHADOW_WARP_SLOPE_MAX 32.0

// 体素平铺条带（ENABLE_VOXELIZATION）占用的那部分 x 轴，保留多少相对密度。
// 测量端（DeferredLight.frag 的 ShadowWarpImportanceAt）把它作为权重下限作用到 x 轴：
// 阴影图左侧一条 256 纹素宽的竖条是体素立方体平铺区，而 warp 逐轴分配分辨率时看不出这条
// 竖条的存在，内容驱动会把它一路压扁。0.6 表示"明显低于该轴平均，但不会压没"。
#define SHADOW_WARP_VOXEL_WEIGHT 0.6

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
    // [2026-09 回退] 上一版改成"取两个相邻表项 + smoothstep 插值"，但随后 k=0 也开始出现
    // 条纹（k=0 时表内容逐点等于解析曲线，本不该有任何条纹），所以先退回这个已验证可用的
    // 硬件线性插值版本；条纹成因另行定位。
    return textureLod(shadowWarpTex, vec2(x / size, rowV), 0.0).rg;
}

// 表项是否无效（= 表没被写入 / 写了一半 / 内容是 NaN）。
// [2026-09] 合法区间现在**直接取自填表端的两条夹紧常量**，不再另写一套经验值：
//   位置：填表端 clamp 到 [-1, 1]（只多给一点浮点/量化余量）
//   缩放：填表端每个 bin 的步长被夹在 [SLOPE_MIN, SLOPE_MAX] 之间 ⇒ 中心差分结果必在区间内
// 早先这里写的是 [0.01, 64]，比填表端的 [0.05, 32] 窄得多，k（内容驱动强度）一大就有大量合法
// 项被判坏、回退解析曲线 ⇒ 表与兜底曲线混用 ⇒ 阴影边缘错位。判据放宽后只剩"真的没写"才回退：
// 全 0（RGBA16F 未写入的默认值）、NaN、越界。
bool WarpEntryInvalid(in vec2 entry) {
    const float posLimit = 1.001;
    return !(entry.x == entry.x) || !(entry.y == entry.y)                    // NaN
        || (entry.x == 0.0 && entry.y == 0.0)                                // 未写入（0 填充）
        || abs(entry.x) > posLimit                                           // 变形后坐标必须在 [-1,1]
        || entry.y < SHADOW_WARP_SLOPE_MIN || entry.y > SHADOW_WARP_SLOPE_MAX;
}

// ---- 解析兜底：与 ShadowWarp.comp 的 WarpAxisCurve / WarpAxis 完全同一式子 ----
// 表不可用时用它，得到的就是"表本该给出的那条可分离曲线"，观感不变、也不会退化。
// [2026-09] 这里补上一个 [0,1] 归一化因子：表是密度积分成 CDF 再拉伸到正好铺满 [-1,1] 的
// （见 ShadowWarp.comp 的 kx/ky 那段），也就是表里的曲线恒等于"解析曲线 × k"，而 k 的解析值就是
// 解析曲线在域端点 |u| = 1 处的取值（那里 log((e^S-1)/1 + 1) ≡ S ⇒ 曲线值 ≡ 1）。乘以 k 之后
// 兜底曲线与表在**值域、单调性、局部缩放（= k·dW/du）**上才一致，两者交界处不会出现 warp 突变
// （早先不归一化，兜底在角点只有表的一半左右，混用时会看到阴影错位）。
float WarpAxisCurveAnalytic(in float u) {
    float r = max(abs(u), 1e-5);
    float invClipLength = rcp(r);
    float distortionCurve = log((exp(SHADOW_DISTORTION_STRENGTH) - 1.0) / invClipLength + 1.0);
    return distortionCurve * invClipLength * rcp(SHADOW_DISTORTION_STRENGTH);
}

float WarpAxisAnalytic(in float u) {
    float normalization = rcp(WarpAxisCurveAnalytic(1.0));   // = S / log(e^S)
    return clamp(u * WarpAxisCurveAnalytic(u) * normalization, -1.0, 1.0);
}

// 局部缩放 = W 的中心差分（步长与填表时一致：1/(TABLE_SIZE-1)），并夹到合法区间。
// 下限尤其重要：1/u 型曲线的中心差分在 u → 0 时有抵消误差，可能算出 0 甚至负数，
// 而 distortionFactor = 0 会让深度偏置归零 ⇒ 大面积自阴影（"移动时出现整块阴影"）。
float WarpAxisScaleAnalytic(in float u) {
    float h = 1.0 / float(SHADOW_WARP_TABLE_SIZE - 1);
    float dW = (WarpAxisAnalytic(u + h) - WarpAxisAnalytic(u - h)) / (2.0 * h);
    return clamp(dW, SHADOW_WARP_SLOPE_MIN, SHADOW_WARP_SLOPE_MAX);
}

// 可分离 warp：vec2(未变形 shadow clip xy) → vec3(变形后 x, 变形后 y, 局部缩放)
// 局部缩放：可分离 warp 在这一点的雅可比是对角的 (sx, sy)，本身各向异性；而调用方
// （深度偏置 / PCF 半径 / 半影搜索半径）要的是一个标量。这里取两轴的**几何平均**
// = 线性面积尺度，即该 warp 的"等效各向同性缩放"，与原实现里 distortionFactor
// （径向的 W/|p|）角色最接近。
// 实测（S=3.0、1024 阴影图、rdc_analysis/rtwsm_phase1_check.py）与原解析因子的比值：
//   几何平均：中位 0.90、P95 1.68、最坏 2.43
//   取 max  ：中位 0.73、P95 2.83、最坏 5.93  ← 两个方向偏差都更大（在阴影图边缘，
//            另一条轴恰好落在中心最大放大处，会把深度偏置抬到约 6 倍 → 易 peter-panning）
vec3 ApplyShadowWarpTable(in vec2 shadowClipXY) {
    vec2 wx = SampleShadowWarpTable(shadowClipXY.x, 0.25);
    vec2 wy = SampleShadowWarpTable(shadowClipXY.y, 0.75);
    // 坏表项逐轴兜底（详见 WarpEntryInvalid 的说明）
    if (WarpEntryInvalid(wx)) wx = vec2(WarpAxisAnalytic(shadowClipXY.x), WarpAxisScaleAnalytic(shadowClipXY.x));
    if (WarpEntryInvalid(wy)) wy = vec2(WarpAxisAnalytic(shadowClipXY.y), WarpAxisScaleAnalytic(shadowClipXY.y));
    return vec3(wx.x, wy.x, sqrt(max(wx.y * wy.y, 0.0)));
}

// 逐轴平滑重要性 → 相对值（已除以该轴均值；1.0 = 该轴平均水平）。
// 用**均值**而不是最大值归一化：均值恒为 1，于是 k 只改"哪儿更多/哪儿更少"的对比度，
// 不改变该轴的总密度（总密度再由填表端的 CDF 归一化吸收，见 ShadowWarp.comp 第 2 段）。
vec2 ShadowWarpRelativeImportance(in vec2 importance, in vec2 meanImportance) {
    return importance * rcp(max(meanImportance, vec2(1e-6)));
}

// 内容驱动密度因子：只在 RTWSM_CONTENT_STRENGTH > 0 时离开 1.0。
// **乘法**而不是线性混合：k 只改内容项的权重，不稀释解析底座的形状（k=0 时恒等于底座，
// 与第一阶段逐点一致）。上下夹紧是必要的：重要性跨度可达几个数量级，不夹会在相邻 bin
// 之间形成台阶 ⇒ CDF 台阶 ⇒ warp 非单调 ⇒ 阴影条纹（见 DeferredLight 的测量说明）。
// 注意宏名是 **RTWSM_***：这个名字是 Iris 的 GUI 选项名（shaders.properties 的 screen.Shadows
// 与 lang 都按它索引），改名会同时丢掉滑块和默认值，所以这里必须跟着用 RTWSM_*。
// 兜底定义只为防"从别处单独 include 本文件"：正常包含链（Common.glsl → 本文件）里
// 这些宏已经由 Common.glsl 定义好，值不会被这里覆盖。
#ifndef RTWSM_CONTENT_STRENGTH
    #define RTWSM_CONTENT_STRENGTH 0.0
#endif

float ShadowWarpDensityFactor(in float relativeImportance) {
    return mix(1.0, clamp(relativeImportance, 0.1, 10.0), saturate(RTWSM_CONTENT_STRENGTH));
}

#endif // SHADOW_WARP_GLSL
