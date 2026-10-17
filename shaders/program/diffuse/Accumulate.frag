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

void TemporalFilter(in ivec2 texelPos, in vec3 screenPos, in vec3 checkNormal) {
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
    encodedNormalDepth = vec4(OctEncodeSnorm(checkNormal), viewPos.z, 0.0);

    if (saturate(prevCoord) == prevCoord && !historyReset) {
        vec4 prevDiffuse = vec4(0.0);
        float sumWeight = 0.0;
        // [2026-08-28 ] 上帧该像素的可信度 = 4 tap 里几何一致权重的最大（不含双线性）。
        // 几何一致（静止）→ 接近 1；遮挡/移动/几何剧变 → 骤降，驱动累积帧数连续衰减。
        float maxGeometryWeight = 0.0;

        // Custom bilinear filter
        #ifdef VXGI_FULLRES
        vec2 prevTexel = prevCoord * viewSize - 0.5;
        #else
        // 画布 texel 已与棋盘相位解耦（见 main 的 auxTexel），不必再补偿上帧相位
        vec2 prevTexel = (prevCoord * viewSize - 0.5) * 0.5;
        #endif

        ivec2 floorTexel = ivec2(floor(prevTexel));
        vec2 fractTexel = prevTexel - vec2(floorTexel);

        float bilinearWeight[4] = {
            oms(fractTexel.x) * oms(fractTexel.y),
            fractTexel.x      * oms(fractTexel.y),
            oms(fractTexel.x) * fractTexel.y,
            fractTexel.x      * fractTexel.y
        };

        float invThresholdZ = 8.0 / encodedNormalDepth.z;

        for (uint i = 0u; i < 4u; ++i) {
            ivec2 sampleTexel = floorTexel + offset2x2[i];
            if (clamp(sampleTexel, ivec2(0), canvasEnd - 1) == sampleTexel) {
			    vec3 sampleAux = texelFetch(colortex14, sampleTexel, 0).xyz;
                vec4 sampleIrradiance = texelFetch(colortex2, sampleTexel, 0);

                float tapGeo = saturate(fma(distance(encodedNormalDepth.z, sampleAux.z), invThresholdZ, 1.0));
                tapGeo *= linearstep(0.5, 0.8, saturate(dot(OctDecodeSnorm(sampleAux.xy), checkNormal)));
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
                integratedDiffuse.a = min(prevDiffuse.a * maxGeometryWeight + 1.0, SSILVB_MAX_ACCUM_FRAMES);
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
    ivec2 auxTexel = texelPos;
    float depth = loadDepth0(auxTexel);
    #else
    // 引导量（法线/深度/重投影）必须完全确定：固定取 2x2 块的左上像素。
    // 不要按"块内最近子像素"之类的 argmin 选——子像素深度接近时（远处屏幕深度已接近饱和、
    // 近处掠射面）胜者会逐帧翻转 → 法线/深度跳变 → 历史被拒、a 归 1 → 整片掉回单帧样本。
    ivec2 auxTexel = texelPos * 2;
    float depth = loadDepth0(auxTexel);
    #endif
    vec2 renderCoord = texelToUv(auxTexel);

    bool terrainCheck = min(GetClosestDepthN(auxTexel), depth) < 1.0;
    #if defined LOD_MOD
        bool lodMask = !terrainCheck;
        if (lodMask) {
            depth = loadDepth0Lod(auxTexel);
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
        float viewDepth = ScreenToViewPos(screenPos).z;
        // 用几何法线而非贴图法线：漫反射 GI 的入射光不该被法线贴图的高频细节当成边缘分割
        vec3 checkNormal = FetchGeometryNormal(auxTexel);

        // 轮廓块：本帧样本所在的子像素可能与引导量子像素不在同一层表面（墙 + 后面的天空/远墙）。
        // 混进去会让 GI 越过轮廓糊过去、并随棋盘相位逐帧跳；EAWF 后几级大步长还会把混合值
        // 扩散成宽光晕。判据与 EAWF 的深度门限同口径（相对视深差 ≤ 1/8 视为同表面）；阈值不能
        // 取得太紧——近处掠射面上相邻子像素的视深差会超过 2%，会误判成异面而把 texel 冻住。
        bool sameSurface = true;
        #ifndef VXGI_FULLRES
            ivec2 sampleTexel = texelPos * 2 + checkerboardOffset2x2[frameCounter & 3u];
            float sampleZ = ScreenToViewPos(vec3(texelToUv(sampleTexel), loadDepth0(sampleTexel))).z;
            float refZ = max(min(abs(sampleZ), abs(viewDepth)), 0.001);
            sameSurface = abs(sampleZ - viewDepth) <= 0.125 * refZ;
        #endif

        if (sameSurface) {
            TemporalFilter(texelPos, screenPos, checkNormal);
        } else {
            // 保留上一帧的累积结果（含帧数 a）与稳定的引导量；不能丢成 0，否则历史被清掉
            integratedDiffuse  = texelFetch(colortex2, texelPos, 0);
            encodedNormalDepth = vec4(OctEncodeSnorm(checkNormal), viewDepth, 0.0);
        }
    }
}
