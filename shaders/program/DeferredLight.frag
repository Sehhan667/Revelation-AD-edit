/*
--------------------------------------------------------------------------------
    Revelation Shaders
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Pass: Deferred lighting and sky combination
    Optimized: Early sun-light culling, deferred bicubic sampling, constant folding.
    Added: SSS_DISABLE_BEYOND_SHADOW_DIST macro to skip SSS outside shadow distance.
    Added: SPECULAR_BLOOM_BOOST for enhancing specular bloom (glare).
    Added: Skip compensation in The End / Nether.
    Added: SUN_BRIGHTNESS_MULTIPLIER and MOON_BRIGHTNESS_MULTIPLIER for independent tuning.
    Added: AMBIENT_BRIGHTNESS_MULTIPLIER and AMBIENT_COLOR_TINT to control ambient/skylight.
    Added: AMBIENT_SUNLIGHT_TINT_RATIO with dynamic time‑based intensity (noon max, night off).
    Added: NIGHT_SHADOW_BOOST to deepen night shadows.
--------------------------------------------------------------------------------
*/

#define PASS_DEFERRED_LIGHTING

#ifndef SHADOW_CONTRAST_STRENGTH
    #define SHADOW_CONTRAST_STRENGTH 1.0 // [0.1 0.2 0.3 0.4 0.5 1.0 2.0 3.0 4.0 6.0 8.0 10.0]
#endif

// 启用补偿
#define COMPENSATION_ENABLED

// 补偿参数
#ifndef COMPENSATION_BOOST
    #define COMPENSATION_BOOST 0.5 // [0.0 0.05 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
#endif
#ifndef COMPENSATION_FADE_SPEED
    #define COMPENSATION_FADE_SPEED 0.2 // [0.1 0.2 0.3 0.4 0.5 1.0 2.0 3.0 4.0 6.0 8.0 10.0]
#endif
#ifndef COMPENSATION_DELAY
    #define COMPENSATION_DELAY 6.0 // [0.0 0.5 1.0 1.5 2.0 3.0 5.0 6.0 10.0 15.0]
#endif
#ifndef COMPENSATION_AO_BOOST
    #define COMPENSATION_AO_BOOST 1.5 // [0.0 0.1 0.2 0.3 0.5 0.7 1.0 1.5 2.0]
#endif

// ====== 次表面散射距离控制 ======
#define SSS_DISABLE_BEYOND_SHADOW_DIST

// ====== 镜面高光泛光增强 ======
#ifndef SPECULAR_BLOOM_BOOST
    #define SPECULAR_BLOOM_BOOST 3.0 // [1.0 1.5 2.0 2.5 3.0 4.0 5.0]
#endif

// ====== 阳光 / 月光亮度控制 ======
#ifndef SUN_BRIGHTNESS_MULTIPLIER
    #define SUN_BRIGHTNESS_MULTIPLIER 1.0 // [0.0 0.5 1.0 1.5 2.0 3.0 5.0]
#endif
#ifndef MOON_BRIGHTNESS_MULTIPLIER
    #define MOON_BRIGHTNESS_MULTIPLIER 1.0 // [0.0 0.5 1.0 1.5 2.0 3.0 5.0]
#endif

// ====== 环境光/天空光亮度与颜色控制 ======
#ifndef AMBIENT_BRIGHTNESS_MULTIPLIER
    #define AMBIENT_BRIGHTNESS_MULTIPLIER 1.5 // [0.0 0.5 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0]
#endif
#ifndef AMBIENT_COLOR_TINT
    #define AMBIENT_COLOR_TINT vec3(1.0, 1.0, 1.0) // 减少蓝色可改为 vec3(1.0, 1.0, 0.85)
#endif

// 环境光阳光色调混合最大强度 (实际强度 = 此值 × 太阳高度因子，仅主世界)
#ifndef AMBIENT_SUNLIGHT_TINT_RATIO
    #define AMBIENT_SUNLIGHT_TINT_RATIO 1.1 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.5 3.0]
#endif

// ====== 夜间阴影增强 ======
#ifndef NIGHT_SHADOW_BOOST
    #define NIGHT_SHADOW_BOOST 4.5 // [1.0 1.5 2.0 2.5 3.0 4.0 5.0]
#endif

// ====== Precomputed Constants ======
#define INV_HAND_DEPTH (1.0 / MC_HAND_DEPTH)
#define HAND_DEPTH_OFFSET (0.5 - 0.5 * INV_HAND_DEPTH)
#define SSS_CONTRAST_POW (1.2 / SHADOW_CONTRAST_STRENGTH)

//======// Utility //=============================================================================//

#include "/lib/Utility.glsl"



//======// Output //==============================================================================//

/* RENDERTARGETS: 0 */
out vec3 sceneOut;

//======// Uniform //=============================================================================//

writeonly uniform uimage2D colorimg7;
uniform sampler2D cloudOriginTex;

#include "/lib/universal/Uniform.glsl"

// 覆盖只读限制，使 GlobalData 可写
#undef SSBO_DECLARED_TPYE
#define SSBO_DECLARED_TPYE
#include "/lib/universal/SSBO.glsl"

//======// Struct //================================================//

#include "/lib/universal/Material.glsl"

//======// Function //============================================================================//

#include "/lib/universal/Transform.glsl"
#include "/lib/universal/Fetch.glsl"
#include "/lib/universal/Random.glsl"

#include "/lib/atmosphere/Common.glsl"
#include "/lib/atmosphere/Celestial.glsl"

#include "/lib/atmosphere/clouds/Render.glsl"
#include "/lib/atmosphere/clouds/Shadows.glsl"

#include "/lib/lighting/Common.glsl"
#include "/lib/lighting/shadow/Render.glsl"

#if AO_ENABLED > 0 && !defined SSILVB_ENABLED
    #include "/lib/lighting/SSAO.glsl"
    #include "/lib/lighting/GTAO.glsl"
#endif

#include "/lib/SpatialUpscale.glsl"

#ifdef RAIN_PUDDLES
    #include "/lib/surface/RainPuddle.glsl"
#endif
#include "/lib/surface/Reflection.glsl"

//#ifdef ENABLE_VOXELIZATION
    #include "/lib/lighting/VoxelGI.glsl"
//#endif

// 方块图集（shaders.properties customTexture.atlas2D = blocks.png，与传播端/体素化同图集）
// 无显式 binding：交由 Iris 按名字自动绑定（显式 binding 会与普通贴图纹理单元冲突）
uniform sampler2D atlas2D;

// 真阳光直射可见度（像素版，与传播端 VoxelSunVisibility 同逻辑，供调试标色）
// 阴影贴图单点硬件深度比较：0=被挡，1=直射；太阳在地平线以下=false
bool VoxelPixelSunVisible(vec3 relPos) {
    if (sunPosition.y < 0.01) return false;
    float distortionFactor;
    vec3 ssp = WorldToShadowScreenSpace(relPos, distortionFactor);
    ssp.z -= 3e-8 * shadowProjInv1y * distortionFactor * SHADOW_BIAS_STRENGTH;
    if (all(equal(ssp, saturate(ssp)))) {
        return textureLod(shadowtex1, vec3(ssp.xy, ssp.z), 0).x > 0.5;
    }
    return true;
}

// 每像素漫反射追踪已迁到 DiffuseIndirect.comp（棋盘半分辨率 1 SPP + SVGF 时域累积，
// 阶段④）；此处只读回信号，不再 include VoxelTracing.glsl。
// VoxelPixelSunVisible（真阳光直射可见度）供 DEBUG_VOXEL_GI 标色，独立于追踪端。


//======// Main //================================================================================//
void main() {
    
    ivec2 texelPos = ivec2(gl_FragCoord.xy);
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;

    vec3 screenPos = vec3(screenCoord, loadDepth0(texelPos));

    #if defined LOD_MOD
        bool lodMask = screenPos.z > 1.0 - EPS;
        if (lodMask) {
            screenPos.z = ViewToScreenDepth(ScreenToViewDepthLod(loadDepth0Lod(texelPos)));
        }
    #endif

    if (screenPos.z < 0.56) {
        screenPos.z = screenPos.z * INV_HAND_DEPTH + HAND_DEPTH_OFFSET;
    }

    vec3 viewPos = ScreenToViewPos(screenPos);
    vec3 worldPos = mat3(gbufferModelViewInverse) * viewPos;
    // 相机相对世界坐标备份：L224 会把 worldPos 改成绝对坐标，但 gbufferModelViewInverse
    // 不含相机平移（Terrain.vert L98 证据），L224 加的不是 cameraPosition，其后 worldPos
    // 并非真正的绝对坐标——GI 查询/追踪/调试一律用本备份（确定正确的相机相对），
    // 不要再做 worldPos - cameraPosition（双重减 → 全越界 → GI 恒 0/全红诊断）。
    vec3 camRelPos = worldPos;
    vec3 worldDir = normalize(worldPos);

    // [2026-08-09] 原版方块光颜色（BLOCKLIGHT_COLOR_R/G/B）策略：
    // - 光追关闭：按玩家设置正常工作；
    // - 光追开启：体素网格内强制 0（原版方块光关闭，由体素 GI 提供方块光），
    //   网格外强制默认颜色 RGB=1（亮度保留玩家设置）——无 GI 数据的区域
    //   以非光追样式渲染。
    vec3 activeBlocklightColor = blocklightColor;
    // 是否位于体素网格内（网格内由 GI 提供方块光；网格外走原版方块光）
    bool blocklightInVoxelGrid = false;
    #ifdef VOXEL_GI_ENABLED
        vec3 blocklightVoxelCoord = camRelPos + cameraPositionFract + float(VOXEL_RADIUS);
        blocklightInVoxelGrid = all(greaterThanEqual(blocklightVoxelCoord, vec3(0.0))) && all(lessThan(blocklightVoxelCoord, vec3(float(VOXEL_AREA))));
        if (blocklightInVoxelGrid) {
            activeBlocklightColor = vec3(0.0);
        } else {
            activeBlocklightColor = vec3(BLOCKLIGHT_BRIGHTNESS);
        }
    #endif

    uvec4 materialPack = loadMaterialPack(texelPos);
    uint materialID = materialPack.y;
    vec3 albedo = sRGBToLinear(loadAlbedo(texelPos));
    float dither = BlueNoise(texelPos, frameCounter);

    sceneOut = vec3(0.0);

    // ========== Sky ==========
    if (materialID == 0u) {
        vec3 transmittance = AtmosphereTransmittanceToPoint(atmosphereViewPos, worldDir);
        vec3 skyRadiance = AtmosphereSkyView(atmosphereViewPos, worldDir, worldSunDir);
        sceneOut = skyRadiance;

        #ifdef CLOUDS
            #ifdef CLOUD_TAAU_ENABLED
                vec4 cloudData = texture(cloudReconstructTex, screenCoord);
            #else
                screenCoord += viewPixelSize * (dither - 0.5);
                vec4 cloudData = texture(cloudOriginTex, screenCoord);
            #endif
            CompositeClouds(sceneOut, cloudData, worldDir);
            transmittance *= cloudData.w;
        #endif

        if (dot(transmittance, vec3(1.0)) > EPS) {
            vec3 celestial = RenderSun(worldDir, worldSunDir);
            vec3 vanillaMoon = albedo * MOON_BRIGHTNESS_MULTIPLIER;   // 月光亮度控制
            #ifdef GALAXY
                celestial += mix(RenderGalaxy(worldDir), vanillaMoon, step(0.06, vanillaMoon.g));
            #else
                celestial += mix(RenderStars(worldDir), vanillaMoon, step(0.06, vanillaMoon.g));
            #endif
            sceneOut += celestial * transmittance;
        }
        imageStore(colorimg7, texelPos, uvec4(0));
        return;
    }

    // ========== Geometry ==========
    worldPos += gbufferModelViewInverse[3].xyz;
    vec3 geoNormal, worldNormal;
    FetchNormalData(texelPos, geoNormal, worldNormal);
    vec3 viewNormal = mat3(gbufferModelView) * worldNormal;
    vec2 lightmap = Unpack2x8U(materialPack.x);

    #if defined MC_SPECULAR_MAP
        vec4 specularTex = ExtractSpecularTex(materialPack);
    #else
        vec4 specularTex = vec4(0.0);
    #endif

    #ifdef RAIN_PUDDLES
        if (wetnessCustom > EPS) {
            if (materialID < 1000u || materialID > 1002u) {
                CalculateRainPuddles(albedo, worldNormal, specularTex.rgb, worldPos, geoNormal, lightmap.y);
                materialPack.z = Packup2x8U(specularTex.xy);
                imageStore(colorimg7, texelPos, materialPack);
            }
        }
    #endif

    Material material = GetMaterialData(specularTex);
    float sssAmount = 0.0;
    
    // --- SSS ---
    #if SHADOW_SOFT_TYPE > 0
        #if SUBSURFACE_SCATTERING_MODE < 2
            switch (materialID) {
                case 1000u: case 1001u: case 1002u: case 1003u: case 27u: case 28u: sssAmount = 0.6; break;
                case 13u: sssAmount = 0.8; break;
                case 37u: case 39u: sssAmount = 0.5; break;
                case 38u: case 51u: sssAmount = 0.8; break;
                case 40u: sssAmount = 0.3; break;
            }
        #endif
        #if TEXTURE_FORMAT == 0 && SUBSURFACE_SCATTERING_MODE > 0 && defined MC_SPECULAR_MAP
            if (specularTex.b > 64.5 / 255.0) sssAmount = max(sssAmount, specularTex.b);
        #endif

        sssAmount = linearstep(64.0 / 255.0, 1.0, sssAmount) * eyeSkylightSmooth * SUBSURFACE_SCATTERING_STRENGTH;
    #endif

    // --- Optimized Direct Light & Shadow Calculation ---
    // 白天：天光按 lightmap 平滑门控（0.02 → 0.2），修复半透光室内主阴影/SSS 泄漏；
    // 夜晚：保留原逻辑（月亮阴影依赖原判定，不受影响）。
    float sunlightFactor = mix(
        saturate(lightmap.y * 1e6 + float(isEyeInWater)),
        saturate(smoothstep(0.02, 0.2, lightmap.y) + float(isEyeInWater)),
        step(0.0, worldSunDir.y)
    );
    vec3 sunlightBase = vec3(0.0);
    float cloudShadow = 1.0;

    if (sunlightFactor > EPS) {
        #ifdef CLOUD_SHADOWS
            vec2 cloudShadowCoord = WorldToCloudShadowScreenPos(worldPos).xy + (dither - 0.5) / textureSize(cloudShadowTex, 0);
            cloudShadow = textureBicubic(cloudShadowTex, saturate(cloudShadowCoord)).x;
        #else
            cloudShadow = 1.0 - wetness * 0.96;
        #endif
        
        // ---------- 末地夜晚直接光（淡紫色、更暗）----------
        #ifdef DIMENSION_THE_END
            const vec3 nightDirectTint = vec3(0.75, 0.45, 0.80);
            const float nightDirectScale = 0.20; // 更暗
            sunlightBase = cloudShadow * sunlightFactor * global.directIlluminance * nightDirectTint * nightDirectScale;
        #else
            sunlightBase = cloudShadow * sunlightFactor * global.directIlluminance;
        #endif
    }
    sunlightBase *= SUN_BRIGHTNESS_MULTIPLIER; // 阳光亮度控制

    vec3 specularDirect = vec3(0.0);
    float worldDistSquared = sdot(worldPos);
    
    float distXZSq = dot(worldPos.xz, worldPos.xz);
    float distanceFade = linearstep(shadowDistance - 8.0, shadowDistance, approxSqrt(distXZSq));
    #if defined LOD_MOD
        distanceFade = saturate(distanceFade + float(lodMask));
    #endif

    float NdotL = saturate(dot(worldNormal, worldLightDir));

    if (sunlightFactor > EPS && (NdotL + sssAmount > EPS)) {
        // [2026-08-19 无阳光处阳光高光/SSS 外泄修复] 真阳光直射可见度（shadow map 深度比较），
        // 仅用于高光/SSS 防护；不改动原有 diffuse 软阴影（PCSS 可靠，避免整个场景阴影被硬 0/1 灭掉）。
        float sunVis = VoxelPixelSunVisible(worldPos - cameraPosition) ? 1.0 : 0.0;
        vec3 shadow = vec3(NdotL);
        float surfaceDepth = 0.0;
        float normalOffsetBase = (approxSqrt(worldDistSquared) * 2e-3 + 2e-2) * (2.0 - NdotL);
        
        vec3 rawShadow = vec3(1.0);

        if (distanceFade < EPS) {
            rawShadow = CalculatePCSS(worldPos, geoNormal * normalOffsetBase, dither, surfaceDepth);
            
            #if SHADOW_SOFT_TYPE == 1
                shadow *= pow(rawShadow, vec3(SHADOW_CONTRAST_STRENGTH));
                shadow = smoothstep(-0.01, 1.01, shadow);
            #else
                shadow *= rawShadow;
            #endif
        }

        #ifdef SCREEN_SPACE_SHADOWS
            float contactShadow = ScreenSpaceShadow(screenPos, viewPos + viewNormal * normalOffsetBase, dither, sssAmount);
        #else
            const float contactShadow = 1.0;
        #endif

        float LdotV = dot(worldLightDir, -worldDir);

        #ifdef SSS_DISABLE_BEYOND_SHADOW_DIST
    bool sssAllowed = (distanceFade < EPS);
#else
    // 过渡区 (0 < distanceFade < 1) 禁用 SSS，因为 surfaceDepth 无效
    bool sssAllowed = (distanceFade < EPS) || (distanceFade >= 1.0 - EPS);
#endif

        if (sssAllowed && sssAmount > EPS) {
            vec3 beta = approxSqrt(normalize(albedo));
            vec3 sigmaA = oms(beta) * 16.0 / (sssAmount * SUBSURFACE_SCATTERING_STRENGTH);
            vec3 sigmaS = 4.0 * beta * sssAmount;
            float phase = HenyeyGreensteinPhase(-LdotV, 0.7) * 0.25 + uniformPhase * 0.75;
            vec3 sss = sigmaS * phase * exp2(-rLOG2 * surfaceDepth * (sigmaS + sigmaA));

            #if SHADOW_SOFT_TYPE == 1
                float sssMask = saturate(dot(rawShadow, vec3(0.3333)));
                sss *= pow(sssMask, SSS_CONTRAST_POW);
            #endif

            float cutout = float(clamp(materialID, 1000u, 1003u) == materialID || clamp(materialID, 27u, 28u) == materialID);
            sss *= mix(1.0, contactShadow, saturate(distanceFade + cutout * 0.75));
            // 乘 sunVis：没有真阳光直射处也熄灭 SSS（修复无阳光处 SSS 外泄）
            sss *= sunVis;
            sceneOut += sunlightBase * sss * SUBSURFACE_SCATTERING_BRIGHTNESS;
        }

        if (dot(shadow, vec3(1.0)) > EPS) {
            // ---------- 夜间阴影增强 ----------
            float isNight = step(0.0, -worldSunDir.y);
            shadow = pow(shadow, vec3(mix(1.0, NIGHT_SHADOW_BOOST, isNight)));

            shadow *= contactShadow * sunlightBase;
            #ifdef PARALLAX_SHADOW
                #if defined PARALLAX && !defined PARALLAX_DEPTH_WRITE
                    shadow *= oms(loadSceneMain(texelPos).x);
                #endif
            #endif

            vec3 halfway = normalize(worldLightDir - worldDir);
            float NdotV = abs(dot(worldNormal, worldDir)), NdotH = dot(worldNormal, halfway), LdotH = dot(worldLightDir, halfway);
            sceneOut += shadow * DiffuseBurley(LdotH, NdotV, NdotL, material.roughness);

            #if defined MC_SPECULAR_MAP
                vec3 f0 = GetMaterialF0(material.metalness, albedo);
            #else
                const vec3 f0 = vec3(DEFAULT_DIELECTRIC_F0);
            #endif
            specularDirect = shadow * SpecularGGX(LdotH, NdotV, NdotL, NdotH, material.roughness, f0);
            // [2026-08-19 无阳光处高光外泄防护] 乘 sunVis：无真阳光直射处高光熄灭
            specularDirect *= sunVis;
            specularDirect *= SPECULAR_BLOOM_BOOST;
        }
    }

    // ====== Ambient Occlusion ======
    #if AO_ENABLED > 0 && !defined SSILVB_ENABLED
        float aoVal = 1.0;
        #if AO_ENABLED == 1
            aoVal = CalculateSSAO(screenCoord, viewPos, viewNormal, SampleStbnUnitvec2(texelPos, frameCounter));
        #else
            aoVal = CalculateGTAO(screenCoord, viewPos, viewNormal, SampleStbnVec2(texelPos, frameCounter));
        #endif
        
        vec3 ao;
        #ifdef AO_MULTI_BOUNCE
            ao = ApproxMultiBounce(aoVal, albedo);
        #else
            ao = vec3(aoVal);
        #endif
    #else
        const vec3 ao = vec3(1.0);
    #endif

    // ====== 末地 / 地狱跳过补偿逻辑 ======
    #ifdef DIMENSION_THE_END
        #undef COMPENSATION_ENABLED
    #endif
    #ifdef DIMENSION_NETHER
        #undef COMPENSATION_ENABLED
    #endif

    // ====== 补偿逻辑 ======
    float activeMinAmbient = MINIMUM_AMBIENT_BRIGHTNESS;
    float compensationAlpha = 0.0;

        #ifdef COMPENSATION_ENABLED
        if (texelPos == ivec2(0,0)) {
            bool skyVisible = false;
            const int grid = 4;
            for (int gy = 0; gy < grid && !skyVisible; gy++) {
                for (int gx = 0; gx < grid; gx++) {
                    vec2 uv = (vec2(gx, gy) + 0.5) / float(grid);
                    ivec2 sampleTexel = ivec2(uv * viewSize);
                    uint sampleMaterial = texelFetch(colortex7, sampleTexel, 0).y;
                    if (sampleMaterial == 0u) {
                        skyVisible = true;
                        break;
                    }
                }
            }

            float currentTime = frameTimeCounter;
            float lastTime = global.lastSkyTime;
            float alpha = global.compensationAlpha;

            // 夜晚关闭补偿：太阳在地平线下时 worldSunDir.y < 0，强制 alpha = 0
            float isNight = step(0.0, -worldSunDir.y);
            if (isNight > 0.5) {
                alpha = 0.0;
            } else {
                if (skyVisible) {
                    lastTime = currentTime;
                    alpha = clamp(alpha + COMPENSATION_FADE_SPEED * frameTime, 0.0, 1.0);
                } else {
                    if (currentTime - lastTime > COMPENSATION_DELAY) {
                        alpha = clamp(alpha - COMPENSATION_FADE_SPEED * frameTime, 0.0, 1.0);
                    }
                }
            }

            global.compensationAlpha = alpha;
            global.lastSkyTime = lastTime;
        }

        compensationAlpha = global.compensationAlpha;
        activeMinAmbient = MINIMUM_AMBIENT_BRIGHTNESS + COMPENSATION_BOOST * compensationAlpha;
    #endif

    // 环境光累积
    vec3 ambientAccum = vec3((worldNormal.y * 0.4 + 0.6) * max(activeMinAmbient, 5e-3 * nightVision));
    // [2026-08-20 修复"傍晚背光侧方块底面冒光"] 朝下面几乎不收无向最小环境底光：
    // 原式对底面(worldNormal.y≈-1)仍给 0.2×activeMinAmbient 灰白底，傍晚再被夕阳 tint
    // 染成暖橙，在暗的背光侧异常扎眼。法线 y<0 时把这份底光渐进去除（一 0→-0.15 过渡），
    // 顶/侧/水平面保持原状，不碰夜视窄差底光。
    ambientAccum *= mix(1.0, 0.0, smoothstep(0.0, -0.15, worldNormal.y));

    // [2026-08-18 网格边缘过渡] 网格外环境光平滑过渡进网格内几格：
    // 新方块进入 64³ 范围时，从"网格外 SH 环境光"瞬间切到"网格内 GI"，
    // 且 GI 是新暴露种子（暗）→ 边缘暗→亮的跳变（用户实测）。在网格内
    // 边缘 VOXEL_EDGE_BLEND_DISTANCE 格内，按到网格表面的距离渐进混入
    // 网格外的 SH 环境光（与非光追同款），外部光→内部 GI 平滑过渡。
    // voxelEdgeBlend：1=紧贴网格表面（全 SH 混合），0=深入网格
    // VOXEL_EDGE_BLEND_DISTANCE 格后（纯 GI，SH 完全淡出，不干扰内部方向性天光）。
    // [FIX 2026-08-18 关光追无环境光] 默认值必须是 1.0：关闭 VOXEL_GI_ENABLED
    // 时走到 #else（ambientInVoxelGrid=false），SH 环境光乘 voxelEdgeBlend——
    // 若默认 0 会把 SH 全乘 0 → 整个世界没环境光（用户实测）。
    // VOXEL_GI_ENABLED 开启时由下方分支按网格内外覆盖为正确值。
    float voxelEdgeBlend = 1.0;

    // 体素 GI 开启时：网格内由光追天光（skyMapTex 方向辐射）提供环境光，
    // 屏蔽原版 SH 平涂天光，避免方向性天光被环境光盖掉；体素外仍走非光追样式。
    #ifdef VOXEL_GI_ENABLED
        vec3 ambientVoxelCoord = camRelPos + cameraPositionFract + float(VOXEL_RADIUS);
        bool ambientInVoxelGrid = all(greaterThanEqual(ambientVoxelCoord, vec3(0.0)))
                               && all(lessThan(ambientVoxelCoord, vec3(float(VOXEL_AREA))));
        // 网格内完全交给 GI（含最小环境光底）：否则平铺底光会把
        // 窗口逸散/遮挡 AO 的梯度盖成“死板固定亮度”（用户实测反馈）。
        // 仅保留夜视底光，避免夜视失效。
        // [2026-08-18] 最小环境光由 MINIMUM_AMBIENT_BRIGHTNESS 宏统一控制
        // （activeMinAmbient，法线权重与夜视同初始值），不再用 skyColor×lightmap
        // 硬编码保底——后者会绕过玩家滑条且与 GI 平涂冲突。
        if (ambientInVoxelGrid) {
            // [2026-08-19 光追模式网格内屏蔽原版环境光] 主世界/末地：环境光交给光追 GI(voxelGI)，
            // 屏蔽 activeMinAmbient 最小环境底（原版光照，与 GI 重复/污染），仅留夜视底。
            // [2026-08-20 下界网格内保底] 下界无天空（worldId==-1 屏蔽 GI 天光），GI 只有
            // 方块光/发光体——离光源稍远处网格内会黑死。下界网格内保留 MINIMUM_AMBIENT_BRIGHTNESS
            // 最暗保底（activeMinAmbient 在此维度已不含 compensation），与网格外一致。
            #ifdef DIMENSION_NETHER
                ambientAccum = vec3((worldNormal.y * 0.4 + 0.6) * max(activeMinAmbient, 5e-3 * nightVision));
            #else
                float nightVisionFloor = 5e-3 * nightVision;
                ambientAccum = vec3((worldNormal.y * 0.4 + 0.6)) * nightVisionFloor;
            #endif
        } else {
            // 网格外：光追范围外无 GI 数据，MINIMUM_AMBIENT_BRIGHTNESS 作为全局最暗保底，
            // 不随 lightmap 门控被压灭。此前主世界网格外洞穴/无光处 lightmap.y≈0 时，
            // smoothstep 把底光乘成 0，调大 MINIMUM_AMBIENT_BRIGHTNESS 看似无效（8/20）。
            // 天空 SH 平涂的洞穴漏光仍由下方 SH 块自身的 lightmap.y 门控拦截，此处只保
            // 底光；默认保底极小（0.05×AMBIENT_BRIGHTNESS_MULTIPLIER），不会大面积点亮。
        }
        // 网格内边缘的过渡权重（网格外恒 1.0 全 SH）
        if (ambientInVoxelGrid) {
            vec3 edgeDist = min(ambientVoxelCoord, vec3(float(VOXEL_AREA)) - ambientVoxelCoord);
            float minEdgeDist = min(min(edgeDist.x, edgeDist.y), edgeDist.z);
            // [2026-08-19 夜晚亮暗生硬] 线性渐隐在"网格外 SH(亮) ↔ 网格内 GI(暗)"落差大时仍显硬切，
        // 改 smoothstep 平滑淡出（两端更缓）。仍硬就把 VOXEL_EDGE_BLEND_DISTANCE 调大。
        voxelEdgeBlend = 1.0 - smoothstep(0.0, VOXEL_EDGE_BLEND_DISTANCE, minEdgeDist);
        } else {
            voxelEdgeBlend = 1.0;
        }
    #else
        bool ambientInVoxelGrid = false;
    #endif

    #ifndef SSILVB_ENABLED
        // [2026-08-18] 抛弃"网格内 SH 阴影补足"：SH 平涂与 GI 方向天光双重计数，
        // 方块表面出现 z-fighting 感（用户实测）。网格内天光完全交给 GI（出界射线
        // 注入 IRC + 自反弹传播），SH 只在网格外按非光追样式渲染。最小环境光底
        // （ambientAccum 的 skyColor×lightmap 项）保留作安全网；IRC alpha 曝光
        // 计算保留但不消费（供后续天光方案复用）。
        // [2026-08-18] 边缘过渡：ambientInVoxelGrid 内的边缘区域（voxelEdgeBlend>0）
        // 也混入网格外同款 SH 环境光，权重随边缘距离渐隐——新方块进网格不再暗→亮跳变。
        if (lightmap.y > EPS && (!ambientInVoxelGrid || voxelEdgeBlend > 0.0)) {
            float lm3 = cube(lightmap.y);
            ambientAccum += ConvolvedReconstructSH3(global.skySH, worldNormal) * lm3 * voxelEdgeBlend;
            ambientAccum += CalculateFakeBouncedLight(worldNormal) * lm3 * (lightmap.y * lightmap.y) * sunlightBase * voxelEdgeBlend;
        }
    #endif

    // ---------- 末地夜晚环境光调整（淡紫色、更暗）----------
    #ifdef DIMENSION_THE_END
        const vec3 nightAmbientTint = vec3(0.65, 0.45, 0.70);
        const float nightAmbientScale = 0.25;
        ambientAccum *= nightAmbientTint * nightAmbientScale;
    #endif

    vec3 finalAo = ao;
    #ifdef COMPENSATION_ENABLED
        float localDarkness = 1.0 - saturate(lightmap.y * 5.0);
        float aoEnhanceWeight = compensationAlpha * localDarkness;
        finalAo = pow(finalAo, vec3(1.0 + COMPENSATION_AO_BOOST * aoEnhanceWeight));
    #endif

    // ---- 动态阳光色调混合（仅非末地维度） ----
    #ifndef DIMENSION_THE_END
        float timeBasedTint = saturate(worldSunDir.y * 2.5 - 0.15);
        float tintStrength = AMBIENT_SUNLIGHT_TINT_RATIO * timeBasedTint;
        if (tintStrength > 0.0) {
            vec3 sunColorTint = global.directIlluminance / max(luminance(global.directIlluminance), EPS);
            ambientAccum = mix(ambientAccum, ambientAccum * sunColorTint, tintStrength);
        }
    #endif

    // 应用环境光亮度与颜色控制（还原旧版：完整 AO，无 mix 门控，无额外 skySH 叠加）
    sceneOut += ambientAccum * finalAo * AMBIENT_BRIGHTNESS_MULTIPLIER * AMBIENT_COLOR_TINT;

    // ====== Emissive & Blocklight ======
    #if EMISSIVE_MODE > 0 && defined MC_SPECULAR_MAP
        sceneOut += material.emissiveness * dot(albedo, vec3(0.75));
    #endif
    #if EMISSIVE_MODE < 2
        // [2026-08-09] 自发光基色与玩家方块光颜色解耦：blocklightColor 在光追开启时
        // 被置 0（屏蔽原版方块光），但发光方块自身的表面自发光（萤石/菌光体/火把等）
        // 必须保留——用默认白 × 亮度作基色，不受玩家红绿蓝设置影响。
        vec3 emissiveBaseColor = blocklightColor;
        #ifdef VOXEL_GI_ENABLED
            emissiveBaseColor = vec3(1.0) * BLOCKLIGHT_BRIGHTNESS;
        #endif
        vec4 emissive = HardCodeEmissive(materialID, albedo, worldPos, emissiveBaseColor);
        #ifndef SSILVB_ENABLED
            if (emissive.a * lightmap.x > EPS) {
                lightmap.x = CalculateBlocklightFalloff(lightmap.x);
                // 体素 GI 开启时：仅在网格内按 VOXEL_GI_BLENDED_LIGHTMAP 屏蔽/混合原版方块光。
                // 网格外无 GI 数据，原版方块光必须全量保留（否则 VOXEL_GI_BLENDED_LIGHTMAP=0
                // 会把网格外方块光一起灭掉 → "网格外连方块光都没有"）。
                #ifdef VOXEL_GI_ENABLED
                    if (blocklightInVoxelGrid) lightmap.x *= VOXEL_GI_BLENDED_LIGHTMAP;
                #endif
                if (lightmap.x > EPS) {
                    sceneOut += lightmap.x * emissive.a * mix(finalAo, vec3(1.0), lightmap.x) * activeBlocklightColor;
                }
            }
        #endif
        sceneOut += emissive.rgb * EMISSIVE_BRIGHTNESS;
    #elif !defined SSILVB_ENABLED
        lightmap.x = CalculateBlocklightFalloff(lightmap.x);
        // 仅在网格内屏蔽/混合原版方块光；网格外全量保留（同上方 EMISSIVE_MODE<2 分支）
        #ifdef VOXEL_GI_ENABLED
            if (blocklightInVoxelGrid) lightmap.x *= VOXEL_GI_BLENDED_LIGHTMAP;
        #endif
        sceneOut += lightmap.x * mix(finalAo, vec3(1.0), lightmap.x) * activeBlocklightColor;
    #endif

    #ifdef HANDHELD_LIGHTING
        if (heldBlockLightValue + heldBlockLightValue2 > EPS) {
            float attenuation = rcp(1.0 + worldDistSquared) * saturate(dot(worldNormal, -worldDir));
            // 手持光源（玩家手上光源）在所有维度/网格内外都生效，不受原版方块光屏蔽影响：
            // blocklightColor 在光追开启时被置 0（屏蔽原版方块光光晕），手持光需独立取
            // 玩家设置的方块光颜色，否则连手持灯一起熄灭（2026-08-20）。
            vec3 heldLightColor = vec3(BLOCKLIGHT_COLOR_R, BLOCKLIGHT_COLOR_G, BLOCKLIGHT_COLOR_B) * BLOCKLIGHT_BRIGHTNESS;
            sceneOut += max(heldBlockLightValue, heldBlockLightValue2) * HELD_LIGHT_BRIGHTNESS * attenuation * heldLightColor;
        }
    #endif

    sceneOut += LightningContribution(worldPos, worldNormal);

    #ifdef SSILVB_ENABLED
        #ifndef VOXEL_GI_ENABLED  // 与体素 GI 互斥（体素优先）：两者共用 colortex3 信号源，避免重复叠加
            #ifdef SVGF_ENABLED
                vec3 radiance = UpscaleDiffuseIndirect(texelPos, worldNormal, length(viewPos), abs(dot(worldNormal, worldDir)));
            #else
                vec3 radiance = texelFetch(colortex3, texelPos >> 1, 0).rgb;
            #endif
            sceneOut += YCoCgToRGB(radiance);
        #endif
    #endif

    // Final composition
        // ====== 反射获取 ======
    vec4 reflection = vec4(0.0, 0.0, 0.0, FP16_MAX);
    bool isReflective = (material.metalness >= 0.5 || materialID == 10050u);
    bool reflectHit = false;
    if (isReflective) {
        reflection = CalculateSpecularReflections(material, materialID, worldNormal, screenPos, worldDir, viewPos, lightmap.y, dither);
        reflectHit = (reflection.a < FP16_MAX && any(greaterThan(reflection.rgb, vec3(0.0))));
    }

    // ====== 最终合成 ======
    if (reflectHit) {
        // 反射命中：反射与金属自身纹理混合，避免反射完全屏蔽纹理
        // sceneOut 已包含环境光/发光等累积，乘 albedo 即为带光照的纹理底色
        sceneOut = mix(sceneOut * albedo, reflection.rgb, REFLECTION_METAL_MIX);
    } else {
        // 反射未命中或非反射块：标准光照
        // 若为金属但无反射，当作非金属着色，使其获得正常漫反射亮度
        if (material.metalness >= 0.5) {
            material.metalness = 0.0;          // 强制转为非金属
            specularDirect = vec3(0.0);        // 去掉金属高光
        }
        sceneOut *= albedo;
        material.metalness *= 0.2 * lightmap.y + 0.8;
        sceneOut *= oms(material.metalness);
        sceneOut += specularDirect;
        
        // 体素 GI（彩色光源）
        #ifdef VOXEL_GI_ENABLED
            #ifdef DEBUG_VOXEL_RADIANCE
            // 单点诊断：整屏显示"玩家所在体素"（网格坐标恒为 VOXEL_RADIUS）的传播缓存，
            // 逐帧演化 = 时间混合/衰减的直观读数（只回答"缓存是否在衰减"这一个问题）。
            // R = 传播缓存（×100 原始值 ×0.5：nRC≈0.08 → 4 饱和红；≈0.004 → 0.2 暗红）
            // B = 天空曝光度 alpha（0-1，光追自算；蓝调越亮 = 该格可见天空程度越高）
            // 注意：查询坐标系 = 相机相对 + VOXEL_RADIUS（与体素化端一致）。
            // 本函数的 worldPos 在 L215 已被改成绝对坐标，此处不能用；
            // 玩家相机自身在网格中的坐标恒为 VOXEL_RADIUS，直接查询即可。
            // 增益 0.15（原 0.5 过早饱和，nRC≥0.02 就纯红，看不出变暗幅度）：
            // nRC≈0.08 → rad.r*0.15≈1.2 近饱和红；≈0.02 → 0.3 暗红；≈0.005 → 0.075 接近黑。
            // 判断标准：小幅抖动=IRC 随机噪声（正常）；持续跌到接近黑=系统性衰减（bug）。
            vec4 rad = FetchVoxelRadiance(ivec3(VOXEL_RADIUS));
            sceneOut = vec3(rad.r * 0.15, 0.0, rad.a * 0.6);
        #else
                // 主 GI = 每像素漫反射追踪（阶段④：追踪输出，IRC 仅作内部数据——
                // 注入循环 + 追踪命中自反弹种子）。
                // 追踪已迁到 DiffuseIndirect.comp：棋盘半分辨率每帧 1 SPP（1/4 像素），
                // 经 SVGF 时域累积 + 边缘保持滤波后在此读回；此处补乘 albedo×强度，
                // 与旧全分辨率路径（VoxelTracePixel × albedo × STRENGTH）视觉语义一致。
                vec3 voxelGI = vec3(0.0);
                #ifdef VOXEL_GI_ENABLED
                    #ifdef VOXEL_GI_DENOISE
                        #ifdef SVGF_ENABLED
                            // UpscaleDiffuseIndirect 返回 YCoCg 空间信号（colortex3 全链路 YCoCg），须显式转回 RGB
                            voxelGI = YCoCgToRGB(UpscaleDiffuseIndirect(texelPos, worldNormal, length(viewPos), abs(dot(worldNormal, worldDir))));
                        #else
                            voxelGI = YCoCgToRGB(texelFetch(colortex3, texelPos >> 1, 0).rgb);
                        #endif
                    #else
                        // 光追降噪关闭：直接读 colortex3 半分辨率棋盘信号（未降噪）
                        voxelGI = YCoCgToRGB(texelFetch(colortex3, texelPos >> 1, 0).rgb);
                    #endif
                    voxelGI *= albedo * VOXEL_GI_TRACE_STRENGTH;
                #endif
                #ifdef DEBUG_VOXEL_GI
                    // [2026-08-19] 调试：按像素所在体素直读 voxelID，定位"目标方块有没有进体素 + ID 对不对 + 在不在正确格"。
                    // 青绿 = 活板门(201/205)/门(155-158) 已体素化；橙 = 其他形状块(155-294) 已体素化；
                    // 黄 = 非形状固体(1-154，全块/发光/反光/水玻璃叶) 已体素化；蓝 = 该格无固体数据(<=0，空气/漏写)；
                    // 红 = 像素在 64³ 网格外。判读水平活板门：其表面应显青绿；显蓝(空)或黄(落成全块) = 没正确体素化(写端)。
                    sceneOut = sceneOut * 0.15;
                    // 沿表面几何法线向内偏移 0.05 格：采样点落在像素所在方块【内部】，而非
                    // 面边界（camRelPos 恰在格边界，ivec3 截断会在"自身格 / 邻接空气格"间
                    // 逐帧跳变 → 黄蓝疯狂闪烁）。偏移后稳定读到该方块自己的体素。
                    ivec3 dbgCoord = ivec3(camRelPos - geoNormal * 0.05 + cameraPositionFract + float(VOXEL_RADIUS));
                    if (all(greaterThanEqual(dbgCoord, ivec3(0))) && all(lessThan(dbgCoord, ivec3(VOXEL_AREA)))) {
                        float dbgVoxelID = texelFetch(voxelDataSampler, dbgCoord, 0).z;
                        if (dbgVoxelID >= 155.0 && dbgVoxelID <= 294.0) {
                            bool doorOrTrapdoor = (dbgVoxelID >= 155.0 && dbgVoxelID <= 158.0)
                                               || dbgVoxelID == 201.0 || dbgVoxelID == 205.0;
                            sceneOut = doorOrTrapdoor ? vec3(0.0, 1.0, 0.5) : vec3(1.0, 0.6, 0.0);
                        } else if (dbgVoxelID > 0.5) {
                            sceneOut = vec3(1.0, 1.0, 0.0);
                        } else {
                            sceneOut = vec3(0.0, 0.4, 1.0);
                        }
                    } else {
                        sceneOut = vec3(1.0, 0.0, 0.0);       // 红：dbgCoord 越界
                    }
                #else
                    sceneOut += voxelGI;
                    #ifdef DEBUG_VOXEL_SKY
                    // [2026-08-17] 左上角 64×64 灰阶读数：本像素 voxelGI 亮度（×4 放大，8 级量化）
                    if (all(lessThan(gl_FragCoord.xy, vec2(64.0)))) {
                        float luma = clamp(dot(voxelGI, vec3(0.299, 0.587, 0.114)) * 4.0, 0.0, 1.0);
                        sceneOut = vec3(floor(luma * 7.999) / 7.0);
                    }
                    #endif
                    #ifdef DEBUG_VOXEL_SKY_LEVEL
                    // [2026-08-18] 方块表面标记有 GI 天光的体素：IRC 天空曝光度
                    // （voxelRadiance alpha，0-1 = 出界射线占比，即天光可见度）超过
                    // 阈值 → 染红；无天光（洞穴/闭塞）→ 保持正常场景不覆盖。
                    // 阈值 0.1 = 只要有少量射线见天（曝光度>10%）即算有天光 → 红。
                    // 0.5 太高：普通方块(ID==1)注入走全方向采样，向上出界占比常
                    // 收敛在 0.2-0.4，会被误判为"无天光"（用户实测大部分位置不红）。
                    ivec3 dbgSkyCoord = ivec3(camRelPos + cameraPositionFract + float(VOXEL_RADIUS));
                    if (all(greaterThanEqual(dbgSkyCoord, ivec3(0))) && all(lessThan(dbgSkyCoord, ivec3(VOXEL_AREA)))) {
                        // 移动时按 cDi 重投影到上一帧缓存位置（与注入端 prevC=c+cDi 同口径），
                        // 避免红块随移动以格为单位偏移（用户实测）。
                        ivec3 dbgPrev = dbgSkyCoord + (cameraPositionInt - previousCameraPositionInt);
                        float skyLevel = (all(greaterThanEqual(dbgPrev, ivec3(0))) && all(lessThan(dbgPrev, ivec3(VOXEL_AREA))))
                                       ? FetchVoxelRadiance(dbgPrev).a : 0.0;   // 0-1 曝光，非 ×100 域
                        if (skyLevel > 0.1)
                            sceneOut = vec3(1.0, 0.0, 0.0);                  // 有天光 → 红
                    } else {
                        sceneOut = vec3(1.0, 1.0, 1.0);                      // 网格外白色提示
                    }
                    #endif
                #endif
            #endif
        #else
            // 体素 GI 未启用（VOXEL_GI_ENABLED 宏未注入本编译单元）：DEBUG 时品红提示
            #ifdef DEBUG_VOXEL_GI
                sceneOut = vec3(1.0, 0.0, 1.0);
            #endif
        #endif
    }
    
}
