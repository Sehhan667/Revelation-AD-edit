# TODO

功能路线图（按优先级排序）。已完成项：体素网格加速追踪、SVGF 风格降噪，不在此列。

## 1. 级联辐射度缓存

- 现状：单分辨率 64³ IRC 辐射度双缓冲（voxelRadiance / voxelRadiance2），另有 RSM、SSILVB
- 目标：多级分辨率 / 按距离级联，扩大 GI 覆盖距离并提升近处质量
- 规模：中等

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
