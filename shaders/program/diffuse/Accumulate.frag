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
	vec3 viewPos = ScreenToViewPos(screenPos);
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
    encodedNormalDepth = vec4(OctEncodeSnorm(worldNormal), viewPos.z, 0.0);

    if (saturate(prevCoord) == prevCoord && !historyReset) {
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
        // 容差 = max(固定相对 12.5%, GI_ACCUM_DEPTH_GRAD_SLACK x 屏幕空间视深梯度)。
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
        float depthTol = max(abs(prevViewPos.z) * 0.125,
                             GI_ACCUM_DEPTH_GRAD_SLACK * giDepthGrad + 6.0 * giDepthGrad);

        for (uint i = 0u; i < 4u; ++i) {
            ivec2 sampleTexel = floorTexel + offset2x2[i];
            if (clamp(sampleTexel, ivec2(0), canvasEnd - 1) == sampleTexel) {
			    vec3 sampleAux = texelFetch(colortex14, sampleTexel, 0).xyz;
                vec4 sampleIrradiance = texelFetch(colortex2, sampleTexel, 0);

                float tapGeo = saturate(1.0 - distance(prevViewPos.z, sampleAux.z) / depthTol);
                tapGeo *= linearstep(0.5, 0.8, saturate(dot(OctDecodeSnorm(sampleAux.xy), worldNormal)));
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

            // [细节收敛斜坡] 新暴露/新累积的像素先给「平滑无细节」的值，再逐帧补细节：
            //   a ≈ 0  → mip3（半分辨率下 8x8 纹素 ≈ 屏幕 16x16 平均）
            //   a → N  → mip 分档降到 0（逐像素原始样本）
            // 这是"先稳再长细节"的机制。
            // 关键：**mip 输入必须量化**。a 在静止时也不是常数——4 相位棋盘每帧把历史取样点
            // 挪 ±1 纹素，4 个 tap 落在不同邻居上 ⇒ maxGeometryWeight 轻微抖动 ⇒ a 抖 ±1。
            // 若 mip 等级是 a 的连续函数，取样的模糊度就逐帧变 ⇒ 静止画面也在动
            //（实测：把本项调到 16 后静止又"不稳定"，就是这条路径覆盖了更多像素）。
            // 量化到 8 帧一档：正常抖动不跨档 ⇒ 静止稳定；细节仍按档位长出来。
            if (integratedDiffuse.a < GI_DISOC_DETAIL_FRAMES) {
                float _aQ = floor(integratedDiffuse.a * 0.125) * 8.0;   // 8 帧一档
                float mipLevel = 3.0 * saturate(1.0 - _aQ * rcp(GI_DISOC_DETAIL_FRAMES));
                integratedDiffuse.rgb = textureLod(colortex3, currCoord, mipLevel).rgb;
            } else {
                integratedDiffuse.rgb = texelFetch(colortex3, texelPos, 0).rgb;
                // [REBLUR prepass 等价物 / spatial reuse] 官方 diffusePrepassBlurRadius = 30
                // （注释：「0 = disabled, must be used in case of badly defined signals and
                //   probabilistic sampling」）—— 本包 GI 正是这种信号（1spp、命中率 1~3%）。
                // 官方 prepass：对**噪声输入**做 30 px 半径的空间重用，把稀疏噪声稠密化后才进累积。
                // 我们无法新开 pass（deferred1/2/3 槽位全占用），因此在取输入处做等价重用：
                //   9×9、步长 2 ⇒ 覆盖 ±16 画布纹素 ≈ ±32 屏幕像素（画布是半分辨率），对齐官方 30 px；
                //   **无条件执行**（官方如此；历史占主导后 alpha 很小，等效影响自然衰减）；
                //   深度/法线加权挡跨表面 —— 用本帧的 colortex14 是上一帧的 aux，故只用视深+法线，
                //   且相对视深差 10%（比官方的切平面距离宽，因为我们是上一帧 aux）。
                #ifdef VOXEL_GI_NRD_ACTIVE
                {
                    vec3 _rsSum = integratedDiffuse.rgb;
                    float _rsW = 1.0;
                    for (int _ry = -8; _ry <= 8; _ry += 2) {
                        for (int _rx = -8; _rx <= 8; _rx += 2) {
                            if (_rx == 0 && _ry == 0) continue;
                            ivec2 _rt = texelPos + ivec2(_rx, _ry);
                            if (clamp(_rt, ivec2(1), canvasEnd - 2) != _rt) continue;
                            vec3 _ra = texelFetch(colortex14, _rt, 0).rgb;   // 邻居法线 + 视深
                            float _rw = saturate(1.0 - abs(GICanvasNeighbourViewDepth(_rt) - viewPos.z) / max(abs(viewPos.z) * 0.1, 1e-3));
                            _rw *= linearstep(0.5, 0.9, saturate(dot(OctDecodeSnorm(_ra.xy), worldNormal)));
                            _rw *= 1.0 / (1.0 + float(_rx * _rx + _ry * _ry) * 0.02);   // 径向衰减
                            _rsSum += texelFetch(colortex3, _rt, 0).rgb * _rw;
                            _rsW += _rw;
                        }
                    }
                    integratedDiffuse.rgb = _rsSum / _rsW;
                }
                #endif
            }

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
                    // anti-lag：只在确实夹掉很多（超过 60% 窗口）时加速，上限 0.1。
                    // 原来「夹多少就加速多少、上限 0.3」会在正常波动下每帧抬 alpha ⇒ 累积失效。
                    float _span = max(max(_tol.r, _tol.g), _tol.b) + 1e-4;
                    float _clampAmt = saturate(length(_histOld - prevDiffuse.rgb) / _span);
                    alpha = max(alpha, step(0.6, _clampAmt) * _clampAmt * 0.1);
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
    // 半径取 5×5（画布是半分辨率，相当于屏幕 10×10），比官方 5×5@stride14 保守。
    #ifdef VOXEL_GI_NRD_ACTIVE
        {
            vec3 _fixSum = vec3(0.0);
            float _fixW = 0.0;
            float _fixA = 0.0;
            for (int _fy = -2; _fy <= 2; ++_fy) {
                for (int _fx = -2; _fx <= 2; ++_fx) {
                    ivec2 _ft = texelPos + ivec2(_fx, _fy);
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
            float _luma = max(texelFetch(colortex2, texelPos, 0).r, 0.0);
            float _dark = 1.0 - smoothstep(0.003, 0.06, _luma);
            accumCap = mix(accumCap, accumCap * 4.0, _dark);
        #endif
        TemporalFilter(texelPos, screenPos, worldNormal, accumCap, giDepthGrad);
    }
}
