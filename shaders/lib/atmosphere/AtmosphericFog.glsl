/*
--------------------------------------------------------------------------------
    Revelation Shaders - High Performance Analytical Fog Engine
    (Visual match with original raymarching version + horizon fix + noise macro)
    Optimizations: Three-point Simpson integration, no loops.
    Keeps all original macros, adds FOG_NOISE_ENABLED for noise toggle.
    Fake horizon blending temporarily removed.
    Now VF_DENSITY_MULT correctly scales overall fog density.
    ✨ 进一步优化：exp → exp2，末地分支散射逻辑简化。
    ✨ 新增：VF_SUNLIGHT_TINT_RATIO (仅主世界) 控制雾气跟随阳光颜色。
    ✨ 动态染色：强度随太阳高度变化，正午最强，傍晚减弱，晚上消失。
    ✨ 末地雾气已为淡紫色调。
--------------------------------------------------------------------------------
*/

// =================【 雾气全局浓度控制阀 】=================
#ifndef VF_DENSITY_MULT
    #define VF_DENSITY_MULT 1.5 // [0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 1.0 1.5 2.0 2.5 3.0 3.5 4.0]
#endif

// =================【 阳光染色最大强度 (仅主世界，实际强度会随太阳高度变化) 】=================
#ifndef VF_SUNLIGHT_TINT_RATIO
    #define VF_SUNLIGHT_TINT_RATIO 0.6 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
#endif

// =================【 雾中光束的阴影对比度（0 = 不压暗 = 没有光束） 】=================
// 正式定义在 settings.glsl；这里兜底，保证单独展开本文件时也能编译。
#ifndef VF_VOLUME_INTENSITY
    #define VF_VOLUME_INTENSITY 1.0
#endif

// =================【 光束亮度（只乘太阳项，不动环境雾） 】=================
#ifndef VF_SHAFT_BRIGHTNESS
    #define VF_SHAFT_BRIGHTNESS 2.0
#endif

// =================【 夜晚雾色饱和度（1 = 原来的蓝，0 = 完全中性） 】=================
#ifndef VF_NIGHT_FOG_SATURATION
    #define VF_NIGHT_FOG_SATURATION 0.5
#endif

// =================【 雨天太阳项保留下限（0 = 原来的归零，1 = 完全不衰减） 】=================
// 正式定义在 settings.glsl；这里兜底（本文件可能先于 settings.glsl 被用到）。
#ifndef VF_RAIN_SUN_FLOOR
    #define VF_RAIN_SUN_FLOOR 0.3
#endif

// =================【 雾层厚度（高度包络的尺度，按 Mie 通道的半衰高度计） 】=================
// 12 = 现状（1 / 0.08333 ≈ 12 格）。正式定义在 settings.glsl；这里兜底。
#ifndef VF_FOG_THICKNESS
    #define VF_FOG_THICKNESS 24.0
#endif
// =========================================================
#define NOISE_SIZE 0.0125 // [0.005 0.006 0.007 0.008 0.009 0.01 0.0125 0.015 0.02 0.025 0.03 0.04 0.05 0.1 1 10 100]
// 噪声开关：定义此宏以启用 3D 噪声（更真实），注释掉则禁用（更快）
#define FOG_NOISE_ENABLED

#include "/lib/atmosphere/Rainbow.glsl"
#include "/lib/atmosphere/clouds/Shadows.glsl"

uniform float biomeSandstorm;
uniform float biomeSnowstorm;
uniform float biomeGreenVapor;

//================================================================================================//

const vec2 FOG_HEIGHT_FALLOFF = vec2(-0.03125, -0.08333); // x: Rayleigh, y: Mie

#ifdef FOG_NOISE_ENABLED
// 3D noise (equivalent to the old Medium quality tier)
float GetFogNoise(vec3 pos) {
    vec3 windOffset = vec3(0.07, 0.04, 0.05) * worldTimeCounter;
    pos *= NOISE_SIZE;
    pos -= windOffset;
    float noise = Pseudo3DNoise(pos) * 2.5;
    noise -= Pseudo3DNoise(pos * 4.0 - windOffset);
    return noise;
}
#endif

vec2 CalculateFogDensity(in vec3 rayPos, in float uniformFog) {
    vec3 worldPos = rayPos + cameraPosition;

    float heightDiff = abs(worldPos.y - VF_HEIGHT) * oms(step(worldPos.y, VF_HEIGHT) * 0.5);
    vec2 density = exp2(heightDiff * FOG_HEIGHT_FALLOFF);

#ifdef FOG_NOISE_ENABLED
    float noise = GetFogNoise(worldPos);
    density.y *= sqr(noise) * (2.0 + biomeSandstorm * 8.0 + biomeSnowstorm * 4.0);
#else
    density.y *= (2.0 + biomeSandstorm * 8.0 + biomeSnowstorm * 4.0);
#endif

    // Uniform fog with linearstep falloff
    density += uniformFog * linearstep(cumulusTopAltitude, cumulusBottomAltitude, worldPos.y);

    return max(density, vec2(0.0));
}

// [2026-09-10] 沿视线的精确（闭式）密度积分，取代原来的 VF_FOG_PANELS 段梯形 + 相位抖动。
//
// 同心环的成因：壳层包络 exp2(FOG_HEIGHT_FALLOFF * h(y))，其中
//     h(y) = |y - VF_HEIGHT| * (y <= VF_HEIGHT ? 0.5 : 1)
// 在 y = VF_HEIGHT 处有一个折点（导数跳变）。梯形法对带折点的函数，误差取决于
// 「折点落在两个采样点之间的哪个位置」→ 视线与壳层的交点随相机高度/俯仰连续移动，
// 每当它扫过一个面板边界，积分值就发生一次确定性跳变 → 雾层上出现同心环。旧对策是
// 加密段数 + 每像素抖动，把确定性误差摊成噪声再交给 TAA 平均（即"掩盖"，不是消除）。
//
// 这里改为精确积分：把射线在折点 t* = (VF_HEIGHT - y0) / dir.y 处切开，每段上指数都是
//     exponent(t) = c + s·t   （段内 y 线性、且不跨折点 → 斜率 s 恒定）
// 其积分有闭式   ∫exp2(c+st) dt = ( 2^(c+s·b) - 2^(c+s·a) ) / (s·ln2)，s→0 时退化为 2^c·(b-a)。
// 于是结果与采样点位置**无关**：折点怎么移动都不会产生误差项（环不是被压住，而是没有来源）。
//
// 均匀雾项 uniformFog * linearstep(cumulusTopAltitude, cumulusBottomAltitude, y) 是分段线性
// （折点在云顶/云底高度），同样按折点切分后逐段用端点梯形——对线性函数梯形是精确的。
//
// 返回 vec3(壳层.x 均值, 壳层.y 均值, 均匀雾均值)，与旧梯形的输出语义一致（都是"沿视线的平均值"）。
vec3 IntegrateFogDensityAlongRay(in vec3 worldStart, in vec3 worldDir, in float rayLength, in float uniformFog) {
    const float LN2 = 0.6931471805599453;
    const float RAMP_RANGE = cumulusTopAltitude - cumulusBottomAltitude;
    const float RAMP_TOP = cumulusTopAltitude;

    float y0 = worldStart.y + cameraPosition.y;   // worldStart 是相机相对坐标，须转成世界绝对高度
    float m = worldDir.y;
    bool slanted = abs(m) > 1e-6;
    float invM = slanted ? rcp(m) : 0.0;
    float invLen = rcp(rayLength);

    // [2026-09-12 雾层厚度] 高度包络的斜率 = 原斜率 × (12 / 厚度)：厚度翻倍 → 斜率减半（层更厚），
    // 两个通道（Rayleigh/Mie）的比例保持不变，所以色相不变、只是上下方向的衰减变缓。
    // 这直接决定「方块与天空谁被遮得多」：层薄时（默认 12 格半衰）站在层里抬头看天空，射线
    // 十几格就离开雾层 → 天空几乎不被遮，而水平方向的方块一直在层内 → 方块被遮得多；
    // 层厚（或接近均匀）时遮蔽只由距离决定，天空（256 格）反而比方块更被遮。
    vec2 fogFalloff = FOG_HEIGHT_FALLOFF * (12.0 / max(VF_FOG_THICKNESS, 1.0));

    // ---- 壳层包络：在 y = VF_HEIGHT 处精确切分（≤2 段）----
    float tKink = slanted ? clamp((VF_HEIGHT - y0) * invM, 0.0, rayLength) : 0.0;
    float shellBounds[3] = float[3](0.0, tKink, rayLength);
    vec2 envAcc = vec2(0.0);
    for (int i = 0; i < 2; ++i) {
        float a = shellBounds[i];
        float b = shellBounds[i + 1];
        if (b <= a) continue;                    // 空段（折点落在区间外时）
        // 段中点判定这段在壳层上方还是下方（段内不跨折点，所以判定是确定的）
        float rel = (y0 + m * (0.5 * (a + b))) - VF_HEIGHT;
        float scale = rel > 0.0 ? 1.0 : 0.5;     // 下方衰减斜率是上方的一半
        float sgn = rel > 0.0 ? 1.0 : -1.0;
        // exponent(t) = fogFalloff * sgn * scale * (y0 + m·t - VF_HEIGHT) = cEx + sEx·t
        vec2 cEx = fogFalloff * (sgn * scale * (y0 - VF_HEIGHT));
        vec2 sEx = fogFalloff * (sgn * scale * m);
        vec2 e1 = exp2(cEx + sEx * a);
        vec2 e2 = exp2(cEx + sEx * b);
        vec2 den = sEx * LN2;
        // 视线接近水平(m→0)时 den→0，(e2-e1) 会发生相减消位（相对误差 ~ulp(e1)/(e1·h)）。
        // 此时改用 x→0 的级数：∫exp2 = e1·u·(1 + h/2 + h²/6)，h = sEx·u·ln2 为段内指数增量。
        vec2 h = sEx * ((b - a) * LN2);
        vec2 lin = e1 * ((b - a) * (1.0 + h * (0.5 + h * (1.0 / 6.0))));
        envAcc += vec2(
            abs(h.x) > 1e-3 ? (e2.x - e1.x) / den.x : lin.x,
            abs(h.y) > 1e-3 ? (e2.y - e1.y) / den.y : lin.y);
    }

    // ---- 均匀雾：linearstep 的两个折点处切分（≤3 段），段内线性、端点梯形精确 ----
    float tTop = slanted ? clamp((RAMP_TOP - y0) * invM, 0.0, rayLength) : 0.0;
    float tBot = slanted ? clamp((cumulusBottomAltitude - y0) * invM, 0.0, rayLength) : 0.0;
    float rampBounds[4] = float[4](0.0, min(tTop, tBot), max(tTop, tBot), rayLength);
    float uniformAcc = 0.0;
    for (int i = 0; i < 3; ++i) {
        float a = rampBounds[i];
        float b = rampBounds[i + 1];
        if (b <= a) continue;
        float rA = clamp((RAMP_TOP - (y0 + m * a)) / RAMP_RANGE, 0.0, 1.0);
        float rB = clamp((RAMP_TOP - (y0 + m * b)) / RAMP_RANGE, 0.0, 1.0);
        uniformAcc += 0.5 * (rA + rB) * (b - a);
    }

    return vec3(envAcc * invLen, uniformFog * uniformAcc * invLen);
}

//================================================================================================//

#if !defined CLOUD_SHADOWS || defined PASS_SKY_MAP
    #undef VF_CLOUD_SHADOWS
#endif

// [2026-08-20] sunVisFactor = 屏幕上太阳可见性（0/1），由调用方计算。用于压制
// 雾中正对太阳方向的 Mie 前向散射，避免"太阳被地形挡但仍有一团光晕"。天空背景雾
// （GenSkyMap / skyMask）传 1.0，保留天空应有的太阳辉光，不参与遮蔽。
// [2026-09-12] sunShadowVis = 沿这条视线的阴影可见度（rgb，1 = 未遮挡；开了
// COLORED_VOLUMETRIC_FOG 时可带玻璃染色），由调用方采样（IntegrateScene 的
// ComputeFogSunVisibility）。它乘在太阳 in-scatter 上 —— 这就是「雾中光束」：
// 被树叶/窗缝切开的明暗直接体现在雾上。天空 LUT（GenSkyMap）没有阴影贴图，传 vec3(1.0)。
// lightEnergy = 定向光辐照度（见下方散射合成处的说明）：天空 LUT 传 global.directIlluminance。
mat2x3 RaymarchAtmosphericFog(in vec3 startPos, in vec3 endPos, in float dither, in bool skyMask, in float sunVisFactor, in vec3 sunShadowVis, in vec3 lightEnergy) {
    vec3 dirDelta = endPos - startPos;
    float rayLengthSq = dot(dirDelta, dirDelta);
    if (rayLengthSq < 1e-6) {
        return mat2x3(vec3(0.0), vec3(1.0));
    }

    float norm = inversesqrt(rayLengthSq);
    float rayLength = rayLengthSq * norm;
    vec3 worldDir = dirDelta * norm;
//!!!!!!!!!!!!!!!!!!!!!!!!!!!!雾气最大累计距离
    float maxDist = min(lodRenderDist, 256.0); 
    if (skyMask) {
        // [2026-09-02 修复地平线圆环] 原式 safeDirY = max(|y|,1e-5)*sign(y+1e-6) 在视线
        // 略微向下（worldDir.y<0）时除法为负 → clamp 归 0；接近水平时 safeDirY→0 除法发散
        // → clamp 到 maxDist。这条 0 ↔ maxDist 的突变恰好落在地平线一圈，形成雾程圆环硬边。
        // 改为只用绝对竖直分量算球壳雾程（变号不再把结果拉负），并在水平带内 smoothstep
        // 平滑过渡，消除地平线硬接缝。
        float absDirY = max(abs(worldDir.y), 1e-5);
        float shellLength = clamp((cumulusTopRadius - atmosphereViewHeight) / absDirY, 0.0, maxDist);
        float horizonSmooth = smoothstep(0.0, 0.06, abs(worldDir.y));
        rayLength = mix(maxDist, shellLength, horizonSmooth);
    }

    vec3 midPos = startPos + worldDir * (rayLength * 0.5);

    float LdotV = dot(worldLightDir, worldDir);
    vec2 phase = AtmospherePhase(LdotV);

    float rainFactor = 1.0 + wetness * VF_MIE_DENSITY_RAIN_MULT;
    float mieDensityMult = VF_MIE_DENSITY * 5e2 * rainFactor;
    #ifdef VF_TIME_FADE
        mieDensityMult *= max(wetness, 1.5 - approxSqrt(max(timeNoon, 0.0)) * 1.5 - timeSunset * 0.75 - timeMidnight * 0.5);
    #endif

    vec3 fogMieExtinction = atmosphere.mieExtinction * mieDensityMult;
    vec3 fogMieScattering = atmosphere.mieScattering * mieDensityMult;

    #ifdef PER_BIOME_FOG
        vec3 biomeAlbedo = mix(vec3(1.0), vec3(1.1, 0.9, 0.7), biomeSandstorm);
        biomeAlbedo = mix(biomeAlbedo, vec3(0.95, 1.1, 1.0), biomeGreenVapor);
        fogMieScattering *= biomeAlbedo;
    #endif

    mat2x3 fogExtinctionCoeff = mat2x3(
        atmosphere.rayleighScattering * (VF_RAYLEIGH_DENSITY * 16.0),
        fogMieExtinction
    );
    mat2x3 fogScatteringCoeff = mat2x3(
        atmosphere.rayleighScattering * (VF_RAYLEIGH_DENSITY * 16.0),
        fogMieScattering
    );

    float uniformFog = (8.0 * rainFactor) / maxDist;

    // [2026-09-10 雾环根治] 原 VF_FOG_PANELS 段梯形 + 相位抖动 → 换成闭式积分
    // IntegrateFogDensityAlongRay（推导见文件上方）：在折点处精确切分，结果与采样点位置无关，
    // 同心环的结构性来源被移除（不再是「抖成噪声交给 TAA 平均」）。
    // VF_FOG_PANELS 现在只用于标定噪声/抖动的相位粒度（保持与旧实现的采样手感一致）。
    #ifndef VF_FOG_PANELS
        #define VF_FOG_PANELS 8
    #endif
    // [2026-09-10 性能] 噪声采样与包络解耦：FOG_NOISE 是乘性白噪声调制，对折点几何没有确定性依赖，
    // 且早已被 per-pixel dither + TAA 平均，用 9 个包络节点去估计「噪声沿视线的平均值」属于过度采样。
    // 包络本身现已精确积分，噪声单独用 VF_FOG_NOISE_SAMPLES 个中点均值估计即可。
    // 语义一致性：旧式 y_i = env_i·noise_i²·storm + uni_i（噪声只乘壳层通道、均匀雾项在噪声之后相加），
    // 因此这里壳层包络与均匀雾项仍分开累加，噪声只作用在包络均值上。
    #ifndef VF_FOG_NOISE_SAMPLES
        #define VF_FOG_NOISE_SAMPLES 3
    #endif
    float sampleJitter = (dither - 0.5) * (0.75 / float(VF_FOG_PANELS));
    vec3 fogIntegral = IntegrateFogDensityAlongRay(startPos, worldDir, rayLength, uniformFog);
    vec2 envAvg = fogIntegral.xy;
    float uniformAvg = fogIntegral.z;

    #ifdef FOG_NOISE_ENABLED
        float noiseFactor = 0.0;
        for (int i = 0; i < VF_FOG_NOISE_SAMPLES; ++i) {
            float t = clamp((float(i) + 0.5 + sampleJitter) / float(VF_FOG_NOISE_SAMPLES), 0.0, 1.0);
            noiseFactor += sqr(GetFogNoise(startPos + worldDir * (rayLength * t) + cameraPosition));
        }
        noiseFactor *= rcp(float(VF_FOG_NOISE_SAMPLES));
    #else
        float noiseFactor = 1.0;
    #endif
    // 风暴/沙尘倍率（循环不变量）：旧实现放在 CalculateFogDensity 内、每个采样点重复一次
    noiseFactor *= (2.0 + biomeSandstorm * 8.0 + biomeSnowstorm * 4.0);

    // 通道语义与旧实现一致：x = 壳层 + 均匀雾（无噪声）；y = 壳层×噪声×风暴因子 + 均匀雾
    vec2 avgDensity = vec2(envAvg.x + uniformAvg,
                           envAvg.y * noiseFactor + uniformAvg);

    // ---- 全局浓度控制（在此生效） ----
    avgDensity *= VF_DENSITY_MULT;

    // ---- 天空路径与几何路径的密度调节 ----
    if (skyMask) {
        // 天空路径不应用室内消隐
    } else {
        // 几何体路径：依据天空光照微弱减弱密度，防止室内/地下过度积雾
        avgDensity *= clamp(eyeSkylightSmooth * 0.8 + 0.2, 0.0, 1.0);
    }

    if (dot(avgDensity, vec2(1.0)) < 1e-5) {
        return mat2x3(vec3(0.0), vec3(1.0));
    }

    // 云影（太阳项的另一个可见度来源，与雾中光束的阴影可见度互相独立）
    vec3 cloudShadow = vec3(1.0);
    #ifdef VF_CLOUD_SHADOWS
        if (midPos.y < cumulusTopAltitude + 64.0) {
            vec2 cloudShadowCoord = WorldToCloudShadowScreenPos(midPos).xy;
            if (saturate(cloudShadowCoord) == cloudShadowCoord) {
                cloudShadow *= texture(cloudShadowTex, cloudShadowCoord).x;
            }
        }
    #endif

    vec2 opticalDepthSun = avgDensity * (4.0 * clamp(worldLightDir.y, 0.2, 1.0));
    vec2 msV = 0.9 * oms(exp2(-8.0 * avgDensity));

    // ✨ 优化：exp 替换为 exp2
    // [FIX 2026-08-20] sunVisFactor 只压前向散射相位（太阳光晕），保留均匀多散射环境项——
    // 否则太阳出屏/被挡时整个 msEnergy 乘 0 → 整团雾变暗（同 WaterFog.glsl 约定）。
    vec2 msEnergy = phase * exp2(-opticalDepthSun * 1.442695) * sunVisFactor;
    
    vec2 denom = max(oms(msV) * (1.0 + opticalDepthSun * 0.25), vec2(1e-4));
    msEnergy += uniformPhase * msV / denom;

    vec3 totalExtinction = fogExtinctionCoeff * avgDensity;
    vec3 safeExtinction = max(totalExtinction, vec3(1e-5));
    vec3 transmittance = exp2(-clamp(rayLength, 0.0, maxDist) * safeExtinction * 1.442695);
    
    vec3 integralFactor = (vec3(1.0) - transmittance) / safeExtinction;



    // [2026-09-12 雾中光束] 太阳 in-scatter = 解析密度/透射率 × 云影 × 阴影可见度。
    // sunShadowVis 由调用方沿射线采样得到（见 IntegrateScene 的 ComputeFogSunVisibility），
    // 1 = 这条视线没被实心方块挡。密度与透射率仍是闭式积分，这里只多一个逐射线系数：
    // 被树叶/窗缝切开的明暗因此直接长在雾上，不再需要单独一层「体积光」pass。
    // VF_VOLUME_INTENSITY 是「光束强度」= 阴影对比度：0 = 不乘可见度（等于没有光束），
    // 1 = 完全按可见度衰减。
    // 注意：系数必须夹在 [0,1]。mix(1, vis, k) 在 k>1 时是外插 —— 全遮挡处会算出负值，
    // 那等于让雾比「完全没有太阳项」还暗（暗部出现反常的黑块）。>1 现在等价于 1（满对比度）。
    float beamContrast = clamp(VF_VOLUME_INTENSITY, 0.0, 1.0);
    vec3 scatteringSun = fogScatteringCoeff * (avgDensity * msEnergy) * integralFactor
                       * cloudShadow * mix(vec3(1.0), sunShadowVis, beamContrast);
    // 光束亮度：只放大太阳 in-scatter，不动环境项（scatteringSky）—— 因此它是「让光束更明显」
    // 的正解。抬雾浓度或米氏系数会把环境雾一起提亮，对比度反而不变；这一项只提亮被太阳照到的
    // 那一部分。注意它也会放大暗处与亮处的差值，配合「阴影对比度」一起用。
    scatteringSun *= VF_SHAFT_BRIGHTNESS;
    vec3 scatteringSky = fogScatteringCoeff * avgDensity * integralFactor;

    #ifndef VF_CLOUD_SHADOWS
        // [2026-09-12 雨雾发黑] 原式 max(1.0 - wetness * CLOUD_SHADOW_STRENGTH, 0.0) 在雨天
        // wetness → 1 时乘子归零（CLOUD_SHADOW_STRENGTH 默认 1.0，且 VF_CLOUD_SHADOWS 默认
        // 关闭所以一定走这里）→ 雾唯一的强光源（太阳项）被整个抹掉，只剩暗得多的天空光项，
        // 观感就是「又黑又黄」。这里加一块地板：雨天太阳项至少保留 VF_RAIN_SUN_FLOOR。
        // 晴天 wetness = 0 ⇒ max(1.0, 0) = 1.0，逐位不变；两条分支在 wetness = 1/(1+FLOOR)
        // 处取值相等，因此过渡连续、无跳变。
        scatteringSun *= max(1.0 - wetness * CLOUD_SHADOW_STRENGTH, VF_RAIN_SUN_FLOOR * wetness);
    #endif
    scatteringSun *= eyeSkylightSmooth * eyeSkylightSmooth; // 平方衰减，减少暗处穿透

    scatteringSky *= eyeSkylightSmooth;

    #ifdef RAINBOWS
        float visibility = wetness * oms(rainStrength);
        if (visibility > EPS) {
            float distanceFade = saturate(rayLength / max(maxDist, 1.0)) * visibility;
            scatteringSun *= 1.0 + RenderRainbows(LdotV) * distanceFade;
        }
    #endif

    // lightEnergy = 定向光（太阳/月亮）辐照度，由调用方给：白天是 global.directIlluminance；
    // 夜晚 directIlluminance ≈ 0（moonlightMult 压制），调用方补一个月光项 —— 否则夜晚雾的
    // 太阳项整体归零，雾中光束也一起消失（与 SUN_HALO / 旧体积光 pass 同一套月光约定）。
    // 之所以用参数而不是在这里直接取 VOXEL_MOON_STRENGTH：本文件可能在 VoxelLighting.glsl
    // 之前被 include，宏取不到值，GUI 旋钮也就跟着失效。
    vec3 scattering = scatteringSun * lightEnergy;
    scattering += scatteringSky * uniformPhase * global.skyUpIlluminance;

    // ---------- 维度专属色调处理 ----------
    #ifdef DIMENSION_THE_END
        // 末地淡紫色雾气（固定强度）
        const vec3 fogPurpleTint = vec3(0.75, 0.50, 0.85);
        const float fogPurpleStrength = 0.3;
        scattering *= fogPurpleTint * fogPurpleStrength;
    #else
        // ---- 主世界阳光染色，强度随太阳高度动态变化 ----
        // 正午 worldSunDir.y ≈ 1 → timeBasedTint ≈ 1；傍晚 ≈ 0 → 0；夜晚 < 0 → 0
        float timeBasedTint = saturate(worldSunDir.y * 2.5 - 0.15);
        float tintStrength = VF_SUNLIGHT_TINT_RATIO * timeBasedTint;
        if (tintStrength > 0.0) {
            vec3 sunTint = global.directIlluminance / max(luminance(global.directIlluminance), EPS);
            scattering = mix(scattering, scattering * sunTint, tintStrength);
        }

        // [2026-09-12 夜晚雾色] 夜里雾的蓝来自两处叠加：① 月光项本身就是蓝的
        //（vec3(0.30,0.42,0.85)，B/R ≈ 2.8）；② 雾的 Rayleigh 散射系数本身就偏蓝（B/R ≈ 5），
        // 白天有太阳项（暖白）压着看不出来，夜里太阳项 ≈ 0 就只剩蓝。
        // 这里按「夜晚程度」把雾的散射色往灰里拉：VF_NIGHT_FOG_SATURATION = 1 保持原来的蓝，
        // 0 = 完全中性（只留亮度）。白天 nightAmt = 0，完全不受影响。
        float nightAmt = smoothstep(-0.10, -0.25, worldSunDir.y);
        scattering = mix(vec3(luminance(scattering)), scattering,
                         mix(1.0, VF_NIGHT_FOG_SATURATION, nightAmt));
    #endif

    
    return mat2x3(max(scattering, vec3(0.0)), clamp(transmittance, 0.0, 1.0));
}