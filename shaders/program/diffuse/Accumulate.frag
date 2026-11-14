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
#include "/lib/universal/SSBO.glsl"

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
#ifndef GI_MOTION_RESPONSE
    #define GI_MOTION_RESPONSE 0.0
#endif

// 每帧输入的**等效样本数**（GI_EFFECTIVE_SPP，选项在 settings.glsl）：
// 本包的输入早已不是 1 spp——GIPrepass 用 32 个样本做 30 纹素空间重用，追踪端还有 ReSTIR
// 复用。照搬官方「时间 / 帧时间」换算会把上限高估 ≈ 该倍数 ⇒ 累积过粘（拖影、火把挪走
// 后要近 1 秒才跟上）。这里显式折算：cap = 时间 / (帧时间 × 等效样本数)。

#ifdef TAA_ENABLED
    #define SHOULD_APPLY_JITTER
#endif

// [2026-11-11 官方拓扑] 官方顺序是 PrePass → **Accumulate** → HistoryFix → Blur → PostBlur。
// HistoryFix 作用在**累积之后**、修的是本帧 TA 输出、结果只喂 Blur 且**不回写历史**
//（见 deferred5 与 GIHistoryFix.comp 顶部）。所以本 pass 的历史只有一条来源：
// colortex2 的上一帧内容（帧末由 GIHistoryStore 覆盖成"上一帧的空间滤波最终输出"）。
// [2026-11-11 官方拓扑] 历史 = **colortex2 的上一帧内容**。
// 官方：TA 读 gHistory_Diff（PERMANENT），而写它的是 PostBlur 的输出（见 GIHistoryStore.comp）。
// [2026-11-13 默认改了] 上面这条「帧末覆盖成空间滤波输出」现在只在 GI_RECURRENT_HISTORY=1 时成立；
// **默认是 0（SVGF 式）**，GIHistoryStore 不再回写 rgb ⇒ 历史就是本 pass 自己写下的原始累积。
// 理由与取舍见 settings.glsl 的 GI_RECURRENT_HISTORY 说明：细节留在历史里，靠噪声下降自己浮出，
// 而不是靠逐帧滤波把细节磨掉后收半径找回来。`.a`（累积帧数）两条路都不动。
// HistoryFix 已移到 deferred5（TA 之后），它的输出只喂 Blur，**不再进入历史**。
#define GI_HISTORY_TEX colortex2

// GI 画布某个纹素「**本帧**」的视深（负值，与 viewPos.z 同口径）。
// 为什么需要：空间重用块要判断"邻居是不是同一个表面"，而 `colortex14` 里存的是**上一帧**的
// 视深。静止时两者相等；一移动，同一世界点在两帧的视深整体错位 ⇒ 邻居全被误判为不同表面
// ⇒ 退回单帧/mip 采样 ⇒ 运动时闪、且预滤波失效（实测"动起来更糟、仍然闪"）。
// 深度必须取**同帧**口径：从 depthtex 按本帧的棋盘相位取邻居的深度再换算成视深。
// [2026-11-10] 原来内联的 ±28px 重建（本函数的唯一调用者）已删除，统一交给 deferred1_c。


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

	// [2026-11-13 去掉重投影上的 TAA jitter] 这里原来写 `prevNDCPos.xy += taaJitterPrev;`。
	// 但 GI 信号本身**不含 jitter**：DiffuseIndirect.comp 里零处用到 taaJitter，
	// trace 的屏幕位置就是像素中心（`texelToUv(renderTexel)`）。
	// 给重投影额外加一个亚像素偏移，等于人为把 4 个历史 tap 每帧挪动 0~1 纹素：
	//   · 静止时这是唯一还在动的量 ⇒ `maxGeometryWeight` 在几何边缘两侧来回采
	//     ⇒ 反复跨过 conf 阈值 ⇒ A 被重置 ⇒ alpha 从 0.8% 跳到 81%
	//     ⇒ 重新灌入一帧 1spp 样本（弱光下常接近 0）⇒ 忽然出现又消失的黑点。
	// 官方 NRD 的 TA 重投影用的是 motionMatrix，同样不含 TAA jitter（jitter 只在最终
	// 全分辨率 resolve 时才参与）。去掉后 prevCoord 在静止时恒定，tap 固定。

	vec2 prevCoord = prevNDCPos.xy * 0.5 + 0.5;

    // a 默认 0（可靠）；不可靠/重投影失效路径在下方置 1
    // 视深用 `ScreenToViewDepth(depth)`（纯投影逆变换，与 taaJitter 无关）——
    // 与 TemporalFilter 里无抖动的 `viewPos` 同口径。
    // 若这里写 `viewPos.z`（带抖动），下一帧的判据就会读到上一帧抖动相位的深度，
    // 造成"静止时累积帧数平滑缓慢起伏"（见 TemporalFilter 顶部注释）。
    encodedNormalDepth = vec4(OctEncodeSnorm(worldNormal), ScreenToViewDepth(screenPos.z), 0.0);

    // [诊断] GI_DEBUG_NO_DISOC = 1：取消一切历史拒绝（越界/重置/深度/法线全不看），
    // 强制历史永远有效。用途：一键判断闪是来自「历史被拒 + 重建」还是「采样/滤波」。
    // 关闭时行为逐位不变（条件里只多一个编译期常量 0）。
    bool _dbgForceHistory = GI_DEBUG_NO_DISOC > 0;
    // [GI_BISECT bit2 = 4] 忽略 historyReset（该 uniform 由 Iris 自定义表达式求值，
    // 若环境不支持 smooth() 可能恒为 true ⇒ 每帧全局重置历史 ⇒ 完全无法累积）。
    bool _ignoreReset = (GI_BISECT & 4) != 0;
    bool _histOk = _dbgForceHistory || (saturate(prevCoord) == prevCoord && (_ignoreReset || !historyReset));
    if (_histOk) {
        vec4 prevDiffuse = vec4(0.0);
        vec3 prevFast = vec3(0.0);   // 短历史（同一组双线性权重）
        float sumWeight = 0.0;
        // [2026-08-28 ] 上帧该像素的可信度 = 4 tap 里几何一致权重的最大（不含双线性）。
        // 几何一致（静止）→ 接近 1；遮挡/移动/几何剧变 → 骤降，驱动累积帧数连续衰减。
        float maxGeometryWeight = 0.0;
        // 官方 `smbFootprintQuality = sqrt( bilinear(occlusionBits) )`：逐 tap 的几何判据按
        // 双线性权重平均。[2026-11-14] 用**连续**的切平面权重而不是 0/1 二值位：官方二值位配
        // 的是 frustum 尺度的容差，本包的深度判据本身是连续量，硬阈值 0.5 会让掠射面/凹凸面
        // 在转头时跨阈值 ⇒ fpq 从 1 掉到 0.5 ⇒ 累积速度被乘半，表现为「没出屏也突然变噪」。
        float footprintSum = 0.0;

        // Custom bilinear filter
        #ifdef VXGI_FULLRES
        // 全分辨率：历史就是本像素，不需要相位补偿
        vec2 prevTexel = prevCoord * viewSize - 0.5;
        #else
        vec2 prevTexel = (prevCoord * viewSize
         - GI_CANVAS_PHASE
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
        // [2026-11-08 相位偏移] 当时还有一层固定偏移：历史取样点在 `prevTexel` 里减掉了**上一帧**的
        // 棋盘相位，所以它相对本像素中心偏 1~3 个画布纹素（= 2~6 个屏幕像素）。深度判据比的是
        // 这些偏移位置的视深，差值 ≈ 局部斜率 × 偏移量 ⇒ 掠射面必然被扣权重。
        // [2026-11-11 量纲修正] 上面那条相位偏移已经不存在了：`GI_CANVAS_PHASE` 固定为 (0,0)
        // （lib/utility/Offset.glsl，官方 README 明确要求四分之一分辨率用固定 pixelPos/2，
        // 不要逐帧轮转）。但补偿项留了下来，而且量纲错了一倍：
        //   `giDepthGrad` 是 **每画布纹素** 的视深变化（本 pass 就在画布分辨率下光栅化，
        //   dFdx/dFdy 的步长 = 1 画布纹素 = 2 屏幕像素），而旧写法把 `sampleTexel - texelPos`
        //   先乘 2 当成屏幕像素、再乘这个「每画布纹素」的梯度 ⇒ 容差整整放大一倍；
        //   另外固定项 `6.0 * giDepthGrad` 是 6 个**画布纹素**，本意是 6 个屏幕像素（= 3 纹素）。
        // 容差偏大的直接后果就是把深度差 10%~20% 的另一层表面的历史也判成「同一表面」并混进来
        // —— 实机表现正是「拖影被拉到其他深度不同的表面上」。现在改为：
        //   固定补偿 = 1 个画布纹素（双线性落点最多偏 1 纹素）
        //   逐 tap 补偿 = 该 tap 与中心的**画布纹素**距离 × 每画布纹素的视深梯度
        // 官方 `disocclusionThreshold = 0.01`（CommonSettings）："two samples considered occluded
        // if relative distance difference is greater than this **slope-scaled** threshold"。
        float _slopeScale = 1.0 + giDepthGrad * rcp(max(abs(viewPos.z), 1e-3));
        float depthTol = abs(prevViewPos.z) * (GI_DISOC_THRESHOLD * _slopeScale) + giDepthGrad;

        for (uint i = 0u; i < 4u; ++i) {
            ivec2 sampleTexel = floorTexel + offset2x2[i];
            if (clamp(sampleTexel, ivec2(0), canvasEnd - 1) == sampleTexel) {
			    vec3 sampleAux = texelFetch(colortex14, sampleTexel, 0).xyz;
                vec4 sampleIrradiance = texelFetch(GI_HISTORY_TEX, sampleTexel, 0);

                // [逐 tap 容差] 每个 tap 相对本像素中心的偏移量不同（双线性 0~1 纹素 + 棋盘相位
                // 1~3 纹素），而偏移越大、视深偏差越大。若所有 tap 用同一个容差，就会出现
                // **哪些 tap 落在容差内随相位循环变化** 的现象 ⇒ maxGeometryWeight 周期性抖动
                // ⇒ 稳态累积帧数在"橙/黄"之间来回跳（实测：大角度远距离的垂直墙面）。
                // 改成容差与该 tap 自身偏移成正比：相位怎么转，判据都一致。
                // [2026-11-11 量纲修正] 距离用**画布纹素**（与 giDepthGrad 同口径），不再 ×2。
                float _tapOffTexels = length(vec2(sampleTexel - texelPos));
                float _tapTol = depthTol + _tapOffTexels * giDepthGrad;   // 双线性落点补偿（同帧口径）

                // 遮挡位只由**深度/切平面**判据决定（官方 TA 的法线位阈值是 cos(89°)，
                // 几乎恒真；把带法线的 tapGeo 二值化会在凹凸表面过度衰减累积速度）。
                float tapPlane = saturate(1.0 - distance(prevViewPos.z, sampleAux.z) / _tapTol);
                float tapGeo = tapPlane * linearstep(0.5, 0.8, saturate(dot(OctDecodeSnorm(sampleAux.xy), worldNormal)));
                if (_dbgForceHistory) { tapPlane = 1.0; tapGeo = 1.0; }   // 诊断：取消几何拒绝
                maxGeometryWeight = max(maxGeometryWeight, tapGeo);
                footprintSum += bilinearWeight[i] * tapPlane;

                float weight = tapGeo * bilinearWeight[i];

                // [2026-11-13 官方帧数闭环] 官方 TA 读的 data1.x 是**上一帧 TS 输出**的
                // 累积速度（TS 里 `data1.x = lerp(min(N,3), N, antilag)` 后由 PackInternalData
                // 加一并 clamp）。本项目此前读 colortex2.a（TA 自己写下的值），TS 的 antilag
                // 调整从未回流 ⇒ 光照突变时 TS 压低了历史权重，下一帧 TA 却仍按长历史累积。
                // colortex23.a 正是上一帧 TS 的 ageOut（deferred11 最后写它），改读它。
                // .a 携带的是帧数，与颜色一起按同一组权重双线性平均（官方 internalData 也走双线性）。
#ifdef VOXEL_GI_NRD_ACTIVE
                float _ageSample = texelFetch(colortex23, sampleTexel, 0).a;
#else
                float _ageSample = sampleIrradiance.a;
#endif
                if (!(_ageSample >= 0.0) || _ageSample > 1e6) _ageSample = 0.0;
                prevDiffuse += vec4(sampleIrradiance.rgb, _ageSample) * weight;
                prevFast += texelFetch(colortex21, sampleTexel, 0).rgb * weight;
                sumWeight += weight;
            }
        }

        if (sumWeight > EPS) {
            sumWeight = 1.0 / sumWeight;
            prevDiffuse *= sumWeight;
            prevFast *= sumWeight;

            // [2026-11-10 1.4] 历史兜底：本 pass 是整条链上唯一没有 Denanify 的地方。
            // NaN/Inf 一旦被读进 prevDiffuse，下一帧写回又会被读到 ⇒ 永久锁死在该像素
            // （官方在 TA 入口同样按 Denanify 处理）。有限值时两个判断都为假，逐位不变。
            if (any(isnan(prevDiffuse)) || any(isinf(prevDiffuse))) prevDiffuse = vec4(0.0);
            if (any(isnan(prevFast)) || any(isinf(prevFast))) prevFast = vec3(0.0);

            // [2026-11-11 官方 ClampNegativeToZero] 官方在 YCoCg 模式下把历史转回 RGB、
            // clamp 掉负值、再转回 YCoCg（REBLUR_Common.hlsli:221-233）。负的 Y 会让后续
            // 亮度判据（antilag / RCRS / firefly 压制）拿到错误的分母，表现为黑块与滤波异常；
            // 我们的历史从来没有做过这一步。正值历史往返一次是恒等，静止时无可观变化。
            {
                vec3 _rgbHist = YCoCgToRGB(prevDiffuse.rgb);
                prevDiffuse.rgb = RGBToYCoCg(max(_rgbHist, vec3(0.0)));
            }

            // [2026-11-13 官方 TA:903] 累积速度的置信度衰减：
            //   diffAccumSpeed *= lerp( diffHistoryConfidence, 1.0, 1.0 / (1.0 + diffAccumSpeed) )
            // 官方 +1 发生在帧末的 PackInternalData（TS 之后），这里等价为「先 +1、再乘衰减」。
            // diffHistoryConfidence = sqrt( 双线性加权后的逐 tap 平面权重 )（见上：用连续值，
            // 避免硬阈值在转头时把 fpq 从 1 打到 0.5）。
            // [替代的旧实现] 二值滞回（可信 +1 / 边缘 -1 / 不可信归 1）。它在 conf 0.3~0.5 时
            // 一帧只掉 1 帧，而官方一帧就把 30 帧乘到 9~15 帧 ⇒ 边缘与掠射面的拖影慢十几倍。
            #ifdef OFFLINE_RENDER
                const float _capA = 1024.0;
            #else
                const float _capA = accumCap;
            #endif
            float _ageRead = min(prevDiffuse.a + 1.0, _capA);
            float _fpq = sqrt(saturate(footprintSum));
            integratedDiffuse.a = _ageRead * mix(_fpq, 1.0, rcp(1.0 + _ageRead));

            // [输入采样 = REBLUR prepass 的输出] 官方把 prepass 做成一个**独立 pass**
            // (diffusePrepassBlurRadius = 30；注释：must be used in case of badly defined
            //  signals and probabilistic sampling)，在累积之前完成 30 px 空间重用，并把
            // 「归一化命中距离」写进输出的 .a 供空间 pass 使用。
            // 我们已按官方把它实现为 program/diffuse/GIPrepass.comp（deferred1_b），
            // 输出在 colortex22：rgb = 重用后的 YCoCg 输入，a = 归一化命中距离。
            // 这里只负责取它——不再在采样处顺手平均（那是之前的近似做法）。
            // [2026-11-13 修正] 旧注释写「colortex22 只在 NRD 模式由 deferred1_b 写入」是错的：
            // deferred1_b 没有任何条件门控，prepass **每帧都在算**、colortex22 每帧都是有效值。
            // 所以 VXGI 路径（含关降噪）统一读 colortex22；只有 SSILVB 仍读 colortex3。
            // 这样「光追降噪」开关关掉后，看到的是**降噪器真正收到的信号**，而不是 prepass 之前的
            // 裸追踪 —— 后者比真实输入脏一档（少 8 tap / 半径 30 纹素的空间重用），容易误判。
#ifdef GI_ACTIVE_VXGI
            integratedDiffuse.rgb = texelFetch(colortex22, texelPos, 0).rgb;
#else
            integratedDiffuse.rgb = texelFetch(colortex3, texelPos, 0).rgb;
#endif

            // [2026-11-13 官方修正] TA 的混合率是**纯 1/(1+N)**（TA:949），不是
            // `GetAdvancedNonLinearAccumSpeed`。后者是 Blur 半径与 TS 历史权重用的公式
            //（带 s=1 / b=0.2 / p=0.8），管的是「空间滤波多宽、稳定化历史多重」，
            // **不参与时域累积本身**。
            // 旧实现把 advanced 公式搬到 alpha：N=1 时 alpha 0.83（官方 0.5）、N=30 时两者接近。
            // 也就是说新像素/刚重置像素采纳本帧太快 ⇒ 移动与新露出区域更噪。
            float alpha = rcp(1.0 + max(integratedDiffuse.a, 0.0));

            // [fast-history clamp] 官方机制在 **GIHistoryFix**（deferred5）里执行：
            // 把空间滤波后的长历史亮度夹到「未经滤波的 6 帧短历史」的 mean ± k·σ
            //（fastHistoryClampingSigmaScale，默认 2.0，GUI 项 NRD_HISTORYFIX_CLAMP_SIGMA）。
            // TA 这里**不做**颜色盒——官方 TA 是纯 lerp；旧的自造 5×5 clamp 已于 2026-11-11 移除
            //（它把 6 帧短历史的噪声逐帧拉进长历史，是静止蠕动与拖影的来源之一）。

            // [2026-11 回正] 原"_preSmooth 运动前置平滑"已删除。它用全分辨率 UV 与象限空间的
            // screenPos 相减，恒带 ≈0.25 的假底盘 ⇒ 平滑每帧无条件执行；而且混合源 colortex3
            // 是上一帧的 EAWF 输出 ⇒ 空间滤波结果被反复掺回累积，是"静止持续蠕动"的直接来源。
            // 稠密化交给 prepass（已对齐官方 30px），官方也没有这个前置滤波。

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

            // [运动自适应] 长历史只在「相机确实在动」时让路：重投影位移超过 2 px 后，
            // 本帧权重抬到至少 0.35 ⇒ 拖影时间常数从 cap 帧压到约 2 帧。
            // 静止时 prevCoord == screenPos.xy（只剩 TAA 亚像素抖动 < 1 px）⇒ boost = 0，
            // 有限值下逐位不变。暗处 VOXEL_GI_DARK_ACCUM 的 cap×4 也被这一步覆盖。
            float _motionPx = length((prevCoord - screenPos.xy) * viewSize);
            float _motionBoost = smoothstep(2.0, 12.0, _motionPx) * GI_MOTION_RESPONSE;
            alpha = mix(alpha, max(alpha, 0.35), _motionBoost);

            vec3 _currRaw = integratedDiffuse.rgb;   // 短历史必须用**未经压制**的本帧输入（见下）
            integratedDiffuse.rgb = mix(min(prevDiffuse.rgb, FP16_MAX), _currRaw, alpha);

            // [官方 firefly suppressor] 对齐 `REBLUR_TemporalAccumulation` 的 diffuse 分支
            //（TA:960-979）：
            //   maxRel = gFireflySuppressorMinRelativeScale(2.0) + 38.0 / (accumSpeed + 1.0)
            //   amount = accumSpeed · gMaxBlurRadius · 0.1;  amount /= 1 + amount
            //   luma   = lerp( luma(result), min(luma(result), luma(history)·maxRel), amount )
            //
            // [2026-11-13 修正] 这里的 accumSpeed 就是**累积帧数 N**（官方 TA 的 diffAccumSpeed），
            // 不是归一化的 alpha。旧注释写成「alpha 值域 0~1」是误读：按 alpha 算的话，
            // 稳定像素（N=30 ⇒ alpha≈0.032）得到 maxRel≈38.8、amount≈0.10，
            // 官方是 maxRel≈3.23、amount≈0.99 ⇒ 亮点几乎不受抑制。
            // amount 也确认是 x/(1+x)，不是 saturate(x)（官方 TA:964-965）。
            // 短历史（fastHistory）仍取原始 _currRaw：官方 fast 也用 GetLuma(diff)，不受压制影响。
            {
                float _ffSpeed  = max(integratedDiffuse.a, 0.0);
                float _ffMaxRel = 2.0 + 38.0 / (_ffSpeed + 1.0);
                // 官方 amount 里的 gMaxBlurRadius = 30（NRD rect 像素）= NRD_RADIUS_PX*10。
                float _ffAmt    = _ffSpeed * (NRD_RADIUS_PX * 10.0) * 0.1;
                _ffAmt          = _ffAmt / (1.0 + _ffAmt);
                float _ffLuma   = max(integratedDiffuse.r, 1e-6);
                float _ffCap    = prevDiffuse.r * _ffMaxRel;
                integratedDiffuse.rgb *= mix(_ffLuma, min(_ffLuma, _ffCap), _ffAmt) / _ffLuma;

                // [2026-11-10 4.11] 短历史同口径压一次（官方 `diffFastClamped`，
                // FAST_RELATIVE_INTENSITY = 1.5）。不压的话单个火点会以 1/6 权重进入短历史并在
                // 其中停留 ~6 帧，把「历史裁剪」的参考区间撑宽 → 该区域几帧内几乎不裁剪。
                // [2026-11-11 官方对齐] fast history 的累积速度 = min(data1.x, maxFastAccumulatedFrameNum=6)，
                // 混合率 = 1/(1+N)（NRDSettings.h:284、TA:988-994）。
                float _fastN = min(_ffSpeed, 6.0);
                vec3 _ffFast = mix(prevFast, _currRaw, rcp(1.0 + _fastN));
                float _ffFastL = max(_ffFast.r, 1e-6);
                _ffFast *= mix(_ffFastL, min(_ffFastL, prevDiffuse.r * _ffMaxRel * 1.5), _ffAmt) / _ffFastL;

                // 短历史：混合率 1/(1+min(N, 6))（官方 maxFastAccumulatedFrameNum = 6）、
                // **永不掺滤波结果** ⇒ 几帧级的新鲜参考（REBLUR fastHistory）。
                // .a 存**本帧的几何可信度**（诊断用，见 GI_DEBUG_VIEW 6 档）：
                // 累积帧数的稳态只取决于它（a* = 1/(1-w)），所以 a 停在半途就说明它在扣权重。
                fastHistory = vec4(_ffFast, saturate(maxGeometryWeight));
                return;
            }
        }
    }

    // [2026-08-19 NRD] 去遮挡标记：走到这里 = 不可靠（越界/historyReset/深度不匹配）→ a=1
    //
    // [2026-11-10 去重] 这里原来还有**第二个** HistoryFix：步长 7 画布纹素（±28 屏幕像素）的 5×5，
    // 读 6 帧短历史（colortex21），并把历史长度写成 `clamp(_fixA / _fixW * 0.5, 1, accumCap)`。
    // 现在修复统一由 deferred1_c（GIHistoryFix，累积之前）完成，本 pass 只做"拒绝历史 + 用已修复的历史起步"。
    // 保留两份修复器的后果（实测）：
    //   · 历史长度被抬到十几~几十帧 ⇒ alpha 极小 ⇒ **静止时那些斑块几十帧不散**（不动的斑点）；
    //   · 每帧重算 ±28px 的短历史平均 ⇒ 转头时跟不住 ⇒ **拖影**。
    // 长度封顶 3（= historyFixFrameNum）：这些像素本来就被判为"历史不可信"，必须几帧内重新收敛。
    // 价值来源仍是 GIHistoryFix 的输出（邻居的长历史，或它自己退到 prepass 的结果）。
    #ifdef VOXEL_GI_NRD_ACTIVE
        {
            // [2026-11-11 官方口径] 历史失效时 TA 使用**本帧输入**并把帧数置 1
            //（官方 TA 的 disocclusion 分支：diff = gIn_Diff, data1.x = 0 ⇒ 下一帧视为 1）。
            // 旧实现是"取 colortex2 里的旧值、帧数压到 1~3" ⇒ 去遮挡像素继续复用旧的滤波值，
            // 移动时表现为**沿着物体边缘拖一条**。改成用本帧 prepass 结果（已做过 30 纹素空间重用），
            // 既新鲜又不脏。降噪开启时**只取中心**，不做邻居平均（保留官方口径的锐度）。
            integratedDiffuse.rgb = texelFetch(colortex22, texelPos, 0).rgb;
            integratedDiffuse.a = 1.0;
        }
    #elif defined GI_ACTIVE_VXGI
        {
            // [2026-11-13] 关降噪的 VXGI：同样用 prepass 输出（colortex22），但保留 5-tap 十字平均。
            // 为什么保留：prepass 的 30 纹素核只覆盖"同一表面"的邻居，新露出区域的边界以外
            // 还没被它平均到；这一层把跨界样本先摊平，避免新像素直接拿单点出图（实机会看到
            // 新像素明显更脏）。为什么读 22 而不是 3：22 才是降噪器真正收到的信号，读 3 等于
            // 把这个诊断档变成"prepass 之前"的样子，比真实输入脏一档，容易误判。
            ivec2 _c = clamp(texelPos, ivec2(0), canvasEnd - 1);
            vec3 _s = texelFetch(colortex22, _c, 0).rgb;
            float _w = 1.0;
            const ivec2 _o[4] = ivec2[4](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));
            for (int _i = 0; _i < 4; ++_i) {
                ivec2 _t = clamp(_c + _o[_i], ivec2(0), canvasEnd - 1);
                _s += texelFetch(colortex22, _t, 0).rgb;
                _w += 1.0;
            }
            integratedDiffuse.rgb = _s * rcp(_w);
        }
    #else
        // [2026-11-11 半分辨率契约修正] 这里原来是 `textureLod(colortex3, currCoord, 3.0)`，
        // 其中 `currCoord = texelToUv(texelPos)` 用的是**全分辨率**像素尺寸，而 texelPos 是
        // **画布**坐标（半分辨率）。于是它取的是「整个全分辨率缓冲的第 3 级 mip」——
        // 而 GI 只写在该缓冲的左上 1/4 象限、mip 链是跨整张图建的 ⇒ 取到的内容与画布完全错位
        //（相当于把 1/16 分辨率的内容当成邻居起点）。这也是本 pass 申请
        // `colortex3MipmapEnabled` 的唯一理由，那条现在一并删掉（省一条全分辨率 mip 链）。
        // 正确做法：在**画布坐标**上取 4 个近邻求平均，纯 texelFetch，不碰 mip、不碰 UV。
        {
            ivec2 _c = clamp(texelPos, ivec2(0), canvasEnd - 1);
            vec3 _s = texelFetch(colortex3, _c, 0).rgb;
            float _w = 1.0;
            const ivec2 _o[4] = ivec2[4](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));
            for (int _i = 0; _i < 4; ++_i) {
                ivec2 _t = clamp(_c + _o[_i], ivec2(0), canvasEnd - 1);
                _s += texelFetch(colortex3, _t, 0).rgb;
                _w += 1.0;
            }
            integratedDiffuse.rgb = _s * rcp(_w);
        }
    #endif
    encodedNormalDepth.a = 1.0;
    // 兜底路径用 -1 标记（weight = 1 时上一帧是白色，与"完全接受历史"无法区分；负数可分）
    fastHistory = vec4(integratedDiffuse.rgb, -1.0);
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
    ivec2 renderTexel = texelPos * 2 + GI_CANVAS_PHASE;
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
        // [逐帧抖动] `frameTime` 是**瞬时**值（0.014/0.015 每帧不同）⇒ 上限每帧变几帧
        // ⇒ 被 clamp 到上限的 `a` 每帧跟着变 ⇒ 诊断视图 1 里**整屏红线极小幅度抽抽**，
        // 且 alpha 随之变 ⇒ 静止无法稳定（实测两轮）。
        // 官方对此有明确警告：
        //   "The FPS passed to this function must be **low pass filtered** to reduce reactions to
        //    transient drops (stutters). Without filtering, a momentary 60 => 30 => 60 FPS change
        //    with a 0.5-second accumulation time changes the limit from 30 => 15 => 30 frames."
        // [2026-11-11 已对齐] 官方要求的「FPS 先低通」现在由 GlobalStorage.comp 统一完成
        //（SSBO `global.smoothedFrameTime`，EMA 时间常数约 10 帧）。三处消费者
        //（本文件 / EAWF / GIStabilize）读同一个值 ⇒ cap、alpha、滤波半径、TS 权重
        // 不再随单帧掉帧整屏抽动。这里的注释保留为历史记录，不再代表现状。
        // [有效样本数折算] 上限按「每帧等效样本数」折算：
        // 除以 GI_EFFECTIVE_SPP 是为了不让上游的 32 样本空间重用被重复计入。
        // 兜底：若 SSBO 尚未被 GlobalStorage 写过（首帧/异常路径），退回瞬时值，
        // 避免 `max(0, 1e-4)` 把 cap 顶到硬上限导致累积过粘。
        float _stableFrameTime = global.smoothedFrameTime > 1e-6
                               ? global.smoothedFrameTime
                               : max(frameTime, 1e-4);
        // [2026-11-13 试过 32 帧下限，已回退] 动机：这一层「时间 ÷ 帧时间」在低帧率下会把
        // 累积帧数一起压小（5 fps、2 s ⇒ 只有 10 帧）。但实测（11 fps，块内时域标准差 B=16）
        // 与直觉相反：cap 22 → 0.24、cap 32 → 0.46，**cap 越大越吵**。
        // 原因：cap 不只喂 alpha，还喂 EAWF 的 NLAS（minHitDistWeight ∝ NLAS）和 TS 的
        // accumSpeed（antilag 灵敏度 ∝ accumSpeed）⇒ cap 大 ⇒ 空间权重变小 + 历史更容易被拒。
        // 所以「多累积几帧」在这套实现里不是单调收益，不要再想当然地加下限。
        float _targetCap = clamp(GI_ACCUM_TIME / (_stableFrameTime * max(GI_EFFECTIVE_SPP, 1.0)),
                                 8.0, SSILVB_MAX_ACCUM_FRAMES);
        // [2026-11-10 去掉 8 帧量化] 量化本意是"fps 抖动不该改变档位"，但档位边界上它会
        // 把连续抖动放大成整档跳变（24↔32），而 A 现在会饱和到上限 ⇒ **整屏亮度逐帧跳**。
        // 官方用的是外部平滑过的 frameRateScale，不用量化。这里直接连续，抖动幅度退回 fps 抖动本身。
        float accumCap = _targetCap;
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
            // [2026-11-13] ×4 之后要回到**硬上限**：下限抬到 32 帧后 ×4 = 128 帧，
            // 5 fps 下是 25 秒历史，暗处拖影会盖过收益；GUI 上「最大累积帧数」也应名副其实。
            accumCap = min(mix(accumCap, accumCap * 4.0, _dark), SSILVB_MAX_ACCUM_FRAMES);
        #endif
        TemporalFilter(texelPos, screenPos, worldNormal, accumCap, giDepthGrad);
    }
}
