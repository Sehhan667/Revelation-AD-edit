# STATUS — 现在在哪

> **最后更新：2026-11-23 20:48**
> 过期判定：若 `.workbuddy/memory/` 里有比这个日期更新的日志，**先读那篇日志**，本文件可能已落后。
> 本文件只写"现在"。过程在日志，历史在 `docs/archive/`，规矩在 `RULES.md`。

## 一句话

26.3（Iris 1.12 + Vulkan）的第一人称手部阴影闪**已修并推送**（`cf114fce`，人实测通过）；
REBLUR 降噪链还有 **13 项标 `⏳` 等实机确认**；最老的悬案是 `historyReset` 到底恒真还是恒假
—— 诊断通道已接好，**一次读数就能定性**。
天空链：**B/C1 性能优化已提交**（`d9be7e03`、`f7b0bf25`）。**SSR 链 #2/#3/#5 已改并提交**。
**AO 新增第 4 档 `VANILLA_AO`（原版 AO）**：`AO_ENABLED` 选它时在 gbuffers_terrain 把
`gl_Color.a` 乘进 albedo，不跑 SSAO/GTAO 追踪。三套自检过，**待进游戏 A/B**。

**进行中：渲染缩放 / 超分辨率移植（分支 `feat/render-scale-port`，只做路径 A）**
- 已落地：选项与 uniform（阶段 1）、gbuffers/DH/天气/星空几何缩放（阶段 2）、
  `composite6_b` 双线性 + FSR1 EASU 升采样、TAA 读 `colortex10`、GI/SSS/DOF/云的 buffer 尺寸与
  workGroups 缩放、反射源画布映射（阶段 3 主体）。
- 100% 档新增代码全部被 `#if RENDER_SCALE_1000X != 1000` 编译掉；50% 档世界画到左下角。
- **待实机**：100% 逐位一致、50% 铺满全屏、GI/云/反射/SSR 边缘是否错位。
- 未做：SSR/AO/SSILVB 的画布边界精修（预期边缘小瑕疵）、voxy（本实例未装）、26.3 验证。
- 2026-11-27 复核：50% 实测只有 ~10% 提升。按 `222.rdc`（RD=2）的 100% 预算，延迟光照 41% /
  合成 15% / 地形 13% ⇒ 若三处都真的缩到 25%，50% 档应接近 2×；10% 恰等于"只有地形缩了"的量级。
  本轮补了 `diffuse/Accumulate.frag` 的画面外早退（仅 GI_MODE≠0 有收益）；`ReprojectScene` 的
  `workGroupsRender=0.5` 复核后**不是**缺陷（50% 时它正好等于画布边长，1 源纹素 = 1 画布像素）。
  剩下要定性的只有两件：该次实测的构建是否已含 `deferred20`/`composite4` 的缩小；`maxFps=160`
  是否截断了收益。

**新增：光照半分辨率（`LIGHTING_HALF_RES`，默认关）**
- `deferred20` 改写 `colortex10`（附加色）+ `colortex11`（光照系数），两张都是 **0.5 屏**
  （= 全分辨率的一半，**不随渲染缩放再除一次**）；新 pass `deferred24`
  （`program/post/LightingResolve.frag`）做深度感知上采样，乘回**全分辨率** albedo 写 `colortex0`
  ⇒ 纹理细节不丢，软的只有阴影/AO/反射轮廓。
- 坐标口径固定在 `RenderScale.glsl`：`lightingViewSize = viewSize * 0.5`、
  `lightingTexelScale = RENDER_SCALE * 2.0`（一个光照纹素覆盖多少画布纹素）。因此光照永远占
  屏幕 1/4 像素：100% 档 = 画布的 1/4（4× 收益），50% 档 = 画布 1:1（无收益，只多一个 resolve pass）。
- 拆分点全部在 `DeferredLight.frag` 的最终合成：`lightAcc * albedo + extraAcc`
  （金属 `(1-m)` / 电介质 `(1-Fd)` / 无命中 三支），关闭该选项时原代码路径逐位不变。
- `deferred20.vsh` 在该选项下 `#define NO_SCALE`（盖满 0.5 缓冲），避免非整数挡位光栅化取整
  漏写边缘纹素。
- **待实机**：开选项后看 ① 有无编译错误（日志搜 `deferred24`）② 明暗过渡是否只在轮廓软 1~2px
  ③ 天空/玻璃/水面是否正常（这三支走"全加算色"）④ 与 50%/75% 渲染缩放叠加时的清晰度。
- 未覆盖：Distant Horizons（`deferred24` 只读 `depthtex0`，LOD 深度没接）、SSS 屏幕空间扩散
  （默认关）、26.3 Vulkan 未验证。

**地形 G-buffer 性能**：RenderDoc 实测（`222.rdc`，RD=2）显示该 pass 固定屏空间成本 ≈2.1 ms、
overdraw **2.47×**（RD=12 时 4.12×）、每片元 4 次纹理采样。**档 1 已改**：`Terrain.frag` 的
`BlueNoise()` dither 换成 IGN + 黄金比例每帧旋转（省一次 `texelFetch`）。三套自检过，**待实测**。

## 环境与命令

| 项 | 值 |
|---|---|
| 工作区 | 本目录（git 仓库，长期带未提交改动，**不要 reset**） |
| 选项文件 | `shaderpacks/Revelation-AD-edit.txt`（Iris 会重写，只保留认识的键） |
| 日志 | `1.21.11-Fabric 0.18.4/logs/latest.log` |
| 重载 | 游戏前台按 `i`（不监听文件变化；**不要抢焦点**） |

```bash
node scripts/preproc_check.js --all      # 预处理配平 + 悬空标识符
node scripts/shader_semantic_check.js    # 语义级
node scripts/shader_static_check.js      # 静态
```

基线：以"无新增命中"为准，入口数会随 pass 增删变化，别记死数字。本机无 GLSL 编译器。

## 本轮确认的硬事实（可直接引用，不用重查）

1. **Iris 1.12 的手部投影多了 `.m22(0.125).m32(0.4375)`**
   （`net.irisshaders.iris.pathways.HandRenderer.setupGlState`）。⇒ 手部 raw depth 区间从
   `<0.5625` 变成 `0.656..0.782`，还原式从 `8d-3.5` 变成 `8d-5.25`。Iris 官方文档**没写这个偏移**。
2. **26.3 把手提交两次**：solid（opaque 后、deferred 前）+ blending（世界末、composite 前）。
   两次深度差在浮点噪声量级时，`Translucent.comp` 的 `loadDepth0 < loadDepth1` 会**逐帧翻转**
   ⇒ 手部在"完整光照（亮、有阴影）"与"廉价补合成（暗、无阴影）"之间跳。修法是手部像素在
   `Translucent.comp` 里直接放行。
3. **26.3 是 Vulkan 后端**：`image.` 自定义图只能用 RGBA16F / RGB10_A2 / R32UI 这类保证支持的格式；
   用 R11F_G11F_B10F 会报 `no image registered for X`（1.12 才报错，1.11 及以前静默跳过）。
4. **`shaders.properties` 必须纯 ASCII（含注释）**：一个中文字符 ⇒ jcpp 抛 `Bad token` ⇒
   文件被截断在该行之前 ⇒ 后面所有 `image.*` / `screen.*` 静默消失。
   看见 `no image registered for X`，**先查日志有没有 `Properties pre-processing failed`**。
5. **累积帧数 cap 不是单调收益**：cap 32 实测比 cap 22 更吵（alpha 之外还喂 EAWF 的 NLAS 与 TS 的 accumSpeed）。
6. **`GI_MOTION_RESPONSE` 是治拖影的开关**（开 = 移动时噪点略升、拖影骤降），不是治闪的。

## 待验证（按优先级）

1. **`historyReset` 是恒真还是恒假 —— 未定论。**
   两轮得出相反结论：11-11 记录"排除（恒 false）"；11-13 从表达式推断"恒真
   （`smooth(x,0.2,0.2)` 在量级 1e3~1e5 上退化）"。诊断已接好：`DEBUG_GI_ACCUM_STATS` 浮层的
   **蓝通道 = 该 uniform 的实际值**，蓝=1 即恒真。
2. **REBLUR 清单的 13 项 `⏳`** —— 见 `REBLUR-CHECKLIST.md` 顶部「待实机确认」表，逐项要人眼回填。
3. **TAA 手部历史只有 3 帧**，手会略噪（`cf114fce` 的已知代价）。嫌噪可放宽到 6，属可选优化。
4. **B 档天空性能优化**（2026-11-22，已提交 `d9be7e03`，用户确认无异常）：
   - `SkyView.comp` 物理模型补了 `moonVisible` 门控，白天跳过月光那趟 raymarch；
   - `clouds/Render.glsl` `CompositeClouds` 的月光透射查询同样按太阳高度跳过。
   两处都用 `moonVisible = 1 - smoothstep(-0.08, 0.02, sunHeight)`，夜间与原值逐位一致。
5. **C1 天空图降分辨率待 A/B**（2026-11-22）：`skyMapTex`(colortex5) 256²→128²，
   同步改了 `GenSkyMap` workGroups 8×8、三个 `setup.csh` 8×8、config 注释。
   **验证口径**：看天空反射（水面/金属）与地平线渐变是否可接受，若不接受回退到 256²。
6. **SSR 链 #2/#3/#5 待 A/B**（2026-11-22）：
   - #2 `ReprojectScene.comp`：反射源现在**每 texel 必写**；重投影失败（出屏/手部 depth≤0.56）时
     退化为「不重投影」（采当前屏幕位置的上一帧色），不再保留 colortex4 象限里的 bloom 残值。
     **验证口径**：金属/水面反射里是否有旧泛光色斑、贴合/边缘是否更干净。
   - #3 死链已删：`SpecularFilter.comp`、`world*/deferred30-32.csh`、`REFLECTION_FILTER` 宏 + lang。
   - #5 `reflectionDist` 深度源 `depthtex0`→`depthtex2`（与 SSRT 命中判定统一）。
     仅影响粗糙反射接触硬化（`ROUGH_REFLECTIONS` 默认关）。
7. **原版 AO（`AO_ENABLED = VANILLA_AO`）待 A/B**（2026-11-23）：
   - `shaders.properties` 的 `separateAo = true` 早已开启，原版 AO 一直在 `gl_Color.a`，
     但 `Terrain.vert` 只写 `gl_Color.rgb` 把它丢了 ⇒ 本次接上并乘进 albedo。
   - 改动：`settings.glsl` 加 `VANILLA_AO 3`；`Terrain.vert/frag` 透传 `vertAo` 并 `albedoOut.rgb *= vertAo`；
     `DeferredLight` 的 AO 守卫收窄为 `AO_ENABLED == 1 || == 2`（3 走 else，ao=1）；
     GI_MODE=1/2 时三档 AO **一律强制关闭**（含原版 AO，避免与体素遮蔽双重变暗）。
   - **验证口径**：GUI「环境光遮蔽」选「原版」，看方块棱角/凹陷是否有原版那种逐顶点遮蔽；
     对比 GTAO 档位，原版应更硬、更贴合方块边界；关掉后应完全无 AO。

## 已排除（别再往这些方向找）

- ❌ "脏污来自体素光场（IRC）的低频偏差" —— 与"静止干净"矛盾，最多是次要因素。
- ❌ "GI 强度不够" —— `VOXEL_GI_STRENGTH` 与 `IRC_GI_STRENGTH` 是两个开关，用前者做"关 GI"归因是错的。
- ⏸ "加大累积 cap" —— 2026-11-12 实测反向，不要想当然加。
- ⏸ "调历史长度治拖影" —— 治不了，要用 `GI_MOTION_RESPONSE` 或运动自适应。

## 下一步（最多 3 条）

1. 进游戏打开 `DEBUG_GI_ACCUM_STATS`，看蓝通道，把 `historyReset` 定性并回填本条。
2. 按 `REBLUR-CHECKLIST.md` 的 ⏳ 表做一轮实机 A/B，逐项回填 `✅` 或记失败现象。
3. 若无新病灶，再考虑 `docs/archive/backlog/TODO.md` 里长期搁置的项（反射拖影、级联等）。

## 陷阱（每一条都踩过）

- 改选项前**先 grep 真实选项名**，否则 Iris 重载时静默丢弃，实验等于没做。
- 报告"闪"**必须带 fps**；抓屏测量分辨率约 0.3 级，小差异别过度解读。
- 判据放宽要做**反向测试**（确认非目标不命中），否则会出现"靠近摄像机的东西消失"。
- 诊断开关（`GI_DEBUG_VIEW`、`DEBUG_GI_ACCUM_STATS`）用完必须关。

## 诊断设施与工具

| 工具 | 用途 |
|---|---|
| `GI_DEBUG_VIEW` 1~6 | 历史长度 / 方差 / 孤立亮点 / 三段对比 / 三通道 / 几何可信度（语义见 `REBLUR-CHECKLIST.md` 顶部） |
| `DEBUG_GI_ACCUM_STATS` | 全屏读数：R=累积帧数、G=本帧不可靠、**B=historyReset** |
| ~~`.workbuddy/shots/gi_probe.py`~~ | 窗口定位 + 抓帧 + 通道/噪声能量读数 —— **2026-11-22 已清理，未重建** |
| ~~`.workbuddy/shots/auto_capture.py`~~ | 等前台 → 按 `i` → 连拍（不抢焦点） —— **同上，未重建** |
| ~~`.workbuddy/shots/flickpipe.js`~~ | 不落盘的管道统计 —— **同上，未重建** |
| `scripts/rdc/` | 2026-11-22 从旧 `rdc_analysis/` 抢救出的 RenderDoc 分析脚本（抓帧文件本身已删） |
