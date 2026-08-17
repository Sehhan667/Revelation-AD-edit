# ADR-0001: 级联辐射度缓存（Cascaded Radiance Cache）

状态：已采纳（TODO #1）

## 背景

当前 GI 使用单一 64³ 相机居中的体素网格：

- `voxelData`（64³ rgba16f）：方块 albedo / ID / skylight，由阴影 pass 内嵌条带调度写入
- `voxelRadiance` / `voxelRadiance2`（64³ rgba16f 双缓冲）：IRC 辐射度缓存
- `voxelLightData`（64³ R32UI）：方块光数据

单分辨率导致"近处精细度"与"远处覆盖范围"互相制约：格子小则近处精细但覆盖短，格子大则覆盖远但近处糊。级联缓存的目的：用多级不同 cell 尺寸的同心网格，近处精细、远处覆盖，查询按距离选择级联。

## 设计

三个同心、相机居中级联，每级仍用 `VOXEL_AREA = 64`（复用现有存储/平铺布局与 DDA 工具）。覆盖半径由 GUI 滑条 `VOXEL_DISTANCE`（默认 64m）统一驱动：near/mid/far 半径 = D/4、D/2、D，cell 尺寸 = D/128、D/64、D/32；球谐光边界与光追计算距离均引用 far 半径（`VOXEL_CASCADE_RADIUS_2`），随 D 自动缩放。

| 级联 | cell 尺寸 | 覆盖范围（以相机为中心） | 用途 |
|---|---|---|---|
| C0 near | D/128 m（默认 0.5） | ±D/4（默认 ±16 m） | 室内/近景精细 GI |
| C1 mid | D/64 m（默认 1.0） | ±D/2（默认 ±32 m） | 中景（等价现有 64³@1m 语义） |
| C2 far | D/32 m（默认 2.0） | ±D（默认 ±64 m） | 远景大致 GI |

坐标约定：所有级联共用一个网格原点（相机整数坐标，`cameraPositionInt`），世界坐标 → 级联坐标 = `camRelPos / cellSize + VOXEL_RADIUS`。相机移动时各级联沿用现有整数重投影补偿。

存储：每级独立 `voxelData` / `voxelRadiance`（双缓冲）/ `voxelLightData`，显存增量约 3×（2+4+1）MB ≈ 21 MB，GTX 1050 Laptop 可接受。

## 集成点

1. **体素化**（Shadow.geom / Shadow.frag）：阴影贴图条带从 256×1024 扩展为三块（横向 768×1024 或竖向堆叠），Shadow.frag 按级联把 `camRelPos / cellSize` 换算后写入对应 `voxelData`。
2. **注入**（VoxelGI.frag）：三级联都做 IRC 随机注入；C1 每帧，C0 / C2 隔帧注入（性能节流，1050 Laptop 首要约束）。
3. **查询**（VoxelTracing / DiffuseIndirect）：光线按距离选级联——近程（≤16 m）C0，中程（≤32 m）C1，远程（≤64 m）C2；射线从近级联出界后在世界坐标连续步进进入下一级联，避免边界断层。
4. **天光门控**：各级联沿用现有 lightmap 0.02–0.24 门控规则，防止级联边界与洞穴漏光。
5. **降噪**：SVGF 链输入不变（仍是屏幕空间累积），不感知级联边界。

## 风险与取舍

- 体素化 ×3 + 注入 ×3 是主要性能开销；通过隔帧注入、远级联降低更新频率缓解。
- 阴影贴图条带变宽会压缩真阴影区分辨率；若横向放不下，改竖向堆叠或单独 compute 调度。
- `shaders.properties` 保持纯 ASCII（MEMO 教训：非 ASCII 字符会崩 Iris 预处理）。
- 新 GUI 滑条需三处同步（VoxelLighting.glsl 定义 + properties + 双语 lang）。

## 实施顺序（增量）

1. 配置与缓冲：`cellSize` 常量、三级联 image 缓冲、properties 注册（纯 ASCII）。
2. 体素化：Shadow GS/Frag 按级联写入三份 voxelData。
3. 注入：VoxelGI.frag 三级联 IRC + 节流。
4. 查询：VoxelTracePixel / DiffuseIndirect 按距离选级联 + 跨级联连续追踪。
5. 边界混合、参数滑条、回归验证（帧率 + 画面）。
