> **已归档（2026-11-22）** — 本文件是历史快照，不再维护；其中的结论、路径、选项名可能已与现行代码不符。
> 现行对应文档：`docs/archive/MEMO-2026-11.md` 的「Probe GI（DDGI 风格）」两节
> 归档说明：一份已执行完毕的任务方案书（DDGI 探针 GI 的 MVP 实施计划）。留作「任务书该怎么写」的样例。

# 探针全局光照（DDGI 风格）—— MVP 实施方案

## Context（为什么做）

用户给光影添加**全新的、与现有 VXGI 并行的独立全局光照方案**，目标是**降噪/更稳定 + 实验探索**。
经评估，最契合的是 DDGI 风格探针 GI：探针值是平滑低频辐照度缓存，天然免降噪、比现有"棋盘 1 SPP + SVGF"稳定。

已与用户确认：

- **独立开关、与 VXGI 互斥**（像 SSILVB 一样单开一个，可直接切换对比）。

- 第一版覆盖 **16³ 格 × 4m 间距 = 64m**（≈ VOXEL\_AREA，与现有体素化对齐）。

- **复用现有体素化**（voxelData）作为探针线的场景几何，不重新体素化。

MVP 只做低频非方向辐照度缓存 + 三线性查询 + 一阶弹射；**不含**反射方向 SH、octahedral 各向异性、双缓冲乒乓、间距自适应。

## 关键复用（不重造轮子）

- 体素化数据与工具：`voxelDataSampler`/`voxelLightSampler`（64³）、`VoxelData.glsl` 的纯函数（`VoxelMin3`/`VoxelRay`/`IsHitBlock`/`VoxelShape`）、`VoxelSphereUnitVectorFromU`（STBN 全方向）。

- DDA 模板：`lib/lighting/VoxelTracing.glsl` L131-344（含 `rdir` 有符号修正、check-then-step、起始格自交跳过、透射吸收）。

- 命中光照：发射光 `VoxelHitLightSphere`、阳光遮挡 `VoxelSunShadowMap/Tracing`、天光 `VoxelSkyColor`（含漏光门控）。

- 坐标约定：世界(相机相对)→体素格 `camRel + cameraPositionFract + float(VOXEL_RADIUS)`，`VOXEL_RADIUS=VOXEL_AREA/2=32`。

- 像素间接光信号源/合成：`program/diffuse/DiffuseIndirect.comp`（现有 `#if VOXEL_GI // #else SSILVB` 互斥分层范式）。

## 文件清单

新增：

- `shaders/lib/lighting/ProbeGI.glsl` —— 探针宏 + `ProbeTrace(origin,dir)` DDA + `ProbeVoxelToNormalized` 三线性查询；声明 `voxelDataSampler/voxelLightSampler/probeRadianceSampler`（**无显式 binding**）。

- `shaders/program/gi/ProbeUpdate.comp` —— 16³ 线程 compute，每探针 STBN 方向采样→ProbeTrace→EMA 累积写缓存。

- `shaders/world0/deferred50.csh`（+ world-1/world1 的 deferred50.csh，仅用于显式禁用）→ `#include "/program/gi/ProbeUpdate.comp"`。

修改：

- `shaders/shaders.properties` —— 新增 `image.probeRadiance`、deferred50 槽位规则、deferred1\_a 三世界规则并入 `PROBE_GI_ENABLED`、可选菜单/slider。

- `shaders/settings.glsl` —— 新增 `PROBE_GI_ENABLED` 开关与 `PROBE_GI_STRENGTH`/`PROBE_RAY_SAMPLES`/`PROBE_UPDATE_PERIOD`/`PROBE_MAX_FRAMES` 参数宏。

- `shaders/program/diffuse/DiffuseIndirect.comp` —— main 内 `#ifdef PROBE_GI_ENABLED` 分叉，优先走探针三线性查询写 colorimg3。

- `shaders/program/DeferredLight.frag` —— 读回分叉：`#ifdef PROBE_GI_ENABLED` 用 camRelPos 全分辨率查探针缓存补 albedo×强度，或读回 colortex3 反 YCoCg。

## 关键决策

- **pass 槽位**：用空闲的 `deferred50`。`program.world0/deferred50.enabled = PROBE_GI_ENABLED`；world-1/world1 **显式** **`= false`**（否则三世界各跑一次 → EMA 重复叠加），沿用 deferred30-32 禁用先例。

- **互斥**：`deferred1_a.enabled` 三世界都并入 `... || PROBE_GI_ENABLED`。SVGF 链 deferred4-9 规则**不改**——PROBE 时 VOXEL\_GI 关 → 规则已为 false → 链不 dispatch → colortex3 保持 DiffuseIndirect 的原始平滑信号 → **天然免降噪**。

- **image3D 绑定**：`image.probeRadiance = probeRadianceSampler rgba rgba16f half_float false false 16 16 16`；compute 用 `layout(rgba16f) writeonly uniform image3D` + `imageStore`，读取用 `sampler3D` + `textureLod`。**绝不给 binding**（项目注释强调显式 binding 与 Iris 冲突→全黑根因）。

- **坐标换算**：`probeCell = floor(vc / PROBE_SPACING)`（vc 为体素空间坐标，\[0,16)）；格心 `(probeCell+0.5)*4.0`；归一化三线性采样 `vc / (16*4)`，探针 i 恰在纹素中心对齐。

- **探针值**：各探针存单一 RGB 平均入射辐照度；EMA `mix(old, new, clamp(PROBE_UPDATE_PERIOD/PROBE_MAX_FRAMES, 0,1))`；帧间方向轮转（`idx % UPDATE_PERIOD != frameCounter % UPDATE_PERIOD` 则本帧跳过）。

- **ProbeTrace**：从任意起点沿方向 DDA 穿 voxelData；首实心命中返回该面辐射度（发射光 / 方块光 / 阳光反弹经 `VoxelSunShadow` 遮挡）；出界返回 `VoxelSkyColor(dir, 1.0)`；MVP 传 lightmap=1.0（开阔可用，室内偏亮——靠强度调，室内精确留 v2）。

- **依赖**：探针追踪读 voxelData → 依赖 `ENABLE_VOXELIZATION`（与 VXGI 同）。文档/GUI 需提示。

## 实现顺序

1. settings.glsl 加开关与参数宏。
2. 新增 ProbeGI.glsl（探针宏 + ProbeTrace + 查询辅助）。
3. 新增 ProbeUpdate.comp + 三个 deferred50.csh。
4. shaders.properties：image.probeRadiance + deferred50 规则 + deferred1\_a 三世界并入。
5. DiffuseIndirect.comp 加探针分叉（最前优先）。
6. DeferredLight.frag 加读回分叉。
   7.（可选）GUI 菜单/滑块 + Debug 可视化。

## 验证（端到端）

- **测试唯一组合**：进游戏前注释 `settings.glsl` 的 `#define VOXEL_GI_ENABLED`，只开 `PROBE_GI_ENABLED`（避免 VXGI 读回双份叠加）。

- 体素化开关 `ENABLE_VOXELIZATION` 保持开启。

- 观察：开阔处在阳光下应有稳定平滑的低频环境光、无棋盘/SVGF 噪点；室内偏亮（预期，靠 PROBE\_GI\_STRENGTH）；帧间稳定无闪烁。

- 用 `renderdoc.txt`/截屏对比：VXGI（现样板）vs 探针 GI（新）两种 N 开关切换的画质与稳定性。

- 用 console/log 或任务管理器确认：PROBE 开时 SVGF 链（deferred4-9）不 dispatch、探针 pass（deferred50）在跑；world-1/world1 的 deferred50 不跑（显式 false）。

- 防崩溃：ProbeUpdate 首行加 in-bounds guard（Iris 可能按 64³ 分配线程）。

## 风险与规避

- **漏光（室内天光过强）**：靠 PROBE\_GI\_STRENGTH/天光门控，留 v2（按探针格深浅传 lightmap）。

- **细节丢失（4m 低频）**：小光源会糊成环境光；发射光路径保留 `VoxelHitLightSphere` 热区，可调 PROBE\_RAY\_SAMPLES。

- **双份叠加**：测试只开 PROBE；GUI 做成 VXGI/SSILVB/Probe 互斥单选更有，MVP 先文档说明。

