//================================================================================================//
// Voxel SkyLight — GI 方向天空光（原创实现，2026-08-09）
//
// 思路（通用物理启发）：
// - 天光主要来自上方：方向权重用平滑曲线（朝上 1、水平 ~0.25、朝下 0）
// - 颜色带昼夜着色（skyColor），天顶更亮、地平线更淡（大气路径更长）
// - 可见度门控用原版天光 lightmap：洞穴/室内（≈0）无天光，户外（≥0.23）全开，
//   中间平滑过渡，树冠缝隙等半遮挡处按比例保留
//================================================================================================//

// 方向天光权重：朝上 1、水平 ~0.25、朝下 0（平滑过渡，无硬性角度阈值）
float VoxelSkyDirWeight(vec3 dir) {
    return smoothstep(-0.4, 0.8, dir.y);
}

// 天光可见度门控：lightmap 0.015-0.23 平滑过渡（洞穴 0 → 关闭，户外 ≥0.23 → 全开）
float VoxelSkyLeakGate(float lightmap) {
    return smoothstep(0.015, 0.23, lightmap);
}

// 命中面朝上加权：法线朝上 1、水平 0.5、朝下 0（天光对水平/朝下面贡献递减）
float VoxelSkyNdotU(vec3 normal) {
    return saturate(normal.y * 0.5 + 0.5);
}

// 方向天空色：skyColor 基础（含昼夜/日出日落着色），天顶提亮、地平线变淡
vec3 VoxelSkyColor(vec3 dir) {
    float horizonFade = mix(0.55, 1.0, smoothstep(-0.25, 0.45, dir.y));
    return skyColor * horizonFade;
}
