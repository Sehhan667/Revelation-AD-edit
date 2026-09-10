/*
--------------------------------------------------------------------------------
    Revelation Shaders
    - 次表面散射（SSS）模型 -

    2026-09 重构。旧实现的三个问题：
      1) 与屏幕空间阴影强耦合：sss *= pow(mean(rawShadow), SSS_CONTRAST_POW) 只在
         受光面叠加，且植物类材质还被 contactShadow 以 75% 权重调制 → 低采样屏幕
         空间阴影的条带会直接出现在草/藤的 SSS 上；反过来 sssAmount 又被当作
         ScreenSpaceShadow 的步进吸收系数（反向耦合）。
      2) 没有厚度：衰减项用的是 PCSS 的 blockerDepth，而它在 PCF 模式下恒为 0
         → exp2(-rLOG2 * 0 * ...) = 1，厚度完全不起作用。
      3) 只有直射太阳，没有天光/环境项 → 阴影里/室内完全没有 SSS。

    本模型给出「沿视线看到的次表面散射辐射亮度」，由三项组成：
      ① 正面扩散：包裹漫反射 × 体积衰减（厚材质：羊毛/冰/雪/水晶/史莱姆）
      ② 背光透光：Barré-Brisebois GDC 2011 的 distortion 近似（薄片：树叶/草/藤）
      ③ 天光/环境：环境辐照 × 体积衰减（阴影里也有，但更弱）

    体积衰减用 Beer-Lambert：T = exp(-σt · L)，σt = (σa·(1-β) + σs·β) / mfp，
    β = sqrt(albedo) 沿用原实现的「albedo → 散射系数」映射；路径长度 L 由材质厚度
    除以光线与法线夹角的余弦得到（斜射路径更长）。
    mfp（扩散平均自由程）来自 SUBSURFACE_SCATTERING_RADIUS —— 这个选项在旧实现里
    是死选项（全工程零引用），现在真正生效。

    第 2 步（屏幕空间扩散 pass）会把本函数的输出当作「去 albedo 的漫射源」送进
    半分辨率可分离模糊，所以这里返回的是源项而非最终颜色。
--------------------------------------------------------------------------------
*/

#ifndef SSS_SUBSURFACE_GLSL
#define SSS_SUBSURFACE_GLSL

// ===== 材质厚度（方块单位）=====
// 薄片：十字模型/树叶/藤蔓（一片）
const float SSS_THICKNESS_THIN = 0.06;
// 中等：羊毛/地毯/旗帜/床/干草/紫水晶/史莱姆
const float SSS_THICKNESS_MEDIUM = 0.25;
// 厚：冰/雪/蜂窝
const float SSS_THICKNESS_THICK = 0.80;

// 薄片判定：厚度小于该值才启用「背光透光」（distortion 近似）
const float SSS_THIN_CUTOFF = 0.16;

// 扩散平均自由程 = SUBSURFACE_SCATTERING_RADIUS × 该系数
const float SSS_MFP_SCALE = 4.0;

// 消光系数系数项：σt = (SSS_ABSORPTION·(1-β) + SSS_SCATTERING·β) / mfp
const float SSS_ABSORPTION = 2.0;
const float SSS_SCATTERING = 1.0;
// 出射增益：把散射系数折算成辐射亮度的量级系数（与旧实现亮度对齐）
const float SSS_EMISSION = 4.0;

// 包裹漫反射（0 = 纯 Lambert，0.5 = 明显包裹）
const float SSS_DIFFUSE_WRAP = 0.5;
// 光线斜射时投影余弦的下限（限制最大路径长度、避免除零）
const float SSS_MIN_COS = 0.25;
// 环境光等效路径倍率（各向同性光照的平均路径 ≈ 厚度的 1.6 倍）
const float SSS_AMBIENT_PATH = 1.6;
const float SSS_AMBIENT_WRAP = 0.8;

// 背光透光（distortion 近似）参数
const float SSS_TRANSMISSION_DISTORTION = 0.25;
const float SSS_TRANSMISSION_POWER = 4.0;
const float SSS_TRANSMISSION_SCALE = 1.0;
const float SSS_TRANSMISSION_AMBIENT = 0.05;

// 材质 id → 厚度。与 DeferredLight 里 sssAmount 的材质表一一对应
// （materialID = mc_Entity.x - 1e4，即 block.properties / entity.properties 的编号）。
float GetSubsurfaceThickness(in uint materialID) {
    switch (materialID) {
        case 13u:                                        // 树叶
        case 1000u: case 1001u: case 1002u: case 1003u:  // 草/植物/十字模型
        case 28u:                                        // 发光浆果藤（block.10028）
            return SSS_THICKNESS_THIN;
        case 37u:                                        // 羊毛/地毯/旗帜/床/干草
        case 39u: case 40u:                              // 旧版遗留材质
        case 27u:                                        // 紫水晶芽/簇（block.10027）
        case 51u:                                        // 史莱姆（entity.10051）
            return SSS_THICKNESS_MEDIUM;
        case 38u:                                        // 冰/雪/蜂窝
            return SSS_THICKNESS_THICK;
    }
    return 0.0;
}

// 背光可见性采样的偏移量：要跨过物体本身（薄片只有一片，偏移 0.5 方块即可越过）
float GetSubsurfaceBackSampleOffset(in uint materialID) {
    return GetSubsurfaceThickness(materialID) + 0.5;
}

// ① + ② + ③，返回已经乘过 sssAmount 的漫射源项（未乘 SUBSURFACE_SCATTERING_BRIGHTNESS）
vec3 CalculateSubsurfaceScattering(
    in uint materialID,
    in float sssAmount,
    in vec3 albedo,
    in vec3 worldNormal,
    in vec3 viewDir,            // 表面 → 相机
    in vec3 lightDir,           // 表面 → 光源
    in vec3 lightRadiance,      // 直射光辐照（含云影/月光/夜色）
    in float frontVisibility,   // 正面阴影可见性（不含接触阴影）
    in float backVisibility,    // 穿出物体后的可见性（仅薄片采样）
    in vec3 ambientIrradiance,  // 环境/天光辐照
    in float ambientOcclusion    // 环境项遮蔽（AO；直射项不受其影响）
) {
    if (sssAmount <= EPS) return vec3(0.0);

    float thickness = GetSubsurfaceThickness(materialID);
    if (thickness <= 0.0) return vec3(0.0);

    vec3 beta = sqrt(saturate(albedo));
    float mfp = max(SUBSURFACE_SCATTERING_RADIUS * SSS_MFP_SCALE, EPS);

    // 体积衰减：消光系数 × 路径长度
    vec3 sigmaT = (oms(beta) * SSS_ABSORPTION + beta * SSS_SCATTERING) / mfp;
    float cosSun = max(abs(dot(worldNormal, lightDir)), SSS_MIN_COS);
    vec3 sunTransmittance = exp2(-rLOG2 * sigmaT * (thickness / cosSun));
    vec3 ambientTransmittance = exp2(-rLOG2 * sigmaT * (thickness * SSS_AMBIENT_PATH));

    // ① 正面扩散
    float wrapDiffuse = saturate((dot(worldNormal, lightDir) + SSS_DIFFUSE_WRAP) * rcp(1.0 + SSS_DIFFUSE_WRAP));
    vec3 diffusion = lightRadiance * (wrapDiffuse * frontVisibility) * sunTransmittance;

    // ② 背光透光（只对薄片）
    vec3 transmission = vec3(0.0);
    if (SUBSURFACE_SCATTERING_TRANSMISSION > EPS && thickness < SSS_THIN_CUTOFF && backVisibility > EPS) {
        vec3 transDir = normalize(-lightDir + worldNormal * SSS_TRANSMISSION_DISTORTION);
        float backLight = pow(saturate(dot(viewDir, transDir)), SSS_TRANSMISSION_POWER) * SSS_TRANSMISSION_SCALE
                        + SSS_TRANSMISSION_AMBIENT;
        float thinness = 1.0 - thickness * rcp(SSS_THIN_CUTOFF);
        transmission = lightRadiance * (backLight * backVisibility * thinness * SUBSURFACE_SCATTERING_TRANSMISSION)
                     * sunTransmittance;
    }

    // ③ 天光/环境（按 AO 衰减——环境光来自各个方向，遮蔽对它是成立的）
    vec3 ambient = ambientIrradiance * (SSS_AMBIENT_WRAP * SUBSURFACE_SCATTERING_AMBIENT * ambientOcclusion)
                 * ambientTransmittance;

    return (SSS_EMISSION * beta * sssAmount) * (diffusion + transmission + ambient);
}

#endif
