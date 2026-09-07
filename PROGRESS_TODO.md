# Revelation-AD-edit — GI 调试进度 & 待办（2026-09-04）

## ⏸ 当前状态：DDGI/IRC 探针 GI 任务暂停（2026-09-06）

- **暂停**：方块光 DDGI 大体可用、仍有打磨项（浮动/格痕/单弹射），先挂起，恢复时从下方"待办"第 1 项开始。
- **运行配置快照（settings.glsl 现状，未提交）**：GI_MODE=3（IRC/DDGI）；IRC_DISABLE_SUN_GI=开（只方块光+自发光）；
  PROBE_UPDATE_PERIOD=8（轮转分摊已接线）、PROBE_RAY_SAMPLES=64（每帧预算）、PROBE_HYSTERESIS=0.95、
  PROBE_DIST_HYSTERESIS=0.85；PROBE_ATLAS_FILTER=开（DIST_K=1.0 / DIR_POW=8.0）；
  shadowMapResolution 默认 1536（用户侧 1024；体素化平铺硬下限 1024）。
- **git 状态**：本会话全部改动**未提交**（DiffuseIndirect.comp / DeferredLight.frag / shaders.properties /
  settings.glsl / VoxelGI.comp(新) / world0|world-1|world1/deferred23.csh(新) / lang 双语文案 / VoxelClear.comp 等）。
  恢复前建议先 review + commit 存档，避免状态丢失。

### 本会话已完成（均未做游戏内实测确认）
1. VXGI 降噪链门控修复：properties 三 world 门控从"派生别名 ifdef"改为 `#if GI_MODE == N` 整型比较
   （假设别名未传入 Iris properties 预处理器 → 降噪链静默禁用；此改动在别名可见时为零风险等价）。
2. SSS（屏幕空间接触阴影）深阴影早退：DeferredLight 中 rawShadow 均值 <0.01 的像素跳过整段步进。
3. DDGI/IRC 参数全部进 GUI（screen.IRCGI）：滞后×2、偏置×2、gamma、atlas 滤波×3、周期、阳光屏蔽调试开关。
4. 八面体图集双边滤波（RTXGI 思路，ProbeUpdateSlice 写入后 3×3 保边平滑，只滤辐照度不动距离场）。
5. 每探针射线预算 + 轮转分摊：每帧更新 1/PROBE_UPDATE_PERIOD 探针、单更新投 R×P 线（分块 64 追踪 +
   36 纹素累积器）、未轮探针"旧值搬移"保乒乓、边缘探针强制播种、滤波仅作用于被更新探针。
6. 轮转补偿公式修正为 hyst^P（曾错写 hyst^(1/P)，响应被拉慢 8 倍）+ 时域参数还原正常值
   PROBE_HYSTERESIS 0.95 / PROBE_DIST_HYSTERESIS 0.85（降噪交给 512 线/更新 + 图集滤波）。

### 待办（恢复时按序执行）
1. **实测批次 A（最高优先）**：GI_MODE=3 方块光——火把周围站定 10s 看浮动/闪烁（ATLAS_FILTER 开关 A/B、
   滞后 0.95/0.97 档对比）；走动看响应/拖影（应恢复常态，不再 8× 慢）；网格边缘重锚瞬变；
   PROBE_UPDATE_PERIOD=1 对照旧行为。
2. **实测批次 B**：GI_MODE=2 VXGI——降噪是否随门控修复恢复收敛（站定噪点应消失）；GI_MODE=1 SSILVB 对照；
   0/1/2/3 各载一次无编译报错（查 latest.log）。
3. SSS 早退优化实测（深阴影内无可见差异即通过）。
4. 结构性缺口：探针格内随机抖动 + 重锚历史搬移（去 4m 格痕/摩尔纹）。
5. 方块光多弹射：命中点回读探针场（与 NVIDIA DDGI 论文最大差距；须待 1/4 稳定后再做）。
6. 阳光/天空项：关掉 IRC_DISABLE_SUN_GI 评估阳光反弹（cave-roof 门控、sunSkyGate、阴影一致性）。
7. PROBE_MAX_FRAMES 接线或删除（现为声明未用的死参数）。
8. 收尾：未提交改动 review + commit；MEMO.md 更新；lang 全量核对；全场景对比截图（白/夜/洞穴）。


## 〇、本轮进展（2026-09-05 GI\_MODE 统一滑条 + IRC 稳定性）

0. **IRC 缓存写端迁移到 compute**（2026-09-05）：

   - 实测确认 Iris 1.10.7 + NVIDIA 下 `deferred22` fragment 对自定义 3D image 的
     `imageStore` 未写入，导致 `voxelRadiance` 全黑；VXGI 因主要使用每像素追踪而不受影响。

   - 新增 `deferred23.csh` / `VoxelGI.comp`，以 512×512 invocation 一线程一体素覆盖完整
     64³ IRC 缓存；关闭旧 `deferred22` 写端。诊断显示确认原始缓存与天空门控后信号均恢复。

   - 光源近场稳定化：`VOXEL_GI_LIGHT_RADIUS` 默认从 0.5 调至 0.8，
     `VOXEL_GI_BLEND` 从 0.99 调至 0.995，降低 1 SPP 发光体素命中方差。

   - 后续根据实测将 `GI_MODE=3` 改为 DDGI 方向性探针后端：八面体方向辐照度、
     距离场可见性、标准中心插值和绝对遮挡衰减；仅保留方块光与阳光。

   - 当前调试阶段已加入 `IRC_DISABLE_SUN_GI`，完全屏蔽 IRC/DDGI 的阳光反弹，
     只观察方块光和自发光传播。

1. **GI 模式改为单滑条** **`GI_MODE`**（settings.glsl）：

   - `GI_MODE 0 = 关闭`、`1 = SSILVB`、`2 = VXGI`、`3 = IRC`（默认 3）。

   - 移除独立开关 `IRC_GI_ENABLED` / `VOXEL_GI_ENABLED` / `SSILVB_ENABLED` 的用户可见配置与 GUI/lang；
     内部改为派生宏 `GI_ACTIVE_IRC / GI_ACTIVE_VXGI / GI_ACTIVE_SSILVB`，条件定义 + 括号表达式，
     避免 Iris 把无值定义误识别为布尔选项。

   - 三个维度的程序调度（deferred22/deferred1\_a/deferred4-9/deferred40/begin1）全部改为直接按
     `#if GI_MODE == N` 分支，不再依赖旧开关；预设 `profile.Default` 同步为 `GI_MODE=3`。

   - 各模式强度/采样/降噪参数页保留；`ENABLE_VOXELIZATION` 保持不变。
2. **IRC 稳定性修缮（上一轮已完成）**：

   - 修正 IRC 三线性查询：保留连续坐标与体素中心偏移，不再退化为固定八邻居 0.125；IRC 取消棋盘位置轮换。

   - 三维度写端原先统一走 `deferred22`，后因 fragment 3D imageStore 实测失效迁移到
     `deferred23` compute；关闭重复 `composite2` 写端。IRC 不进入 SVGF 降噪链。

   - IRC 逐帧更新、空气格清零、过滤 NaN/非法历史、加冷启动首帧保护；曝光历史用重投影坐标，新暴露体素解析播种。

   - 保留 `(1-alpha)` 露天衰减与方向性 SH 天空光（用户选择，不做光源分离）。

## 一、当前生效方案（IRC\_GI，DDGI 方向性探针、免 SVGF）

- **IRC\_GI**：复用 DDGI 探针后端（16³×4m 八面体方向辐照度 + 距离场），
  写端与查询端均在 `deferred1_a` compute 内完成。**无每像素追踪、无 SVGF**。

- **IRC\_GI 只出「阳光 + 方块光」**：DDGI `ProbeTrace` 在 `GI_ACTIVE_IRC` 下屏蔽
  `VoxelSkyColor` / `SimpleSkyLighting`，天空只由 SH 提供。

- **完整方向性 SH 天空**：环境光仍由 `ConvolvedReconstructSH3(global.skySH, worldNormal)` 提供
  （还原了 1.0.2b 的方向性），IRC\_GI 不屏蔽 SH（VXGI 仍屏蔽，走原路径）。

- **夜晚亮度旋钮（已接线）**：`NIGHT_BRIGHTNESS`（原为空定义，已接到夜晚环境光+月光直射）、
  `MOON_BRIGHTNESS_MULTIPLIER`（已加入 GUI MiscLighting）。

- **VXGI 未动**：所有门控为 `VOXEL_GI_ENABLED || IRC_GI_ENABLED`（或含 SSILVB/PROBE），VXGI 打开时行为不变。

## 二、后端调整

- **DDGI 探针（4m 方向性探针缓存）**：作为 `GI_MODE=3` 的内部后端重新启用；
  不再作为独立 GUI 模式暴露。4 张探针 image 复用已禁用的 ReSTIR reservoir 槽位，
  保持 Iris image 数量限制内。

## 三、主分支结构（diffuse/DiffuseIndirect.comp, deferred1\_a）

```
#if IRC + PROBE backend       -> ProbeSampleRadiance（方向辐照度 + 距离可见性）× IRC_GI_STRENGTH
#elif IRC legacy backend      -> 三线性采样 voxelRadiance（备用路径）
#elif defined VOXEL_GI_ENABLED -> VXGI 每像素追踪（原路径）
#else                          -> SSILVB
#endif
```

## 四、这个会话踩过的坑（务必别再犯）

1. **shaders.properties 必须纯 ASCII + 单空格 + 无 BOM**：

   - 中文注释 → `Properties pre-processing failed` → 黑屏；

   - 多空格对齐字段 → `Unknown image type` → 纹理不创建 → 写读全黑；

   - **UTF-8 BOM（0xEF 0xBB 0xBF）** → `org.anarres.cpp Bad token 0xEF@1,1` → 配置没生效（曾导致"没GI/SH坏"）。

   - 改完必查：`Get-Content -Encoding UTF8 | % { if($_ -match '[^\x00-\x7F]'){$_} }` + 检查首字节 BOM。
2. **去掉 screen 定义时必须同步父菜单的** **`[XXX]`** **引用**（删 `screen.ProbeGI` 但 `[ProbeGI]` 还留在
   `screen.GlobalIllumination` → GUI 残留"点不开的 ProbeGI"）。
3. **新增 image 槽位会挤爆 16 上限**（probe 4 张 + voxel 6 张 + reservoir 4 张 → `Only up to 16 images`）。
4. **GI 分支的** **`program.*/deferred1_a.enabled`** **门控必须包含新 GI 宏**，否则 compute 不调度 → 没GI + 曝光/天空缓冲脏。
5. DeferredLight 复合（`sceneOut += colortex3`）和「网格内屏蔽 SH」的门控也要跟着 GI 宏扩展。
6. `NIGHT_BRIGHTNESS`、`MOON_BRIGHTNESS_MULTIPLIER` 原本都是空定义（两版）——要接线才有效。

## 五、待办

- [x] **IRC 天空光分离**：IRC 模式不再注入/采样天空光，只保留方块光与阳光反弹。

- [ ] **全场景对照测试**：白天露天 / 夜晚 / 洞穴火把 各截一张，确认无漏光、无色偏、方向性正确。

- [ ] **夜晚亮度定标的默认值**：对齐 1.0.2b 的目标，把 `NIGHT_BRIGHTNESS`/`MOON_BRIGHTNESS_MULTIPLIER` 预设到合适值。

- [x] **重新启用 DDGI 代码**：ProbeGI.glsl、ProbeTrace、ProbeUpdateSlice 现作为
  `GI_MODE=3` 的方向性 IRC 后端，不再属于待清理死代码。

- [x] **lang 文件**：给 IRC / `MOON_BRIGHTNESS_MULTIPLIER` 加中英标签；GI\_MODE 统一滑条后已补中英名。（本轮完成）

- [ ] **游戏内四档验证**：GI\_MODE 分别 0/1/2/3 重载，确认无编译报错、关闭档全关、IRC 免降噪、VXGI 方块光正常。

- [ ] **全场景对照回归**：白天露天 / 夜晚 / 洞穴火把 各截一张，确认无漏光、无色偏、方向性正确（立体采样的半分辨率边缘串光需重点看）。

- [ ] **提交/收尾**：确认最终状态后 `git commit`，并更新 MEMO.md 的 GI 关键点。

## 六、关键入口（改了这些要重选包/F3+R）

- settings.glsl：`GI_MODE`（0关/1 SSILVB/2 VXGI/3 IRC，默认3）、`IRC_GI_STRENGTH`、`NIGHT_BRIGHTNESS`、`MOON_BRIGHTNESS_MULTIPLIER`。

- shaders.properties：探针 image 绑定、`program.*/deferred1_a.enabled`、`screen`（GI 参数页）、
  `sliders`、`profile.Default`（GI\_MODE）。

- diffuse/DiffuseIndirect.comp：`GI_ACTIVE_IRC` 分支（查询端三线性 IRC + 门控）。

- diffuse/DiffuseIndirect.comp + ProbeGI.glsl：IRC DDGI 写端、方向性查询与距离可见性。

- VoxelGI.comp / deferred23.csh：仅保留给 VXGI 的传统 `voxelRadiance` 缓存维护。

- DeferredLight.frag：复合门控、网格内 SH 屏蔽门控、夜晚亮度（nightAmt）。

## VXGI 降噪失效排查（2026-09-05 晚）
- 症状：GI_MODE=2(VXGI) + VOXEL_GI_DENOISE 开 / 方案0(SVGF)，站定全屏噪点永不收敛 -> deferred4-9 降噪链未生效。
- 根因候选：shaders.properties 里 deferred4-9/40 的门控此前用 settings 派生别名（#ifdef VOXEL_GI_ENABLED 等）；
  Iris 预处理 properties 时派生别名是否可见不可靠——deferred1_a 因底部 828-830 无条件兜底(true)而幸免，降噪链没有兜底 -> 静默 false。
- 修复：三个 world 的门控链(438-807 区)条件全部改为同文件已验证的整型比较 #if GI_MODE == 1 / #elif == 2 / #elif == 3 / #else(与 CLOUD_TAAU_SCALE/EXPOSURE_MODE/VOXEL_GI_DENOISE_MODE 同款写法)；分支内容不变。ASCII/无BOM 已验证。
- 待实测：F3+R -> GI_MODE=2 站定看噪点是否收敛；顺带 0/1/3 各载一次确认门控（0 全关、1 SSILVB 降噪正常、3 IRC 免降噪不误跑）。

## 探针图集双边滤波（2026-09-05 晚）
- 新增 RTXGI 式八面体图集双边滤波：ProbeUpdateSlice 写完内部 N×N 后，做 3×3 边缘保持平滑（
  方向相似度^DIR_POW × exp2(-Δ距离²·DIST_K)），再镜像边界环。只滤辐照度，不动距离场（防漏光）。
- 参数：PROBE_ATLAS_FILTER（开/关）、PROBE_ATLAS_FILTER_DIST_K 1.0、PROBE_ATLAS_FILTER_DIR_POW 8.0，均已进 GUI（光照→全局光照→IRC 方向性探针 GI）。
- 目标：不加射线预算，压掉小光源命中/落空的逐纹素方差与低频浮动。待实测 A/B：关/开对比火把周围；
  若明显变糊 → 调大 DIST_K/DIR_POW；若仍浮动 → 下一步考虑探针格内抖动或轮转更新(接线 PROBE_UPDATE_PERIOD)。

## 每探针射线预算与轮转分摊（2026-09-05 深夜）
- ProbeUpdateSlice 重构：每帧只更新 vi≡frameCounter(mod PROBE_UPDATE_PERIOD) 的探针（每帧 1/P），每个更新
  投出 PROBE_RAY_SAMPLES×P 条射线（分块 64 线追踪 + 36 纹素累积器，避免大数组压寄存器）→ 总射线/帧不变，
  单更新方差÷P。
- 未轮到的探针走"旧值搬移"分支（imageLoad 旧块→写当前块，含重居中整数搬移），保证查询端另一块永远是最近值；
  新暴露边缘探针强制立即更新播种。双边滤波只作用于被更新的探针（避免重复滤波累积模糊）。
- 滞后语义修正：PROBE_HYSTERESIS/DIST_HYSTERESIS 保持"每帧保留比例"语义，更新端换算 hyst^(1/P)，
  响应时间不随周期拉长（GUI 标签承诺每帧语义）。
- GUI：PROBE_UPDATE_PERIOD 已进 IRCGI 屏（[1 2 4 8 16 32]）；PROBE_RAY_SAMPLES 语义=每探针平均每帧预算
  （[4..256]）。默认 64×8=512 线/更新，总预算与旧版一致。N=1 即旧行为（逐帧全量）。PROBE_MAX_FRAMES 仍预留未接线。
- 待实测：火把周围再对比；走动看响应/拖影；网格边缘重锚处看有无瞬变；异常时先试 PROBE_UPDATE_PERIOD=1 回退旧行为。
- [修正 2026-09-06] 轮转补偿公式方向写反过：原代码 hyst^(1/P)（每更新只混 0.25%，响应被拉慢 8 倍）→
  已改为 hyst^P（P=8、hyst 0.95 → 每更新保留 0.95^8≈0.66，等效逐帧 5% 混入，响应/噪声与 P=1 一致）。
  同时时域参数恢复正常值：PROBE_HYSTERESIS 0.98→0.95、PROBE_DIST_HYSTERESIS 0.95→0.85（降噪交给
  512线/更新 + 图集双边滤波）。待实测：收敛速度/拖影是否恢复正常、浮动是否仍在（若在再提 0.97/0.9）。
- [2026-09-06] VXGI 加速/采样开关恢复 GUI 可用（Debug→Voxel，默认关=原行为）：
  VOXEL_COARSE_ACCEL / VOXEL_FINE_ACCEL（occupancy 生产者本就在 Shadow.frag 原子置位、begin1 清零，
  但无 settings 定义+锚点 → GUI 点不动；已补定义行/锚点并把生产者按宏门控，默认关时省两笔原子写/片元）
  与 VOXEL_COS_SAMPLING（余弦密度半球采样）。待实测：COARSE 开看帧数与漏光；FINE 开若见空洞则关；
  COS 采样亮度观感是否偏移。
- [2026-09-06 细格跳过改进] VOXEL_FINE_ACCEL 单独开启现在也自动包含 4³ 粗块空洞跳跃：
  VoxelTracing 的 coarse 采样器声明/粗块跳跃代码与 Shadow.frag 的 coarse 置位门控合并为
  `COARSE || FINE`（此前 FINE 单独开无粗块跳跃，全空粗块也逐格查位图，拿不到最大收益）。
  lang/设置注释同步。已知取舍（未改）：实心密集区每格多一次位图采样（粗块内实心格=位图+体素 2 次 3D 采样），
  洞穴/建筑内部 FINE 反而更慢 → 该场景关闭。可选后续：轴向空格运行的整段位图跳跃（竖直射线收益大）。
