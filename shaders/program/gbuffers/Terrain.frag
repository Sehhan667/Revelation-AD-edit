//#version 430 compatibility
/*
--------------------------------------------------------------------------------
    Revelation Shaders
    Copyright (C) 2026 HaringPro
    Apache License 2.0

    Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Modified by AnotherCream, 2026.





    Performance Optimized: reduced redundant computations, early exits,
                           combined conditionals, minor math simplifications.
    Fix: Clear low 2 bits of materialOut.w to avoid entity flag conflicts.
    Feature: Voxel Mapping Integration
--------------------------------------------------------------------------------

*/
// 视差映射最大距离（米），超出此距离视差完全失效
#define PARALLAX_MAX_DISTANCE 64  // [2 4 6 8 16 32 64 128 256 512 1024 2048]

// 视差映射淡化距离（米）：内圈（FADE_END）满强度，外圈（FADE_START）淡到 0
#define PARALLAX_FADE_START 64  // [2 4 6 8 16 32 64 128 256 512 1024 2048]
#define PARALLAX_FADE_END   32  // [2 4 6 8 16 32 64 128 256 512 1024 2048]
// [2026-10-06 视差阴影可视距离] 满强度半径 16->32 m、淡出终点 32->64 m，MAX_DISTANCE 同步 64。
// 为什么原来"看不到"：视差自阴影只乘直射阳光，且两者共用同一条 fade —— fade 归零时射线横向
// 步长也归零，只剩 z 方向爬升，必定判定无遮挡。所以 32 m 外结构上不可能有自阴影，
// 16 m 内才满强度更是等于"开了也白开"。
// 取 64/32 不是拍脑袋：这正是本文件 #else 兜底（smoothstep(64.0, 32.0, d)）与上游 Revelation
// 的等价范围，即"没有这些旋钮时本该有的行为"；旧值 32/16 是本 fork 后来收紧的一半。
// 代价：参与视差的像素面积约 4 倍（视差是可选功能、默认关，只影响主动开视差的人）。
// 想省性能：把这三项一起调回 MAX_DISTANCE/FADE_START=32、FADE_END=16。
// 另一个坑（只影响深度写入档）：FADE_START > PARALLAX_MAX_DISTANCE 时，fade 还没归零就先被
// doParallax=false 掐断，深度会在 MAX_DISTANCE 处硬切 —— 保持 FADE_START <= MAX_DISTANCE（现在 64/64 齐平）。

// 方块法线/高光贴图裁剪最大距离（米）
#define BLOCK_TEXTURE_CULL_DISTANCE 64  // [2 4 6 8 16 32 64 128 256 512 1024 2048]

// === Voxel Settings ===
// ENABLE_VOXELIZATION 和 VISUALIZE_VOXELS 由 shaders.properties 注入，此处不再重复定义
#define VOXEL_AREA 64     // [32 64 128]
#define VOXEL_RADIUS (VOXEL_AREA/2)

#include "/lib/Utility.glsl"

/* RENDERTARGETS: 6,7,8 */
layout (location = 0) out vec4 albedoOut;
layout (location = 1) out uvec4 materialOut;
layout (location = 2) out vec4 normalOut;

// [2026-10-06 视差阴影接线] 声明了 location 3 就必须把 colortex0 也列进 RENDERTARGETS：
// 只有 6,7,8 三个目标时，第 4 个输出没有 draw buffer，写出去的值落不到 deferred 读的位置
// （DeferredLight.frag 的 shadow *= 1 - colortex0.x）。这不是本包独有写法：上游修同一问题时
// （commit 9cd3edca Fix parallax shadow issue when disable PARALLAX_DEPTH_WRITE）加的就是这一行。
#if defined PARALLAX && defined PARALLAX_SHADOW && !defined PARALLAX_DEPTH_WRITE
/* RENDERTARGETS: 6,7,8,0 */
layout (location = 3) out float parallaxShadowOut;
#endif

flat in uint normalPack;
#if defined MC_NORMAL_MAP
flat in uvec2 tangentPack;
#endif

in vec3 vertColor;
in vec2 texCoord;
in vec2 lightmap;
flat in uint materialID;

#if defined PARALLAX || defined AUTO_GENERATED_NORMAL
    in vec2 tileBase;
    flat in vec2 tileScale;
    flat in vec2 tileOffset;
#endif

// --- Voxel Inputs ---
in vec3 block_centered_relative_pos;
uniform sampler3D voxelDataSampler;  // 可视化读取体素数据（atlas 引用格式，RGBA16，shadow pass 写入）
// 无显式 binding：gbuffers 的 image 与方块图集等普通贴图共用同一套硬件纹理单元，
// 显式 binding 会覆盖 Iris 的运行时分配，导致 imageAtomicMax 写到错误单元（全黑根因）。
// ：由 shaders.properties 的 image.<name> = <samplerName> 按名字自动绑定。
// 注意：非 writeonly 的 image 变量强制要求格式限定符（r32ui / rgba16）。

uniform sampler2D tex;
#if defined MC_NORMAL_MAP
    uniform sampler2D normals;
#endif
#if defined MC_SPECULAR_MAP
    uniform sampler2D specular;
#endif
#include "/lib/universal/Uniform.glsl"
#include "/lib/universal/Random.glsl"
#include "/lib/universal/Transform.glsl"

#ifdef PARALLAX
    #include "/lib/surface/Parallax.glsl"
#endif

void main() {
    vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;
    float dither = BlueNoise(ivec2(gl_FragCoord.xy), frameCounter);

    // [2026-10-06 视差阴影接线] 一开始就写 0（= 无自阴影），只让真正算了视差的像素覆盖它。
    // 必须「先清后写」而不是像 Block/Textured 那样在末尾写 0：Terrain 的自阴影在中间算出来，
    // 末尾再写 0 会把它抹掉。也不能指望不写 —— colortex0 每帧不清（config.glsl
    // colortex0Clear = false），未写入的像素会留着上一帧最终画面的红通道，
    // DeferredLight.frag 的 shadow *= 1 - colortex0.x 就会按上一帧亮度压掉直射阳光。
    #if defined PARALLAX && defined PARALLAX_SHADOW && !defined PARALLAX_DEPTH_WRITE
        parallaxShadowOut = 0.0;
    #endif

    vec2 packedGeo = unpackSnorm2x16(normalPack);
    vec2 packedNormal = packedGeo;          // 默认输出几何法线

    float distSq;
    bool skipNormalSpecular = true;

    #if defined MC_NORMAL_MAP || defined MC_SPECULAR_MAP || defined PARALLAX
        vec3 viewPos = ScreenToViewPos(vec3(screenCoord, gl_FragCoord.z));
        distSq = dot(viewPos, viewPos);
        skipNormalSpecular = distSq > (BLOCK_TEXTURE_CULL_DISTANCE * BLOCK_TEXTURE_CULL_DISTANCE);
    #endif

    // [2026-10-06 视差深度写入 × 方块PBR剔除] 这一档下强制不剔除（BLOCK_TEXTURE_CULL_DISTANCE 失效）。
    // 为什么：深度写入把视差位移后的高度写进深度缓冲，下游（SSAO/GTAO、SSR、GI 重建、阴影、DOF）
    // 都按这张深度判几何。而剔除是一条**硬边界**：边界外深度停在几何面、边界内被位移，
    // 同时法线（L210）与 PBR 材质（L257）也从贴图值切成几何值 —— 同一平面上出现台阶与材质突变。
    // 视差范围（PARALLAX_MAX_DISTANCE / fade）本来是渐变的，剔除却在其中插一条硬线，
    // 范围调得比剔除距离大时深度会直接硬切。故此处让两者不再互相打架。
    // 选项仍留在 GUI（关掉视差或深度写入即恢复生效）；本块只在两个开关同时打开时参与编译。
    #if defined PARALLAX && defined PARALLAX_DEPTH_WRITE
        skipNormalSpecular = false;
    #endif

    vec4 albedo;

    #ifdef PARALLAX
        vec2 parallaxCoord = texCoord;
        mat2 texGrad; // 提前声明：剔除命中的远距离分支不赋值也不使用；深度写入档下剔除被强制关掉，这里总会赋值

        if (skipNormalSpecular) {
            // 远距离：跳过导数，普通采样
            albedo = texture(tex, texCoord);
            if (albedo.a < 0.1) { discard; return; }
        } else {
            // 近距离：计算导数与 TBN
            texGrad = mat2(dFdx(texCoord), dFdy(texCoord));

            #if defined MC_NORMAL_MAP
                vec3 tangent   = OctDecodeSnorm(unpackSnorm2x16(tangentPack.x));
                vec3 normal    = OctDecodeSnorm(packedGeo);
                vec3 bitangent = cross(tangent, normal) * uintBitsToFloat(tangentPack.y);
                mat3 tbnMatrix = mat3(tangent, bitangent, normal);
            #endif

            vec4 normalTex = textureGrad(normals, parallaxCoord, texGrad[0], texGrad[1]);

            #ifdef PARALLAX_DEPTH_WRITE
                gl_FragDepth = gl_FragCoord.z;
            #endif

            if (normalTex.w < (1.0 - rcp255)) {
                bool doParallax = true;
                #ifdef PARALLAX_MAX_DISTANCE
                    if (distSq > PARALLAX_MAX_DISTANCE * PARALLAX_MAX_DISTANCE) doParallax = false;
                #endif

                if (doParallax) {
                    float tangentLength = sqrt(distSq);
                    #if defined(PARALLAX_FADE_START) && defined(PARALLAX_FADE_END)
                        float parallaxFade = clamp((PARALLAX_FADE_START - tangentLength) / (PARALLAX_FADE_START - PARALLAX_FADE_END), 0.0, 1.0);
                    #else
                        float parallaxFade = smoothstep(64.0, 32.0, tangentLength);
                    #endif

                    vec3 tangentPos = mat3(gbufferModelViewInverse) * viewPos * tbnMatrix;
                    vec3 offsetCoord = CalculateParallax(tangentPos / tangentLength, dither, parallaxFade);
                    parallaxCoord = atlasCoord(offsetCoord.xy);

                    normalTex = textureGrad(normals, parallaxCoord, texGrad[0], texGrad[1]);
                    DecodeNormalTex(normalTex.xyz);

                    if (offsetCoord.z < (1.0 - rcp255) && parallaxFade > EPS) {
                        #ifdef PARALLAX_DEPTH_WRITE
                            gl_FragDepth = ViewToScreenDepth(ScreenToViewDepth(gl_FragDepth) - oms(offsetCoord.z) * PARALLAX_DEPTH);
                        #elif defined PARALLAX_SHADOW
                            if (dot(tbnMatrix[2], worldLightDir) > 1e-3) {
                                parallaxShadowOut = CalculateParallaxShadow(worldLightDir * tbnMatrix, offsetCoord, dither, parallaxFade);
                            }
                        #endif
                        #ifdef PARALLAX_BASED_NORMAL
                            #define sampleHeight(uv) textureGrad(normals, atlasCoord(uv), texGrad[0], texGrad[1]).w
                            vec2 bias = 1e-2 / (tileScale * vec2(atlasSize));
                            float heightR = sampleHeight(offsetCoord.xy + vec2(bias.x, 0.0));
                            float heightL = sampleHeight(offsetCoord.xy - vec2(bias.x, 0.0));
                            float heightU = sampleHeight(offsetCoord.xy + vec2(0.0, bias.y));
                            float heightD = sampleHeight(offsetCoord.xy - vec2(0.0, bias.y));
                            float deltaX = heightL - heightR;
                            float deltaY = heightD - heightU;
                            normalTex.xyz = normalize(vec3(deltaX, deltaY, step(abs(deltaX) + abs(deltaY), 1e-3)));
                        #endif
                    }
                } else {
                    DecodeNormalTex(normalTex.xyz);
                }
            } else {
                DecodeNormalTex(normalTex.xyz);
            }

            packedNormal = OctEncodeSnorm(tbnMatrix * normalTex.xyz);

            albedo = textureGrad(tex, parallaxCoord, texGrad[0], texGrad[1]);
            if (albedo.a < 0.1) { discard; return; }
        }

    #else   // ---- 非视差分支 ----
        albedo = texture(tex, texCoord);
        if (albedo.a < 0.1) { discard; return; }

        if (!skipNormalSpecular) {
            #if defined MC_NORMAL_MAP
                vec3 tangent   = OctDecodeSnorm(unpackSnorm2x16(tangentPack.x));
                vec3 normal    = OctDecodeSnorm(packedGeo);
                vec3 bitangent = cross(tangent, normal) * uintBitsToFloat(tangentPack.y);
                mat3 tbnMatrix = mat3(tangent, bitangent, normal);

                vec3 normalTex = texture(normals, texCoord).xyz;
                DecodeNormalTex(normalTex);
                packedNormal = OctEncodeSnorm(tbnMatrix * normalTex);
            #endif
        }
    #endif

    // --- Voxel Visualization Injection ---
    // 嵌套单独 #ifdef（Iris 选项扫描只识别单独的 `#ifdef X`，不能用 `#if defined A && defined B`
    // 复合条件——会跳过整行导致 VISUALIZE_VOXELS 与 ENABLE_VOXELIZATION 两个开关都消失）
    #ifdef VISUALIZE_VOXELS
        #ifdef ENABLE_VOXELIZATION
        {
            // 读取体素数据（atlas 引用格式，RGBA16）并按相机位移重投影。
            // 数据为本帧（gbuffers 边写边读，边缘可能闪烁；调试功能，默认关闭）
            ivec3 voxVisCoord = ivec3(block_centered_relative_pos);
            ivec3 voxVisPrev = voxVisCoord + (cameraPositionInt - previousCameraPositionInt);
            if (all(greaterThanEqual(voxVisPrev, ivec3(0))) && all(lessThan(voxVisPrev, ivec3(VOXEL_AREA)))) {
                vec4 voxVisData = texelFetch(voxelDataSampler, voxVisPrev, 0);
                if (voxVisData.z > 0.5) {
                    albedo.rgb = texture(tex, voxVisData.xy).rgb;  // 图集 UV 中心采样（与 gbuffers 同图集）
                }
            }
        }
        #endif
    #endif

    // Iris 布尔开关引用锚（无实际作用，仅供 Iris 把 VOXEL_GI_DENOISE 识别为 GUI 布尔选项）。
    // 必须单独一行 #ifdef（不能写进复合条件），否则该开关在 GUI 消失/空格子。
    #ifdef VOXEL_GI_DENOISE
    #endif

    // ---- 输出 GBuffer ----
    albedoOut = vec4(albedo.rgb * vertColor, 1.0);
    #ifdef WHITE_WORLD
        albedoOut = vec4(1.0);
    #endif

    uint matZ = 0u, matW = 0u;
    #if defined MC_SPECULAR_MAP
        if (!skipNormalSpecular) {
            #ifdef PARALLAX
                vec4 specularTex = textureGrad(specular, parallaxCoord, texGrad[0], texGrad[1]);
            #else
                vec4 specularTex = texture(specular, texCoord);
            #endif
            matZ = Packup2x8U(specularTex.xy);
            matW = Packup2x8U(specularTex.zw);
        }
    #endif

    materialOut = uvec4(PackupDithered2x8U(lightmap, dither), materialID, matZ, matW);
    materialOut.w &= 0xFCu;

    normalOut = vec4(packedGeo, packedNormal);
}