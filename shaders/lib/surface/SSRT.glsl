// Reference:
// Morgan McGuire, Michael Mara. "Efficient GPU Screen-Space Ray Tracing". JCGT, 2014.
// https://jcgt.org/published/0003/04/04/paper.pdf
// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.

#define SSRT_MAX_SAMPLES 16 // [1 2 4 6 8 12 16 18 20 24 28 32 36 40 48 64 128 256 512]
//#define SSRT_SKY_TRACING

#define SSRT_REFINEMENT
#define SSRT_REFINEMENT_STEPS 8 // [0 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20 22 24 26 28 30 32]

// [2026-10-08 P0-3 下半] 命中厚度容差的**下限**（× 本步跨过的视深）。0 = 关闭（只用原相对判据）。
// 为什么需要它：本 march 是"离散格点 + 每帧抖相位（STBN）"，而命中判定 `|Δ视深| < 0.2×|视深|`
// 是**二元**的。近景一步跨过的视深与这个阈值恰好同量级（短射线 12 步 ≈ 0.4 格/步，z≈2 时阈值
// 也 ≈0.4 格）⇒ 起点相位每帧一挪，"接受/拒绝"就翻转一次 = **近景条纹**；相位由 dither 决定、
// STBN 时域轴每帧推进一格 ⇒ 条纹**匀速移动**；TAA 又用**表面**运动矢量对齐反射（见 TODO #0）
// ⇒ 收敛不掉。远景每步跨度远大于阈值 ⇒ 不翻转 ⇒ 无条纹（与实测"只有近景"一致）。
// 把容差抬到"至少覆盖一步的跨度"后，凡是发生在**一步之内**的合法穿越都被接受 ⇒ 判定不再依赖
// 相位；而跨过多步的异常穿越（射线早就穿到很深的背面）仍被拒绝，防漏光能力不丢。
#define SSRT_THICK_FLOOR 1.0 // [0.0 0.5 1.0 1.5 2.0] 容差下限（×本步视深跨度）；0=只用原相对判据

// [2026-10-08 P0-3 上半] 命中厚度容差的**上限**（格 = 视空间单位）。判据本体保持原样：
// 相对项 |Δz| < 0.2×|视深|。
// 这一项是**随距离缩放**的，不能拍平成固定值：远处每步的深度跨度本就比固定值大
// （100 格长的射线 12 步 ≈ 8 格/步），拍平会把远处的合法命中判负 ⇒ 实测表现为"远景反射质量下降"
// （2026-10-08 用户实测，随即回退）。所以这里只保留一个**默认关闭**的可选上限：0 = 完全按原判据。
// 注：与 SSILVB_HIT_THICKNESS 不同量纲（那个是屏幕空间深度单位），不要互相套数值。
#define SSRT_MAX_THICKNESS 0.0 // [0.0 1.0 1.5 2.0 3.0 4.0 6.0 8.0] 0=关闭（只用相对判据，与原实现逐位一致）

// [2026-10-08] 命中点深度插值：在"前一点（在表面前方）"与"当前点（在表面后方）"之间按深度差
// 线性插值出交点，作为二分细化的起点（jiaozi158 / baddogzz 2020 的做法）。
// 关掉则退回"跨过表面的那个采样点"，二分仍能收敛，只是起点差半格步长。
#define SSRT_HIT_INTERPOLATION 1 // [0 1]

// [2026-10-08] 调试/对照开关：厚度测试失败（射线已穿过该表面但超出容差）时是否继续推进。
// 1 = 按名义步长继续（修掉"原地空转"）；0 = 旧行为（不推进，剩余迭代原地打转、并漏掉后面的命中）。
// 用于对照实测；确认无回归后可删除此开关并固定为 1。
#define SSRT_STALL_FIX 1 // [0 1]

//================================================================================================//

// 快速归一化（替代 fastNormalize）
float rcpLengthFast(vec3 v) {
    return inversesqrt(max(dot(v, v), 1e-8));
}

bool ScreenSpaceRaytrace(in vec3 viewPos, in vec3 viewDir, in float dither, in uint steps, inout vec3 screenPos) {
    vec3 origin = screenPos;

    // ---- 确保 near、viewSize、viewPixelSize 可用 ----
    #ifndef near
        const float near = 0.05;
    #endif
    #ifndef viewSize
        vec2 viewSize = vec2(viewWidth, viewHeight);
    #endif
    #ifndef viewPixelSize
        vec2 viewPixelSize = 1.0 / viewSize;
    #endif

    // ---- 计算最大行进距离（与原逻辑一致） ----
    float fixZ = step(viewDir.z, 0.0) * 1e23 - (viewPos.z + near) / viewDir.z;
    vec3 rayDir = normalize(ViewToScreenPos(viewDir * fixZ + viewPos) - origin);
    rayDir *= minOf((step(0.0, rayDir) - origin) / rayDir);

    // 转换到像素空间，避免宽高比失真
    rayDir.xy *= viewSize;
    origin.xy *= viewSize;

    float rSteps = 1.0 / float(steps);
    float invDirZ = rcp(abs(rayDir.z));
    vec3 rayStep = rayDir * rSteps;

    // ---- 天空深度宏处理 ----
    #if defined LOD_MOD
        float screenDepthSky = ViewToScreenDepth(ScreenToViewDepthLod(1.0));
    #else
        float screenDepthSky = 1.0;
    #endif

    bool hit = false;

    // [2026-10-08 修 P0-1；同日两处"性能向"改动已按用户实测回退，原因记在下面]
    //  P0-1 原实现只在"射线在表面前方"（rayPos.z <= sampleDepth）时推进 t：厚度测试失败
    //       （射线已穿过该表面但超出容差）时既不 break 也不推进 ⇒ 循环顶部用同一个 t 重算出
    //       同一个 rayPos，剩余迭代全部空转（每次白付一个全分辨率深度读取），而且这条射线
    //       **此后永远找不到命中**（薄遮挡后面的真实交点被跳过）。
    //       现改为：表面前方按深度差快进（原逻辑）；已穿过的按名义步长继续（普通 march 行为，
    //       保证前进且不像 1% 下限那样爬行）。对照开关 SSRT_STALL_FIX。
    //  [回退 1] 曾让"同像素重复采样"跳过深度读取并改按名义步长推进 —— **本 march 的推进量依赖
    //       刚读到的深度**（advance = clamp(深度差/|dirZ|, ...)），跳过读取就等于换了轨迹，
    //       大步长时会跨过薄表面（近景掠射角最明显）⇒ 用户实测"近景反射有时出现条纹"，已撤回，
    //       恢复每轮都读深度。
    //  [回退 2] 曾把厚度容差加上固定绝对上限（1.5 格）⇒ 把远处的合法命中判负，实测"远景反射
    //       质量下降"，已撤回为默认关闭的可选上限 SSRT_MAX_THICKNESS（0 = 原判据）。
    //  [保留] 命中点深度插值（SSRT_HIT_INTERPOLATION）：只影响命中点位置、不改变命中与否，
    //       与上面两处观感回归无关，继续保留待实测。
    float t = dither * rSteps;
    vec3 prevRayPos = origin;
    float prevDiff = -1.0;   // <0 = 没有可用的前一点（首轮 / 前一点也已在表面后方）⇒ 不做插值
    for (uint i = 0u; i < steps; ++i) {
        vec3 rayPos = origin + rayDir * t;

        // 超出像素空间边界则失败
        if (clamp(rayPos.xy, vec2(0.0), viewSize - 1.0) != rayPos.xy) break;

        // 命中天空处理
        if (rayPos.z >= screenDepthSky) {
        #ifdef SSRT_SKY_TRACING
            // [2026-10-08] 天空面在屏幕深度上是常数（z = screenDepthSky），而射线 z 随 t **线性**
            // ⇒ 交点可解析求出，不该用"第一个越过天空面的格点"。原来直接取 rayPos：命中 UV 会被
            // 量化到步进格点上，抖相位（STBN 每帧推进）一挪就整步跳变 —— 近景反射常在一两步内打到
            // 天空、而近景一步在 UV 上跨度很大 ⇒ 这就是"近景条纹且匀速移动"的直接来源，与厚度判据无关。
            // clamp 下限 0：万一 origin 本身已在天空深度（调用端通常会剔除，这里只是兜底）。
            float tSky = max((screenDepthSky - origin.z) * rcp(max(rayDir.z, 1e-8)), 0.0);
            screenPos = origin + rayDir * tSky;
            hit = true;
        #endif
            break;
        }

        // 采样深度
        ivec2 rayTexel = ivec2(rayPos.xy);
        float sampleDepth = loadDepth2(rayTexel);
        #if defined LOD_MOD
            if (sampleDepth > 1.0 - EPS) sampleDepth = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth1Lod(rayTexel)));
        #endif

        // >0：射线还在该表面**前方**；<0：已穿过该表面
        float rayDiff = sampleDepth - rayPos.z;

        // ---- 核心：视图空间厚度过滤（防拉丝） ----
        if (rayPos.z > sampleDepth) {
            float sampleViewZ = ScreenToViewDepth(sampleDepth);
            float stepViewZ = ScreenToViewDepth(rayPos.z);
            // 本步跨过的视深（用上一点的视深算；首轮 prevRayPos == origin，跨度退化为抖动量）
            float viewSpan = abs(ScreenToViewDepth(prevRayPos.z) - stepViewZ);
            // 下限（SSRT_THICK_FLOOR）：保证"一步之内的穿越"恒被接受 ⇒ 判定与抖相位无关（消近景条纹）
            float tolerance = max(-0.2 * stepViewZ, SSRT_THICK_FLOOR * viewSpan);
            // 上限（SSRT_MAX_THICKNESS）：默认 0 = 不启用（拍平上限会把远处的合法命中判负）
            if (SSRT_MAX_THICKNESS > 0.0) tolerance = min(tolerance, SSRT_MAX_THICKNESS);

            if (distance(sampleViewZ, stepViewZ) < tolerance) {
                #if SSRT_HIT_INTERPOLATION == 1
                    // 深度差在两次采样之间线性过零的位置 = 估计交点（薄表面前提：相邻两像素的表面深度近似）。
                    // prevDiff>0 且 rayDiff<0 才说明这一步真的跨过了表面；否则退回跨面采样点。
                    if (prevDiff > 0.0 && rayDiff < 0.0) {
                        screenPos = mix(prevRayPos, rayPos, saturate(prevDiff * rcp(max(prevDiff - rayDiff, 1e-6))));
                    } else {
                        screenPos = rayPos;
                    }
                #else
                    screenPos = rayPos;
                #endif
                hit = true;
                break;
            }
            // 穿越被容差判负 ⇒ 按名义步长继续（旧行为在这里不推进：剩余迭代原地空转 + 漏掉后面的命中）
            #if SSRT_STALL_FIX == 1
                t += rSteps;
            #endif
        } else {
            // 表面前方：按深度差快进（原逻辑）
            t += clamp(rayDiff * invDirZ, rSteps * 0.01, rSteps * 1.25);
        }

        prevRayPos = rayPos;
        prevDiff = rayDiff;
    }

    // ---- 二分细化（必须开启） ----
    #ifdef SSRT_REFINEMENT
    if (hit) {
        for (uint i = 0u; i < SSRT_REFINEMENT_STEPS; ++i) {
            rayStep *= 0.5;
            float sampleDepth = loadDepth2(ivec2(screenPos.xy));
            #if defined LOD_MOD
                if (sampleDepth > 1.0 - EPS) sampleDepth = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth1Lod(ivec2(screenPos.xy))));
            #endif
            // 替换 signMul 为条件表达式
            screenPos += (sampleDepth < screenPos.z) ? -rayStep : rayStep;
        }
    }
    #endif

    // 从像素空间转回屏幕空间坐标 [0,1]
    screenPos.xy *= viewPixelSize;

    return hit;
}
