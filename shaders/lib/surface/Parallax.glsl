// [2026-10-06 铁律二兜底] 本文件无条件引用 PARALLAX_SAMPLES / PARALLAX_DEPTH / PARALLAX_REFINEMENT_STEPS，
// 而它们由 GUI 选项决定：用户存档里若把这三项留空（历史配置或 profile 写成 !NAME），宏就不存在，
// 只要 PARALLAX 打开就整包编译失败（error C1503: undefined variable PARALLAX_SAMPLES）。
// 这里给兜底值，保证库文件单独展开也能编译；取值与 settings.glsl 的源码默认一致。
#ifndef PARALLAX_SAMPLES
    #define PARALLAX_SAMPLES 15 // [5 10 15 20 25 30 35 40 45 50 55 60 65 70 75 80 85 90 95 100 110 120 130 140 150 160 170 180 190 200]
#endif
#ifndef PARALLAX_DEPTH
    #define PARALLAX_DEPTH 0.35 // [0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0]
#endif
#ifndef PARALLAX_REFINEMENT_STEPS
    #define PARALLAX_REFINEMENT_STEPS 8 // [4 8 12 16 20 24 28 32 36 40 44 48 52 56 60 64 68 72 76 80 84 88 92 96 100]
#endif

#define atlasCoord(coord) (tileOffset + tileScale * fract(coord))
#define atlasTexel(coord) ivec2((tileOffset + tileScale * fract(coord)) * vec2(atlasSize))

const float rSteps = 1.0 / float(PARALLAX_SAMPLES);

vec3 CalculateParallax(in vec3 tangentDir, in float dither, in float parallaxFade) {
    vec3 rayStep = vec3(tangentDir.xy, 1.0) * -rSteps;
    rayStep.xy *= PARALLAX_DEPTH * parallaxFade / tangentDir.z;

    vec3 rayPos = vec3(tileBase, 1.0) + rayStep * dither;

    float sampleHeight;
    for (uint i = 0u; i < PARALLAX_SAMPLES && sampleHeight < rayPos.z; ++i) {
        rayPos += rayStep;
        sampleHeight = texelFetch(normals, atlasTexel(rayPos.xy), 0).a;
    }

    // Refine the parallax mapping (binary search)
    #ifdef PARALLAX_REFINEMENT
        rayPos -= rayStep;
        rayStep *= 0.5;

        for (uint i = 0u; i < PARALLAX_REFINEMENT_STEPS; ++i) {
            sampleHeight = texelFetch(normals, atlasTexel(rayPos.xy), 0).a;

            rayPos += rayStep * (step(sampleHeight, rayPos.z) * 2.0 - 1.0);
            rayStep *= 0.5;
        }

        rayPos += rayStep * 2.0;
    #endif

    return rayPos;
}

float CalculateParallaxShadow(in vec3 tangentDir, in vec3 rayPos, in float dither, in float parallaxFade) {
    vec3 rayStep = vec3(tangentDir.xy, 1.0) * rayPos.z * rSteps;
    rayStep.xy *= PARALLAX_DEPTH * parallaxFade / tangentDir.z;
    rayPos += rayStep * dither;

    for (uint i = 0u; i < PARALLAX_SAMPLES; ++i) {
        float sampleHeight = texelFetch(normals, atlasTexel(rayPos.xy), 0).a;

        if (sampleHeight > rayPos.z) return 1.0;
        rayPos += rayStep;
    }

    return 0.0;
}