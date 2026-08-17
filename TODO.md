# TODO

功能路线图（按优先级排序）。已完成项：体素网格加速追踪、SVGF 风格降噪，不在此列。

## 1. 级联辐射度缓存

- 现状：单分辨率 64³ IRC 辐射度双缓冲（voxelRadiance / voxelRadiance2），另有 RSM、SSILVB
- 目标：多级分辨率 / 按距离级联，扩大 GI 覆盖距离并提升近处质量
- 规模：中等
- 已实现：三级联（near 0.5m / mid 1.0m / far 2.0m 默认），GUI `VOXEL_DISTANCE` 统一驱动级联/球谐光/光追距离
- **已解决（2026-08-17）**：far 级联网格为空的根因是游戏实际生效的阴影分辨率被 Iris 记住的旧配置覆盖（`shaderpacks/Revelation-AD-edit.txt` 里 shadowMapResolution=1536/1024），far 平铺区（y 1024–1536 行）整块在贴图外被裁剪。改源码 settings.glsl 无效，因为游戏读的是它记住的选项文件。把该文件的 shadowMapResolution 抬到 2048 后 far 平铺区完整落入贴图，远处 GI 恢复。注意：用户改 GUI 里的阴影分辨率会影响此文件，需保持 ≥1536 才能容纳三级联平铺。

## 2. NRD 风格实时降噪增强

- 现状：SVGF 链（Accumulate → VarianceEstimate → EAWF ×4），已有按历史长度选 mip 的手法
- 目标：补上 hit-distance 驱动的模糊半径、可靠性权重、去遮挡修复等 NRD 思路
- 规模：渐进式

## 3. ReSTIR RT

- 现状：每像素 1 条随机光线 + 时域累积；STBN 蓝噪声已就位
- 目标：时空重采样（RIS + 时域/空间 reservoir 复用）
- 规模：大

## 4. 路径引导

- 现状：仅静态重要性采样（半球 PDF、镜面采样偏置）
- 目标：在线学习光线方向分布（球谐 / 八叉树 PDF 场，或辐照度引导）
- 规模：最大

## 5. 天光系统完善（2026-08-17 暂停，待恢复）

- 现状：光追天光链路已恢复并接通（2026-08-17，c722f4d → 67bb105）——追踪/IRC 出界
  注入、新暴露播种、Phase1 曝光、NaN 奇点修复、门控放宽、滑条接线、阳光染色。
  **洞穴不漏光已达成，开阔地天光可用**。
- 已知改进空间（用户暂停时未解决）：
  - **室内方向性**：反弹阳光的方向性阴影（物体背对门口留影，itrp 同款）未最终实测
    调校。方向对比依赖缓存空间对比度（门口阳光亮斑 vs 深处暗），已把 SELF_BOUNCE
    降到 0.15 恢复对比度，但未实测确认。
  - **门控精度**：天光目前用原版 lightmap(skylight) 做门控（itrp 同做法）。可升级为
    IRC Phase1 曝光度（射线追踪自算的天空可见度 alpha）做门控，更准。
  - **平衡精调**：SELF_BOUNCE 0.15 / SKY 0.6 / TRACE_SKY 1.0 / SUN 1.5 / TRACE_SUN 12
    是快速调参结果，未精调；GUI 滑条全接线后可现场拖（光影设置 → Debug → voxel）。
  - **收尾清理**：lang 残留废弃条目（VOXEL_GI_MODE/RAYS/RAY_STEPS/DECAY）；
    VoxelPropagate.glsl 死文件。
- 注意坑：`shaderpacks/Revelation-AD-edit.txt` 的记住值会覆盖代码默认值（详见 MEMO 2026-08-17 节）。
- 规模：中等（方向性 / 门控精度两项为主）
