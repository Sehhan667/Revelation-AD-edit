/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

	Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
	Modified by AnotherCream, 2026.





    Pass: Accumulation and variance estimation
	Reference:  https://research.nvidia.com/sites/default/files/pubs/2017-07_Spatiotemporal-Variance-Guided-Filtering://svgf_preprint.pdf
                https://cescg.org/wp-content/uploads/2018/04/Dundr-Progressive-Spatiotemporal-Variance-Guided-Filtering-2.pdf

--------------------------------------------------------------------------------

*/

/*
--------------------------------------------------------------------------------
    Revelation Shaders – Accumulation and variance estimation
    Peak Hold re-enabled for smoother GI convergence.
--------------------------------------------------------------------------------
*/

const bool colortex3MipmapEnabled = true;

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 2,14,21 */
layout (location = 0) out vec4 integratedDiffuse;
// [2026-08-19 NRD] colortex14 升 RGBA16F，a 存 disocclusion 标记（1=不可靠/新暴露/重投影失效）。
layout (location = 1) out vec4 encodedNormalDepth;
// REBLUR 短历史（fastHistory）：只累积、不掺滤波结果 ⇒ 新鲜、4 帧级响应，供长历史裁剪参考。
layout (location = 2) out vec4 fastHistory;

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"
#include "/lib/universal/Random.glsl"

// ====== Peak Hold 控制宏（仅添加，不改其他）======
//#define SSILVB_PEAK_HOLD
#ifndef SSILVB_HOLD_DOWN_SPEED
    #define SSILVB_HOLD_DOWN_SPEED 0.1  // [0.01 0.02 0.05 0.1 0.2 0.5 1.0]
#endif
#ifndef SSILVB_HOLD_UP_SPEED
    #define SSILVB_HOLD_UP_SPEED 7.0     // [0.1 0.5 1.0 2.0 3.0 5.0]
#endif

#ifdef TAA_ENABLED
    #define SHOULD_APPLY_JITTER
#endif

// GI 画布某个纹素「**本帧**」的视深（负值，与 viewPos.z 同口径）。
// 为什么需要：空间重用块要判断"邻居是不是同一个表面"，而 `colortex14` 里存的是**上一帧**的
// 视深。静止时两者相等；一移动，同一世界点在两帧的视深整体错位 ⇒ 邻居全被误判为不同表面
// ⇒ 退回单帧/mip 采样 ⇒ 运动时闪、且预滤波失效（实测"动起来更糟、仍然闪"）。
// 深度必须取**同帧**口径：从 depthtex 按本帧的棋盘相位取邻居的深度再换算成视深。
float GICanvasNeighbourViewDepth(in ivec2 canvasTexel) {
#ifdef VXGI_FULLRES
    ivec2 rt = canvasTexel;
#else
    ivec2 rt = canvasTexel * 2 + checkerboardOffset2x2[frameCounter & 3u];
#endif
    return ScreenToViewDepth(loadDepth0(rt));
}

void TemporalFilter(in ivec2 texelPos, in vec3 screenPos, in vec3 worldNormal, in float accumCap, in float giDepthGrad) {
	// [无抖动口径] 必须用 `ScreenToViewPosRaw`（不减 `taaJitter`）。
	// 原因（实测：静止时大角度远距离的垂直墙面在橙/黄之间**平滑、长周期**来回跳）：
	// `ScreenToViewPos` 会减掉本帧的 taaJitter，而 TAA 抖动图案本身是几十帧的平滑序列。
	// 于是本帧重建出的 `viewPos.z` / `prevViewPos.z` 带本帧抖动偏移，而历史里存的
	// `sampleAux.z` 是**上一帧**（不同抖动相位）写下的 ⇒ 两边差值随抖动图案缓慢起伏
	// ⇒ `maxGeometryWeight` 缓慢起伏 ⇒ 稳态累积帧数 a* = 1/(1-w) 在档位间平滑移动。
	// 掠射面深度斜率大，抖动偏移被放大 ⇒ 垂直墙最明显。
	// 抖动只应影响**采样位置**，不应参与几何判据；这里统一改成无抖动口径。
	vec3 viewPos = ScreenToViewPosRaw(screenPos);
    vec3 worldPos = transMAD(gbufferModelViewInverse, viewPos);
    // GI 画布尺寸（半分辨率 = 屏幕一半；全分辨率 = 屏幕）
#ifdef VXGI_FULLRES
    ivec2 canvasEnd = ivec2(viewSize);
#else
    ivec2 canvasEnd = ivec2(halfViewSize);
#endif

	vec3 prevWorldPos = worldPos + (cameraPosition - previousCameraPosition) * step(0.56, screenPos.z); // To previous frame's world space
    vec3 prevViewPos = transMAD(gbufferPreviousModelView, prevWorldPos); // To previous frame's view space
	vec3 prevNDCPos = projMAD(gbufferPreviousProjection, prevViewPos) * rcp(-prevViewPos.z); // To previous frame's NDC space

    #ifdef SHOULD_APPLY_JITTER
        prevNDCPos.xy += taaJitterPrev;
    #endif
    vec2 prevCoord = prevNDCPos.xy * 0.5 + 0.5;

    vec2 currCoord = texelToUv(texelPos);
    // a 默认 0（可靠）；不可靠/重投影失效路径在下方置 1
    // 视深用 `ScreenToViewDepth(depth)`（纯投影逆变换，与 taaJitter 无关）——
    // 与 TemporalFilter 里无抖动的 `viewPos`、以及 `GICanvasNeighbourViewDepth()` 同口径。
    // 若这里写 `viewPos.z`（带抖动），下一帧的判据就会读到上一帧抖动相位的深度，
    // 造成"静止时累积帧数平滑缓慢起伏"（见 TemporalFilter 顶部注释）。
    encodedNormalDepth = vec4(OctEncodeSnorm(worldNormal), ScreenToViewDepth(screenPos.z), 0.0);

    // [诊断] GI_DEBUG_NO_DISOC = 1：取消一切历史拒绝（越界/重置/深度/法线全不看），
    // 强制历史永远有效。用途：一键判断闪是来自「历史被拒 + 重建」还是「采样/滤波」。
    // 关闭时行为逐位不变（条件里只多一个编译期常量 0）。
    bool _dbgForceHistory = GI_DEBUG_NO_DISOC > 0;
    bool _histOk = _dbgForceHistory || (saturate(prevCoord) == prevCoord && !historyReset);
    if (_histOk) {
        vec4 prevDiffuse = vec4(0.0);
        vec3 prevFast = vec3(0.0);   // 短历史（同一组双线性权重）
        float sumWeight = 0.0;
        // [2026-08-28 ] 上帧该像素的可信度 = 4 tap 里几何一致权重的最大（不含双线性）。
        // 几何一致（静止）→ 接近 1；遮挡/移动/几何剧变 → 骤降，驱动累积帧数连续衰减。
        float maxGeometryWeight = 0.0;

        // Custom bilinear filter
        #ifdef VXGI_FULLRES
        // 全分辨率：历史就是本像素，不需要相位补偿
        vec2 prevTexel = prevCoord * viewSize - 0.5;
        #else
        vec2 prevTexel = (prevCoord * viewSize
         - checkerboardOffset2x2[(frameCounter - 1) & 3u]
         - 0.5) * 0.5;
        #endif

        ivec2 floorTexel = ivec2(floor(prevTexel));
        vec2 fractTexel = prevTexel - vec2(floorTexel);

        float bilinearWeight[4] = {
            oms(fractTexel.x) * oms(fractTexel.y),
            fractTexel.x      * oms(fractTexel.y),
            oms(fractTexel.x) * fractTexel.y,
            fractTexel.x      * fractTexel.y
        };

        // 历史几何检查必须比「同一帧、同一空间」的两个视深：
        //   sampleAux.z   = 上一帧该 tap 的视深；
        //   prevViewPos.z = 本像素世界点在**上一帧**的视深（重投影结果）。
        // 原来拿它与 encodedNormalDepth.z（本帧视深）比：同一世界点在相机运动后视深本来就会变
        //（视深 ∝ 距离 × cosθ，20 格处转 2° 就变 0.7 格，而阈值只有 8/20 = 0.4），于是同一表面被
        // 判成不同表面 → maxGeometryWeight 骤降 → 累积帧数塌到 1~2 → 每像素独立噪点（满天星）。
        // 纯 A/D 横移时视深几乎不变，所以看着稳定；前后移动与转视角立刻暴露。
        // 改成比 prevViewPos.z 后：静止时它与 viewPos.z 完全相同（行为逐位不变），运动时恒为同帧口径。
        // 掠射面（法线近乎垂直于视线）上一个纹素的视深变化可达自身深度的 5%~10%，而 4 个历史 tap
        // 天然偏离重投影像素 0~1 个纹素 ⇒ 固定容差会把它们全判成不同表面，累积帧数永远上不去
        //（实测：近乎垂直于摄像机的表面完全累积不下来）。
        // [2026-11-08 相位偏移] 还有一层固定偏移：历史取样点在 `prevTexel` 里减掉了**上一帧**的
        // 棋盘相位，所以它相对本像素中心偏 1~3 个画布纹素（= 2~6 个屏幕像素）。深度判据比的是
        // 这些偏移位置的视深，差值 ≈ 局部斜率 × 偏移量 ⇒ 掠射面必然被扣权重。
        // 后果（实测）：静止时 `maxGeometryWeight` 只有 0.94~0.98 ⇒ 稳态 a* = 1/(1-w) 只有
        // 16~57 帧，**没有任何像素能达到满累积**（诊断视图 5 看不到绿色），且掠射/远处最差。
        // 因此容差必须显式覆盖这段相位偏移：加上 `相位跨度 × 每纹素视深梯度`。
        // 相位跨度最多 3 个画布纹素，每纹素 ≈ 2 个屏幕像素 ⇒ 6 x giDepthGrad。
        // 官方 `disocclusionThreshold = 0.01`（CommonSettings）："two samples considered occluded
        // if relative distance difference is greater than this **slope-scaled** threshold"。
        // 即比较**相对**深度差，并按局部斜率放宽；这里用屏幕空间视深梯度做斜率项。
        // 另外仍保留一项"棋盘相位偏移"补偿（6×屏幕梯度）：我们的历史取样点带 1~3 画布纹素
        // 的相位偏移，不补偿会让掠射面被系统性误判（这是本包特有、官方无此问题的地方）。
        float _slopeScale = 1.0 + giDepthGrad * rcp(max(abs(viewPos.z), 1e-3));
        float depthTol = abs(prevViewPos.z) * (GI_DISOC_THRESHOLD * _slopeScale) + 6.0 * giDepthGrad;

        for (uint i = 0u; i < 4u; ++i) {
            ivec2 sampleTexel = floorTexel + offset2x2[i];
            if (clamp(sampleTexel, ivec2(0), canvasEnd - 1) == sampleTexel) {
			    vec3 sampleAux = texelFetch(colortex14, sampleTexel, 0).xyz;
                vec4 sampleIrradiance = texelFetch(colortex2, sampleTexel, 0);

                // [逐 tap 容差] 每个 tap 相对本像素中心的偏移量不同（双线性 0~1 纹素 + 棋盘相位
                // 1~3 纹素），而偏移越大、视深偏差越大。若所有 tap 用同一个容差，就会出现
                // **哪些 tap 落在容差内随相位循环变化** 的现象 ⇒ maxGeometryWeight 周期性抖动
                // ⇒ 稳态累积帧数在"橙/黄"之间来回跳（实测：大角度远距离的垂直墙面）。
                // 改成容差与该 tap 自身偏移成正比：相位怎么转，判据都一致。
                // 画布纹素 → 屏幕像素 = ×2；giDepthGrad = 每屏幕像素的视深变化（|dFdx|+|dFdy|）。
                float _tapOffPx = 2.0 * length(vec2(sampleTexel - texelPos));
                float _tapTol = depthTol + _tapOffPx * giDepthGrad;   // 相位偏移补偿（同帧口径）

                float tapGeo = saturate(1.0 - distance(prevViewPos.z, sampleAux.z) / _tapTol);
                tapGeo *= linearstep(0.5, 0.8, saturate(dot(OctDecodeSnorm(sampleAux.xy), worldNormal)));
                if (_dbgForceHistory) tapGeo = 1.0;   // 诊断：取消几何拒绝
                maxGeometryWeight = max(maxGeometryWeight, tapGeo);

                float weight = tapGeo * bilinearWeight[i];

                prevDiffuse += sampleIrradiance * weight;
                prevFast += texelFetch(colortex21, sampleTexel, 0).rgb * weight;
                sumWeight += weight;
            }
        }

        if (sumWeight > EPS) {
            sumWeight = 1.0 / sumWeight;
            prevDiffuse *= sumWeight;
            prevFast *= sumWeight;

            // [2026-08-19 离线渲染] 持续累计：把帧数上限拉高，让时域累积权重更均匀、收敛到更低噪声。
            // 关闭宏时用原 SSILVB_MAX_ACCUM_FRAMES，与之前完全一致。
            // [2026-08-28 ] 累积帧数乘上 maxGeometryWeight（上帧几何可信度）连续衰减：
            // 静止一致 → ≈1，a 正常累加；遮挡/移动/几何剧变 → 骤降 → alpha 变大 → 几乎不混历史。
            #ifdef OFFLINE_RENDER
                integratedDiffuse.a = min(prevDiffuse.a * maxGeometryWeight + 1.0, 1024.0);
            #else
                integratedDiffuse.a = min(prevDiffuse.a * maxGeometryWeight + 1.0, accumCap);
            #endif

            // [输入采样 = REBLUR prepass 的输出] 官方把 prepass 做成一个**独立 pass**
            // (diffusePrepassBlurRadius = 30；注释：must be used in case of badly defined
            //  signals and probabilistic sampling)，在累积之前完成 30 px 空间重用，并把
            // 「归一化命中距离」写进输出的 .a 供空间 pass 使用。
            // 我们已按官方把它实现为 program/diffuse/GIPrepass.comp（deferred1_b），
            // 输出在 colortex22：rgb = 重用后的 YCoCg 输入，a = 归一化命中距离。
            // 这里只负责取它——不再在采样处顺手平均（那是之前的近似做法）。
            integratedDiffuse.rgb = texelFetch(colortex22, texelPos, 0).rgb;

            // [官方 convergenceSettings] f = 1 / (1 + k*N)，其中
            //     k = s * lerp( b, 1, saturate( N / (p * maxAccumulatedFrameNum) ) )
            // 官方参数 s = 1.0（总尺度）、b = 0.2（短历史行为）、p = 0.8（b 影响的比例）。
            // 意图（原文）：b < 1 「历史重置后做更多降噪 —— a blurry result is better on average
            // than a dirty result」；s > 1 「短累积时做更少降噪（干净信号不该被抹）」。
            // N = 1 时 alpha ≈ 0.81（原 1/N 写法是 1.0：第一帧 100% 用单帧样本 ⇒ 闪）。
            // N = 30 时 alpha ≈ 1/31，与原来 1/N 基本一致。
            float alpha;
            {
                const float _convS = 1.0;    // 官方 s
                const float _convB = 0.2;    // 官方 b
                const float _convP = 0.8;    // 官方 p
                float _N = max(integratedDiffuse.a, 1.0);
                float _t = saturate(_N * rcp(max(_convP * accumCap, 1.0)));
                float _k = _convS * mix(_convB, 1.0, _t);
                alpha = rcp(1.0 + _k * _N);
            }

            // [新像素防闪] a < 8（刚出现/历史长度重建不足）时把 alpha 封顶到 1/8：
            // 否则 alpha 可以到 0.8 量级 ⇒ 输出几乎全是**本帧单次采样** ⇒ 逐帧独立跳动（闪）。
            // 这不是新增机制：官方 convergenceSettings 的 b < 1 表达的是同一意图
            //（「a blurry result is better on average than a dirty result」），我们只是把
            // "年轻像素"的混合率再收紧一点；a ≥ 8 后 alpha ≤ 1/a 已经更小，本式不再生效。
            alpha = min(alpha, rcp(max(integratedDiffuse.a, 8.0)));

            // [REBLUR 历史裁剪] 官方做法（`fastHistoryClampingSigmaScale = 2.0`，原文：「REBLUR clamps
            // the spatially processed main history to the spatially unprocessed fast history」）：
            // 把**空间滤波后**的长历史，夹到**未经滤波**的短历史的 `mean ± k·σ`。
            // 短历史只累积、不掺滤波结果（固定 1/6 混合率 = 官方 maxFastAccumulatedFrameNum = 6）
            // ⇒ 参考不会滞后：
            //   · 光照变化（火把挪走）→ 短历史几帧内跟上 → 长历史被拉回 ⇒ 不拖影；
            //   · 静止时短历史邻域足够宽、长历史原样通过 ⇒ 降噪收益不减；
            //   · 长历史被逐帧夹在「当前信号附近」⇒ 滤波反馈不会把细节逐帧压掉。
            // σ 取自短历史 3×3；另加绝对下限（暗处 σ≈0 时防过紧）。
            #ifdef VOXEL_GI_NRD_ACTIVE
                if (GI_FAST_CLAMP_SIGMA > 0.0) {
                    // 官方 fastHistoryClampingSigmaScale = 2.0：σ 取自未经滤波的短历史邻域。
                    // 关键修正（2026-11-08 实测「静止也扭动、动起来更糟」）：
                    //   · 参考必须比被夹的东西**更平滑**，否则每帧都会夹住。短历史只有 6 帧，
                    //     低光下单像素仍有约 40% 波动；用它 3×3 的 σ 当窗口 ⇒ 30 帧的长历史永远在
                    //     窗口外 ⇒ 每帧被拉回，且 anti-lag 每帧把 alpha 抬到 0.3 ⇒ 累积建立不起来。
                    //   · 官方能用是因为它的短历史在 prepass 里已做过 30px 空间重用（参考被平滑过）。
                    //   · 这里改用 5×5 估 μ/σ（等效平滑参考），并加相对下限 15%·μ + 0.01，
                    //     让正常波动落在窗口内；只有真正落后（拖影）才被夹。
                    vec3 _fSum = prevFast;
                    vec3 _fSum2 = prevFast * prevFast;
                    float _fN = 1.0;
                    for (int _fy = -2; _fy <= 2; ++_fy) {
                        for (int _fx = -2; _fx <= 2; ++_fx) {
                            if (_fx == 0 && _fy == 0) continue;
                            ivec2 _ft = texelPos + ivec2(_fx, _fy);
                            if (clamp(_ft, ivec2(0), canvasEnd - 1) != _ft) continue;
                            vec3 _fc = texelFetch(colortex21, _ft, 0).rgb;
                            _fSum += _fc;
                            _fSum2 += _fc * _fc;
                            _fN += 1.0;
                        }
                    }
                    vec3 _mu = _fSum / _fN;
                    vec3 _sigma = sqrt(max(_fSum2 / _fN - _mu * _mu, vec3(0.0)));
                    vec3 _tol = GI_FAST_CLAMP_SIGMA * _sigma + 0.15 * _mu + vec3(0.01);
                    vec3 _histOld = prevDiffuse.rgb;
                    prevDiffuse.rgb = clamp(_histOld, _mu - _tol, _mu + _tol);
                    // [⑧ 官方 antilag] 替换此前"裁剪量→加速"的 RELAX 式近似。
                    // 官方 ReblurAntilagSettings：亮度梯度 delta 与「局部方差 × luminanceSigmaScale」比较，
                    // 超出阈值即缩短历史（提高 alpha），luminanceSensitivity 控制灵敏度（越小越敏感）。
                    const float ANTILAG_SIGMA_SCALE = 2.0;   // luminanceSigmaScale
                    const float ANTILAG_SENSITIVITY = 3.0;   // luminanceSensitivity
                    float _deltaL = abs(integratedDiffuse.r - _histOld.r);
                    float _sigmaChar = max(_sigma.r, 1e-5) * ANTILAG_SIGMA_SCALE;
                    float _thr = max(_sigmaChar * ANTILAG_SENSITIVITY, 1e-5);
                    alpha = max(alpha, saturate((_deltaL - _thr) * rcp(_thr)));
                }
            #endif

            // [2026-08-28 ] 时域累积的连续衰减已由上方 maxGeometryWeight 接管（静止≈1 深累积、
            // 几何剧变骤降少混合历史），这里不再重复调 alpha。仅保留：运动时对该像素做一次
            // 3×3 当前帧邻域平均（前置空间滤波），再进 EAWF，缓解转动脏污。
            {
                // 用全分辨率 UV 与 screenPos.xy（本帧 renderCoord）比：currCoord 是象限空间 UV，
                // 两者相减自带 ≈0.25 的假底盘 ⇒ _preSmooth 恒为 1，前置滤波变成每帧无条件执行。
                float _motion = length(prevCoord - screenPos.xy);
                float _preSmooth = smoothstep(0.02, 0.06, _motion);
                if (_preSmooth > 0.0) {
                    vec3 _sum = integratedDiffuse.rgb;
                    for (int _dy = -1; _dy <= 1; ++_dy) { for (int _dx = -1; _dx <= 1; ++_dx) {
                        ivec2 _t = texelPos + ivec2(_dx, _dy);
                        if (clamp(_t, ivec2(0), canvasEnd - 1) == _t)
                            _sum += texelFetch(colortex3, _t, 0).rgb;
                    }}
                    _sum *= 1.0 / 9.0;
                    integratedDiffuse.rgb = mix(integratedDiffuse.rgb, _sum, _preSmooth * 0.5);
                }
            }

            // ====== 峰值保持：亮度下降慢，上升快 ======
            #ifdef SSILVB_PEAK_HOLD
                float currLuma = integratedDiffuse.r;
                float prevLuma = prevDiffuse.r;
                if (prevLuma > currLuma) {
                    alpha *= SSILVB_HOLD_DOWN_SPEED;
                } else {
                    alpha *= SSILVB_HOLD_UP_SPEED;
                }
            #endif

            // [2026-08-28 PTGI 方案] 更强时域累积：压低 alpha → 等效更多帧累积，磨平 1SPP 密集噪。
            // 代价：移动/转视角更糊、拖影更长（SEUS PTGI 同款取舍）。仅 PTGI(mode=1) 生效，SVGF 不受影响。
            #ifdef VOXEL_GI_PTGI_DENOISE
                alpha *= 0.25;
            #endif

            integratedDiffuse.rgb = mix(min(prevDiffuse.rgb, FP16_MAX), integratedDiffuse.rgb, alpha);
            // 短历史：固定 1/6 混合率（官方 maxFastAccumulatedFrameNum = 6）、**永不掺滤波结果**
            // ⇒ 几帧级的新鲜参考（REBLUR fastHistory）。
            // .a 存**本帧的几何可信度 maxGeometryWeight**（诊断用，见 GI_DEBUG_VIEW 6 档）：
            // 累积帧数的稳态只取决于它（a* = 1/(1-w)），所以 a 停在半途就说明它在扣权重。
            fastHistory = vec4(mix(prevFast, integratedDiffuse.rgb, 1.0 / 6.0),
                               saturate(maxGeometryWeight));
            return;
        }
    }

    // [2026-08-19 NRD] 去遮挡标记：走到这里 = 不可靠（越界/historyReset/深度不匹配）→ a=1
    //
    // [REBLUR HistoryFix] 官方 `historyFixFrameNum = 3`：历史失效时不用"当前帧的模糊样本"当起点，
    // 而是从**仍然有效的历史**（几帧前的短历史）里按深度/法线加权重建。好处：
    //   · 起点是已累积信号 ⇒ 不含本帧冲激（不闪）；
    //   · 亮度正确 ⇒ 不会像 mip3 那样偏暗；
    //   · 与周围像素连续 ⇒ 新区域不出现"补丁"。
    // 步长取官方 historyFixBasePixelStride = 14（像素）：5×5 个 tap、相邻 tap 相隔 14 px，
    // 而不是紧凑 5×5。画布是半分辨率 ⇒ 画布步长 = 14/2 = 7 纹素，覆盖 ±14 画布纹素（≈ ±28 屏幕像素）。
    // 官方这么做的原因：历史失效区域往往成片，采样更远的邻居才能找到"仍有效"的历史。
    #ifdef VOXEL_GI_NRD_ACTIVE
        {
            vec3 _fixSum = vec3(0.0);
            float _fixW = 0.0;
            float _fixA = 0.0;
            for (int _fy = -2; _fy <= 2; ++_fy) {
                for (int _fx = -2; _fx <= 2; ++_fx) {
                    ivec2 _ft = texelPos + ivec2(_fx, _fy) * 7;   // 官方 historyFixBasePixelStride = 14 px（画布半分辨率 ⇒ 7 纹素）
                    if (clamp(_ft, ivec2(1), canvasEnd - 2) != _ft) continue;
                    vec3 _fa = texelFetch(colortex14, _ft, 0).rgb;      // 该邻居的法线+视深
                    vec3 _fc = texelFetch(colortex21, _ft, 0).rgb;      // 该邻居的短历史（已累积）
                    // 深度权重：相对视深差 10% 以外不参与（防跨表面）
                    float _w = saturate(1.0 - abs(GICanvasNeighbourViewDepth(_ft) - viewPos.z) / max(abs(viewPos.z) * 0.1, 1e-3));
                    // 法线权重：同表面才参与
                    _w *= linearstep(0.5, 0.9, saturate(dot(OctDecodeSnorm(_fa.xy), worldNormal)));
                    _fixSum += _fc * _w;
                    // 官方 HistoryFix 同时重建**历史长度**：邻居累积到多少帧，新像素就继承多少。
                    // 不重建长度的后果（实测「新像素闪得厉害」）：新像素 a 恒为 1 ⇒ alpha ≈ 0.83
                    // ⇒ 输出 83% 是本帧单采样 ⇒ 每帧都在跳。继承邻居 a 后 alpha 立刻很小，
                    // 输出≈重建值（平滑），随后正常累积。
                    _fixA += texelFetch(colortex2, _ft, 0).a * _w;
                    _fixW += _w;
                }
            }
            if (_fixW > 1e-4) {
                integratedDiffuse.rgb = _fixSum / _fixW;
                // 打个折扣（0.5）：邻居的长度不完全代表这个新像素，避免过度自信而不响应变化
                integratedDiffuse.a = clamp(_fixA / _fixW * 0.5, 1.0, accumCap);
            } else {
                integratedDiffuse.rgb = textureLod(colortex3, currCoord, 3.0).rgb;
            }
        }
    #else
        integratedDiffuse.rgb = textureLod(colortex3, currCoord, 3.0).rgb;
    #endif
    encodedNormalDepth.a = 1.0;
    fastHistory = vec4(integratedDiffuse.rgb, 1.0);
}

float GetClosestDepthN(in ivec2 texel) {
    float depth = 1.0;

    for (uint i = 0u; i < 8u; ++i) {
        ivec2 sampleTexel = offset3x3N[i] + texel;
        float sampleDepth = loadDepth0(sampleTexel);
        depth = min(depth, sampleDepth);
    }

    return depth;
}

//======// Main //================================================================================//
void main() {
    ivec2 texelPos = ivec2(gl_FragCoord.xy);

    #ifdef VXGI_FULLRES
    ivec2 renderTexel = texelPos;
    #else
    ivec2 renderTexel = texelPos * 2 + checkerboardOffset2x2[frameCounter & 3u];
    #endif
    vec2 renderCoord = texelToUv(renderTexel);

    float depth = loadDepth0(renderTexel);
    bool terrainCheck = min(GetClosestDepthN(renderTexel), depth) < 1.0;
    #if defined LOD_MOD
        bool lodMask = !terrainCheck;
        if (lodMask) {
            depth = loadDepth0Lod(renderTexel);
            terrainCheck = depth < 1.0;
        }
    #endif

    integratedDiffuse = vec4(0.0);
    encodedNormalDepth = vec4(0.0);
    fastHistory = vec4(0.0);

    // 视深的屏幕空间梯度：导数必须在分支外求（下面 if 是逐像素的，导数在非一致控制流里未定义）。
    // 用途见 TemporalFilter 的容差：掠射面（法线近乎垂直于视线）一个纹素的视深变化可达自身深度的
    // 5%~10%，4 个历史 tap 天然偏离重投影像素 0~1 个纹素 ⇒ 固定相对容差会把它们全判成不同表面。
    float giDepthGrad = abs(dFdx(ScreenToViewDepth(depth))) + abs(dFdy(ScreenToViewDepth(depth)));

    // 关降噪（VOXEL_GI_DENOISE 未定义）时本 pass 仍要跑：它才是 4 相位棋盘的重建 +
    // 时域累积（DeferredLight 关降噪时读 colortex2 的累积结果，只跳过 VarianceEstimate/EAWF）。
    // SSILVB 链（GI_ACTIVE_VXGI 未定义）不受影响。
    if (terrainCheck) {
        #if defined LOD_MOD
            if (lodMask) depth = ViewToScreenDepth(ScreenToViewDepthLod(depth));
        #endif

        vec3 screenPos = vec3(renderCoord, depth);
        vec3 worldNormal = FetchSurfaceNormal(renderTexel);

        // [按秒计算的累积上限] NRD 的官方做法（NRDSettings.h）：
        //   "Although all NRD accumulation-related settings are expressed in frames for simplicity,
        //    it is recommended to make the accumulated frame count FPS-dependent. This minimizes lag
        //    at low FPS and maximizes IQ at high FPS. All default values assume 60 FPS."
        // REBLUR 漫反射默认累积时间 = **0.5 秒**（`REBLUR_DEFAULT_ACCUMULATION_TIME`），
        // 换算 `GetMaxAccumulatedFrameNum(0.5, smoothedFPS)`。
        // 我们原来固定 64 帧 ≈ 1.07 s @60fps ⇒ 拖影上限直接翻倍。
        // 这里改成按秒算、并用 SSILVB_MAX_ACCUM_FRAMES 当硬上限（用户仍可调）。
        float accumCap = clamp(GI_ACCUM_TIME / max(frameTime, 1e-4), 8.0, SSILVB_MAX_ACCUM_FRAMES);
        #ifdef VOXEL_GI_DARK_ACCUM
            // [暗处判定必须用稳定量] 原来用 `texelFetch(colortex2, texelPos).r`（**正在累积的 GI 亮度**）
            // 做 smoothstep，这是一个**反馈回路**：亮度收敛 → `_dark` 变 → 上限跟着变 →
            // 累积帧数的目标又变 → 亮度再漂。实测表现正是：诊断视图 5 里累积帧数在橙/黄/绿之间
            // **缓慢平滑移动**，而且因为亮度在整片表面上连续变化 ⇒ "完整表面一起翻绿再跌回"。
            // 改用**原版光照等级**（lightmap，来自 colortex7）：稳定、无反馈，
            // 语义也更准（"只有少量光线照入的暗处"本来就是 lightmap 低的区域）。
            uint _matPack = loadMaterialPack(renderTexel).x;
            float _lmMax = max(Unpack2x8UX(_matPack), Unpack2x8UY(_matPack));   // 方块光 / 天空光取大者
            float _dark = 1.0 - smoothstep(0.10, 0.60, _lmMax);
            accumCap = mix(accumCap, accumCap * 4.0, _dark);
        #endif
        TemporalFilter(texelPos, screenPos, worldNormal, accumCap, giDepthGrad);
    }
}
