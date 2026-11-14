// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.

// [2026-11-11 水坑尺寸语义] RAIN_PUDDLE_SCALE 现在是尺寸倍率，频率 = 基准 0.03 / 倍率。
// 旧版把滑条值直接乘进噪声 UV，值越大频率越高、水坑越碎（旧默认 0.03、上限 0.5）。
// 基准 0.03 时 256 纹素噪声约 33 格一循环（约 0.13 格/纹素），与旧默认逐位一致（除以 1.0 精确）。
// 下限 1.0：旧配置文件里残留的 0.5（旧上限）会被当作默认尺寸，避免旧频率语义再次生效。
#ifndef RAIN_PUDDLE_SCALE
    #define RAIN_PUDDLE_SCALE 3.0
#endif

const float puddleBaseFrequency = 0.03;
const float puddleSizeMin = 1.0;

float CalculateRainPuddles(inout vec3 albedo, inout vec3 normal, inout vec3 specTex, in vec3 worldPos, in vec3 geoNormal, in float skylight) {
    vec3 minecraftPos = worldPos + cameraPosition;
    vec2 puddlePos = minecraftPos.xz - minecraftPos.y;
    puddlePos -= worldTimeCounter * vec2(0.016, 0.01);
    // 尺寸倍率越大 -> 频率越低 -> 水坑越大；覆盖率只由下面的阈值与 wetnessCustom 决定。
    puddlePos *= puddleBaseFrequency / max(RAIN_PUDDLE_SCALE, puddleSizeMin);

    // 降低采样次数：从 3 次降为 2 次，通过调整乘数保持噪声形态
    float noise = texture(noisetex, puddlePos).z;
    noise += texture(noisetex, puddlePos * 0.3).z * 2.0;  // 去掉中间一层，调大低层权重
    noise = saturate(noise * 0.2) * wetnessCustom;

    float puddles = smoothstep(0.45, 0.55, noise);
    if (puddles < EPS) return 0.0;

    puddles *= saturate(geoNormal.y * 0.5 + 0.5);
    puddles *= saturate(skylight * 5.0 - 4.0);

    vec3 wetAlbedo = desaturate(albedo, 0.25) * 0.5;
    #if TEXTURE_FORMAT == 0
        float porosity = saturate(specTex.b * (255.0 / 64.0) - step(64.5, specTex.b * 255.0));
        puddles *= 1.0 - porosity;
        wetAlbedo *= oms(porosity * wetAlbedo);
    #endif
    albedo = mix(albedo, wetAlbedo, puddles);

    specTex.r = mix(specTex.r, RAIN_PUDDLE_SMOOTHNESS, puddles);
    specTex.g = max(specTex.g, DEFAULT_DIELECTRIC_F0 * puddles);

    // 返回最终湿区掩码供反射资格判定：水坑是脚本化电介质镜面，
    // 不能只靠金属度通道判断（其 F0 远低于 METALNESS_THRESHOLD）。
    return puddles;
}