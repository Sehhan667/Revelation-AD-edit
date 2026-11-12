# 性能审计（2026-11-12）—— 全包系统性排查，**待确认后才动手**

> 本文只做分析与建议，**没有修改任何着色器代码**。
> 范围排除：所有类型的全局光照（VXGI / SSILVB / DDGI / IRC / PTGI / RSM / SVGF / REBLUR / GI 历史缓冲）、
> CAS 锐化、体积云本体。镜面反射（SSR/天空回退）、阴影、G-buffer、延迟光照、后处理、天空/大气/雾/水/地形全部在范围内。

---

## 0. 结论摘要（TL;DR）

1. **一帧是带宽受限的**：抓帧实测（1632×918）每帧**写入约 1.3 GB**（60fps ≈ 78 GB/s），其中
**G-buffer 36% + 阴影 26% + 环境/模组侧 33%**，光影包自己的照明+后处理只占 **9%**。
   所以「把后处理 ALU 抠掉」的收益远小于「少写一遍 G-buffer / 少写一遍阴影附件」。
2. **最划算的一笔是「实体受击故障」的帧级门控**（`:0.2–0.7 ms`，常态产出恒 0，纯白付）：
   2026-09-20 曾做过、2026-09-22 为修 bug 被移除，现在可以安全地重做。
3. A 档（低风险、纯代码、无观感变化）**合计约 1.0–2.0 ms/帧**（17 ms 帧上 ≈ +6–12% fps），
   全部是「省掉重复计算 / 重复取样 / 死写」，不降任何采样数、不改任何观感参数。
4. B 档（需要 A/B 或观感裁定）另有 0.5–1.2 ms；C 档（结构性大改，2–4 天级）还能再拿 1 ms 量级，
   但本仓有过两次「半分辨率 imageStore 读不到」的前科，风险最高。
5. 顺手挖出 **4 个非性能缺陷**（软阴影半影被遮挡物 albedo 染色、半透明 SSR 模式 2 的旧 bug、
   bloom 就地读写违反 `restrict`、TAA 每帧把 colortex4 写成 0），B 档里一并列出。

---

## 1. 方法与边界

- **5 个子代理分域读码**：帧结构/带宽、阴影、延迟光照+反射、后处理、天空/雾/水/地形；
  **我本人**负责抓帧分析、跨域去重与冲突核验（下面有 3 处子代理结论被我修正/否决）。
- **新抓帧** `capture.rdc`（202MB，2026-11-12 08:11）→ `renderdoccmd convert -c xml` → 自写脚本统计
  （`rdc_analysis/capture_inventory.py`、`capture_buffers.py`，产物 `rdc_analysis/capture_*.txt`）。
- **`duration` 不可当 GPU 时间**：它是每次 GL 调用的 wall-time（含抓帧注入/驱动序列化固定开销）。
  旧报告 `rdc_analysis/lookme_top10.md:7-26` 已用「同一份 26 draw 在 4096×2048 与 256×128 上耗时几乎相同」
  证伪过。**本文的排序不依赖 duration**，只依赖：pass 结构、分辨率、调用次数、**字节数**、静态指令/取样计数。
  真实收益必须「一次只改一项 + F3/Event Browser 的 pass Duration A/B」确认。
- **抓帧环境**：GTX 1050 / 驱动 582.28；窗口 1920×1080，**场景分辨率 1632×918**（renderscale 类模组 ≈0.85×）；
  曝光模式 `AUTO_HISTOGRAM`；MOTION_BLUR/TAA/BLOOM 开，DOF 关，CAS 关，PARALLAX 关，KILL_RIPPLE 关。
- 沿用既有裁定：**「降低采样数 / 调 GUI 滑条默认值」不算优化**；新功能默认「无视觉变化」；每项必须可 A/B。

---

## 2. 抓帧事实（1632×918，单帧）

### 2.1 每帧写入带宽模型（上限值：按每个 draw 覆盖满目标计）

| 分组 | MB/帧 | 占比 | 说明 |
|---|---:|---:|---|
| **G-buffer** | **463** | 36% | colortex7 (RGBA16UI) 183 + colortex8 (RGBA16_SNORM) 183 + colortex6 (RGBA8) 74 + colortex12 (RG16) 23；16 个 gbuffer draw |
| **阴影** | **336** | 26% | shadowcolor0 112 + shadowcolor1 112 + 深度 112；28 个 shadow draw（4 个 shadow 程序） |
| **环境/模组侧** | **423** | 33% | Iris labPBR 精灵图集 mip（tex19797/tex21913/tex1351，按 viewport 计的上限）+ 原版/呈现目标 231（1920×1080 主帧缓冲 blit 等）；**不是光影包代码** |
| **光影包照明+后处理** | **116** | 9% | colortex0 69 + colortex3 25 + colortex1 11 + colortex4 9 + 面板 1 + 天空 0.6 |
| 合计 | **≈1.30 GB/帧** | | 60fps ≈ 78 GB/s 写流量（1050 理论 112、可达约 80–90 GB/s） |

**2026-11-12 二次核对（rdc 逐 pass 分组，见 rdc_analysis/capture_feature_cost2.txt）**：
- 上表「labPBR 图集 192 MB」是**按 viewport 满覆盖算的上限**，实际每次 draw 只光栅化一个精灵的小
  矩形 ⇒ 真实带宽可忽略；这块的成本是**每帧 24 次（本次抓帧）微小 draw 的固定开销**，
  不是带宽。9 月复核过 130 次那份（`rdc_analysis/sprite_animation_pass.md`）：真实约 1–2 ms，
  且用户实测关 PBR 帧率不变。
- 计入字节的**包内**写入合计约 **1041 MB/帧**（阴影 336 / 地形 G-buffer 274 / 半透明 137 / 实体 103 /
  手部粒子天空 80 / composite4 34 / TAA 29 / GI 16 / deferred20 11 / 运动模糊 11 / final 6 / bloom 2 /
  面板 1），带宽下限 ≈ 9.1 ms（112 GB/s）。
- 该 rdc **没有 GPU 计时**（RenderDoc 未记录 timer query）：XML 的 duration 是 CPU wall-time，
  不能当 GPU 时间；排行只能靠「字节数 + 代码侧 ALU 估计」，真实 ms 必须 A/B 实测。


### 2.2 显存占用（带标签纹理，main+alt 各一份）

合计 **188 MB**（不含深度与图集）。大头：colortex0/1/3/7/8/27/28 各 11.4 MB×2；
colortex4/6/12 各 5.7 MB×2；shadowcolor0/1 各 4 MB×2；colortex5 (256²) 0.5。
**其中 colortex27/28（启动面板）占 22.8 MB ≈ 12%，只在启动 4 秒用。**

### 2.3 清屏

`colortex3 / colortex6 / colortex7 / colortex12` 的 **main+alt 都被清**（≈68 MB/帧），
shadowcolor0/1 main+alt 再 16 MB/帧（Iris 对 `xxxClear=true` 的缓冲两份都清）。
可省的前提是「每帧被完全覆盖」——colortex6/7 需要保留（天空像素不写材质/反照率），colortex3 待确认。

### 2.4 其它实测

- `setup` 只在**加载时**跑一次（不是每帧），所以 GenSkyMap 的 1/4 棋盘 + 历史累积是有效的。
- `composite20/21`（直方图/自动曝光）只在 `AUTO_HISTOGRAM` 档调度——当前就是这个档。
- `composite11-15`、`deferred21`、`deferred30/31/32` 均已按预期不调度。

---

## 3. A 档：低风险、纯代码、无观感变化（建议先做这一批）

合计 **≈1.0–2.0 ms/帧**。每条都写清「改哪、省什么、怎么验证」。

| # | 项目 | 证据 | 预期收益 | 风险 | 工作量 |
|---|---|---|---|---|---|
| A1 | **实体受击故障帧级门控**（最大单项） | `post/Final.frag:294-376` | **0.2–0.7 ms** | 低 | M |
| A2 | **`CalcSunScreenVisibility` 提为帧常量** | `IntegrateScene.frag:117-135,386`、`Translucent.comp:139-160,292` | 0.05–0.3 ms | 零 | S |
| A3 | **Translucent 早退顺序**（短路写反了） | `Translucent.comp:236-246` | 0.06–0.15 ms | 零 | S |
| A4 | **`colortex15` RGBA16F → RG16F** | `config.glsl:44`、`DOF/Prepare.comp:146`、`DOF/Gather.comp:47,217` | 0.06–0.08 ms + 8 MB 显存 | 零 | S |
| A5 | **TAA 每帧把整张 colortex4 写成 0** | `TemporalAA.frag:28-35,208` | 0.06–0.08 ms | 低 | S |
| A6 | **DOF Gather 重复取同一 texel 的 CoC** | `DOF/Gather.comp:207` vs `:345` | 0.04–0.06 ms | 零 | S |
| A7 | **DeferredLight 两处 `colorimg7` 死写** | `DeferredLight.frag:282,307-314` | 雨天 0.1–0.3 ms / 晴天 0.05 ms | 低 | S |
| A8 | **SSR 天空命中仍跑 8 步二分** | `SSRT.glsl:109-121 → 173-185` | 0.03–0.1 ms | 中（观感） | S |
| A9 | **SSSR/焦散：复用已算好的 shadow-screen 位置** | `shadow/Render.glsl:144-159`（4×链）、`:116-137`（SSS blocker 2×链） | 0.03–0.17 ms | 极低 | S-M |
| A10 | **接触阴影对 NdotL≈0 的像素白付 10 次深度读** | `DeferredLight.frag:440`、`shadow/Render.glsl:394-412` | 0.03–0.1 ms | 极低 | S |
| A11 | **水面法线里同一个 `lfNoise` 取 3 遍** | `water/WaterWave.glsl:63-104` | 0.01–0.03 ms | 零 | 20 min |
| A12 | **雾中光束的 `sRGBToLinear` 换现成近似** | `IntegrateScene.frag:168`、`Color.glsl:63-65` | 0.03–0.15 ms | 极低 | 1 行 |
| A13 | **启动面板：缓冲缩回 1/8 + 3 pass 并成 2 pass** | `config.glsl:83-84`、`StartupPanelBlur.comp` | 0.01–0.02 ms + **22.4 MB 显存** | 低 | M |
| A14 | **直方图并进 Bloom Downsample** | `LumHistogram.comp:49-70`、`Downsample.comp:71-91` | 0.05–0.08 ms | 低 | S-M |
| ~~A15~~ | ~~运动模糊「半分辨率 + 2×2 块共享矢量」~~ **更正：这是 1e4a4873 按用户裁定主动回退的，不是丢失的优化，不要重做** | `git log 1e4a4873` | — | — | — |

> **落地情况（2026-11-12，分支 `perf/audit-a-2026-11-12`）**：A1–A12 已实现（A9 只做零风险的①），
> 共 6 个提交：`2e027550`(A1)、`a9b85d19`(A2/A3/A4/A6)、`91410ae9`(A5/A7/A10/A11/A12)、
> `a8cdb386`(A8)、`b8d49e8e`(A9①)。暂缓：A13（只省显存、面板刚修好）、A14（动自动曝光输入，
> 必须实机 A/B）、A9②（要引入 distort 的雅可比近似，收益同级但数学风险）。A15 作废（见上）。


### A1 细节（最大单项）
`Final.frag` 的 `ENTITY_AREA_GLITCH` 段（`:294-376`）**每帧每像素**先跑
`ComputeGlitchField`（7 次 sin + 10 层撕裂循环 ≈ 17 SFU + ~120 ALU，`:216-238`）、
`GlitchTearDistanceFade`（2 次 depth load，`:135-145`）、1–2 次 `colortex7` 取样（8 B/px，位移采样不吃缓存），
再在 `:345` 才用分支判定是否真的画。常态（场上无受伤实体）**产出恒 0**。
门控是被 2026-09-22 修「特效消失」时删掉的：标志位原本由 `composite5`(HurtTimer) 写 `colortex10.b`，
而 composite5 被 `KILL_RIPPLE`（默认关）门控 ⇒ 标志恒 0。
**修法（推荐）**：在已经算好 `hurt` 的 `gbuffers/Entities.frag:86-87` 里写 `global.hurtEntitySeen = 1`
（SSBO 由 `prepare` 每帧重置，零带宽），`Final` 段首加 `if (global.hurtEntitySeen != 0u) { ... }`。
**兜底**（不改 SSBO）：新增 1 个工作组的 `composite5_a.csh` 扫 16×16 稀疏网格写标志；
或把 `composite5` 从 `KILL_RIPPLE` 解绑（仓内实测该 pass 0.081 ms）。
**注意**：不能改成「按当前像素的 isEntity/isHurt 门控」——`:345` 判的是被位移的**源**像素，
背景像素承载拖拽条带与补洞，必须帧级。

---

## 4. B 档：需要 A/B 或观感裁定（收益真实但要人点头）

| # | 项目 | 证据 | 预期收益 | 风险 | 工作量 |
|---|---|---|---|---|---|
| B1 | **色差让 `GradeScene` 每像素跑 3 次**：拆 `GradeCtx`（泛光/雾/雨/暗角/曝光各取一次）+ `ApplyGrade` | `Final.frag:184-201`、`GradeCore.glsl:56-193` | 0.2–0.3 ms | 低 | M |
| B2 | 同处**再进一步**：色差改到 tone map 之前（AcademyFit 只跑 1 次） | 同上 + `ACES.glsl:398-411` | 0.1–0.2 ms | **中**（高光色边减弱） | S-M |
| B3 | **PCF 的 shadowtex0/1 采样口径不自洽**：半影会误走「彩色透明遮挡」分支 ⇒ 边缘被 albedo 染色/压暗（性能 + 观感双修） | `shadow/Render.glsl:227-245`、`:296-309`、`IntegrateScene.frag:158-169` | 0.01–0.04 ms + 修观感 | 低-中 | S |
| B4 | **`entityShadowDistanceMul = 0.5`**（32 格外实体不进 shadow pass） | `shaders.properties:292-313` 未使用该指令 | 实体多时 0.1–0.4 ms | 中（远处实体无阴影） | S |
| B5 | **shadow pass SOLID 阶段不写 shadowcolor0/1**（不透明 caster 的彩色数据永不被读） | `Shadow.frag:155-167` + `Render.glsl:234` | 0.05–0.15 ms | 低（依赖 B3 先修） | S |
| B6 | **shadow pass 水片元 9 次 noisetex**（只为水底焦散波法线） | `Shadow.frag:148-152` → `WaterWave.glsl:95-104` | 海面视角 0.1–0.3 ms | ①无 ②中 | ①S ②L |
| B7 | **云影覆盖范围与分辨率错配**（2048 格压进 512² ⇒ 4 格/纹素，97% 纹素采样不到；改 `CLOUD_SHADOW_DISTANCE*8` 可白送 4× 锐度） | `GlobalStorage.comp:66-70`、`GenCloudShadow.comp:24-25` | 性能≈0，**画质白送** | 低 | 30 min |
| B8 | **bloom 两趟高斯就地读写同一张 colortex4，且带 `restrict`**（UB/驱动屏障；`BLOOM_KERNEL_C=8` 的 halo 跨工作组） | `bloom/Blur.comp:59,62,121-133` | 正确性为主 | 低 | S |
| B9 | **`begin/SkyView` 全屏 dispatch 服务 192² LUT**（1080p 32,400 组只有 576 组干活） | `SkyView.comp:47`、`image.skyViewImg=192²` | 几十 µs | 低（作者记录过字面量导致 LUT 变空，需抓帧确认） | S |
| B10 | **视差二分后 3–4 次无信息增益**（步长已 < 1 纹素） | `surface/Parallax.glsl:32-45` | 仅开 PARALLAX 时 0.02–0.04 ms | 低 | S |
| B11 | **`colortex10` 仍是 RGBA16F**（升格式的原门控已被删） | `config.glsl:31-34` | KILL_RIPPLE 开时 8.3 MB/帧 | 低 | S |

---

## 5. C 档：结构性改动（大工程，收益上限高）

| # | 项目 | 预期收益 | 风险 | 工作量 |
|---|---|---|---|---|
| C1 | **SSR 追踪搬到半分辨率 compute + 命中缓冲 + 双边上采样**（复用现成的 `ReprojectScene` 与 `UpscaleDiffuseIndirectFrom` 范式） | **0.4–1.5 ms**（唯一 ms 级） | 中-高（本仓两次「半分辨率 imageStore 读不到」前科） | 2–4 天 |
| C2 | **G-buffer 带宽收窄**：colortex8 (RGBA16_SNORM) → 8 bit；colortex7 (RGBA16UI) 位域压缩 | 写带宽 −20%（≈90 MB/帧）+ 显存 | 中高（法线色带 / 材质位语义全链同步） | L |
| C3 | **DOF 不再把整张场景色复制进 colortex3**（Prepare 只写 CoC，Gather 读 c0 写 c3，TAA/运动模糊改道） | 16.6 MB/帧（≈0.1–0.2 ms） | 中（跨 4 pass 改道，格式/布局错一处就静默失败） | M |
| C4 | **两趟 Gauss（bloom H/V）合并成单 pass LDS** | 0.03–0.06 ms | 低 | L |
| C5 | **雾噪声把「二八度 2D 取样」烘成 128³ R8 3D 纹理**（采样点仍 3 个，只是每次 2 fetch → 1） | 6.2 M 采样/帧（0.05–0.12 ms） | 低 | 半天（含离线烘 `.bin`） |
| C6 | **静态几何阴影不每帧重画** | — | **核实不成立**：Iris 无 pass 级门控、shadowtex 每帧清空 | 不做 |

---

## 6. D 档：已核实「已优化 / 不要再提」（避免重复劳动）

| 项 | 现状 |
|---|---|
| Bloom 多级 | 已砍成单级 L0 画布，L1–L5 已 `enabled=false`（`shaders.properties:1193-1211`） |
| 天空 LUT（TLUT/MSLUT/SkyView） | 全部首帧化 + 版本指纹门控，不变就 `return` |
| 天空环境图 256² | 1/4 棋盘 + 历史累积（≤128 帧），已是 LUT 最优形态 |
| 天空 SH | 1 工作组 × 256 线程 + subgroup 归约，≈0 |
| 雾 | 闭式积分，无步进循环；超 shadowDistance 已早退 |
| 云影生成 | 1/16 棋盘 + 0.95 时域累积，已是标准答案 |
| 半透明 | 走 compute 后合成，不是 forward 混合 overdraw |
| DOF | Postfilter 已并入 Gather；CoC 传播已复用 |
| 硬件 PCF | 已在用（`sampler2DShadow`），单 tap 已拿 2×2 平均 |
| deferred21 / deferred30-32 / composite11-15 | 已删或已关 |
| `Uniform.glsl` 40 个 sampler | Iris 只绑 active，运行期收益≈0 |
| 阴影贴图分辨率/级联 | 该 pass 是几何/调用开销主导；加级联会推翻所有消费端约定 |
| 「距离→abs 省 sqrt」类 | `SSRT.glsl:144` 的 `distance()` 已是一条指令，无收益 |

**另外核实后否决的两条子代理结论**：
- 「`setup` 每帧清零 colortex5 破坏天空累积」——**不成立**：Iris 的 `setup` 只在加载/改窗口时跑一次。
- 「TAA 清 colortex4 只是清 ReprojectScene 的洞」——**不准确**：它把整张缓冲写成 0（这正是 A5 的收益来源），
  但删掉前必须确认「colortex4 下半区确实没有读者」（当前证据支持：只有左上象限被采样）。

---

## 7. 建议的落地与验证流程

1. **先做 A 档**，按 A1 → (A2+A3+A4+A6) → A5 → (A7+A11+A12) → A9/A10 → A13/A14/A15 分 4–5 个提交。
   每批一个提交、可单独 `git revert`。
2. **验证协议**（每批）：
   - 同视角同时间（`/time set`、`/weather clear` 冻结）× 定点截图，`rdc_analysis/compare_shots.ps1` 做 diff；
   - F3 帧时间取 3 次中位数；或每批前后各抓一帧 `.rdc`，用 `renderdoccmd convert` + `capture_inventory.py` 对比
     pass 结构与字节数（脚本已备好）；
   - 需要 GPU 级 pass 时间时，用 qrenderdoc 的 Event Browser Duration（会重新注入 timer query，比 XML 的 duration 可信）。
3. **B 档逐项 A/B**，凡涉及观感的（B1/B2/B3/B6/B7）先给你看前后截图再定。
4. **C1/C2/C3 只在 A/B 档做完仍有帧数缺口时再考虑**。

---

## 8. 附录：本次用到的工具（都在被 gitignore 的 `rdc_analysis/`）

- `rdc_analysis/capture_rdc` → `renderdoccmd convert -f capture.rdc -o rdc_analysis/capture.xml -c xml`
- `rdc_analysis/capture_inventory.py`：pass 清单 / 每帧写入带宽 / dispatch 尺寸 / 非着色器开销
- `rdc_analysis/capture_buffers.py`：清屏明细 / copy-blit / 带标签纹理显存清单
- 产物：`rdc_analysis/capture_inventory.txt`、`rdc_analysis/capture_buffers.txt`
