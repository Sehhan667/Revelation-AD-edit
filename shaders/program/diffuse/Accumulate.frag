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

/* RENDERTARGETS: 2,14 */
layout (location = 0) out vec4 integratedDiffuse;
// [2026-08-19 NRD] colortex14 升 RGBA16F，a 存 disocclusion 标记（1=不可靠/新暴露/重投影失效）。
layout (location = 1) out vec4 encodedNormalDepth;

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

void TemporalFilter(in ivec2 texelPos, in vec3 screenPos, in vec3 worldNormal, in float accumCap) {
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
        float sumWeight = 0.0;
        // [2026-08-28 ] 上帧该像素的可信度 = 4 tap 里几何一致权重的最大（不含双线性）。
        // 几何一致（静止）→ 接近 1；遮挡/移动/几何剧变 → 骤降，驱动累积帧数连续衰减。
        float maxGeometryWeight = 0.0;

        // Custom bilinear filter
        #ifdef VXGI_FULLRES
        // 全分辨率：历史就是本像素，不需要相位补偿
        vec2 prevTexel = prevCoord * viewSize - 0.5;
        #else
        #ifdef VOXEL_GI_STABLE_GUIDE
        // 引导量已与相位解耦（见 main 的 renderTexel）→ 不再补偿上帧相位，否则反而错位
        vec2 prevTexel = (prevCoord * viewSize - 0.5) * 0.5;
        #else
        vec2 prevTexel = (prevCoord * viewSize
         - checkerboardOffset2x2[(frameCounter - 1) & 3u]
         - 0.5) * 0.5;
        #endif
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
        float invThresholdZ = 8.0 / prevViewPos.z;

        for (uint i = 0u; i < 4u; ++i) {
            ivec2 sampleTexel = floorTexel + offset2x2[i];
            if (clamp(sampleTexel, ivec2(0), canvasEnd - 1) == sampleTexel) {
			    vec3 sampleAux = texelFetch(colortex14, sampleTexel, 0).xyz;
                vec4 sampleIrradiance = texelFetch(colortex2, sampleTexel, 0);

                float tapGeo = saturate(fma(distance(prevViewPos.z, sampleAux.z), invThresholdZ, 1.0));
                tapGeo *= linearstep(0.5, 0.8, saturate(dot(OctDecodeSnorm(sampleAux.xy), worldNormal)));
                maxGeometryWeight = max(maxGeometryWeight, tapGeo);

                float weight = tapGeo * bilinearWeight[i];

                prevDiffuse += sampleIrradiance * weight;
                sumWeight += weight;
            }
        }

        if (sumWeight > EPS) {
            sumWeight = 1.0 / sumWeight;
            prevDiffuse *= sumWeight;

            // [2026-08-19 离线渲染] 持续累计：把帧数上限拉高，让时域累积权重更均匀、收敛到更低噪声。
            // 关闭宏时用原 SSILVB_MAX_ACCUM_FRAMES，与之前完全一致。
            // [2026-08-28 ] 累积帧数乘上 maxGeometryWeight（上帧几何可信度）连续衰减：
            // 静止一致 → ≈1，a 正常累加；遮挡/移动/几何剧变 → 骤降 → alpha 变大 → 几乎不混历史。
            #ifdef OFFLINE_RENDER
                integratedDiffuse.a = min(prevDiffuse.a * maxGeometryWeight + 1.0, 1024.0);
            #else
                #ifdef VOXEL_GI_ROBUST_ACCUM
                // 稳态累积帧数 = 1/(1-w)，对 w 极其敏感：w=0.984→62 帧、0.95→20、0.90→10。
                // 运动时重投影的亚像素残差（向量本身是对的）就足以把 w 压到 0.9~0.95 ⇒ 累积从
                // 64 帧塌到 10~20 帧 ⇒ 源端的冲激（稀疏命中 / 二值阳光反弹，单样本可到 clamp 32）
                // 重新露出来 → 表现就是「一动就发白/发脏」，而静止时又正常。
                // 这里把 w 只当「是否同一表面」的判据：匹配就满速累积，不匹配才快速衰减（w²）。
                float _wAccum = maxGeometryWeight > 0.9 ? 1.0 : maxGeometryWeight * maxGeometryWeight;
                integratedDiffuse.a = min(prevDiffuse.a * _wAccum + 1.0, accumCap);
                #else
                integratedDiffuse.a = min(prevDiffuse.a * maxGeometryWeight + 1.0, accumCap);
                #endif
            #endif

            if (integratedDiffuse.a < 8.0) {
                float mipLevel = 3.0 * saturate(1.0 - integratedDiffuse.a * rcp(8.0));
                integratedDiffuse.rgb = textureLod(colortex3, currCoord, mipLevel).rgb;
            } else {
                integratedDiffuse.rgb = texelFetch(colortex3, texelPos, 0).rgb;
            }

            float alpha = rcp(integratedDiffuse.a);

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

            // [逐样本钳制] 弱光的噪声主体是冲激（大多数帧 0、偶发一个很大值）：稀疏命中、二值阳光反弹。
            // 空间滤波只能把它抹成脏污；在**入样**处按当前累积均值的 K 倍封顶则只压尖峰、不模糊。
            // K=0 关闭；a 太小时跳过（均值≈0 会把真实光照一起压掉）。
            if (VOXEL_GI_SAMPLE_CLAMP > 0.0 && integratedDiffuse.a > 4.0) {
                vec3 _meanClamp = max(prevDiffuse.rgb, vec3(1e-5));
                integratedDiffuse.rgb = min(integratedDiffuse.rgb, _meanClamp * VOXEL_GI_SAMPLE_CLAMP);
            }

            integratedDiffuse.rgb = mix(min(prevDiffuse.rgb, FP16_MAX), integratedDiffuse.rgb, alpha);
            return;
        }
    }

    // [2026-08-19 NRD] 去遮挡标记：走到这里 = 不可靠（越界/historyReset/深度不匹配）→ a=1
    integratedDiffuse.rgb = textureLod(colortex3, currCoord, 3.0).rgb;
    encodedNormalDepth.a = 1.0;
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
    #ifdef VOXEL_GI_STABLE_GUIDE
    // 引导量（法线/深度/重投影位置）固定取 2x2 块的左上子像素，不再随棋盘相位轮转：
    // 相位轮转会让下一帧的历史几何检查逐帧在两个子像素之间跳 → maxGeometryWeight 抖 →
    // 累积帧数 a 抖 → 转视角 / 法线贴图表面会掉回单帧样本（噪）。
    ivec2 renderTexel = texelPos * 2;
    #else
    ivec2 renderTexel = texelPos * 2 + checkerboardOffset2x2[frameCounter & 3u];
    #endif
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

    // 关降噪（VOXEL_GI_DENOISE 未定义）时本 pass 仍要跑：它才是 4 相位棋盘的重建 +
    // 时域累积（DeferredLight 关降噪时读 colortex2 的累积结果，只跳过 VarianceEstimate/EAWF）。
    // SSILVB 链（GI_ACTIVE_VXGI 未定义）不受影响。
    if (terrainCheck) {
        #if defined LOD_MOD
            if (lodMask) depth = ViewToScreenDepth(ScreenToViewDepthLod(depth));
        #endif

        vec3 screenPos = vec3(renderCoord, depth);
        vec3 worldNormal = FetchSurfaceNormal(renderTexel);

        // 弱光（只有少量光线照入）：1 SPP 采样太稀疏，32 帧不足以压噪。暗处信号变化慢，
        // 可以提高时域累积上限——只加长历史、不加大空间模糊，因此不会把画面抹平。
        float accumCap = SSILVB_MAX_ACCUM_FRAMES;
        #ifdef VOXEL_GI_DARK_ACCUM
            float _luma = max(texelFetch(colortex2, texelPos, 0).r, 0.0);
            float _dark = 1.0 - smoothstep(0.003, 0.06, _luma);
            accumCap = mix(SSILVB_MAX_ACCUM_FRAMES, SSILVB_MAX_ACCUM_FRAMES * 4.0, _dark);
        #endif
        TemporalFilter(texelPos, screenPos, worldNormal, accumCap);
    }
}
