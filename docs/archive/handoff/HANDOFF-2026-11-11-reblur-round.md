# 交接说明（给新对话的 agent）

> 先读 `MEMO.md`（项目规范）和 `REBLUR-CHECKLIST.md`（54 项对齐清单，含当前进度）。
> 本文件只写"新 agent 必须知道、但散落在对话里会丢"的东西。

## 1. 任务是什么

`Revelation-AD-edit`：Minecraft 1.21.11 + Iris 光影包。目标是把它的体素 GI 降噪链
**逐项对齐 NVIDIA NRD 的 REBLUR**（只做 diffuse，specular 明确不做）。
做法：按 `REBLUR-CHECKLIST.md` 从 §1 到 §10 **顺序**核对，每项先写判定标准，再对照官方源码，
改完立刻跑检查，更新该行。跳项被明确禁止（上游错会让下游无法修）。

## 2. 路径与命令

- 工具读写：`D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\`
- git 命令：`git -C "d:\Games\HMCL\.minecraft\versions\1.21.11-Fabric 0.18.4\shaderpacks\Revelation-AD-edit" ...`
  （同一目录的 junction，两套路径不要混用）
- 改完必跑（cwd 用 somemcstuff 路径）：
  ```
  node scripts/shader_semantic_check.js
  node scripts/shader_static_check.js
  node scripts/preproc_check.js --all
  ```
  全绿基线：`语义级检查全部通过` / `静态检查全部通过` / `345 个入口：无新增命中（基线内已知 34 条已忽略）`
- **这台机器没有 GLSL 编译器**（无 `glslangValidator` / `glslc`）。三套脚本只查语义与预处理，
  不查语法、不保证能编译。改完能不能跑只有 Iris 能证明。

## 3. 官方参考（唯一权威来源）

仓库：`https://github.com/NVIDIA-RTX/NRD`
原始文件（`master` 分支）：`https://raw.githubusercontent.com/NVIDIA-RTX/NRD/master/Shaders/<文件名>`

**版本基线（2026-11-10 校正）**：`master` 当前是 **v4.18.0**；本文件里的路径与行号全部对应它。
清单题头旧写的 v4.11.4 是更早一轮的对照版本，那个版本的 shader 在 `Shaders/Include/` 与 `Shaders/Source/`
（例：`Shaders/Include/REBLUR_PrePass.hlsli`），路径完全不同。§3 已用两版交叉核对，结论一致；
今后统一以 master 为权威，引用时写明版本与文件路径。

需要的文件（下载到临时目录即可，注意 `%TEMP%` 会被清空，新会话要重新下）：

| 文件 | 用途 |
|---|---|
| `Shaders/REBLUR_PrePass.cs.hlsl` | §3 预滤波（入口） |
| `Shaders/REBLUR_Common_SpatialFilter.hlsli` | §3 权重主体（v4.11.4 对应 `Include/REBLUR_Common_DiffuseSpatialFilter.hlsli`） |
| `Shaders/Common.hlsli`、`Shaders/NRD.hlsli` | 权重函数与 hitDist 归一化定义 |
| `Include/NRDSettings.h` | 官方默认值（半径 30 / minBlurRadius 1 / 高斯系数等） |
| `Shaders/REBLUR_TemporalAccumulation.cs.hlsl` | §4 时域累积（含 `diffAccumSpeed *= lerp(conf,1,1/(1+accumSpeed))`，第 903 行） |
| `Shaders/REBLUR_TemporalStabilization.cs.hlsl` | §7 稳定化（antilag 只在 TS，第 141-163 行） |
| `Shaders/REBLUR_PostBlur.cs.hlsl` | §6 a-trous |
| `Shaders/REBLUR_Common.hlsli` | luma / YCoCg 模式（205-219）、`GetTemporalAccumulationParams`（312） |
| `Shaders/NRD.hlsli` | 宏默认值（如 `REBLUR_USE_ANTILAG_NOT_INVOKING_HISTORY_FIX`） |
| `README.md`、`Integration.md`、`Shaders/NRD.hlsli` 顶部注释 | 分辨率/帧数/antilag 约定 |

仓库路径是 `Shaders/`，不是 `Source/`。作者 Alexey Panteleev（NVIDIA）。
REBLUR **有正式论文**：Zhdan, D. "ReBLUR: A Hierarchical Recurrent Denoiser", in *Ray Tracing Gems II* (Marrs/Shirley/Wald eds.), Apress 2021, ch.49, Open Access, DOI 10.1007/978-1-4842-7185-8_49。此外还有仓库 README、各 .cs.hlsl 头注释、Include/NRDSettings.h 的默认值、以及 Source/Reblur.cpp 的派发顺序（这张最可靠）。
**本项目曾误记为"没有论文"，已于 2026-11-11 更正** —— 那次误记直接导致漏掉了论文标题里
的核心机制（Recurrent：主历史 = 上一帧空间滤波输出）。引用文献前必须先查，不要凭印象断言。

## 4. 已确认事实（不要重复踩）

1. `VOXEL_REUSE` 在 `lib/lighting/VoxelLighting.glsl` 里被 `#undef` ⇒ **没有 ReSTIR 池化**，
   每画布像素每帧 1 条新射线 = 官方 1 spp 同构。代码里所有 `VOXEL_REUSE` 分支是死代码。
2. 官方 **TA 没有 σ / 颜色盒**，只有 `MixHistoryAndCurrent` + anti-firefly；σ 只在 TS。
3. 官方 **antilag 只在 TS**，TA 里不碰 alpha。
4. 官方 NRD 本身就是 YCoCg 可选项（`REBLUR_USE_YCOCG`），我们的 YCoCg 就是那个模式，**不是偏差**。
5. 官方 `smbFootprintQuality` 来自**上一帧** occlusion 的双线性值（`TS.cs:98-104`）；
   我们的 `maxGeometryWeight` 是当帧 4 tap 取 max（清单 7.1 ⚠️）。
6. **官方 HistoryFix 在 TA 之后**（master `REBLUR_HistoryFix.cs.hlsl:99` 注释：frameNum after
   TemporalAccumulation is 1, not 0；v4.11.4 同）。我们的 `GIHistoryFix`（deferred1_c）在 prepass
   之后、Accumulate **之前** ⇒ 拓扑偏离，已记为清单 5.6。旧版「位置正确」的判断作废。
7. diffuse / specular 是两个独立实例，不做 specular 不影响 diffuse。
8. 半分辨率 = 像素少 4 倍，**不是**多样本；prepass 的 32 tap 才是"更多样本"。
9. **prepass 半径口径 = NRD rect 像素**：官方 `skew *= gRectSizeInv * blurRadius`，半径按降噪缓冲尺寸换算、
   不随渲染分辨率缩放；quarter-res README 明确 NRD 视其为 full-res input ⇒ 我们的 30 画布纹素（=60 屏幕 px）正确，
   **不要改成 15**。官方另有 `sqrt(hitDistFactor)` 自适应收缩 + `minBlurRadius = 1` 下限 ⇒ **B0 已实现**
   （`GI_NRD_WEIGHTS=1` 时启用，默认关）。
10. **§3 继承的 ✅ 大半是错的**：官方 ReblurSettings 没有 `fireflyClampThreshold`、prepass 不估方差；
    高斯是 `exp(-0.66r²)`（不是 -2r²）；**几何/法线权重官方默认是 SmoothStep(1,0,t) 三次窗**
    （`NRD_USE_EXPONENTIAL_WEIGHTS` 两版默认 0——清单旧写的 `ExpApprox(-3t)` 是需显式开启的指数变体，
    只有 hitDist 权重无条件用它）；中心样本权重 1 无条件参与。逐条证据见清单 §3，别再把旧 ✅ 当基线。
11. **`stabilizationStrength` 官方夹在历史权重上**：`lerp(diff, hist, min(historyWeight, strength))`
    （`TS.cs:171`、v4.11.4 TS:270）。我们乘在 accumSpeed 上 ⇒ 端点等价、中间值不同（清单 7.6 ⚠️）。
    MEMO 旧写的「乘在 accumSpeed 上」是误读。
12. **官方 TA 没有颜色盒**：`MixHistoryAndCurrent` 是纯 lerp（`REBLUR_Common.hlsli:193`）；
    fast-history clamp 在 HistoryFix（`HistoryFix.cs:278/487`）。我们放在 Accumulate ⇒ 4.4 ❌、4.7 ⚠️。
    官方 `ReblurConvergenceSettings` 默认 s=1 / b=0.2 / p=0.8，我们的 4.5 逐项一致（✅）。

## 5. 诊断视图（GI_DEBUG_VIEW）使用规则 —— 本轮最大教训

- **语义以 `Final.frag` 为准**（2026-11-10 统一；settings / lang / 清单里旧说明已作废）：
  1 = 历史长度(红) + 不可靠(绿) + 年轻度(蓝)；2 = 方差 σ 灰阶；3 = 孤立亮点离群度(红=火点 / 绿=正常)；
  4 = 三段对比（左 prepass / 中累积 / 右最终，YCoCg→RGB 后同增益 Reinhard）；
  5 = 三通道（红=A/cap，绿=几何可信度，蓝=不可靠）⇒ **黄=老且可信，绿=新但可信（正常响应）**，蓝/青=走兜底；
  6 = 几何可信度灰阶（红=没用上历史）。
- **视图 3 旧判据静止恒红**：`abs(滤波输出-累积值)/累积值`，空间滤波本来就改掉大半亮度、暗处分母趋 0
  ⇒ E 测试完全无法判读。已改成「相对 3x3 邻域均值的离群量」，只标火点。
- **视图 4 旧实现把 YCoCg 当 RGB 显示**（g/b 是可能为负的色差）⇒ 串色/发黑，"画面太诡异看不清"。
  已用 `YCoCgToRGB` 转回 RGB 再显示。
- **视图 5 是逐帧原始值，不经过 TAA/上采样/色调映射。计数器 ±1~2 帧的抖动在灰度图上会放大成"整屏闪"，
  但正常画面完全看不出来（已实机确认）。** 判断"闪"一律看正常画面；视图只用来判断空间上是否大片缺历史。
- 本轮最大教训：**同一视图在三份文档里写三种语义，会把实测结论直接带偏**（F 的「新像素绿、旧像素黄」
  其实是三通道的期望行为）。改视图必须同步 `Final.frag` / `settings.glsl` / 双语 lang / 清单 / 本文件。
- 不要再用调试视图反复做 A/B 归因；一次定死，别把用户当测量仪器。

## 6. 本轮之后代码净状态

已提交：`71433a08 feat(gi)`、`96642b92 docs(memo)`。之后有未提交改动，包含：

| 改动 | 是否保留 |
|---|---|
| 1.4 `Accumulate` 历史入口 NaN/Inf 兜底 | 保留 |
| 1.5 IRC/探针 `GI_HITDIST_NONTRACED=1024`、SSILVB `.a` 修正 | 保留（默认 VXGI 路径行为不变） |
| 2.5 奇数分辨率 `GICanvasCoord` 夹取 + EAWF dispatch 越界早退 | 保留 |
| 3.x `SpatialUpscale` 等 | 见 git diff |
| 4.11 短历史 anti-firefly 压制（官方 `diffFastClamped` ×1.5） | 保留 |
| 累积计数器改**整数 + 双阈值滞回** | 保留（正常画面无差别，视图不再出假条纹） |
| `accumCap` 去掉 8 帧量化 | 保留 |
| 兜底路径继承历史长度（`clamp(_fixed.a,1,accumCap)`） | **已撤回**（有拖影风险） |
| 视图 5 改三通道；视图 1/5 的上限与 Accumulate 逐项一致 | 保留 |

## 7. 进度

- §1 输入层：1.1/1.2/1.4/1.5/1.7 ✅；**1.6 ✅（实机 C 通过）**；**1.3 ✅（矢量本身，主人 2026-11-10 裁定）**；1.8 待实机标定。
  **拖影 / 新像素噪点不计入 1.3**，已单独立清单 9.6（跨阶段问题，❌ 待 `GI_MOTION_RESPONSE` 实机）。
- §2 分辨率与坐标：2.1~2.3 ✅；**2.4 / 2.5 ✅（实机 C / D 通过）**。
- 实机第一轮（2026-11-10）：B ✅、C ✅、D ✅、F ✅（按修正后三通道语义）；A ⏳、G 未测、
  E 阻塞（诊断视图缺陷，已修）。
- 实机第二轮（23:20 重载后）：**诊断视图修复生效 ✅、E ✅（4.11 改 ✅）**，A/G 仍未报。
  视图 4 = **左段干净、中段+右段拖尾** ⇒ 输入信号与重投影方向均无问题（1.3 ✅）；
  拖影是 4.x / 5.x / 7.x / 2.4 的跨阶段问题，见清单 9.6，不要与 1.3 混在一起。
  证据链：`Accumulate` 的 `alpha≈1/31` + fast clamp 门控地板 `+0.02`；`GIStabilize` 的
  `quality≈1`、`historyWeight≈0.89`。完整链条与候选旋钮见清单顶部「第二轮重载回填」。
- 实机第三轮（23:27）：按建议把 `GI_ACCUM_TIME` 拉到 0.5、`GI_STABILIZE_FRAMES` 拉到 4，
  **拖影无改善**。选项文件确认两项已生效（`enableShaders=true`、无编译错误）。
  离线算清原因：cap 下限 8 + `GI_EFFECTIVE_SPP=2` ⇒ 低 fps 下 0.5 s 撞下限；
  用户选项 `VOXEL_GI_DARK_ACCUM=true` 让暗处 cap ×4（60 fps 仍 60 帧）；
  TS 的 `N/(1+N)` 8→4 只把 0.889 降到 0.800（10%）。**上一轮把小步参数当主旋钮是错的**。
  已改为运动自适应响应 `GI_MOTION_RESPONSE`（默认 1.0），见清单第三轮小节。
- §3 预滤波：**逐条重判完成**（2026-11-10）。3.1 口径已证 ✅（保持 30）、3.8 ✅；
  3.2/3.3/3.7/3.9/3.10/3.11/3.12 = ⚠️；3.4/3.5/3.6 = ❌ 错判；新增 3.13 记录两项缺失机制。
  代码只做了两处默认观感不变的改动：`GIPrepass.comp` 方差无偏校正（仅调试视图 2 读数）、
  `GI_FIREFLY_CLAMP` 补齐四处接线（默认 0）。三套检查 + 编码/配平自检全绿。
- §4~§12：**逐项重判完成**（2026-11-11，只判结构/公式，观感项留 ⏳）。继承的 ✅ 大半站不住：
  4.4 / 5.1(文档写反) / 5.2 / 6.1 / 6.3 / 6.4 / 6.5 / 6.9 / 7.1 / 7.6 / 8.5 / 9.2 / 9.4 / 10.3
  均已改 ⚠️ 或 ❌；真正保留的只有 4.5 / 4.10 / 4.11 / 5.3 / 5.5 / 6.7 / 7.4 / 7.7 / 8.1~8.5。
  新增 5.6（HistoryFix 拓扑位置偏离官方）；§11 批次、§12 说明同步更新。本轮**未动 shader**。
- **B0/B0b/B2 代码落地**（2026-11-11，只做实现未动默认）：`GI_NRD_WEIGHTS`（B0+B0b，
  GIPrepass 3.4/3.5/3.6/3.10/3.13 + EAWF 6.3/6.4/6.5 及高斯/post-blur）与 `GI_NRD_TS`（B2，
  GIStabilize 7.1/7.2/7.3/7.6 + Accumulate 7.1 写端）两个默认关 A/B 开关，四处接线齐全；
  官方权重形态关键更正见 MEMO 末节（SmoothStep 三次窗，非 ExpApprox）。三套检查在开关
  两种取值下全绿。剩余全部是 V（清单顶部 H / I 两行）。
- **7.0 TS 竞态修复**（2026-11-11，主人报「静止全是模糊密集噪点 / 移动全是伪影」且一直如此）：
  排除本轮开关（选项文件无）、`GI_MOTION_RESPONSE`（静止位移 <1 px 不触发）、`historyReset`（恒 false）后，
  定位到 `GIStabilize`（纯 compute、不 flip）在同一 dispatch 内读 colortex23 当历史又写 colorimg23
  ⇒ 真竞态（EAWF 当年为此改乒乓，TS 漏掉）。用 deferred10 GIHistoryStore 把上一帧 colortex23
  快照到 colortex25，TS 改读快照、输出仍写 colortex23；零新增缓冲、DeferredLight 不变、读值严格等价。
  清单新增 §7.0 与待实机 J 行；三套检查全绿，**待实机重载确认**。
- **二次对齐：四处量级偏差**（2026-11-11，主人反馈竞态修完仍「静止糊噪点 / 一动狂闪」）：
  ① `NRD_RADIUS_PX` 1.0→**3.0**（EAWF 有效覆盖 ~2.5 → ~7.5 画布纹素，官方稳定像素 ~9）；
  ② `GI_EFFECTIVE_SPP` 2.0→**1.0**（0.5 s cap 15→30 帧，官方同值）；
  ③ `GI_FAST_CLAMP_SIGMA` 2.0→**0.0**（官方 TA 无颜色盒，旧逻辑每帧把长历史拉向短历史噪声）；
  ④ `GI_MOTION_RESPONSE` 1.0→**0.0**（移动 alpha 抬到 0.35 = 狂闪的直接原因，官方无此机制）。
  另 EAWF 的 hitDistFactor 改用官方 `saturate(hitDist_m/frustumSize)`；选项文件
  `GI_STABILIZE_FRAMES=4.0`→8.0（备份 `.bak`）。三套检查全绿，**待实机**。
- **拖影两处机制补齐**（2026-11-11，主人报「移动拖影被拉到不同深度的表面」）：
  ① `GIStabilize` 加了**逐 tap 几何判据**（`disocTol = frustumSize·saturate(0.01/max(0.05,NoV))`，
  颜色/历史长度/quality 都按 `bilinearWeight·tapGeo` 加权）——此前只读 colortex21.a（每像素自己的
  质量，不是这 4 个历史 tap 的），跨深度历史被无条件混入，正是该现象的来源（清单 7.1）；
  ② `GIHistoryFix` 补上官方 **fast-history clamp**（5×5 σ×2.0、`lerp(clamped,orig,1/(1+N·2))`、
  只动亮度）——上一版关了 TA 的 clamp 却没搬这一处，导致长历史无人拉回（清单新增 5.7）。
  三套检查全绿，**待实机**。
- **离线全量对齐（2026-11-11，主人无法实机）**：逐 pass 复核官方 master 源码，补 5 处：
  ① TA 的 `ClampNegativeToZero`（负值历史；新增清单 4.12）；② fast history 混合率
  `1/(1+min(N,6))`（4.8 改 ✅）；③ HistoryFix 邻居 `1+长度` 加权 + hitDist 指数权重（5.3），
  门槛改官方 `sumd=1+min(age,3)`（5.4）；④ TS footprint 补 `sizeQuality` 视角拉伸补偿（7.1）。
  离线数值自检通过（见 MEMO 末节）；三套检查全绿。
- **EAWF 前两级空转修复**（2026-11-11，本轮最关键）：Node 实测旧 `offsetScale` 在稳定像素上
  只有 0.50/0.68 画布纹素 ⇒ 8 个 Vogel tap **全部 round 回中心**，4 级 a-trous 的前两级
  等于没滤波（真正在工作的只有第 3 级 + post-blur）。改为官方
  `blurRadius = max(saturate(sqrt(hitDistFactor·NLAS))·maxBlurRadius, 1)` 再按 1:2:4:8 分摊，
  每级下限 1 画布纹素。同时移除自造 `stepBoost`，`NRD_DISOCCLUSION` 废弃（GUI/profile 已移除）。
  三套检查全绿，**待实机**。
- **全链路逐段复核（2026-11-11 第四轮，四个「没生效」缺陷）**：
  ① `SVGF_QUALITY` 在 `settings.glsl` 里**从未定义**（只在 properties/lang 里登记）⇒
  `SpatialUpscale.glsl` 兜底成 0 = 最近邻上采样，半分辨率 GI 一直铺成 **2×2 屏幕像素硬方块**，
  且累积不消失。已补 `#define SVGF_QUALITY 1`（清单 2.4）。
  ② EAWF `FILTER_PASS_INDEX == 3` 只跑 post-blur 3×3 就 return ⇒ **a-trous 最大步长从未执行**，
  总覆盖新像素 21.0→10.3、稳定像素 6.5→4.2 画布纹素。现在 4 级全跑，post-blur 作为 0.25 权重
  小环并入第 4 级；权重抽成 `SpatialTapWeight()` 单一实现（清单 6.1）。
  ③ `Accumulate` 的 `giDepthGrad` 是**每画布纹素**梯度，旧式却按屏幕像素用（×2）再加
  `6.0·giDepthGrad` ⇒ 容差大一倍，跨深度历史被混入（清单 4.3）。
  ④ `GIStabilize` 拿本帧 `colortex14.z` 比 `prevViewPos.z`（上一帧视空间）= 跨帧混用坐标系，
  已统一到本帧（清单 7.1）。
  另：`GI_KERNEL_ROT_PER_FRAME` 在配置里是 false（文案写反了），已改正文案 + 配置改回 true。
  三套检查全绿，**待实机**。
- **半分辨率契约审计（2026-11-11 第五轮）**：按官方 README 的两条硬要求逐 pass 核对
  （"NRD 视半分辨率为全分辨率输入" / "resolve 必须用全分辨率 guide"）。修三处：
  ① 上采样权重改用**全分辨率** `depthtex0`+法线包（原用半分辨率 colortex14 ⇒ 退化成 2×2 软混合）；
  ② prepass 命中距离改**逐 tap 归一化**（官方 front-end 口径，原来平均米值再用中心分母）；
  ③ `Accumulate` 非 NRD 回退的 `textureLod(colortex3, 全分辨率UV, 3.0)` 改为画布 4-tap texelFetch，
  并删掉 `colortex3MipmapEnabled`；`DeferredLight` SSILVB 分支改走 `GICanvasCoord()`。
  另确认 colortex3 是帧内共享暂存（TAA 全分辨率重写为运动矢量），不能改半分辨率。
  逐 pass 契约表见 MEMO 末节。三套检查全绿，**待实机**。
- **「剩下的都做完」（2026-11-11 第十一轮，结构级，全部按官方、无 A/B）**：
  ① **6.1/6.8 空间滤波重写**：官方 Blur 与 PostBlur 是两个独立 dispatch、共用同一份 8-tap
  SpatialFilter，差别只在 `radiusScale`(1.0/2.0) 与 `fractionScale`(1.0/0.5) —— **PostBlur 不是 3×3，
  是半径翻倍的同款 8-tap**（此前记错）。`deferred6`=Blur(25→3)、`deferred7`=PostBlur(3→25)，
  `deferred8/9` 入口删除。总覆盖 8.6（稳定）/ 45.6（新像素）画布纹素，是旧 4 级 a-trous 的 1.9~2.2 倍。
  ② **6.6 `g_Special8` + 各向异性 skew**：黄金角 Vogel → 官方 4 轴点+4 对角点；
  `skew = lerp(1-|Nv.xy|, 1, NoV)/max(...)`。
  ③ **4.3 CatRom12**：TS 颜色历史改 12-tap CatRom（门控 `足迹有效率 > 11.5/16`），帧数/quality 仍双线性。
  官方 TA 的颜色历史也是 CatRom，不是我之前记的「只用于 guide」。
  ④ **5.3/5.4 HistoryFix**：法线权重改**指数**（官方这两处显式用 `ExpApprox`，几何才用三次窗）、
  邻居帧数 `1+data1.x` 不夹、输出 `.a` 透传 TA 帧数（此前写死 1.0）。
  ⑤ **7.5/7.6 `maxStabilizedFrameNum` 语义修正**：官方在 `Source/Reblur.cpp:303` 把它换算成
  `strength = N/(1+N)`，默认 63 ⇒ 0.984，**不是帧数上限**。`GI_STABILIZE_FRAMES` 默认 8 → 63。
  ⑥ **TS 不再是第二级累积**：`taAge = prevAge+1` 已删，改为直读本帧 `colortex2.a` —— 官方只有 TA 一级
  时域累积，这是「拖影一大条」的结构性来源之一。
  ⑦ 删除 `GI_NRD_WEIGHTS` / `GI_NRD_TS` 两个 A/B（官方已成唯一路径，GUI/lang 一并移除）。
  三套检查全绿（342 入口），properties 纯 ASCII。**全部待实机**。

## 8. 下一步（从这里接）

**结构侧已无「没做的」** —— 清单里只剩需要屏幕才能判的观感项。下一步全部是实机验证：

0. **重载一次，只报三件事**（清单待实机 J 行）：站定 10 秒看墙面 → 平移 3 秒 → 斜看地面 3 秒。
   - 静止是否还有密集颗粒
   - 移动拖影是否**变短**、是否**还跨表面**
   - 斜看是否比正看更闪
1. **归因对照表**（拿到上面三条后按此定，不要另做实验）：
   | 现象 | 下一步 |
   |---|---|
   | 仍满屏颗粒 | 时域链：查 `GI_DEBUG_VIEW=5` 的累积帧数是否真的爬到 30 |
   | 拖影仍跨表面 | 几何判据：`GI_DISOC_THRESHOLD` 0.01 → 0.005（更严） |
   | 斜看更闪 | `skew` 或平面距离容差：`PLANE_DIST_SENS`（prepass/EAWF/HistoryFix/TS 四处同值 0.02）→ 0.03 |
   | 糊到看不清细节 | `NRD_RADIUS_PX` 3.0 → 2.0（覆盖仍是官方 2/3） |
   | 拖影仍长 | `GI_ACCUM_TIME` 0.5 → 0.35（代价：静止噪点略升） |
2. **仅剩的结构项**：9.1（有效样本数贯穿三处）/ 9.3（帧数反推）—— 纯内部一致性，
   没有屏幕反馈无法判断是否需要，暂不动。
3. **仍需实机才能定的参数**：`NRD_RADIUS_PX` / `GI_ACCUM_TIME` / `GI_STABILIZE_FRAMES`
   三个滑条的默认值。现在都取的官方默认。
4. 所有改默认观感的项一律「主人实机确认 → 再单独提交」，不许直接改默认值。

## 9. 用户工作规则（必须遵守）

- 只能靠肉眼看结论的项（拖影/渗色/斑点/滑条单调/闪）→ 清单标 `⏳` 并写清"怎么看"，**主人实机确认后才允许改 ✅**。
  不许用"我检查过代码"替代。
- 不要让他反复做归因实验；诊断要一次定死，给可判读的隔离量。
- 先读 `MEMO.md` 与 `REBLUR-CHECKLIST.md` 再动手。
- 中文回答，简洁直接，不要长篇解释过程。
- 清单里 §3 以后现存的 ✅ 都是继承来的，推进到该节时必须按同规则重判。
