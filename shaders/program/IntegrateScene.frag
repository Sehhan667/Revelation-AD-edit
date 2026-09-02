/*
--------------------------------------------------------------------------------

    Revelation Shaders (Ultra Performance Edition - Horizon Fix Removed)

    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Pass: Compute refraction, combine translucent and fog
    Optimizations: 
      - Sky-bypass early Z culling.
      - Zero-iteration screen space projection refraction.
      - Full-resolution inline analytical fog (Zero bandwidth upscale).
      - Removed unused LdotV calculation.
    Note: Horizon blending (edgeFactor) removed for performance / compatibility.
--------------------------------------------------------------------------------
*/

#define PASS_COMPOSITE

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"

//======// Output //==============================================================================//

/* RENDERTARGETS: 0 */
layout (location = 0) out vec4 sceneOut;

//======// Uniform //=============================================================================//

#include "/lib/universal/Uniform.glsl"

//======// SSBO //================================================================================//

#include "/lib/universal/SSBO.glsl"

//======// Struct //==============================================================================//

#include "/lib/universal/Material.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"
#include "/lib/universal/Random.glsl"

#include "/lib/atmosphere/Common.glsl"

#include "/lib/atmosphere/AtmosphericFog.glsl" 
#include "/lib/atmosphere/CommonFog.glsl"
#include "/lib/SpatialUpscale.glsl"

#include "/lib/water/WaterFog.glsl"
#include "/lib/surface/BRDF.glsl"
#include "/lib/surface/SSRT.glsl"

// 体积光（VOLUMETRIC_LIGHT_MODE == 1，SDV 风格世界空间步进）需要阴影采样：
// 阴影形变 + 体素平铺 Shift（与体积光 pass / 体素 GI 同约定）。
#include "/lib/lighting/shadow/Common.glsl"
#include "/lib/lighting/VoxelLighting.glsl"

// 体积光阴影采样（彩色阴影：实心挡=0，直射=1，穿玻璃=玻璃吸收色）
uniform sampler2DShadow shadowtex1;
uniform sampler2D shadowtex0;
uniform sampler2D shadowcolor0;

vec2 CalculateRefractedCoord(in ivec2 texelPos, in vec3 viewPos, in vec3 screenPos, in bool waterMask) {
    vec3 viewNormal = mat3(gbufferModelView) * FetchSurfaceNormal(texelPos);
    float viewLengthInv = inversesqrt(sdot(viewPos));
    vec3 viewDir = viewPos * viewLengthInv;

    vec3 refractedDir;
    if (waterMask) {
        vec3 viewGeometryNormal = mat3(gbufferModelView) * FetchGeometryNormal(texelPos);
        refractedDir = refract(viewDir, viewNormal - viewGeometryNormal * 0.95, 1.0 / WATER_IOR);
    } else {
        refractedDir = refract(viewDir, viewNormal, 1.0 / GLASS_IOR);
    }

    // 零步进屏幕空间投影折射
    float estimatedThickness = waterMask ? 3.0 : 0.3; 
    refractedDir *= estimatedThickness * REFRACTION_STRENGTH;
    
    vec2 refractedCoord = ViewToScreenPos(viewPos + refractedDir).xy;

    float refractedDepth = loadDepth1(uvToTexel(refractedCoord));
    refractedCoord = mix(refractedCoord, screenPos.xy, step(refractedDepth, screenPos.z));

    vec2 edgeFade = smoothstep(0.8, 1.0, abs(refractedCoord * 2.0 - 1.0));
    return mix(refractedCoord, screenPos.xy, edgeFade);
}

// [2026-08-20] 屏幕上太阳可见性：把世界太阳方向投影到屏幕，采样不透明深度。
// 该处天空（≈1）→ 可见；被地形挡/出屏/在相机背后 → 不可见。
// 供雾的太阳光晕遮蔽使用，替代 shadow map 精确采样（更轻、无 include 依赖）。
// [2026-08-20 平滑过渡] 太阳位置周边 9 点软采样，跨地形轮廓 0→1 渐变，消除光晕瞬间亮灭。
float CalcSunScreenVisibility() {
    vec3 sunView = mat3(gbufferModelView) * worldSunDir;
    if (sunView.z >= 0.0) return 0.0;                 // 太阳在相机背后/地平线下
    vec2 sunUv = ViewToScreenPosRaw(sunView).xy;
    // [2026-08-20] 太阳滑近屏幕边缘 → 平滑淡出（取代硬 if 的瞬间跳变，对齐太阳本体的滑动过程）
    vec2 edge = min(sunUv, vec2(1.0) - sunUv);
    float edgeFade = smoothstep(0.0, 0.08, min(edge.x, edge.y));
    if (edgeFade <= 0.0) return 0.0;

    const float r = 0.02;                              // 软采样半径（决定过渡的角宽度）
    vec2 uvMax = vec2(1.0) - viewPixelSize;
    float occ  = step(1.0 - 1e-4, loadDepth1(uvToTexel(sunUv)));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2( r, 0.0), vec2(0.0), uvMax))));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2(-r, 0.0), vec2(0.0), uvMax))));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2(0.0,  r), vec2(0.0), uvMax))));
    occ += step(1.0 - 1e-4, loadDepth1(uvToTexel(clamp(sunUv + vec2(0.0, -r), vec2(0.0), uvMax))));
    // [P1 2026-09-02] 9 点 -> 5 点（十字，去掉对角线采样）：每像素省 4 次深度读取；光晕过渡由 edgeFade 平滑，几乎无感
    return edgeFade * occ * (1.0 / 5.0);
}

// 阴影贴图彩色可见性（与 VolumetricFog.frag 的 SampleVolumetricShadow 同逻辑）：
// 实心挡=0，直射=1，穿玻璃=玻璃吸收色。camRelPos 为相机相对世界坐标。
vec3 SampleSunShaftsShadow(in vec3 camRelPos) {
    vec3 shadowClipPos = (shadowModelView * vec4(camRelPos, 1.0)).xyz;
    shadowClipPos = (shadowProjection * vec4(shadowClipPos, 1.0)).xyz;
    vec3 ssp = DistortShadowSpace(shadowClipPos) * 0.5 + 0.5;
    #ifdef ENABLE_VOXELIZATION
        ShiftShadowScreenPos(ssp.xy); // 体素平铺布局：真阴影在右上区
    #endif

    vec3 result = vec3(1.0);
    if (all(equal(ssp, saturate(ssp)))) {
        result = vec3(0.0);
        ssp.z -= 4e-5; // 消除自阴影深度偏差
        float soildShadow = textureLod(shadowtex1, vec3(ssp.xy, ssp.z), 0.0);
        if (soildShadow > 0.5) {
            float translucentShadow = step(ssp.z, textureLod(shadowtex0, ssp.xy, 0.0).x);
            result += vec3(translucentShadow);
            float coloredShadow = saturate(soildShadow - translucentShadow);
            if (coloredShadow > 1e-3) {
                vec4 shadowColorSample = textureLod(shadowcolor0, ssp.xy, 0.0);
                result += sRGBToLinear(shadowColorSample.rgb) * shadowColorSample.a * coloredShadow;
            }
        }
    }
    return result;
}

// [2026-08-21] 体积光（SDV 风格，世界空间光柱步进）：从相机沿视线方向步进，
// 每步把世界坐标投影到阴影贴图，采样彩色阴影（实心挡=0/直射=1/玻璃染色）累加。
// 被方块挡住的光束自然断裂；"只在雾内部"由雾密度门控（1-exp2(-dist*密度) 距离累积）
// + 高度衰减（玩家在雾层上方光消失）共同实现，与体积雾浓度联动。
// 颜色 = 体积雾散射色相（fogScatter 归一化）× 物理辐照度，与雾完全一致且可见。
// 噪声靠 TAA。仅 VOLUMETRIC_FOG 开启时由调用方门控。
vec3 ScreenSpaceSunShafts(vec2 uv, vec2 pixelSize, vec3 worldDir, float dither, vec3 fogScatter) {
    // 夜晚月光判定（moonAmt 用于给光轴颜色补月光；光柱形状由阴影贴图决定，与方向无关）
    float moonAmt = smoothstep(-0.10, -0.25, worldSunDir.y);

    float curDepth = loadDepth0(uvToTexel(uv));

    // 步进终点：像素深度（几何体）或固定远端（天空）
    float rayEnd;
    if (curDepth > 1.0 - 1e-4) {
        rayEnd = 256.0;
    } else {
        vec3 viewPos = ScreenToViewPos(vec3(uv, curDepth));
        vec3 endWorld = transMAD(gbufferModelViewInverse, viewPos) + cameraPosition;
        rayEnd = min(length(endWorld - cameraPosition), 256.0);
    }
    if (rayEnd < 0.5) return vec3(0.0);

    // ---- 雾密度门控（SDV 核心：体积光只在雾内部）----
    // 距离累积雾密度：1-exp2(-dist*浓度)，随距离和雾浓度增长；插值到 fogFactor
    //（体积雾强度）使光强与雾联动。用 CalculateFogDensity 取相机位置的雾浓度。
    float fogFactor = CalculateFogDensity(vec3(0.0), 0.0).y * VF_DENSITY_MULT;
    float volumetricFogDensity = (1.0 - exp2(-rayEnd * fogFactor * 0.01));
    volumetricFogDensity = (volumetricFogDensity - fogFactor) * 0.5 + fogFactor;
    if (volumetricFogDensity <= 1e-3) return vec3(0.0);

    // ---- 高度衰减（玩家在雾层上方 → 体积光消失）----
    // 相机高度 cameraPosition.y 相对雾层高度 VF_HEIGHT，越远衰减越快。
    float h = saturate((VF_HEIGHT - cameraPosition.y) / 64.0);
    float heightFade = sqr(sqr(1.0 - sqr(h)));
    if (heightFade <= 1e-3) return vec3(0.0);

    // ---- 光源颜色：体积雾散射色相（fogChroma）× 物理直射辐照度 ----
    // fogScatter（fogData[0]）是体积雾的散射色，量级偏低（尤其白天，0-1 尺度下
    // 光柱看不见）。正确做法：先归一化出色相（fogChroma，保留雾的天体光晕/维度色调/
    // 阳光染色方向），再乘物理直射辐照度 global.directIlluminance（白天 ≈128，
    // 夜晚被 moonlightMult 压到近 0），保证白天/夜晚都可见且色相与雾完全一致。
    vec3 fogChroma = fogScatter / max(luminance(fogScatter), 1e-4);
    vec3 lightColor = fogChroma * global.directIlluminance;
    if (moonAmt > 0.0) {
        // 夜晚月光：directIlluminance 夜晚≈0（moonlightMult 压制），光柱/月晕主体
        // 由月光补项提供，色相淡蓝、强度跟随 VOXEL_MOON_STRENGTH。
        lightColor += vec3(0.30, 0.42, 0.85) * moonAmt * VOXEL_MOON_STRENGTH;
    }

    // ---- Mie 前向散射相位（天体光晕）----
    // 夜晚沿月亮方向（-worldSunDir）、白天沿太阳方向（worldLightDir）聚拢 → 天体
    // 周围出现辉光（夜晚月晕由此而来）。与均匀项 mix 避免正对光源的尖锐峰值盖过
    // 周围光柱（"太阳亮、光柱弱"）。方向由 dot(lightDir, worldDir) 决定。
    vec3 lightDir = worldLightDir;
    if (moonAmt > 0.0) lightDir = -worldSunDir;
    float miePhase = mix(1.0, AtmospherePhase(dot(lightDir, worldDir)).y, 0.5);

    // ---- 世界空间光柱步进（SDV：7-12 步）----
    // [P1 2026-09-02] 12 -> 8：光柱每像素步进减为 8，少 4 次阴影贴图采样；噪声靠 TAA 平滑，几乎无感
    const int shaftsSamples = 8;
    float stepLen = rayEnd / float(shaftsSamples);
    vec3 shafts = vec3(0.0);

    for (int i = 0; i < shaftsSamples; ++i) {
        float t = (float(i) + dither) * stepLen;
        vec3 sampleCamRel = worldDir * t; // 相机相对世界坐标
        // 彩色阴影采样：实心挡=0，直射=1，穿玻璃=玻璃色
        vec3 shd = SampleSunShaftsShadow(sampleCamRel);
        shafts += lightColor * miePhase * shd * (1.0 / float(shaftsSamples));
    }

    // 强度 = 步进累积 × 雾密度门控 × 高度衰减 × 亮度倍率 × 正午衰减。
    // 昼夜分开换算：白天阳光 ≈128 需压回可见范围（0.03），夜晚月光 ≈1 用更大系数
    // 保持月晕/光柱可见。VF_VOLUME_INTENSITY / VF_SHAFT_COLOR_BRIGHTNESS 仍独立可调。
    // [2026-08-21 正午衰减] 正午太阳在头顶，光柱方向与视线几乎不交叉、天顶大气路径
    // 最短 → 体积光不可见（与方案 0 同曲线）。worldSunDir.y 白天 0(日出)→1(正午)。
    float noonFade = 1.0 - smoothstep(0.30, 0.60, max(worldSunDir.y, 0.0));
    float intensityScale = mix(0.03, 0.5, moonAmt);
    return shafts * VF_VOLUME_INTENSITY * volumetricFogDensity * heightFade * VF_SHAFT_COLOR_BRIGHTNESS * intensityScale * noonFade;
}

void main() {
    ivec2 texelPos = ivec2(gl_FragCoord.xy);
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;

    float depth = loadDepth0(texelPos);

    vec3 screenPos = vec3(screenCoord, depth);
    vec3 viewPos = ScreenToViewPos(screenPos);
    #if defined LOD_MOD
        if (depth > 1.0 - EPS) {
            depth = screenPos.z = loadDepth0Lod(texelPos);
            viewPos = ScreenToViewPosLod(screenPos);
        }
    #endif

    vec3 sceneColor;
    float fogMask = 1.0;
    
    vec3 worldPos = mat3(gbufferModelViewInverse) * viewPos;
    vec3 worldDir = normalize(worldPos);

    float viewDistance = 0.0;
    if (depth < 1.0 || isEyeInWater == 1) {
        viewDistance = length(viewPos);
    }

    // ====================================================================================
    // 天空 / 半透明物体处理
    // ====================================================================================
    if (depth >= 1.0) {
        sceneColor = loadSceneMain(texelPos);
    } else {
        uvec4 materialPack = loadMaterialPack(texelPos);
        uint materialID = materialPack.y;
        bool glassMask = materialID == 2u;
        bool waterMask = materialID == 3u;

        ivec2 refractedTexel = texelPos;
        if (glassMask || waterMask) {
            refractedTexel = uvToTexel(CalculateRefractedCoord(texelPos, viewPos, screenPos, waterMask));
        }

        sceneColor = loadSceneMain(refractedTexel);

        vec4 translucent = ExtractSpecularTex(materialPack);
        vec3 albedo = sRGBToLinear(translucent.rgb);

        // 安全回退：部分玻璃实体（掉落物/展示实体）可能未把 albedo 打包进 materialPack.zw，
        // zw 为 0 时 log2(0) 得到 -inf/NaN，会让玻璃乘出纯黑不可见。
        // 此时回退使用 colortex6 中的真实 albedo，保证物体至少可见。
        if (maxOf(translucent.rgb) < 0.001 || translucent.a < 0.001) {
            vec4 fallbackAlbedo = texelFetch(colortex6, texelPos, 0);
            translucent = vec4(sRGBToLinear(fallbackAlbedo.rgb), max(fallbackAlbedo.a, 0.75));
            albedo = translucent.rgb;
        }

        if (materialID == 500u) {
            vec3 diffuseLight = texelFetch(colortex3, texelPos, 0).rgb;
            sceneColor = mix(sceneColor, albedo * diffuseLight, translucent.a);
        }

        if (glassMask || waterMask) {
            if (glassMask) {
                sceneColor *= exp2(log2(albedo) * approxSqrt(translucent.a));
                sceneColor += (2.0 * EMISSIVE_BRIGHTNESS) * Unpack2x8UX(materialPack.x) * mean(albedo) * albedo;
            }
            vec4 specularLight = texelFetch(colortex3, texelPos, 0);
            sceneColor = sceneColor * specularLight.a + specularLight.rgb;
        }

        #ifdef BORDER_FOG
            if (isEyeInWater == 0) {
                float xzDistSq = sdot(worldPos.xz) * (1.0 / (2048.0 * 2048.0));
                float xzDistPow4 = xzDistSq * xzDistSq;
                float density = exp2(-0.1 * max0(worldPos.y - 63.0)) * (xzDistPow4 * xzDistPow4); 
                float transmittance = exp2(-BORDER_FOG_FALLOFF * density);

                vec3 skyRadiance = AtmosphereSkyView(atmosphereViewPos, worldDir, worldSunDir);
                sceneColor = mix(skyRadiance, sceneColor, transmittance);
            }
        #endif
    }

    // ====================================================================================
    // 体积雾 / 水下雾（统一处理，并修复天空所有方向的雾）
    // ====================================================================================
    mat2x3 fogData = mat2x3(vec3(0.0), vec3(1.0));

    if (isEyeInWater == 1) {
        float LdotV = dot(worldLightDir, worldDir);
        fogData = AnalyticWaterFog(eyeSkylightSmooth, viewDistance, LdotV, CalcSunScreenVisibility());
    } else {
        #ifdef VOLUMETRIC_FOG
            float dither = BlueNoise(texelPos, frameCounter);
            
            bool skyMask = (depth >= 1.0 - EPS);
            vec3 fogEndPos = worldPos;

            if (skyMask) {
                // 天空像素：强制使用几何路径，固定有限距离，覆盖全方向
                skyMask = false;
                const float skyFogDist = 256.0;           // 控制天空雾的浓度（调小变浓）
                fogEndPos = vec3(0.0) + worldDir * min(length(worldPos), skyFogDist);
            } else {
                // 非天空：检查后方是否实际是天空（例如半透明区域）
                float opaqueDepth = loadDepth1(texelPos);
                #if defined LOD_MOD
                    if (opaqueDepth > 1.0 - EPS) opaqueDepth = loadDepth1Lod(texelPos);
                #endif
                if (opaqueDepth >= 1.0 - EPS) {
                    skyMask = true;          // 实际为天空，同样使用有限距离
                    const float skyFogDist = 512.0;
                    fogEndPos = vec3(0.0) + worldDir * min(length(worldPos), skyFogDist);
                }
            }
            
            fogData = RaymarchAtmosphericFog(vec3(0.0), fogEndPos, dither, skyMask, 1u, CalcSunScreenVisibility());
        #endif
    }

    sceneColor = ApplyFog(sceneColor, fogData);
    fogMask = mix(1.0, mean(fogData[1]), eyeSkylightSmooth);

    if (viewDistance == 0.0) viewDistance = length(viewPos);
    RenderVanillaFog(sceneColor, fogMask, viewDistance);

    // [2026-08-21] 体积光（God Rays）叠加。方案 0：colortex11 为 1/4 分辨率 RGBA16F，
    // 全屏 UV 与其 UV 范围一一对应，直接采样后上采样叠加（RGB=散射，A=透射率）。
    // 方案 1：全分辨率屏幕空间太阳光轴内联计算（无需 colortex11），仅体积雾
    // （VOLUMETRIC_FOG）开启时生效。噪声均由 TAA 平滑。
    #ifdef VOLUMETRIC_LIGHT
        #if VOLUMETRIC_LIGHT_MODE == 1
            #ifdef VOLUMETRIC_FOG
                float shaftsDither = BlueNoise(texelPos, frameCounter);
                // 光轴颜色用该像素体积雾的散射色（fogData[0]），与体积雾完全一致；
                // 夜晚月光、阳光染色、维度色调均已含在体积雾散射色中。
                vec3 shafts = ScreenSpaceSunShafts(screenCoord, viewPixelSize, worldDir, shaftsDither, fogData[0]);
                // 只能和体积雾重叠渲染：用该像素体积雾的散射色（fogData[0]）做门控——
                // 散射色>0（该像素有体积雾散射）= 显示光轴；无雾处散射色≈0 = 光轴消失。
                // 不用透射率（1-fogData[1]）做门控：白天薄雾透射率≈1 会误杀光轴。
                float fogPresence = saturate(luminance(fogData[0]) * 50.0);
                sceneColor += shafts * fogPresence;
            #endif
        #else
            vec4 volumeLight = textureLod(colortex11, screenCoord, 0);
            sceneColor = sceneColor * volumeLight.a + volumeLight.rgb;
        #endif
    #endif


    #if defined TAA_ENABLED && RENDER_MODE == 1
        sceneColor = RGBToYCoCg(sceneColor);
    #endif

    #if DEBUG_NORMALS == 1
        sceneColor = FetchSurfaceNormal(texelPos) * 0.5 + 0.5;
    #elif DEBUG_NORMALS == 2
        sceneColor = FetchGeometryNormal(texelPos) * 0.5 + 0.5;
    #endif

    sceneOut = vec4(sceneColor, saturate(1.0 - fogMask));
}