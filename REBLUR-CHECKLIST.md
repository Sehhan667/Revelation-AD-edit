# REBLUR 半分辨率完整实现清单

> 目标：从 tracer 输入到最终上采样输出，逐项对齐官方 NRD `REBLUR`（半分辨率 / quarter-res 输入）的行为。
>
> **官方基线（2026-11-10 校正）**：HANDOFF 里的文件路径/行号对应 `master = v4.18.0`；题头旧写的 v4.11.4 是更早一轮的对照版本。  
> 本轮 §3 用两版交叉核对（`v4.11.4/Shaders/Include/REBLUR_PrePass.hlsli` + `REBLUR_Common_DiffuseSpatialFilter.hlsli`，  
> 与 `master/Shaders/REBLUR_PrePass.cs.hlsl` + `REBLUR_Common_SpatialFilter.hlsli`），结论在两版一致。  
> 今后统一以 master 为权威，v4.11.4 仅作回归参考；引用时写明版本与文件路径。
>
> **规则**
>
> 1. 每项必须先有「判定标准」；没有可测标准的项**不许勾**，标为 `BLOCKED`。
> 2. 每项做完立刻验证，验证不过就回退，不允许"先堆着后面一起看"。
> 3. 不改拓扑结构，除非该项明确写了「需要改拓扑」。
> 4. **凡是「验证 = V」或结论只能靠肉眼判断的项，一律只标 `⏳`，必须主人实机确认后才允许改 `✅`。** 我用代码/数值只能证明"实现符合意图"，不能证明"看起来对"。
> 5. **判定标准必须单一**：结构项只判结构（例 1.3 只判重投影本身），观感现象（拖影 / 噪点）另立项，
>    不许把下游多环节的现象算到上游某一项头上。
>
> **图例**  
> `✅` 已对齐（有 S/N/R 证据） ｜ `⏳` 已实现/已核对，**待主人实机确认** ｜ `⚠️` 已实现但有已知偏差（写在备注） ｜ `❌` 未实现 / 故意偏离 ｜ `❓` 未核实
>
> **验证方式**  
> `S` = 结构/静态脚本（`scripts/shader_semantic_check.js`、`shader_static_check.js`、`preproc_check.js`）  
> `N` = 离线数值（Node 仿真 / 解析推导，不启动游戏）  
> `R` = 对照官方源码或 README 原文  
> `V` = 实机 A/B（**必须人眼或截图，我无法独立完成**）

---

## 待实机确认（⏳）— 一轮跑完，逐项回填

> 下面是目前所有"只能肉眼定"的结论。**你确认哪条，我才把对应行改 ✅。**  
> **不要直接看最终画面**（光照、AA、色调映射全在干扰）。一律用 `GI_DEBUG_VIEW` 把被测量单独画出来：  
> 视图语义以 `Final.frag` 为准（2026-11-10 已统一文档；旧「分档配色 / 两段对比」说法作废）：  
> 1 = 历史长度(红)+本帧不可靠(绿)+年轻度(蓝) ｜ 2 = 方差 σ 灰阶(白=σ≥3.3% 亮度) ｜  
> 3 = 孤立亮点(红=累积值显著高于 3x3 邻域，绿=正常) ｜ 4 = 三段对比(左 prepass / 中累积 / 右最终，YCoCg→RGB) ｜  
> 5 = 三通道：红=A/cap，绿=几何可信度，蓝=本帧不可靠 ⇒ 黄=老且可信、**绿=新但可信(正常)**、蓝/青=兜底、红=老却不可信 ｜  
> 6 = 几何可信度(白=全接受/灰=扣权重/红=没用上历史)。

| 测试      | 开哪个视图         | 操作                                   | 通过                              | 失败 ⇒ 指向                                                                |
| ------- | ------------- | ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| A 静观    | **4**（三段）     | 站定 10 秒看有阳光反射的墙角                     | 左段有 1 体素量级块状起伏，右段更平滑且**静止时也不闪** | 右段块状且不随时间变 ⇒ 体素网格相关误差（1.1/1.2）。视图 4 已修 YCoCg 解码，需重看                    |
| 1.3 重投影 | **正常画面** | 沿墙平移 3 秒 + 原地转头 3 秒 | 无整屏波前、无整体错位（**只判矢量本身**；边缘拖尾归 9.6） | 整屏拖影 / 整体错位 ⇒ 重投影前提或符号反 |
| B 拖影    | **6** + **1** | 同上                                   | 大面积保持白；边缘后方发灰属正常                | 明明静止也大面积发灰 ⇒ 几何判据误杀。视图 6 的**红色**专标「走兜底、没用上历史」，极短属正常                    |
| C 天空    | **2**（σ）      | 抬头看天与树/建筑交界                          | 天空纯黑（0），交界只有 1 像素过渡             | 天空非零 / 交界大片白 ⇒ 1.6 或 2.4                                               |
| D 奇数分辨率 | **1**         | 窗口改 1367×769 再改回                     | 最右列/最下行与其他区域一致                  | 出现异常条带/白点 ⇒ 2.5 越界                                                     |
| E 火点    | **3**（离群度）    | 火把/岩浆快速进出视野后静止                       | 火点在时红/黄，移走后 1~2 帧内**回到全绿**      | 固定位置长期发红 ⇒ 4.11 没咬住                                                    |
| F 响应    | **5**         | 挖掉/放下方块                              | 命中区由**黄变绿**（短历史但仍可信），几帧后爬回黄     | 一直黄不动 ⇒ antilag 没触发（7.8/参数）                                            |
| G 离群钳制  | **正常画面**      | 亮场把 GUI 的「预滤波离群钳制」从 0 拉到 2~4，站定看 3 秒 | 滑条有反应、单点亮点被压、周围不整体发暗            | 没反应 ⇒ 3.11 接线没生效；暗处整体变暗 ⇒ 参考量缺陷（已知，回 0）                                |
| 9.6 拖影  | **正常画面**      | 沿墙平移 3 秒 + 原地转头 3 秒（`GI_MOTION_RESPONSE` 默认 1.0 已实施） | 拖影比第三轮明显变短、移动噪点可接受 | 拖影无改善 ⇒ 位移计算或权重没咬住；噪点不可接受 ⇒ 先拉 0.5，再不行设 0 一键回退 |
| J 结构重写（本轮） | **正常画面**      | 只重载一次，站定 10 秒看墙面 → 再平移 3 秒 → 再斜看地面 3 秒（不用开任何开关） | 静止无密集颗粒、移动拖影短且不跨表面、斜看不比正看更闪 | 仍满屏颗粒 ⇒ 时域/上采样；拖影跨表面 ⇒ 几何判据；斜看更闪 ⇒ skew 或平面距离容差；整体糊到看不清细节 ⇒ 把 `NRD_RADIUS_PX` 3.0 降到 2.0（覆盖仍是官方 2/3） |

### 实测回填（2026-11-10，主人）

| 测试  | 观察                             | 判定 / 后续                                                                                                 |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A   | 「大概符合要求。画面太诡异看不太清」             | ⏳ 不算确认。视图 4 直接把 YCoCg 当 RGB 显示 ⇒ 串色/发黑，**已修**（转回 RGB），重载后重看一次                                           |
| 1.3 | 「新像素明显更噪，有些拖影」 | ✅ 矢量本身通过：无整屏波前、B 视图 6 全白（历史采样点几何判据通过）。**拖影/噪点不计入本项**，已拆到 9.6 |
| B   | 「基本全白。移动时有极短红色拖影」              | ✅ 通过。几何判据没误杀；红色 = 视图 6 的兜底标记，1~2 帧消失属预期                                                                 |
| C   | 「通过」                           | ✅ 1.6、2.4 改 ✅（天空纯黑、交界仅 1 px）                                                                            |
| D   | 「通过」                           | ✅ 2.5 改 ✅（奇数分辨率无条带/白点）                                                                                  |
| E   | 「静止时画面已经是全红，无法测试」              | ⛔ BLOCKED。视图 3 旧判据用「滤波前后差 / 累积值」，空间滤波本来就改掉大半亮度 + 暗处分母趋 0 ⇒ 恒饱和全红。**已修**为相对 3x3 邻域的离群度，重载后重测；4.11 仍 ⏳    |
| F   | 「很奇怪。新像素是绿的，旧像素是黄的。除此之外应该基本符合」 | ✅ 通过（按修正后的三通道语义）。**这正是期望行为**：黄=老且可信，绿=新但可信。旧表格写「掉到红/橙再爬回绿」是分档配色的遗留，已改判据                                 |
| G   | 未测                             | ⏳ 保持。不追加实验，下一轮顺带看                                                                                       |

> **视图 5 使用注意**：它是逐帧原始值，不经过 TAA/上采样/色调映射；计数器 ±1~2 帧的抖动在灰度图上会被放大成整屏闪，  
> 但正常画面看不出来。视图 5 只用来判断「空间上是否大片没有历史」，不用来判断闪；判断闪一律看正常画面。  
> 三通道语义以 Final.frag 为准：绿 = 新像素但可信，不是「历史满」。

### 第二轮重载回填（2026-11-10 23:20，主人）

| 项          | 观察               | 判定                                           |
| ---------- | ---------------- | -------------------------------------------- |
| 0 新代码生效    | 「01 没问题」         | ✅ 视图 3 不再恒红、视图 4 颜色正常 ⇒ Iris 编译通过，诊断视图修复实机确认 |
| E 火点       | 同「01 没问题」        | ✅ **4.11 改 ✅**（火点移走 1~2 帧回全绿，公式与实机都成立）       |
| A 静观       | 未单独报             | ⏳ 保持，不补实验                                    |
| G 离群钳制     | 未测               | ⏳ 保持                                         |
| 1.3 / 视图 4 | 「中段和右边都有拖尾」，左段干净 | 1.3 结论不受影响（左段干净 ⇒ 输入与重投影方向都对）；拖尾是跨阶段问题 ⇒ 归 9.6 |

#### 三段结论（左干净 / 中+右拖尾）

- **左段 = 本帧 prepass（无历史）干净 ⇒ 输入信号与重投影方向都没问题**，1.3 判 ✅；拖影属跨阶段问题，见 9.6。
  上一轮「新像素起步信号脏」的判断撤回。
- **中段 = Accumulate 长历史**：沿墙平移时深度/法线几乎不变 ⇒ 去遮挡判据全通过  
  （B 的「基本全白」互证：`maxGeometryWeight≈1` ⇒ 历史长度不重置）。  
  `alpha = 1/(1+k·N)` 在 N≈30 只给本帧 3% 权重；fast-history clamp 的门控地板 `+0.02`  
  还会吞掉暗处的真实变化 ⇒ 旧内容保留几十帧 = 拖尾。
- **右段 = GIStabilize 第二级历史**：`quality = sqrt(mean(colortex21.a)) ≈ 1` ⇒  
  `historyWeight ≈ 0.89`；antilag 只在历史亮度偏离邻域 μ±σ 时降权，拖影内容与邻域相似 ⇒ 不触发  
  ⇒ 再叠一层拖尾。
- 结论：**不是 bug，是「降噪换响应」的取舍被推过头**（两级累积 + 两处 clamp 地板）。  
  B 的「移动时全白」也要重新解读：静止全白是对的，**移动时全白 = 平面墙上判据无从识别新像素**，  
  它是拖尾的来源而不是「判据健康」的证明。
- 修复必须选拖影↔噪点的平衡点 ⇒ 属观感取舍，按 `docs/CODE_STYLE.md` §8.5  
  **先给旋钮与代价，由主人定，不擅自改默认值**。

#### 候选旋钮（本轮已补齐 GUI 接线，默认值全部等价现状）

| 旋钮                           | 现状 → 建议      | 预期                     | 代价                   |
| ---------------------------- | ------------ | ---------------------- | -------------------- |
| `GI_ACCUM_TIME`              | 1.0 → 0.5    | 中段拖尾约减半（cap 30 → 15 帧） | 静止噪点上升（累积帧数减半）       |
| `GI_STABILIZE_FRAMES`        | 8 → 4        | 右段拖尾变短                 | TS 平滑减弱，可能轻微闪        |
| `NRD_STABILIZATION_STRENGTH` | 1.0 → 0.5    | 右段历史权重下降、更跟手           | antilag / 颜色盒同时变松    |
| `GI_DEBUG_NO_TS`             | 0 → 1        | 右段拖尾立刻消失（隔离量，不是修复）     | 失去稳定化 ⇒ 静止小闪         |
| `GI_DEBUG_NO_HISTORY_FIX`    | 0 → 1        | 排除 HistoryFix 是否参与中段拖尾 | 新暴露区更脏               |
| 新增 `GI_FAST_CLAMP_GATE`      | 0.02 → 0.005 | 暗处真实变化能触发裁剪            | 暗处可能蠕动（当年加这个地板正是为治它） |

**这条建议已被第三轮实机推翻**（见下），保留作为反面记录。

### 第三轮回填（23:27，主人）：两个滑条都无效

「拖影仍在没有改善」。离线核对选项文件 `shaderpacks/Revelation-AD-edit.txt`：  
`GI_ACCUM_TIME=0.5`、`GI_STABILIZE_FRAMES=4.0` **确实写入并生效**（`enableShaders=true`、  
日志无 `error C####`）。不是没重载，是**这两个旋钮的量级本来就不够**：

| 原因                                        | 数值                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `accumCap` 有下限 8，且除以 `GI_EFFECTIVE_SPP=2` | 20 / 30 / 45 / 60 fps 下 0.5 s ⇒ cap = 8 / 8 / 11.3 / 15；1.0 s ⇒ 10 / 15 / 22.5 / 30。低帧率下 0.5 直接撞下限，几乎没变 |
| 选项文件里 `VOXEL_GI_DARK_ACCUM=true`          | 暗处 `accumCap ×4` ⇒ 60 fps 下 0.5 s 仍有 15×4 = 60 帧历史，拖影时间常数约 1 秒                                          |
| `GI_STABILIZE_FRAMES` 8 → 4               | `historyWeight = N/(1+N)`：0.889 → 0.800，**只降 10%**，人眼不可辨                                                |

⇒ 拖影的主导项是「长历史 + 暗处 ×4」，**调历史长度这类小步参数动不了它**。上一轮把这两个当成主旋钮是错的。

#### 本轮修复：`GI_MOTION_RESPONSE`（默认 1.0）

- 机制：`Accumulate.frag` 按重投影位移 `length((prevCoord - screenPos.xy) * viewSize)` 把本帧权重抬到 ≥0.35；  
  `GIStabilize.comp` 按同一位移把 `historyWeight` 压到 0。位移 2 px 起效、12 px 满响应；  
  **静止（含 TAA 亚像素抖动 < 1 px）逐位不变**。
- 量级：拖影时间常数从 cap 帧（暗处可达 60）压到约 2 帧，不是 10% 的微调。
- 代价：移动时历史让路 ⇒ 噪点上升（已知取舍）。一键回退 `GI_MOTION_RESPONSE=0`。
- 四处接线齐全（settings / properties 的 screen.VXGI 与 sliders / 双语 lang），两个 comp 有 `#ifndef` 兜底。
- 三套检查全绿。**待实机**：重载后沿墙平移 3 秒，报「拖影是否变短 + 移动噪点能否接受」。

---

## 0. 现行管线（对照基准）

| 阶段    | 官方 pass                                | 本包实现                                       | 缓冲                                |
| ----- | -------------------------------------- | ------------------------------------------ | --------------------------------- |
| 追踪    | 外部信号源 | `deferred1_a` DiffuseIndirect | 3（画布象限） |
| 预滤波   | `REBLUR_PrePass` | `deferred1_b` GIPrepass | 22 颜色+normHit，26 平滑 normHit |
| 历史修复 | `REBLUR_HistoryFix`（TA **之后**，输出只喂 Blur、不回写历史） | `deferred5` GIHistoryFix（已按官方重写；`deferred1_c` 退役） | 25（当帧临时） |
| 时域累积 | `REBLUR_TemporalAccumulation`（历史 = 上一帧 PostBlur 输出） | `deferred4` Accumulate | 2 累积，14 法线/深度/去遮挡，21 短历史 |
| 方差    | 无独立 pass | **NRD 路径无**（deferred5 让位给 HistoryFix）；GI_MODE 1 仍用 VarianceEstimate | — |
| 空间滤波 | `REBLUR_Blur` + `REBLUR_PostBlur` | 4 遍 EAWF（第 4 遍兼 post blur，权重 0.25） | 25↔3 乒乓（最终在 25） |
| 时域稳定化 | `REBLUR_TemporalStabilization` | `deferred11` GIStabilize（历史快照在 colortex24） | 23 |
| 历史回流 + TS 快照 | `PostBlur` 输出 = 下一帧 TA 的 `gHistory_Diff` | `deferred10` GIHistoryStore | 2（主历史）/ 24（TS 快照） |
| 输出    | 上采样后合成                                 | `DeferredLight`                            | `colortex23` → 屏幕                 |

---

## 1. 输入层（决定所有常数的标定基准）

| #   | 项目               | 官方行为 / 值                                                                                            | 现状                                                                                                                                                                                                 | 判定标准（PASS 条件）                         | 验证  | 状态                                                                                                                                                                                                                                   |
| --- | ---------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 | 输入样本数            | 1 spp，喂给降噪器的是**单帧单样本**（prepass 8 tap @30 是降噪第一级，不是追踪端预滤）                                            | `VOXEL_TRACE_SPP = 1`；**ReSTIR 复用已 `#undef VOXEL_REUSE`**（见 VoxelLighting.glsl:48-50，复用分支是死代码）⇒ 每画布像素每帧 1 条新射线，与官方同构。差异只剩：prepass **32** tap vs 官方 8；画布半分辨率（像素数少 4 倍，**不是**样本多 4 倍）                | 每帧输入每像素 1 个独立样本；换算关系可解析               | N   | ✅ 已对齐：`S=Σw²/(Σw)²`，32 tap → S=0.0410（σ=0.203×1spp），官方 8 tap → S=0.125（σ=0.354×1spp）。等噪帧数 = 30×(0.0410/0.125) ≈ **9.8 帧** ⇒ `GI_EFFECTIVE_SPP` 理论 3.06；体素网格的相关误差不随 tap 数下降，故实际有效值落在 **1~3**，现值 **2.0** 在区间内、有依据                      |
| 1.2 | 噪声独立性            | 像素间独立                                                                                               | 无池化 ⇒ 每像素方向由自身 hash 决定，样本独立；但**体素 1m 网格量化**让"误差"空间相关（那是偏差不是方差，归 §3/§7 的 σ 处理）                                                                                                                      | 记录为已知偏差；只有 MC 分量服从 1/N                | N   | ✅ 样本独立成立；网格相关性已在 1.1 注明                                                                                                                                                                                                              |
| 1.3 | 运动矢量 | 精确 motion vector | 无，用深度 + 相机位移重投影：`worldPos + (cameraPosition - previousCameraPosition)` → 上帧 ModelView/Projection | 重投影在纯平移/旋转下误差 < 1 纹素（**只判矢量本身，不含拖影**） | N+V | ✅（2026-11-10 主人裁定）：公式解析成立（worldPos 为相机相对世界、上帧 MV/P 重投影），实机无整屏波前 / 整体错位，B 视图 6 全白 ⇒ 历史采样点几何一致。**拖影是下游多环节问题，已拆到 9.6，不再计入本项** |
| 1.4 | NaN / Inf        | `Denanify` 逐处防护                                                                                     | DiffuseIndirect / GIPrepass / EAWF / GIStabilize 原有；本轮补 **Accumulate 历史入口**（整条链上唯一漏的地方：NaN 读进 `prevDiffuse` 后写回又读到 ⇒ 永久锁死）                                                                         | 注入 Inf 不产生扩散                          | S+N | ✅ 已补（有限值时判断恒假 ⇒ 逐位不变）                                                                                                                                                                                                                |
| 1.5 | hit distance 有效性 | 每条命中给出有意义的距离                                                                                        | 默认 VXGI 路径本来就对：miss = 射程上限（远）、命中 = 米值。**有问题的是非默认路径**：IRC / 探针写 `1.0`（≈近距离命中）、SSILVB 的 `vec3` 赋值让 `.a` 漏成 `0`（最近命中）。已统一为 `GI_HITDIST_NONTRACED=1024`；`VOXEL_REUSE` 死代码里写 `1.0` 处改为回填 `reservoirW.a` | 所有分支写出的 `normHit` 都在同一量纲（近=小、远/无信息=1） | S   | ✅ 已修（影响面：IRC / 探针 / SSILVB 三种模式；**默认 VXGI 模式行为不变**）                                                                                                                                                                                  |
| 1.6 | 天空 / 背景          | `isSky` 早退，不参与任何滤波                                                                                  | GIPrepass / EAWF / GIStabilize / GIHistoryFix / Accumulate / DiffuseIndirect 六个 pass 均按 `depth >= 1` 早退（VarianceEstimate 拿到 0 输入 ⇒ 0 方差）                                                           | 天空像素不写脏数据、不渗色                         | S+V | ✅ 实机 C 通过（2026-11-10 主人）：天空 σ 纯黑、交界仅 1 px 过渡。写入侧 S 已证 + 肉眼 V 补齐                                                                                                                                                                      |
| 1.7 | 色彩空间             | 线性 RGB（`REBLUR_USE_YCOCG == 0`）/ **官方也支持 YCoCg 模式**（==1 时 `GetLuma = input.x`、`ChangeLuma` 整体缩放三通道） | 全程 YCoCg，且正是官方 YCoCg 模式的等价实现：`RGBToYCoCg` 为标准矩阵（Y=(R+2G+B)/4、Co=(R-B)/2、Cg=(2G-R-B)/4）；`GetLuma` 取 `.r`；火点压制是整体乘比例（= 官方 `ChangeLuma`）                                                              | 亮度判据在 Y 上，色差只随权重整体缩放                  | R   | ✅ 对齐（官方 `REBLUR_Common.hlsli:205-219`）。唯一会破坏 YCoCg 的负值 clamp 发生在**转 YCoCg 之前**的 RGB 域（`DiffuseIndirect.comp:906-907`），顺序正确；16F 下色差以差值存储、精度优于直接存 RGB                                                                                  |
| 1.8 | 输入动态范围           | 有限，需 firefly 抑制                                                                                     | 体素 tracer 单样本离群更多                                                                                                                                                                                  | `GI_FIREFLY_CLAMP` 标定到合适值（默认 0 = 未标定） | N+V | ❓                                                                                                                                                                                                                                    |

---

## 2. 分辨率与坐标

| #   | 项目              | 官方行为 / 值                                   | 现状                                                                                 | 判定标准                          | 验证  | 状态                                                                 |
| --- | --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------- | --- | ------------------------------------------------------------------ |
| 2.1 | 画布 texel ↔ 屏幕纹素 | `rt = canvasTexel * 2 + phase`             | 一致（全部 pass 同一换算）                                                                   | 4 个 pass 的映射完全一致，无 off-by-one | S   | ✅                                                                  |
| 2.2 | 画布相位            | 固定 `pixelPos / 2`（quarter-res README 明确要求） | `GI_CANVAS_PHASE = (0,0)`                                                          | 不轮转；轮转会显著增加 disocclusion      | R   | ✅                                                                  |
| 2.3 | 画布边界            | 夹取到 `[1, end-2]`                           | 一致                                                                                 | 半径 > 1 的核不会越界读                | S   | ✅                                                                  |
| 2.4 | 半分辨率 → 全分辨率上采样 | 官方 NRD 只输出降噪缓冲（半/四分之一分辨率），全分辨率重建由集成层负责 | `SpatialUpscale.glsl`：4 邻域十字 + 法线权重 + 相对深度权重；**档位由 SVGF_QUALITY 控制** | 边缘不渗色；块状可见度 | S+V | ❌ **2026-11-11 发现严重缺陷并修复**：`SVGF_QUALITY` 在 `shaders.properties` 的 screen.VXGI / screen.SSILVB 里登记了，但 `settings.glsl` **从未 #define 它** ⇒ Iris 认不出这个选项，GUI 滑块无效、配置文件里的 `SVGF_QUALITY=1` 也被忽略，`SpatialUpscale.glsl` 的 `#ifndef` 兜底成 **0 = 仅取中心值 = 最近邻放大**，每个 GI 画布纹素铺成 2×2 屏幕像素的硬方块。已补 `#define SVGF_QUALITY 1 // [0 1]` | **同日补第二条（官方 README 原文）**："bind downsampled guides to NRD but **retain the original full-resolution guides for the application-side resolve**" —— 旧上采样用的是**半分辨率** colortex14 的深度/法线，权重只在画布格点取值，全分辨率像素差异体现不出来 ⇒ 退化成 2×2 软混合。已改为全分辨率 `depthtex0` + 法线包。
| 2.5 | 奇数分辨率           | —                                          | `halfViewSize` 取整；`GICanvasCoord` 夹到 `ivec2(halfViewSize)-1`；EAWF 补了 dispatch 溢出早退 | 最右/最下 1 像素不出现半像素错位，且不越界读      | S+V | ✅ 实机 D 通过（2026-11-10 主人）：1367×769 下最右列/最下行无条带、白点、错位。越界索引另由整数数学证明修好 |



---

## 3. 预滤波（Prepass）

> **[2026-11-11 B0 更正] 官方权重形态**：`NRD_USE_EXPONENTIAL_WEIGHTS` 在 v4.11.4 与 master **默认都是 0**
> ⇒ 几何/法线权重实际生效的是 `ComputeNonExponentialWeight` = `SmoothStep(1, 0, u)` 三次窗
>（u ≥ 1 全拒、u = 0.5 时 0.5），**不是** `ExpApprox(-3u)`——那是需显式开启的指数变体
>（仅 hitDist 权重无条件使用它）。本节旧判定的「官方 t=1 ⇒ 0.077」是指数变体的值，默认配置下应为 0。
> 本轮已把 3.4/3.5/3.6/3.10/3.13 + 6.3/6.4/6.5 全部实现为**默认关的 A/B 开关 `GI_NRD_WEIGHTS`**
>（0 = 现状逐位不变；1 = 官方形态），四处接线齐全，待实机 V。

| #    | 项目                       | 官方值                                                                                                                                                                                     | 现状                                                 | 判定标准                                                | 验证  | 状态                                                                                                                                                                                                                    |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | 半径                       | `diffusePrepassBlurRadius = 30`（NRD rect 像素）；另乘 `sqrt(hitDistFactor)`、下限 `minBlurRadius = 1`                                                                                            | 固定 30 画布纹素，无自适应/下限                                 | 与官方同口径（半分辨率 ⇒ 30 画布 = 60 屏幕）；HANDOFF §8 的「改 15」疑问作废 | R   | ✅ 口径已证（**保持 30**）：官方用 `gRectSizeInv * blurRadius` 换算偏移（v4.11.4 DiffuseSpatialFilter:83 / master SpatialFilter:160），半径按 NRD rect 像素、不随渲染分辨率缩放；quarter-res README 明确 NRD 视其为 full-res input，集成层对 30 不做缩放。自适应收缩缺失 ⇒ 3.13 |
| 3.2  | 样本数                      | 8（`REBLUR_POISSON_SAMPLE_NUM`，Poisson disk；注意 `g_Special8` 是 Blur/PostBlur 的图案，两者别混）                                                                                                    | 8（黄金角 Vogel）                                       | 与官方同数量；同分辨率、同半径 ⇒ 采样密度一致                        | N   | ✅ **2026-11-11 由 32 收回 8**：原判定「半径 15→30 后按同密度需 64」把**半径变化**误当成**分辨率差异**，而官方 prepass 本就跑在半分辨率、半径就是 30。收回后 `S = Σw²/(Σw)²` = 0.125 与官方同值，prepass fetch 开销降 75%                                            |
| 3.3  | 采样图案                     | 固定 8 点盘 + `NRD_FRAME` rotator（逐帧 + 每像素分量）                                                                                                                                               | 8 点 Vogel + 2x2 共享 hash + 逐帧黄金角                     | 图案无固定方向性；旋转角逐帧变化                                    | S+R | ⚠️ 结构对齐（两条判据成立），但图案与旋转粒度均非官方：官方每像素 rotator、我们 2x2 共享。原 ✅ 撤回为 ⚠️                                                                                                                                                       |
| 3.4  | 平面距离权重 | 默认 `ComputeNonExponentialWeight` = `SmoothStep(1, 0, t)` 三次窗（**默认** `NRD_USE_EXPONENTIAL_WEIGHTS = 0`，Common.hlsli:58；`ExpApprox` 只在 hitDist 处显式使用） | `t = planeDist / (0.02·frustumSize)`，`w = 3u²-2u³`（u = saturate(1-t)） | t = 1 时权重 0（深度断层两侧全拒） | R+N | ✅ **2026-11-11 成为唯一路径**：旧 `exp(-t)`（t=1 仍留 0.368）与 `GI_NRD_WEIGHTS` A/B 已删除 |
| 3.5  | 法线瓣角权重 | `w = ComputeNonExponentialWeight(angle, 1/angleMax, 0)`，`angleMax = max(atan(tanHalf), NRD_NORMAL_ENCODING_ERROR)`，prepass `fractionScale = 2` | `param = 1.1748`，`w = SmoothStep(1, 0, angle·param)` | 半球外样本权重 0；过渡连续 | R+N | ✅ **2026-11-11 成为唯一路径**：旧 `smoothstep(0.952, 0.992, dot)` 硬阈已删除。param 推导：pov = 0.75·lerp(0.15,1,1/11) = 0.1705 → tanHalf 0.4533 → angleMax 0.4256 rad → (1/0.4256)/2 = 1.1748 |
| 3.6  | 高斯权重 | `GetGaussianWeight(r) = exp(-0.66·r²)`，r 归一化到 1（Common.hlsli:564） | `exp(-0.66·rn²)` | r = 1 时 0.517 | R | ✅ **2026-11-11 成为唯一路径**：旧 `exp(-2rn²)`（r=1 只剩 0.135）已删除 |
| 3.7  | hitDist 平均               | `diff += s · w`（REBLUR_TYPE 的 .w 随颜色一起平均）、`diff /= Σw`                                                                                                                                  | `hitSum / wSum`（原始米值）后再归一化                         | 不得对原始 hitDist 做 saturate                            | S+R | ⚠️ 近似对齐：官方逐 tap 输入已是归一化值再平均；我们先平均米值、后用中心深度归一化。视深差小的时候等价，掠射/深度断层处有偏                                                                                                                                                    |
| 3.8  | 归一化 hitDist              | `f = (A + abs(viewZ) · B) · lerp(1, C, exp2(D · roughness²))`，A=3 B=0.1 C=20 D=-25；diffuse roughness=1 ⇒ `f = 3 + 0.1 · abs(viewZ)`                                                     | 一致                                                 | 近处 → 0，远处 → 1，单调                                    | R   | ✅ 重判保留：v4.11.4 NRD.hlsli:509 与 master NRD.hlsli:597 两版公式等价，我们的 `abs(viewZ)` 与 `saturate` 均正确                                                                                                                          |
| 3.9  | 方差估计                     | **官方 prepass 不估方差**（两版 spatial filter 全文无一/二阶矩；REBLUR 的 σ 在 TS 由 3x3 luma 邻域算，见 7.7）                                                                                                    | `colortex24` 加权 `E[x²]-E[x]²`，只被调试视图 2 读           | 与真实样本方差误差 < 5%（离线）                                  | R+N | ⚠️ 自造项，原 ✅ 撤回。旧估计有偏：平场 -4.1%、判据拒掉半数样本时 -24%（`E[var] = σ²(1-S)`）。本轮补 `1/(1-S)` 校正，蒙特卡洛 0.9995 / 0.9991（真值 1.0）。不影响画面，只改调试视图 2 读数                                                                                       |
| 3.10 | 能量归一 | `sum = 1.0; result = 中心样本` 起手 ⇒ 中心样本**无条件**参与且权重 1（SpatialFilter:67-70） | 同：`sum = _center.rgb; wSum = 1.0; hitSum/lSum/... 均以中心起手` | 输入平场 ⇒ 输出平场；邻域全拒时退化为恒等 | R+N | ✅ **2026-11-11 成为唯一路径**：旧实现 `sum = 0` + `wSum < 1e-4` 兜底已删除 |
| 3.11 | firefly                  | **ReblurSettings 没有 `fireflyClampThreshold`**（两版都只有 `fireflySuppressorMinRelativeScale`；suppressor 在 TA，见 4.11）                                                                         | 自造 `GI_FIREFLY_CLAMP`，默认 0，此前 **GUI 未接线**（半成品）     | 默认 0 逐位不变；开启后极端离群被压到阈值内                             | S+V | ⚠️ 自造 / 默认关。本轮补齐四处接线（settings / properties screen+sliders / 双语 lang），默认观感不变。开启效果 ⏳ 待 G                                                                                                                                |
| 3.12 | 平滑 hitDist（EMA）          | 无（prepass 输出即时归一化 hitDist）                                                                                                                                                              | `colortex26` 0.15 EMA                              | 半径不随帧抖动；EMA 滞后 ≤ 3 帧                                | R+N | ⚠️ 自造且**判定标准不成立**：0.15 EMA 的时间常数 ≈ 6.7 帧（10% 衰减 ≈ 15 帧），不是 ≤3 帧。保留但改写口径                                                                                                                                               |
| 3.13 | 半径自适应 + hitDist 权重 | `blurRadius = max(saturate(sqrt(hitDistFactor))·MAX_BLUR_RADIUS·smc, gMinBlurRadius)`；`w *= minHitDistWeight + ExpApprox(-3·|Δhit|/NLAS)`（SpatialFilter:113-124/266） | 同：`prepassRadius = max(sqrt(saturate(hitDist_m/frustumSize))·30, 1)`；`w *= 0.2 + rcp(33Δ²+33Δ+1)`（NLAS=1/11、fractionScale=2） | 接触区半径自动收缩；跨 hitDist 样本不互混 | R+N | ✅ **2026-11-11 成为唯一路径**：旧 `const 30` 与「无 hitDist 权重」已删除 |
| 3.14 | 命中距离归一化域（本轮新增） | alpha 里是**归一化**命中距离（front-end 完成除法）；prepass 平均的也是归一化值，**每个 tap 用自己的 viewZ 算分母**（SpatialFilter:111-112/248-251） | 2026-11-11 前：平均**米值**，再用**中心像素**的分母归一化 | 平坦面两者恒等；深度不连续处归一化值不被最远 tap 主导 | R+N | ✅ **2026-11-11 已对齐**：逐 tap 计算 `saturate(a_tap / (A+|z_tap|·B))` 后加权平均，输出直接就是归一化值。旧写法在台阶/接触区会把 normHit 顶到 1 ⇒ hitDistFactor=1 ⇒ 半径永远取满 ⇒ 过糊 |


> **§3 本轮重判小结（2026-11-10）**：原有 ✅ 全是继承来的，逐条回官方源码后只剩 3.1（口径）与 3.8 站得住；  
> 3.4 / 3.5 / 3.6 / 3.9 / 3.10 是错判（系数、函数形态、官方是否真有该项），3.3 / 3.7 只是近似对齐。  
> 新增 3.13 记录两项真正缺失的官方机制。**本轮没有改动任何默认观感**：3.11 只补接线，3.9 只改调试视图 2 的读数；  
> 权重类差异统一留到「默认关的 A/B 开关」批次，实机确认后才动默认值。  
> 三套检查全绿：语义 / 静态 / 预处理 345 入口无新增命中；properties 非 ASCII 0、lang 无 BOM、GIPrepass 预处理 8/8 配平。

---

## 4. 时域累积（TA）

> **§4~§8 逐项重判（2026-11-11）**：原有 ✅ 全是继承来的，逐条对照官方 `master = v4.18.0`
> （与 v4.11.4 交叉）后大幅修正。证据写文件名与行号；只判结构/公式，观感项一律 ⏳ 等主人实机。
> 权威文件：`Shaders/REBLUR_TemporalAccumulation.cs.hlsl`、`REBLUR_Common.hlsli`、`Shaders/Include/NRDSettings.h`。

| # | 项目 | 官方行为 | 现状 | 判定标准 | 验证 | 状态 |
|---|---|---|---|---|---|---|
| 4.1 | 重投影 | surface/virtual motion vector，历史用 CatRom12 带 fallback 到 Bilinear（TA:167-173），disocclusion 逐 tap 判定（TA:253-267） | 深度 + 相机位移，4-tap 双线性（1.3 已 ✅） | 静止/纯平移 0 误差（1.3 已实机确认） | N+V | ✅ 矢量本身成立；历史采样滤波器是 CatRom12 而非双线性 ⇒ 归入 4.3 |
| 4.2 | 去遮挡判据 | `GetDisocclusionThreshold(0.01, frustumSize, NoV)`，逐 tap 用 `step(planeDist, threshold)` 生成 **二值 occlusion 位**（TA:254-267） | `tapGeo = saturate(1 - dist/tol)` 连续权重 × 法线 `linearstep`，另加相位补偿 `6·giDepthGrad` | 掠射面不误拒，遮挡边界必拒 | S+R | ⚠️ 结构等效但形态不同：官方是二值位 + 双线性质量，我们是连续权重；相位补偿是本包特有。原 ✅ 撤回 |
| 4.3 | 历史采样 + 深度容差 | **颜色历史也用双三次**：`BicubicFilterNoCornersWithFallbackToBilinearFilterWithCustomWeights`（TA:934-937、TS:147-152），门控 `dot(16 个 occlusion 位, 1) > 11.5`；帧数走双线性（`ApplyBilinearCustomWeights`） | `HistTap()` 逐 tap 几何判据；颜色 = CatRom 12 tap（4×4 去 4 角，门控 `足迹有效率 > 11.5/16`）或双线性兜底；**帧数与 quality 恒走双线性** | 边界夹取不越界；跨深度历史不得混入；历史不被反复重采样糊掉 | S+R | ✅ **2026-11-11 实现**。CatRom 的意义在 Recurrent 下放大：同一份历史逐帧重采样，双线性的模糊会**累加**，CatRom 负瓣可抵消。负瓣也乘 tapGeo（否则跨表面负权重造成边缘过冲）；`abs(crW) < 1e-3` 时退回双线性 |
| 4.4 | 颜色盒 clamp | **官方 TA 没有颜色盒**：`MixHistoryAndCurrent` 是纯 `lerp(history, current, f)`（REBLUR_Common.hlsli:193）；fast-history clamp 在 **HistoryFix** pass（HistoryFix.cs:278/487） | 5×5 μ±kσ 的 fast clamp + `+0.02` 门控地板；**`GI_FAST_CLAMP_SIGMA` 默认已改 0.0（关闭）** | 突变被裁到邻域范围 | R | ❌ 自造且位置错，**2026-11-11 起默认关闭**（对齐官方 TA）。>0 时保留旧行为做 A/B；它会把长历史每帧拉向 6 帧短历史的噪声，是静止残噪来源之一 |
| 4.5 | alpha | `GetAdvancedNonLinearAccumSpeed(accumSpeed)` = `1/(1+e·N)`，`e = s·lerp(b,1,saturate(N/(1+p·maxAccum)))`，默认 s=1/b=0.2/p=0.8（NRDSettings.h:254-268、REBLUR_Common.hlsli:302-308） | `_convS=1 / _convB=0.2 / _convP=0.8`，`alpha = 1/(1+k·N)` | 静止收敛曲线与公式逐项一致 | N+R | ✅ 重判保留：常数与公式逐项对齐，是本链少数真正与官方一致的一项 |
| 4.6 | `maxAccumulatedFrameNum` | 30（NRDSettings.h:279），注释要求「按秒而非按帧」；`REBLUR_DEFAULT_ACCUMULATION_TIME = 0.5 s` | `GI_ACCUM_TIME/(frameTime·GI_EFFECTIVE_SPP)`，clamp 下限 8，暗处 `×4` | 60 fps / 0.5 s ⇒ cap = 30（官方同值） | N | ⚠️ **已修正**：`GI_EFFECTIVE_SPP` 2.0→**1.0**（VOXEL_REUSE 已 undef ⇒ 与官方 1 spp 同构），旧值 2.0 把 0.5 s 腰斩成 15 帧，是「静止满屏噪点」的直接来源之一。剩余偏差：下限 8 + 暗处 ×4 仍是 9.6 拖影来源 |
| 4.7 | σ / 颜色盒 | 官方 TA 无 σ；`fastHistoryClampingSigmaScale=2` 只出现在 HistoryFix（HistoryFix.cs:482） | 我们在 TA 自造 fast clamp（见 4.4） | 官方 TA 不产生 σ | R | ⚠️ 自造，官方对应项在 §5 而非本链；保留但标注，与 4.4 同一处代码 |
| 4.11 | anti-firefly | `maxRel = 2 + 38/(accumSpeed+1)`；`amount = accumSpeed·maxBlurRadius·0.1` 饱和；`ChangeLuma(result, lerp(luma, min(luma, cap), amount))`，fast 分支 ×1.5（TA:960-999） | 主链 + 短历史同口径（Accumulate.frag:370-397） | 单帧火点不进入主/短历史 | R+V | ✅ 实机 E 通过（2026-11-10 第二轮重载）：火点移走 1~2 帧回全绿。唯一缺口：官方对 `.w`=hitDist 也 clamp，我们的 `.a` 是历史长度 ⇒ 不适用 |
| 4.12 | 负值历史 | `ClampNegativeToZero`：YCoCg 模式转回 RGB、clamp 负值、再转回（REBLUR_Common.hlsli:221-233） | **2026-11-11 补上**（Accumulate 的历史入口，紧跟 NaN 兜底） | 历史不得含负亮度 | S | ✅ 新增。负 Y 会让 antilag / RCRS / firefly 的亮度判据拿到错误分母（黑块、滤波异常）；正值历史往返恒等 |
| 4.13 | 历史缓冲的尺寸/mip/UV 口径（本轮新增） | NRD 的 `resourceSize = rectSize`（降噪分辨率），所有读写都用同一个 `pixelPos`；NRD 自己**不做 mip 链** | colortex3 是全分辨率共享暂存缓冲（GI 只写左上 1/4）；`Accumulate` 的非 NRD 回退曾用 `textureLod(colortex3, texelToUv(texelPos), 3.0)` | 半分辨率信号只能用画布坐标 + texelFetch 读取 | R | ❌ **2026-11-11 已修**：`texelToUv` 是全分辨率像素尺寸，而 texelPos 是画布坐标 ⇒ 取到「整张全分辨率缓冲的第 3 级 mip」，与画布内容完全错位（等于把 1/16 分辨率当邻居起点）。改为画布坐标 4-tap `texelFetch`；同时删掉只为它服务的 `colortex3MipmapEnabled`（省一条全分辨率 mip 链）。另 `DeferredLight` 的 SSILVB 分支 `texelPos >> 1` 改为 `GICanvasCoord()`（奇数分辨率越界） |
| 4.8 | fast history | `maxFastAccumulatedFrameNum = 6`；`diffFastAccumSpeed = min(data1.x, 6)`，`fastNonLinearAccumSpeed = 1/(1+N)`（TA:988-994） | 固定 1/6 混合率 | 快速变化可由 fast history 兜底 | S+R | ✅ **2026-11-11 对齐**：改为 `1/(1+min(prevAge,6))`（N=1 ⇒ 0.5，N=6 ⇒ 0.143）。旧固定 1/6 让新像素要 6 帧才跟上（官方 2 帧） |
| 4.9 | 历史长度写回 | 打包进 `gOut_Data1` / `data1.x` | `colortex2.a`（长度），`colortex21.a`（几何质量） | 下游读取位置一致不串台 | S | ✅ 语义对齐，通道划分是本包特有 |
| 4.10 | antilag | master TA 全文无 `ComputeAntilag`；只在 TS 调用（TS.cs:157/272） | 已删除自造的 TA antilag | TA 不做亮度自适应 | R | ✅ 重判保留（master 与 v4.11.4 一致） |

---

## 5. 历史修复（HistoryFix）

> 权威文件：`Shaders/REBLUR_HistoryFix.cs.hlsl`（v4.11.4 为 `Shaders/Include/REBLUR_HistoryFix.hlsli`）。
> **官方 HistoryFix 在 TA 之后**（HistoryFix.cs:99 注释：frameNum after TemporalAccumulation is 1, not 0）。

| # | 项目 | 官方行为 | 现状 | 判定标准 | 验证 | 状态 |
|---|---|---|---|---|---|---|
| 5.1 | 触发条件 | `stride = float2(frameNum < gHistoryFixFrameNum)`，`historyFixFrameNum = 3`（HistoryFix.cs:64、NRDSettings.h:292） | `wFix = saturate((3-age)/2)`，age 越低修复越满；去遮挡标记强制 age=1 | 只在低 age 区生效 | S+R | ✅ 实现方向正确；清单旧写「age ≥ 3」是**文档写反**，已更正 |
| 5.2 | 步长 | `historyFixBasePixelStride = 14`（NRDSettings.h:295），且随 frameNum / hitDistFactor 动态缩放并 round（HistoryFix.cs:99-120） | 固定画布 4 纹素（±8 屏幕像素）的紧凑 5×5 | 半分辨率换算正确 | R+V | ⚠️ **刻意偏离**：第一版按官方 14px 实测出现硬边界/补丁感（MEMO 1682-1692），改小后消失。原 ✅ 撤回 |
| 5.3 | 权重 | 深度（三次窗）+ 法线（**指数** `ExpApprox(-3·angle·param)`）+ **`1+data1.x`** + hitDist（指数）；5×5 去中心去 4 角 = 20 tap（HistoryFix.cs:145-195） | 同：几何走 `WindowWeight`、法线与 hitDist 走 `ExpWeight`、`w *= 1 + 邻居帧数`（不夹） | 跨表面/跨命中距离不参与；长历史邻居优先 | S | ✅ **2026-11-11 对齐**：法线权重此前用三次窗（官方这两处显式用指数）、邻居帧数此前夹到 3（官方不夹） |
| 5.4 | 继承历史长度 | **不改帧数**：HistoryFix 只重建颜色，`data1` 由 TA 算好、PostBlur 原样写出（HistoryFix 无 `gOut_InternalData` 写入） | 输出 `.a` 现在原样透传 TA 的帧数（此前写死 1.0） | 修复值不得改变累积计数 | S | ✅ **2026-11-11 修正**：`.a` 改透传。另注意 HistoryFix 自身没有「支撑门槛」——官方是无条件重建 + 归一化（`sumd = 1+frameNum` 起手，循环里累加），我们此前的 needW 门槛已删除 |
| 5.5 | 修复器数量 | 1 处 | 1 处（deferred1_c；Accumulate 内联那份已删） | 不存在第二份修复 | S | ✅ 重判保留 |
| 5.8 | **Recurrent 回流**（已按官方启用） | 主历史 = 上一帧 PostBlur（空间滤波）输出。证据：只有 PostBlur 的 `gOut_Diff`=PERMANENT，而 TA 的 `gHistory_Diff` 正是 PERMANENT 输入。论文：Zhdan, "ReBLUR: A Hierarchical Recurrent Denoiser", Ray Tracing Gems II 2021 ch.49 | `GIHistoryStore` 帧末把 colortex2.rgb 覆盖为 colortex25（EAWF 最终输出），保留 `.a` 帧数 | `H_{n+1}=Filter(lerp(H_n, 输入, alpha))` | S+N | ✅ **拓扑重排后默认开启**（`GI_RECURRENT_HISTORY=1`）|
| 5.6 | pass 位置（**已按官方重排**） | 官方 C++ 派发顺序（`Source/Reblur.cpp:145-186`）：`PREPASS → TEMPORAL_ACCUMULATION → HISTORY_FIX → BLUR → POST_BLUR → TEMPORAL_STABILIZATION`；HistoryFix 的输出 `gOut_Diff` 是 `NRD_RESOURCE_OUT`，**只喂 Blur、不回写历史** | `deferred5`（TA 之后）按官方重写：只对 `frameNum < 3` 的像素做宽步长重建（基 stride 7、5×5 去 4 角 = 20 tap，权重 = 平面距离 × 法线瓣角 × (1+邻居帧数) × 命中距离），随后无条件做 fast-history 亮度夹取；输出 colortex25 只给 EAWF；`deferred1_c` 退役 | 修复值不得进入历史 | S | ✅ **2026-11-11 重排完成**：原来"先修历史、且修复值写进历史"会让邻居的旧 GI 永久固化（跨表面拖影的结构性来源），现已消除 |
| 5.7 | fast-history clamp（本轮新增） | 官方在 **HistoryFix** 里做：σ 取 fast history 半径 2（5×5）× `fastHistoryClampingSigmaScale=2.0`，亮度夹到 μ±σ，再按历史长度软化 `lerp(clamped, orig, 1/(1+N·2))`，最后 `ChangeLuma`（只动亮度、色差按比例）（HistoryFix.cs:270-290、REBLUR_Config.hlsli:107） | 我们原先只在 **TA** 里有自造 5×5 clamp（已默认关，对齐官方 TA 无颜色盒），HistoryFix 里没有 ⇒ 关掉后「长历史被短历史拉回」的机制整个消失 ⇒ 拖影变长 | 静止不触发（μ 差 < 2σ_fast）、移动时把滞后历史拉回 | S+V | ⚠️ **2026-11-11 已补**：在 GIHistoryFix 的 `wFix<=0` 分支按官方写法实现（`FAST_CLAMP_SIGMA=2.0`）；只处理历史稳定的像素，`age<3` 的修复路径不受影响。待 V |

---

## 6. 空间滤波（Blur / a-trous）

> 权威文件：`Shaders/REBLUR_Blur.cs.hlsl`、`REBLUR_PostBlur.cs.hlsl`、`REBLUR_Common_SpatialFilter.hlsli`。
> 注意：**官方没有 `postBlurRadius` 字段**（NRDSettings.h 全文无），旧清单的「postBlurRadius=4」是编造。

| # | 项目 | 官方行为 | 现状 | 判定标准 | 验证 | 状态 |
|---|---|---|---|---|---|---|
| 6.1 | pass 数 / 半径分摊 | Blur 与 PostBlur 是**两个独立 dispatch**，共用一份 `REBLUR_Common_SpatialFilter.hlsli`；差别只在 `radiusScale`(1.0/2.0) 与 `fractionScale`(1.0/0.5)（REBLUR_Config.hlsli:86-93） | `deferred6` = Blur、`deferred7` = PostBlur，同一份 `EAWF.comp` 由 `FILTER_PASS_INDEX` 分派；`deferred8/9` 已删除 | 两个步长都真实执行，总覆盖与官方同量级 | R+S+N | ✅ **2026-11-11 重写**：旧 4 级 a-trous（1:2:4:8 分摊 + 第 4 级兼 3×3 小环）已删除。新结构 Node 实测：稳定像素 Blur 2.85 + PostBlur 5.70 = **8.6 画布纹素**（旧 4 级约 4.5），新像素 15.6 + 30.0 = **45.6**；每遍 8 个 tap 全部落在不同位置（无 round 回中心的空转） |
| 6.2 | 半径口径 | `blurRadius = saturate(radiusScale·sqrt(hitDistFactor·NLAS))·maxBlurRadius`，`maxBlurRadius = 30`、`minBlurRadius = 1`（SpatialFilter:113-124） | `NRD_RADIUS_PX × 10 = maxBlurRadius`（3.0 即官方 30），下限 1 画布纹素 | 与官方同值 | N+V | ✅ **2026-11-11 对齐**：`max(saturate(radiusScale·sqrt(hitDistFactor·NLAS))·30, 1)`，`radiusScale` 由 pass 决定。`blurRadius` 单位改为画布纹素、直接当像素偏移用（不再分摊） |
| 6.3 | 几何权重 | `ApplyGeometryWeightLast` ⇒ 默认为三次窗 `SmoothStep(1,0,t)`（Common.hlsli:557-565；`ExpApprox(-3t)` 是指数变体，见 §3 节头更正） | `exp(-t)`（EAWF 主循环 + post-blur 3×3） | 台阶/边缘不糊穿 | R | ⚠️ **B0b 已实现**（`GI_NRD_WEIGHTS=1`：主循环与 post-blur 都换三次窗），默认 0 不变，待 V |
| 6.4 | 法线权重 | 按夹角连续权重，param 随像素累积速度收紧（SpatialFilter:232/236；新像素全拒角 ≈ 60°、稳定 ≈ 22°） | `smoothstep(0.952,0.992,dot)` 硬阈（EAWF 主循环 + post-blur） | 折角两侧不互混 | R | ⚠️ **B0b 已实现**（`GI_NRD_WEIGHTS=1`：按角度连续三次窗，param = 1/angleMax(NLAS)），默认 0 不变，待 V |
| 6.5 | hit distance 权重 | `w *= minHitDistWeight + ComputeExponentialWeight(hitDist_s, params)`（SpatialFilter:266），minHitDistWeight = 0.1·NLAS，u = 3·|Δ|/NLAS | `w *= mix(0.1,1,saturate(colortex26.r))`（EAWF:299） | 近命中不被完全丢弃 | R | ⚠️ **B0b 已实现**（`GI_NRD_WEIGHTS=1`：`0.1·NLAS + rcp(u²+u+1)`，Δ 取 colortex26 中心/邻居差），默认 0 不变，待 V |
| 6.6 | 采样图案 | `g_Special8`（Common.hlsli:207）：4 个轴点（半径 1.0，高斯 r=1）+ 4 个对角点（半径 0.25√2 = 0.5，高斯 r=0.5）；`NRD_FRAME` rotator | `SPATIAL_DIR[8]` / `SPATIAL_GAUSS_R[8]` 逐点照抄 | 8 个 tap 覆盖均匀、无重叠 | R | ✅ **2026-11-11 对齐**：旧黄金角 Vogel 已替换。官方还有一项 `skew = lerp(1-\|Nv.xy\|, 1, NoV) / max(...)` 的各向异性**已同时补上** |
| 6.7 | 半径随累积速度收缩 | `areaFactor = hitDistFactor · NON_LINEAR_ACCUM_SPEED`，`blurRadius = radiusScale·sqrt(areaFactor)·MAX_BLUR_RADIUS`（SpatialFilter:117-124） | `radiusScale = max(sqrt(nonLinearSpeed),0.5)` × `hitDistFactor`（EAWF:173-184） | 稳定像素半径小、新像素半径大 | N+R | ✅ 结构对齐；下限 0.5 是自造（官方用 `gMinBlurRadius=1`） |
| 6.8 | post blur | 独立 pass，`REBLUR_POST_BLUR_RADIUS_SCALE = 2.0`、`FRACTION_SCALE = 0.5`、8 tap 同款图案（**不是 3×3**） | `deferred7`，`radiusScale 2.0` / `fractionScale 0.5` | 半径 = Blur 的 2 倍；法线判据更严、minHitDistWeight 减半 | R+N | ✅ **2026-11-11 实现**：旧实现把它当成「权重 0.25 的 3×3 小环」并进第 4 级，与官方结构不同。现在 `fractionScale` 同时作用于 `normalParam`（×2 更严）与 `minHitDistWeight`（×0.5） |
| 6.9 | firefly 钳制 | **Blur 里没有**：suppressor 在 TA（4.11）、RCRS 在 TS（7.4） | 无独立实现 | 不出现孤立亮斑 | R | ⚠️ 归类错：这不是 §6 的项，官方对应机制已分别记在 4.11 / 7.4。原 ✅ 撤回为「N/A 归类」 |

---

## 7. 时域稳定化（TS）

> 权威文件：`Shaders/REBLUR_TemporalStabilization.cs.hlsl`、`REBLUR_Common.hlsli`（v4.11.4 为 `Shaders/Include/REBLUR_TemporalStabilization.hlsli`）。

| # | 项目 | 官方行为 | 现状 | 判定标准 | 验证 | 状态 |
|---|---|---|---|---|---|---|
| 7.0 | TS 历史缓冲读写同帧（本轮新增，清单此前漏记） | TS 读的是**上一帧**稳定化结果；NRD 用双缓冲，读写不落在同一张纹理上 | 修复前 `GIStabilize`（纯 compute，不 flip）在**同一 dispatch** 里 `texelFetch(colortex23)` 当历史、又 `imageStore(colorimg23)` 写本帧输出 ⇒ 两者都是 main，真竞态（EAWF 当年因此改 ping-pong）。静止时重投影落在自身、移动时邻居可能已被别的 invocation 写过 ⇒ 历史值是本帧未稳定化数据而非上一帧 | 历史源与输出缓冲必须不同；静止重投影落在自身时不出现逐帧不确定 | S+V | ⚠️ **已修**（2026-11-11）：`GIHistoryStore`（deferred10，本帧 EAWF 乒乓已用完）先把上一帧 colortex23 快照到 colortex25，GIStabilize 改读 colortex25、输出仍写 colortex23，DeferredLight 不变。两个 pass 派发条件同为 `REBLUR_ON`、10 在 11 前，中间无片元 pass 故无 flip ⇒ 读到的内容与修复前严格等价。三套检查全绿，**观感待 V** |
| 7.1 | footprint quality | `ApplyBilinearFilter(smbOcclusion)` 后 sqrt，再乘 **sizeQuality**（视角拉伸补偿，TA:322-329）；occlusion 是 TA 逐 tap 的二值位 | **2026-11-11 起按同一判据在 TS 内重算**：`tapGeo = saturate(1-|viewPos.z-aux.z|/disocTol)` × 法线，`disocTol = frustumSize·saturate(0.01/max(0.05,NoV))`；**并补了 sizeQuality**；**2026-11-11 判据统一**：改用**切平面距离**（`PLANE_DIST_SENS_TS = 0.02 × frustumSize`），与 prepass / EAWF / HistoryFix 同一口径；不用 |ΔviewZ| —— 掠射面上一个纹素的视深差与深度断层同量级，纯深度差判据必然过拒（历史权重掉 0 ⇒ 闪）或过松 | 新暴露像素权重接近 0；跨深度历史不得混入；视角拉伸时降权 | S+V | ⚠️ **已修三处**：① 只读 colortex21.a（每像素自己的质量，不是这 4 个历史 tap 的）⇒ 跨深度拖影；② 缺 sizeQuality；③ `colortex14` 在本 pass 存的是**本帧**内容（Accumulate 已写过并 flip），旧代码拿它比 `prevViewPos.z` = 跨帧混用两套坐标系，相机一动判据就系统性偏移。现在两侧同帧同坐标系 |
| 7.2 | antilag | `ComputeAntilag(h, m1, sigma, footprintQuality·data1.x)`（TS.cs:157）；`magic = antilag.y·(2·fps)²`（REBLUR_Common.hlsli:237-241） | `magic = SENS·framerateScale²`，`accumSpeed = stabAge·quality`（GIStabilize:191-207） | 真实变化 1~2 帧内历史权重掉到 <0.3 | R+V | ⚠️ **B2 已实现**（`GI_NRD_TS=1`：magic 补 (2·fps)² 的 4 倍），默认 0 不变，待 V |
| 7.3 | 颜色盒 tol | `Color::Clamp(diffLumaM1, diffLumaSigma·params.y, diffLumaHistory)`，`params.y = 1+w·3·2·fps`（TS.cs:163-169、REBLUR_Common.hlsli:312-320）；**只夹亮度**；最终混合 = `ChangeLuma`（本帧颜色整体缩放到稳定化亮度，色差来自本帧） | `hist = clamp(prev.rgb, mu±tol)` 夹三个通道，`tol = sigma·(1+3·fps·hw)+mu·0.1+0.01` | 暗处不持续蠕动 | R+V | ⚠️ **B2 已实现**（`GI_NRD_TS=1`：只夹亮度、tol = σ·(1+6·fps·hw)、无地板、混合改 ChangeLuma 语义）。暗处蠕动风险是官方口径的真实代价，A/B 重点观察。默认 0 不变 |
| 7.4 | RCRS | 本帧滤波亮度夹到 3×3 邻域 min/max（v4114 TS:157、TS.cs:134 附近） | `filtered.r = clamp(filtered.r, lumaMin, lumaMax)`（GIStabilize:133） | 孤立亮斑被压掉 | R | ✅ 重判保留：只改 Y 且与官方 YCoCg 模式一致 |
| 7.5 | `maxStabilizedFrameNum` | **不是帧数上限**：`Source/Reblur.cpp:303` 把它换算成 `gStabilizationStrength = N/(1+N)`，默认 63 ⇒ 0.984，用来夹最终混合权重 | `GI_STABILIZE_FRAMES` 默认 **63.0**，`_stabStrength = 63/64 × NRD_STABILIZATION_STRENGTH`，`min(hw, strength)` | 端点：0 = 关闭稳定化 | N | ✅ **2026-11-11 修正语义**：此前把它当"本级帧数上限"（默认 8），而本级根本不该有帧数上限——已删。旧默认 8 ⇒ strength 0.889，现在与官方同为 0.984 |
| 7.6 | `stabilizationStrength` | 夹在历史权重上：`lerp(diff, hist, min(hw, gStabilizationStrength))`（TS:171） | `_hwMix = min(historyWeight, _stabStrength)` | 0 = 关闭且无残留 | R | ✅ **2026-11-11 对齐**：公式改为 `N/(1+N)`（见 7.5），不再乘在 accumSpeed 上 |
| 7.7 | σ 来源 | 本帧**滤波后**信号的 3×3 luma 矩（TS.cs:134） | 3×3 邻域矩（GIStabilize:114-129） | σ 反映信号变化而非噪声 | R | ✅ 重判保留（与官方同源；9.2 的「σ 应来自输入分布」本身不是官方口径） |
| 7.8 | antilag 触发后压累积速度 | `data1.x = lerp(diffMinAccumSpeed, data1.x, diffAntilag)`（v4114 TS:291） | `ageOut = mix(min(age,3), age, antilag)`，`historyWeight *= antilag` | 真实变化发生时历史被主动判不可靠 | R | ⚠️ 已实现，等价于官方 `USE_ANTILAG_NOT_INVOKING_HISTORY_FIX=1` 分支（回落到 3 帧而不是清零）；清零会让暗处蠕动，保留取舍 |

---

## 8. 输出与上采样

| # | 项目 | 官方行为 | 现状 | 判定标准 | 验证 | 状态 |
|---|---|---|---|---|---|---|
| 8.1 | 颜色空间回转 | 线性 RGB（front/back end 可换 YCoCg） | `YCoCgToRGB` 在 DeferredLight.frag:1031/1033/1041 | 单色场景无偏色 | S | ✅ 重判保留（三处合成点都转了） |
| 8.2 | 上采样 | README:930 推荐 Nearest Z | `SpatialUpscale.glsl` 4 邻域十字 + 法线 + 相对深度权重 | 边缘不渗色 | V | ✅ 实机 C 通过（天空/轮廓交界 1 px 过渡）；算法与官方 Nearest Z 不同，属等效替代 |
| 8.3 | 能量守恒 | 权重和归一 | GIPrepass `sum/wSum`、EAWF `sumW`（EAWF:309）、post `postW` | 平场输入 ⇒ 输出亮度相等（±1%） | N+S | ✅ 重判保留，三处归一都在 |
| 8.4 | 关降噪直通 | `enableDenoiser = false` 原样输出 | DeferredLight 有 `VOXEL_GI_DENOISE` 分支（读 colortex2 累积值） | 关闭后与未滤波信号一致 | S | ✅ 重判保留 |
| 8.5 | 诊断视图 | — | 视图 **1~6**，语义已统一并实机验证（2026-11-10） | 刻度统一、能区分历史/滤波/采样 | S+V | ✅ 重判保留；旧清单写「1~5」已更正，视图 3/4 的实现缺陷已修 |

---

## 9. 跨阶段标定（真正决定"像不像"）

| # | 项目 | 说明 | 判定标准 | 验证 | 状态 |
|---|---|---|---|---|---|
| 9.1 | 有效样本数口径 | `GI_EFFECTIVE_SPP` 目前只进累积上限 | 同一口径贯穿累积上限 / EAWF 半径 / TS magic | N | ❌（保留，B2 待做） |
| 9.2 | σ 的来源一致性 | 旧写「4.7 与 7.7 都偏低」是**误判**：官方 TS 的 σ 本来就取本帧滤波后信号（7.7 ✅），TA 不设 σ | σ 口径与官方一致：TS 取滤波后 3×3 luma，TA 不设 | R | ⚠️ 7.7 已对齐；偏差只剩 4.4/4.7 那个自造 fast clamp。原 ❌ 撤回 |
| 9.3 | 帧数常数的来源 | 官方按 1 spp 给，本包按秒折算 | 所有帧数由目标 10% 衰减时间反推 | N | ⚠️（保留；cap 下限 8 / 暗处 ×4 见 9.6） |
| 9.4 | 半径常数 | §3.1 已证官方半径是 **NRD rect 像素**（`gRectSizeInv·blurRadius`）；`hitDistFactor = saturate(hitDist_m / frustumSize)`（GetHitDistFactor） | 所有半径同一口径 | R | ⚠️ **2026-11-11 部分对齐**：EAWF 的 hitDistFactor 改用官方 `saturate(hitDist_m/frustumSize)`（旧写法是 saturate(normHit)，量纲错位、远距离恒饱和）；`NRD_RADIUS_PX` 仍是屏幕像素口径，但换算已写进注释。prepass 30 画布纹素 ✅ |
| 9.5 | 半分辨率补偿 | 画布减半 ⇒ 等效覆盖翻倍 | 覆盖表算清并写进 MEMO | N | ✅（保留，§3 重判已补证据） |
| 9.6 | 运动拖影（跨阶段，独立于 1.3） | 来自 4.x 长历史（暗处 cap×4）、5.x HistoryFix 邻居复制、7.x 第二级历史、2.4 上采样；**不是运动矢量** | 沿墙平移 3 秒无可见拖尾，且不显著抬高静止噪点 | V | ❌ 未解决。**`GI_MOTION_RESPONSE` 默认 1.0→0.0**（2026-11-11）：它把移动时 alpha 抬到 0.35、TS 历史压 0 ⇒ 每帧只剩单样本，正是「稍微一动狂闪」的原因。官方没有这个机制，拖影改由官方常数（累积上限/稳定化）处理；需要跟手时再手动开 0.5。**同日补两处拖影机制**：TS 的逐 tap 几何判据（7.1，堵住跨深度拖影）+ HistoryFix 的官方 fast clamp（5.7，让滞后长历史被短历史拉回）。若仍有同表面拖影，下一步降 `GI_ACCUM_TIME` 到 0.35（代价：静止噪点略升） |

---

## 10. 回归与基准（没有这层就永远靠眼睛）

| # | 项目 | 判定标准 | 通过条件 | 验证 | 状态 |
|---|---|---|---|---|---|
| 10.1 | 固定基准场景 | 固定种子 / 固定机位 / 固定时间 | 同一 commit 两次截图逐像素一致（≤ 1 LSB） | V | ❌（需实机） |
| 10.2 | 残差度量 | 与参考累积（500 帧静止）对比 RMSE | 稳定后 RMSE 随时间单调下降 | V | ❌（需实机） |
| 10.3 | 阶跃响应 | 灯灭后 10% 衰减帧数 | 与 9.3 预算一致（±20%） | N | ⚠️ MEMO 有离线串级仿真（当前 1.33 s / 官方 3.10 s），但**未含 antilag 与 `GI_MOTION_RESPONSE`** ⇒ 只能证明模型自洽，不能证 ±20%。原 ✅ 撤回 |
| 10.4 | 运动残差 | 匀速横移时的拖影长度 | 不超过设定时间常数 × 速度 | V | ❌（需实机，与 9.6 同一现象） |
| 10.5 | 三套脚本 | 语义 / 静态 / 预处理全绿 | 无新增命中 | S | ✅（本轮复跑全绿：345 入口无新增命中） |

---

## 11. 执行顺序（建议批次）

| 批次 | 内容 | 状态 |
|---|---|---|
| B0 | 3.4 / 3.5 / 3.6 / 3.10 / 3.13 官方权重 | ✅ 2026-11-11：A/B 已删除，官方为唯一路径 |
| B0b | 6.3 / 6.4 / 6.5 同源权重 | ✅ 2026-11-11：随 EAWF 重写一并完成 |
| B1 | 5.6 HistoryFix 拓扑重排（移到 TA 之后、修复值不入历史） | ✅ 2026-11-11：`deferred5`，`deferred1_c` 退役 |
| B2 | 7.1 / 7.2 / 7.3 / 7.6 TS 口径对齐 | ✅ 2026-11-11：官方为唯一路径；7.5 语义修正 |
| B3 | 9.1 有效样本数 / 9.3 帧数反推 / 9.4 半径口径 | ⚠️ 9.4 已随 6.2 对齐；9.1/9.3 仍开 |
| B4 | 9.6 拖影 | ⚠️ 结构侧已改（TS 不再二级累积）；观感待 V |
| B6 | **6.1 / 6.6 / 6.8 空间滤波重写为官方 Blur + PostBlur** | ✅ 2026-11-11 |
| B7 | **4.3 CatRom12 历史采样** | ✅ 2026-11-11 |
| B5 | 10.1~10.4（基准场景与残差） | ⏳ 需要实机 |

> **[2026-11-11 进度]** B0/B0b/B2 **代码已实现**（2026-11-11）：
> `GI_NRD_WEIGHTS`（B0+B0b 共用，GIPrepass + EAWF 主循环 + post-blur）与 `GI_NRD_TS`（B2，
> GIStabilize + Accumulate 7.1 写端）两个默认关开关，四处接线齐全，开关两种取值下三套检查全绿。
> **另修 7.0（TS 历史缓冲同帧读写竞态，清单此前漏记）**：用 deferred10 做历史快照，
> 读写分离，零新增缓冲、零下游改动，见 §7 与待实机 J 行。
> 剩余全部是 V：两个开关的实机 A/B（H / I）与竞态修复的重载确认（J）。B1 仍被 5.6 拓扑方向阻塞。

> **[2026-11-11 第三轮 · 把剩下的全部做完]** 按主人要求「剩下的全部都做、优先参考官方」，本轮做了五项结构级改动，
> 全部逐行对照官方 master 源码，**没有保留 A/B 开关**（官方实现即唯一路径）：
>
> | 项 | 官方依据 | 改了什麼 |
> |---|---|---|
> | 6.1 / 6.8 | `REBLUR_Blur` + `REBLUR_PostBlur` 是两个独立 dispatch，共用一份 SpatialFilter，差别只在 `radiusScale`(1.0/2.0)、`fractionScale`(1.0/0.5) | 4 级 a-trous → 官方两级。`deferred6`=Blur、`deferred7`=PostBlur；`deferred8/9` 入口删除。**总覆盖 8.6（稳定）/ 45.6（新像素）画布纹素**，旧结构约 4.5 / 21 |
> | 6.6 | `g_Special8`（4 轴点 + 4 对角点）、`skew = lerp(1-\|Nv.xy\|, 1, NoV)` 各向异性 | 黄金角 Vogel → `g_Special8`；补上各向异性 skew |
> | 4.3 | `BicubicFilterNoCornersWithFallbackToBilinear`（门控 `occlusion 位 > 11.5/16`）；帧数走双线性 | TS 颜色历史 → CatRom 12 tap，帧数/quality 保持双线性 |
> | 5.3 / 5.4 | HistoryFix 法线与 hitDist 用 `ComputeExponentialWeight`（**指数**）、几何用三次窗；`w *= 1+data1.x` 不夹；HistoryFix **不改帧数** | 法线权重改指数、邻居帧数不夹、输出 `.a` 透传 TA 帧数 |
> | 7.5 / 7.6 | `gStabilizationStrength = maxStabilizedFrameNum/(1+maxStabilizedFrameNum)`（`Source/Reblur.cpp:303`） | `GI_STABILIZE_FRAMES` 语义改为 maxStabilizedFrameNum（默认 63），strength = 63/64 |
>
> **另修一处结构性偏差**：TS 此前 `taAge = prevAge + 1`，等于在 TA 之外**又叠了一级时域累积**（官方只有 TA 一级）。
> 现在直接读 `colortex2.a`（本帧 TA 的帧数）、不 +1 —— 这是「拖影一大条」的结构性来源之一。
>
> **删掉的开关**：`GI_NRD_WEIGHTS` / `GI_NRD_TS`（官方已是唯一路径，GUI 与文案一并移除，settings 保留定义仅为兼容旧配置）。
>
> **[2026-11-11 二次对齐 · 直击「静止糊噪点 / 一动狂闪」]** 主人反馈竞态修完仍不行，重新按官方量级核对，
> 发现四处**量级级**偏差（不是公式细节）：
> ① 空间滤波有效覆盖只有官方的 1/4（`NRD_RADIUS_PX=1.0` ⇒ 有效 ~2.5 画布纹素，官方稳定像素 ~9）；
> ② 累积上限被 `GI_EFFECTIVE_SPP=2.0` 腰斩（0.5 s ⇒ 15 帧，官方 30）；
> ③ 官方 TA 没有颜色盒，而我们每帧把长历史拉向 6 帧短历史的噪声（`GI_FAST_CLAMP_SIGMA`）；
> ④ `GI_MOTION_RESPONSE=1.0` 把移动时 alpha 抬到 0.35、TS 历史压 0 ⇒ 每帧只剩单样本。
> 已分别改为 3.0 / 1.0 / 0.0 / 0.0，并把选项文件里覆盖默认的 `GI_STABILIZE_FRAMES=4.0` 改回 8.0
> （备份 `Revelation-AD-edit.txt.bak`）。同时 EAWF 的 hitDistFactor 改用官方
> `saturate(hitDist_m/frustumSize)`。三套检查全绿，待实机看「静止是否干净、移动是否不闪」。

---

## 12. 必须说清楚的：这份清单保证不了什么

1. **"与官方一致"只能是结构与指标一致，不是像素一致。** 输入分布（8 样本空间重用 + 半分辨率 + YCoCg + 无运动矢量）与 NRD 假设不同，官方常数搬过来必然偏，只能重标定。
2. **没有官方参考输出可比。** NRD 是 HLSL + DX12 库，无法在同一帧同一场景取 golden image；"一致"只能退化为「公式一致 + 判定标准的数值成立」。
3. **观感项（6.2 / 6.8 / 7.2 / 7.3 / 9.6 / 10.x）必须有实机。** 我这边没有渲染与截图能力，只能由主人验收；代码/数值只能证明「实现符合意图」。
4. **有些项会永远停在 ❌**：7.5（TS 上限 8 vs 63）、9.6（拖影，待实机）以及 5.6（HistoryFix 拓扑位置）属于取舍或待办，不是漏做。旧文档写的 1.1 / 1.2 早已 ✅，已更正。
5. **§4~§8 重判结论**：继承的 ✅ 里，真正站得住的只有 4.5 / 4.10 / 4.11 / 5.3 / 5.5 / 6.7 / 7.4 / 7.7 / 8.1~8.5；其余都是 ⚠️ / ❌ / ⏳。**不要拿旧 ✅ 当基线继续往下推。**
6. 清单全部勾完的合理预期是：**结构完整、参数自洽、回归可测**；"再也不出问题"不成立——但每一个新问题都能落到某一行上定位。
