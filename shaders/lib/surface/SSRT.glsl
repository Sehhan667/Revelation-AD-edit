// Reference:
// Morgan McGuire, Michael Mara. "Efficient GPU Screen-Space Ray Tracing". JCGT, 2014.
// https://jcgt.org/published/0003/04/04/paper.pdf
// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.
//
// [2026-09-21 B'5] SSR_USE_HIZ: Hi-Z mip tracing. deferred.csh (HiZDepth.comp)
// builds a 6-level max-depth chain of depthtex2 into the custom image hizTex
// (R32F, 64-px tiles); regular reflections (steps >= 12) trace hierarchically
// over it and fall back to the original linear march when disabled or for low
// step counts.

#define SSRT_MAX_SAMPLES 16 // [1 2 4 6 8 12 16 18 20 24 28 32 36 40 48 64 128 256 512]
//#define SSRT_SKY_TRACING

#define SSRT_REFINEMENT
#define SSRT_REFINEMENT_STEPS 8 // [0 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20 22 24 26 28 30 32]

//================================================================================================//

// 快速归一化（替代 fastNormalize）
float rcpLengthFast(vec3 v) {
    return inversesqrt(max(dot(v, v), 1e-8));
}

#ifdef SSR_USE_HIZ

uniform sampler2D hizTex;

// Hi-Z tile 布局读取：64px tile，mip m 的 cell 尺寸 = 2^m px（m ∈ [1,6]），
// tile 内存储原点 = (64 - (64 >> (m-1)), 0)。必须与 HiZDepth.comp 的写出布局一致。
float FetchHiZ(ivec2 pixelPos, int mip) {
    ivec2 tileIdx = pixelPos >> 6;
    ivec2 cell = (pixelPos & 63) >> mip;
    // floor 移位布局的最右/最下边缘没有对应 cell：clamp 到该 mip 的最后一个 cell
    ivec2 mipDim = max(ivec2(viewWidth, viewHeight) >> mip, ivec2(1));
    cell = min(cell, mipDim - 1);
    return texelFetch(hizTex, (tileIdx << 6) + ivec2(64 - (64 >> (mip - 1)), 0) + cell, 0).x;
}

// Hi-Z 分层追踪：射线在空旷区域按当前 cell 尺寸跳跃（最大 64px），接近几何时逐级
// 降级到逐像素，命中判定/厚度过滤/二分细化与原线性版保持一致。
bool ScreenSpaceRaytraceHiZ(in vec3 viewPos, in vec3 viewDir, in float dither, inout vec3 screenPos) {
    vec3 origin = screenPos;

    #ifndef near
        const float near = 0.05;
    #endif
    #ifndef viewSize
        vec2 viewSize = vec2(viewWidth, viewHeight);
    #endif
    #ifndef viewPixelSize
        vec2 viewPixelSize = 1.0 / viewSize;
    #endif

    // ---- 射线构建与原版一致：截断到屏幕边界的像素空间射线，t ∈ [0,1] ----
    float fixZ = step(viewDir.z, 0.0) * 1e23 - (viewPos.z + near) / viewDir.z;
    vec3 rayDir = normalize(ViewToScreenPos(viewDir * fixZ + viewPos) - origin);
    rayDir *= minOf((step(0.0, rayDir) - origin) / rayDir);
    rayDir.xy *= viewSize;
    origin.xy *= viewSize;

    float rayLenPx = max(length(rayDir.xy), 1.0);
    float invDirZ = rcp(abs(rayDir.z));

    #if defined LOD_MOD
        float screenDepthSky = ViewToScreenDepth(ScreenToViewDepthLod(1.0));
    #else
        float screenDepthSky = 1.0;
    #endif

    // 起点沿射线偏移 2~4px，避免立即命中反射面自身
    float t = (2.0 + dither * 2.0) / rayLenPx;
    float tPrev = t;
    int level = 1;

    bool hit = false;

    for (uint i = 0u; i < 48u; ++i) {
        vec3 p = origin + rayDir * t;

        if (clamp(p.xy, vec2(0.0), viewSize - 1.0) != p.xy) break;
        if (p.z >= screenDepthSky) {
        #ifdef SSRT_SKY_TRACING
            screenPos = p;
            hit = true;
        #endif
            break;
        }

        // ---- 当前位置所在 cell 与离开该 cell 的 t（cell 网格与 64px tile 对齐）----
        float cellScale = float(1 << level);
        vec2 cellBase = floor(p.xy / cellScale);
        vec2 nextBound = (cellBase + vec2(greaterThan(rayDir.xy, vec2(0.0)))) * cellScale;
        // 防除零：轴向分量为 0 时除以 1e-10 得 ±巨大值，不参与 min 胜出，避免 0/0 = NaN
        vec2 dirXY = mix(rayDir.xy, vec2(1e-10), lessThan(abs(rayDir.xy), vec2(1e-10)));
        vec2 tExitXY = (nextBound - origin.xy) / dirXY;
        float tExit = max(min(min(tExitXY.x, tExitXY.y), 1.0), t + 1e-4);

        // ---- 入口判定：hiZ = 当前 cell 的 max depth ----
        float hiZ = level == 0 ? loadDepth2(ivec2(p.xy)) : FetchHiZ(ivec2(p.xy), level);
        #if defined LOD_MOD
        if (level == 0 && hiZ > 1.0 - EPS) hiZ = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth1Lod(ivec2(p.xy))));
        #endif

        if (p.z >= hiZ || hiZ >= screenDepthSky) {
            // 当前位置已越过该 cell 全部内容，或 cell 纯天空（无几何可命中）
            if (level > 0) {
                // 整块跳到 cell 出口并尝试升级
                tPrev = t;
                t = tExit;
                level = min(level + 1, 6);
            } else {
                // 逐像素命中候选：与原版相同的厚度过滤（判定/位置都在当前 p）
                if (p.z > hiZ) {
                    float sampleViewZ = ScreenToViewDepth(hiZ);
                    float stepViewZ = ScreenToViewDepth(p.z);
                    if (distance(sampleViewZ, stepViewZ) < -0.2 * stepViewZ) {
                        screenPos = p;
                        hit = true;
                        break;
                    }
                }
                // 薄物穿透：深度导引步长越过该表面（等效原版变步长分支，上限 8px）
                tPrev = t;
                t += clamp((hiZ - p.z) * invDirZ, 1.5 / rayLenPx, 8.0 / rayLenPx);
                level = 1;
            }
        } else {
            // cell 内存在射线尚未越过的内容
            if (level > 0) {
                // 降级细化（位置不动）
                level--;
            } else {
                // level 0：该像素表面在前方——深度导引步长逼近（上限 8px），
                // 跳后回到 level 1 重新分层（原版变步长分支的 Hi-Z 等效）
                tPrev = t;
                t += clamp((hiZ - p.z) * invDirZ, 1.0 / rayLenPx, 8.0 / rayLenPx);
                level = 1;
            }
        }
    }

    // ---- 二分细化（与原版一致的收敛行为，区间 = 命中步）----
    #ifdef SSRT_REFINEMENT
    if (hit) {
        vec3 refineStep = rayDir * (t - tPrev) * 0.5;
        for (uint i = 0u; i < SSRT_REFINEMENT_STEPS; ++i) {
            float sampleDepth = loadDepth2(ivec2(screenPos.xy));
            #if defined LOD_MOD
            if (sampleDepth > 1.0 - EPS) sampleDepth = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth1Lod(ivec2(screenPos.xy))));
            #endif
            screenPos += (sampleDepth < screenPos.z) ? -refineStep : refineStep;
            refineStep *= 0.5;
        }
    }
    #endif

    // 从像素空间转回屏幕空间坐标 [0,1]
    screenPos.xy *= viewPixelSize;

    return hit;
}

#endif // SSR_USE_HIZ

bool ScreenSpaceRaytrace(in vec3 viewPos, in vec3 viewDir, in float dither, in uint steps, inout vec3 screenPos) {
    #ifdef SSR_USE_HIZ
        // 常规反射（步数预算充足）走 Hi-Z；粗糙反射等低步数保持线性追踪
        if (steps >= 12u) return ScreenSpaceRaytraceHiZ(viewPos, viewDir, dither, screenPos);
    #endif

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

    float t = dither * rSteps;
    for (uint i = 0u; i < steps; ++i) {
        vec3 rayPos = origin + rayDir * t;

        // 超出像素空间边界则失败
        if (clamp(rayPos.xy, vec2(0.0), viewSize - 1.0) != rayPos.xy) break;

        // 命中天空处理
        if (rayPos.z >= screenDepthSky) {
        #ifdef SSRT_SKY_TRACING
            screenPos = rayPos;
            hit = true;
        #endif
            break;
        }

        // 采样深度
        float sampleDepth = loadDepth2(ivec2(rayPos.xy));
        #if defined LOD_MOD
            if (sampleDepth > 1.0 - EPS) sampleDepth = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth1Lod(ivec2(rayPos.xy))));
        #endif

        // ---- 核心：视图空间厚度过滤（防拉丝） ----
        if (rayPos.z > sampleDepth) {
            float sampleViewZ = ScreenToViewDepth(sampleDepth);
            float stepViewZ = ScreenToViewDepth(rayPos.z);

            if (distance(sampleViewZ, stepViewZ) < -0.2 * stepViewZ) {
                screenPos = rayPos;
                hit = true;
                break;
            }
        } else {
            t += clamp((sampleDepth - rayPos.z) * invDirZ, rSteps * 0.01, rSteps * 1.25);
        }
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
