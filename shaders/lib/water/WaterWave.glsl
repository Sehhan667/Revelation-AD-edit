// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.





#if !defined INCLUDE_WATER_WATERWAVE
#define INCLUDE_WATER_WATERWAVE

const mat2 goldenRotate = mat2(cos(goldenAngle), -sin(goldenAngle), sin(goldenAngle), cos(goldenAngle));

// ---------------------------------------------------------------------------
// 噪声采样函数（统一使用硬件双线性过滤，代替昂贵的双三次采样）
// ---------------------------------------------------------------------------
float FetchNoise(in vec2 coord, in float t) {
    coord.y = coord.y * 2.0 + t;
    return sqr(1.0 - texture(noisetex, coord).z);
}

float FetchNoiseFast(in vec2 coord, in float t) {
    coord.y = coord.y * 2.0 + t;
    return sqr(1.0 - texture(noisetex, coord).z);
}

// ---------------------------------------------------------------------------
// 轻量级高度计算（用于阴影等对细节要求不高的 Pass）
// 从 5 层降为 3 层，关闭低频调制时仅需 3 次采样
// ---------------------------------------------------------------------------
float CalculateWaterHeight(in vec2 position) {
    #if RENDER_MODE == 1
        float waveTime = 0.02 * WATER_WAVE_SPEED * frameTimeCounter;
    #else
        float waveTime = 0.0;
    #endif
    vec2 pos = 0.0075 * position;

    float waveHeight = WATER_WAVE_HEIGHT * 0.4;
    #if !defined PASS_SHADOW
        float lfNoise = texture(noisetex, pos * 0.2 + waveTime * 0.1).z;
        waveHeight *= saturate(lfNoise * 2.0 - 0.75) + 0.25;
        pos += lfNoise * 0.05;
    #endif

    // 3 层叠加，平衡质量与性能
    float waves = FetchNoise(pos, waveTime);

    pos = goldenRotate * (1.75 * pos) + waves * 0.03;
    waveTime *= 1.25;
    waves += FetchNoise(pos, waveTime) * 0.75;

    pos = goldenRotate * (1.75 * pos) + waves * 0.03;
    waveTime *= 1.25;
    waves += FetchNoise(pos, waveTime) * 0.15;

    // 原先 5 层中最后两层已移除，以提升性能
    return waveHeight * waves;
}

// ---------------------------------------------------------------------------
// 全精度高度计算（用于水表面法线，仍保持 3 层）
// ---------------------------------------------------------------------------
float CalculateWaterHeightFull(in vec2 position) {
    #if RENDER_MODE == 1
        float waveTime = 0.02 * WATER_WAVE_SPEED * frameTimeCounter;
    #else
        float waveTime = 0.0;
    #endif
    vec2 pos = 0.0075 * position;

    float waveHeight = WATER_WAVE_HEIGHT * 0.4;
    #if !defined PASS_SHADOW
        float lfNoise = texture(noisetex, pos * 0.2 + waveTime * 0.1).z;
        waveHeight *= saturate(lfNoise * 2.0 - 0.75) + 0.25;
        pos += lfNoise * 0.05;
    #endif

    float waves = FetchNoiseFast(pos, waveTime);

    pos = goldenRotate * (1.75 * pos) + waves * 0.03;
    waveTime *= 1.25;
    waves += FetchNoiseFast(pos, waveTime) * 0.75;

    pos = goldenRotate * (1.75 * pos) + waves * 0.03;
    waveTime *= 1.25;
    waves += FetchNoiseFast(pos, waveTime) * 0.15;

    // 移除多余细节层，仅保留 3 层
    return waveHeight * waves;
}

// ---------------------------------------------------------------------------
// 水面法线计算
// ---------------------------------------------------------------------------
// [2026-09-21 B'4] 前向差分版（原实现，保留为 fallback 与非 fragment 场景使用）：
// 3 次 CalculateWaterHeightFull = 12 次纹理采样/像素。视角无关、quad 边缘无混合误差。
vec3 CalculateWaterNormalForward(in vec2 position) {
    const float delta = 0.05;

    float height0 = CalculateWaterHeightFull(position);
    float height1 = CalculateWaterHeightFull(position + vec2(delta, 0.0));
    float height2 = CalculateWaterHeightFull(position + vec2(0.0, delta));

    vec2 waveNormal = vec2(height0 - height1, height0 - height2);
    return normalize(vec3(waveNormal, delta * (1.0 + dot(fwidth(position), vec2(0.2)))));
}

#ifdef WATER_NORMAL_SCREEN_DERIV
    // [2026-09-21 B'4] 屏幕空间 2x2 quad 导数版（默认）：单次高度采样（4 次纹理采样）
    // + 硬件导数，水面像素 3 倍降采样。世界梯度 = Jacobian 逆 * 屏幕梯度；
    // z 分量沿用前向差分版的远距衰减项（屏幕每像素世界跨度越大、法线越平）。
    // 仅用于调用点前无逐像素随机 discard 的 fragment pass（gbuffers/Water.frag）：
    // 水岸边界 quad 混入 else 分支 discard 的线程时 dFdx 未定义，靠下方 gradLim
    // 夹紧兜底；逐像素 dither discard 的 pass（DH/Shadow/Voxy）必须用 Forward 版。
    // 掠射角 Jacobian 行列式趋零时输出平坦法线而非爆炸。
    vec3 CalculateWaterNormal(in vec2 position) {
        float height = CalculateWaterHeightFull(position);

        // 高度场幅度粗上界（waves<=1.9 × waveHeight<=0.5*WATER_WAVE_HEIGHT），
        // 夹住屏幕梯度：水岸边界 quad 混入被 discard 的邻居线程时 dFdx 为未定义值，
        // 夹到有界坡度后最坏是边缘 1px 的错误法线，不会 NaN/爆炸
        const float gradLim = 2.0 * WATER_WAVE_HEIGHT;
        vec2 screenGrad = clamp(vec2(dFdx(height), dFdy(height)), vec2(-gradLim), vec2(gradLim));

        mat2 jacobian = mat2(dFdx(position), dFdy(position));
        float det = jacobian[0].x * jacobian[1].y - jacobian[1].x * jacobian[0].y;
        vec2 worldGrad = abs(det) > 1e-10
            ? (vec2( jacobian[1].y, -jacobian[0].y) * screenGrad.x
             + vec2(-jacobian[1].x,  jacobian[0].x) * screenGrad.y) / det
            : vec2(0.0);

        return normalize(vec3(-worldGrad, 1.0 + dot(fwidth(position), vec2(0.2))));
    }
#else
    vec3 CalculateWaterNormal(in vec2 position) {
        return CalculateWaterNormalForward(position);
    }
#endif

// 重载版本（直接使用平面坐标，忽略光线方向）
vec3 CalculateWaterNormal(in vec3 rayPos, in vec3 rayDir) {
    return CalculateWaterNormal(rayPos.xz);
}

#endif // INCLUDE_WATER_WATERWAVE