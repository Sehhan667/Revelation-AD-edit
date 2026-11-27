# 任务书：移植原版 Revelation 的降分辨率 / 超分辨率

> 分支：`feat/render-scale-port`（基于 `dev`，2026-11-27 建立）
> 上游基准：`upstream/dev` = `cf7a0f67`（Improve SSRT）
> 本轮**只做规划**，不改 shader；下面的阶段按顺序执行，每阶段一个提交、可单独 revert。

---

## 执行进度（2026-11-27）

- [x] 阶段 0：分支 `feat/render-scale-port`
- [x] 阶段 1：选项、自定义 uniform、`RenderScale.glsl`、`colortex10`
- [x] 阶段 2：gbuffers/DH/天气/星空顶点缩放，`Simple.vert` 画布缩小，TAA/Grade/Final `NO_SCALE`
- [x] 阶段 3 主体：3b Translucent、3c SSS、3d DOF、3e GI 链、3f 云尺寸/调度、3h ReprojectScene
- [x] 阶段 4：`composite6_b` 双线性 + FSR1 EASU，TAA 读 `colortex10`
- [ ] 阶段 3a/3g 边界精修（SSR/AO/SSILVB 的画布边缘，预期小瑕疵）
- [ ] 实机验证：1000 逐位一致、50%/75% 构图与 fps
- [ ] 阶段 6 收尾（检查、文档、提交）

---

## 0. 结论摘要

1. 上游功能是**两条独立路径**：
   - **路径 A（本轮唯一目标）：shader 内置 `RENDER_SCALE_1000X`**（降分辨率 + 内置升采样 + 可选 FSR1 EASU），不依赖任何 mod。
   - **路径 B（不做，仅存档）：`super_resolution` mod 接口**（`shaders/superresolution.json` + `SR_*` 宏），由 mod 在指定 pass 前接管升采样。
     用户已明确只考虑路径 A。
2. 本地**没有**任何 RENDER_SCALE 体系（`docs/archive/MEMO-2026-11.md` §112 的老坑：uniform 未赋值时 Iris 默认 0 ⇒ 画面错位）。
   本地 DOF/SSR/GI 等库都写着"本包没有渲染缩放体系"的适配注释，移植时必须逐处推翻。
3. **不能照抄上游的坐标写法**。上游用"缩放域 uv 0~1 + `scaleScreenUv`"，本地 GI 链的既有契约是
   "**画布 texel = 全屏像素坐标的子集**"（`renderTexel = texelPos * 2 + phase`，见 `Accumulate.frag:473-480`）。
   本规划采用 **方案 A：保留全屏像素坐标，只缩小画布与 dispatch**，避免重写整条 REBLUR 链。
4. 本地主世界/下界/末地是**三套独立 world 目录**（`world0` / `world-1` / `world1`），pass 入口要三套同步。
5. 默认值 `RENDER_SCALE_1000X = 1000` 时，全链路必须**逐位一致**（CODE_STYLE §4 铁律一）。所有新代码都要
   被 `#if (RENDER_SCALE_1000X != 1000)` 或 `#if SR_ENABLE` 编译掉。
6. 模组现状（已核实）：
   - `1.21.11` 实例：`renderscale-1.4.0-alpha.4` **启用中**；`[超分辨率] super_resolution-0.9.1-alpha.1` **已装但 disabled**。
   - 两个 mod 互相 `breaks`，只能二选一。测试 shader 内置缩放时**必须禁用 renderscale**，否则会叠加两次缩放。
   - `26.3` 实例：`renderscale-2.0.0-beta.1`（disabled），无 `super_resolution`。

---

## 1. 目标（可验收）

| # | 目标 | 验收口径 |
|---|---|---|
| G1 | GUI 出现「渲染缩放」档位（100/90/85/75/66.7/60/58.8/50%） | 切换档位能触发 Iris 重载并真实改变内部分辨率 |
| G2 | 50% 时世界几何只占屏幕左下 1/4，最终画面被正确铺满全屏 | 无拉伸、无黑边、无错位、无重复象限 |
| G3 | 升采样支持内置双线性与 FSR1 EASU 两档 | 两档肉眼可区分；FSR1 无 NaN/黑块 |
| G4 | 所有后处理（TAA/DOF/Bloom/CAS/MotionBlur/曝光）在缩放下不崩 | 逐个开关 A/B 通过 |
| G5 | GI 链（半分辨率画布）在 50%/75% 下仍对齐 | 静止无错位、移动无拖影恶化 |
| G6 | 100% 档与改动前逐位一致 | 截图对比 / 同一视角像素差 ≈ 0 |
| G7 | ~~`super_resolution` mod 接管缩放~~ | **不在本轮范围（只做路径 A）** |

**性能目标**：50% 档在 GPU 瓶颈场景应显著提升 fps（以用户实测为准，不预设毫秒数）。

---

## 2. 不做什么（边界）

- 不引入 DLSS/XeSS/TAAU；只做双线性 + FSR1 EASU + 既有 CAS。
- 不改 `shaders/ffx/` 现有文件；FSR1 作为**新目录** `shaders/ffx/fsr1/` 整体引入（AMD MIT，文件头保留）。
- 不改 specular 的 NRD 对齐范围（沿用 CONTEXT 的"明确不做"）。
- 不重构 GI 链的降噪算法；只改坐标/尺寸/调度，不动权重与判据。
- 不把上游的 `CombineLighting` / `SpecularFilter` / `deferred30-32` 死链搬回来（本地已删除，见 `STATUS.md`）。
- 不改变 TAA 的双模式（MakeUp 默认）与手部判定（0.5625 / 0.656~0.782）。

---

## 3. 上游功能拆解（移植标的）

### 3.1 选项层（`upstream/dev:shaders/settings.glsl:239-266`）

```glsl
#define RENDER_SCALE_1000X 1000 // [500 588 600 667 750 850 900 1000]
// 每档派生：RENDER_SCALE（0.5~1.0）、RENDER_SCALE_HALF（0.25~0.5）
#define UPSCALE_MODE 1 // [0 1]  0 = bilinear, 1 = FSR1 EASU
```

`shaders.properties` 里还要**重复定义一遍**这两个宏（properties 的预处理环境不包含 `settings.glsl`），
并派生自定义 uniform：

```properties
uniform.vec2.scaledViewSize     = vec2(floor(viewWidth * RENDER_SCALE), floor(viewHeight * RENDER_SCALE))
uniform.vec2.scaledHalfViewSize = vec2(floor(viewWidth * RENDER_SCALE_HALF), floor(viewHeight * RENDER_SCALE_HALF))
uniform.vec2.scaledTexelSize    = vec2(1.0 / scaledViewSize.x, 1.0 / scaledViewSize.y)
uniform.vec2.renderScale        = scaledViewSize * originTexelSize
```

### 3.2 几何层

- 所有 gbuffers 顶点（Terrain/Block/Entities/Hand/Overlay/Basic/Textured/Water/Weather）、DH Terrain/Water：
  在 `gl_Position` 与 `taaJitter` 之后追加

  ```glsl
  #if (RENDER_SCALE_1000X != 1000) || SR_ENABLE
      gl_Position.xy = gl_Position.xy * renderScale + (renderScale - 1.0) * gl_Position.w;
  #endif
  ```

  效果：NDC `[-1,1]` → `[-1, 2*scale-1]`，即世界画到**左下角** `scale×scale` 区域。
- `Simple.vert`：全屏三角形 `uv *= renderScale`（仅 `!defined NO_SCALE` 的 pass）。
- `Begin_a.csh`：`workGroupsRender = vec2(RENDER_SCALE, RENDER_SCALE)`，用于清全屏缓冲的左下角画布。
- gbuffers frag：`deltaUv1/2 *= renderScale`（修 mip 导数）；并加"画布外 discard"（上游 "G-Buffers render scale discard"）。
- `voxy.json` 加 `"renderScale": [...]` 档位表。

### 3.3 缩放域 pass 的坐标

上游把屏幕坐标统一换成"缩放域 uv 0~1"：
- `lib/utility/Load.glsl` 新增 `uvToTexelScaled` / `texelToUvScaled`（基于 `scaledViewSize/scaledTexelSize`）。
- `Transform.glsl`、SSAO/GTAO/SSILVB/SSR/SSRT/shadow render、Translucent、IntegrateScene、DOF、
  `Accumulate`/`DiffuseIndirect`/`EAWF`、bloom、MotionBlur、LumHistogram、SpecularFilter 等全部改用 scaled 坐标。
- 采样**全屏纹理**时用 `scaleScreenUv(uv) = uv * renderScale`。

### 3.4 升采样

- 新增 `program/post/SR/Upscale.comp`，目标 `colorimg3`，输入 `colortex0`；
  `UPSCALE_MODE==0` 直接 `texture(colortex0, scaledUv)`；`==1` 调 `fsr1Easu(scaledViewSize, originViewSize, originViewSize)`。
- 新增 `world0/composite6.csh`（include Upscale.comp）。
- `program.world0/composite6.enabled = false` 当 `SR_ENABLE || RENDER_SCALE_1000X == 1000`。
- TAA（`composite7`）加 `NO_SCALE`，并在缩放时读升采样后的缓冲（上游读 `colortex3`）。
- 新增 `ffx/fsr1/ffx_fsr1.glsl`（AMD FidelityFX FSR1，2021 版）。

### 3.5 SR mod 接口

- 新增 `shaders/superresolution.json`（schema 2，`trigger: BEFORE composite8`，`inputs.color.src = autotex1`，`outputs.upscaled_color.target = autotex1`）。
- 新增空 pass `world0/composite8.fsh/.vsh` 作为 SR 触发边界；`program.world0/composite8.enabled` 由 `SR_ENABLE` 控制。
- `lib/Utility.glsl` 顶部：

  ```glsl
  #if SR_INSTALLED && SR_ENABLE
      #undef TAA_ENABLED
      #undef CLOUD_TAAU_ENABLED
      #undef CAS_ENABLED
  #endif
  #if SR_ENABLE
      #undef RENDER_SCALE
      #define RENDER_SCALE SR_RENDER_SCALE_FACTOR
      #undef RENDER_SCALE_HALF
      #define RENDER_SCALE_HALF SR_RENDER_SCALE_FACTOR_HALF
  #endif
  ```

- `SR_INSTALLED` / `SR_ENABLE` / `SR_RENDER_SCALE_FACTOR` / `SR_RENDER_SCALE_FACTOR_HALF` /
  `SR_SHOULD_APPLY_JITTER` / `SR_ALGO_SUPPORTS_JITTER` / `SRJitterOffset` / `SRPreviousJitterOffset`
  **由 `super_resolution` mod 注入**（已核实 mod 的 `SRCompatV2Processor` 会注入这些宏；Iris 自身不注入）。
- TAA jitter 在 SR 时改用 mod 提供的偏移：

  ```properties
  #if SR_ENABLE && SR_SHOULD_APPLY_JITTER && SR_ALGO_SUPPORTS_JITTER
      uniform.vec2.taaJitter = vec2(SRJitterOffset.x * 2.0 * scaledTexelSize.x, SRJitterOffset.y * 2.0 * scaledTexelSize.y)
  #endif
  ```

---

## 4. 本地与上游的差异（为什么不能照抄）

| 维度 | 上游 (cf7a0f67) | 本地 (dev) | 影响 |
|---|---|---|---|
| 坐标体系 | 缩放域 uv 0~1 + `scaleScreenUv` | 全屏像素坐标 + 半分辨率画布（`texelPos*2 + GI_CANVAS_PHASE`） | 决定用方案 A，不能整体替换 |
| 升采样目标 | `colortex3` | `colortex3` 已被 GI 占用（`SpatialUpscale` 读它） | 需新增 buffer（建议 `colortex11`） |
| pass 编号 | DOF=composite3/4/5，SR upscale=composite6，TAA=composite7，SR 占位=composite8 | DOF=composite6/6_a，TAA=composite7，Grade=composite31，无 composite8 | 升采样插在 `composite6_b` |
| TAA | Playdead YCoCg，单模式 | MakeUp/Playdead 双模式，默认 MakeUp；motionVector 方向相反；手部特判 | 只改 loadInput 与 jitter，不动算法 |
| CAS | `Final.frag` 内 `FFXCasFilter` | `GradeCore.glsl` 内联 / `composite31` Grade+CAS | 不重复引入上游 CAS |
| GI 链 | 简化版 diffuse 链 | 13 个 REBLUR 对齐 pass，half-res 画布，`colortex2/3/14/21-26` | 缩放要同时改尺寸/调度/边界，风险最高 |
| buffer 布局 | colortex0/1/2/3/4/9/13/14 为主 | 0~28 全用（含 SSS 18-20、DOF 15、启动面板 27/28） | 升采样目标只能用空闲 10/11 |
| 手部 | `depth < 0.56` | `IsHandScreenDepth`：`<0.5625` 或 `0.656~0.782`（Iris 1.12） | 判定基于深度，无需改 |
| world 目录 | world0/world1 | world0 / world-1 / world1，三套完整链 | pass 入口三套同步 |
| 平台 | OpenGL | 1.21.11 OpenGL(Iris 1.10.8) + 26.3 Vulkan(Iris 1.12) | 新 image 必须是 RGBA16F |
| 模组 | 依赖 `super_resolution` mod（可选） | `renderscale` 启用、`super_resolution` disabled | 测试前必须二选一 |

**本地已有但上游没有、且缩放时会坏的东西**（必须逐一处理）：
- `lib/SpatialUpscale.glsl`：把半分辨率 GI 画布铺到全屏，内部用 `halfViewSize`/`viewSize` 做 clamp。
- `lib/post/DOF.glsl`：注释明写"本包没有 RENDER_SCALE，scaledViewSize 已替换为全屏 viewSize"。
- `program/post/SubsurfaceBlur.comp`：SSS 三张 half-res buffer。
- `program/Translucent.comp`：`workGroupsRender=1.0`、`uvMax = 1 - viewPixelSize`。
- `program/clouds/Render.comp` / `Reconstruct.frag`：云 TAAU 自带 1/2、1/3、1/4 缩放，与全局缩放叠加。
- `program/ReprojectScene.comp`：反射源写 `colorimg4` 的左上象限，`currentUv = texelToUv * 2`。
- `composite31`/`composite32-34`（Grade/启动面板）：`Simple.vert` 若统一缩放会把启动面板画布也缩小 ⇒ 需 `NO_SCALE`。

---

## 5. 设计决策

### D1 坐标系：方案 A（全屏像素 + 缩小画布）

- 世界几何按 `renderScale` 缩到左下角；**所有 buffer 仍是全屏尺寸**（GI/SSS 的半分辨率 buffer 乘 `RENDER_SCALE`）。
- 所有屏幕空间 shader 继续用 `viewSize` / `viewPixelSize` 求 uv：
  `gl_FragCoord ∈ [0, scaledViewSize)` ⇒ `uv ∈ [0, renderScale)`，正好落在左下角世界内容上。
- 画布边界统一用新宏：

  ```glsl
  #define CANVAS_END       ivec2(scaledViewSize)
  #define CANVAS_END_HALF  ivec2(scaledHalfViewSize)
  ```

  替换现有 `ivec2(viewSize)` / `ivec2(halfViewSize)` 的**边界判断**（不是替换所有坐标计算）。
- 只有三类地方需要"缩放域 uv 0~1"概念：`Simple.vert`、TAA jitter、升采样 pass。

**理由**：本地 GI 画布契约就是全屏像素子集；改成上游的 uv 0~1 需要重写 13 个 pass 的坐标，且会踩 MEMO §112 的老坑。

### D2 buffer 分配

| 用途 | 选择 | 说明 |
|---|---|---|
| 升采样输出 | **新增 `colortex10`**（RGBA16F，clear=false） | 核实：本地只在已删除的 kill-ripple / composite5 用过，现在全仓无读者；`colortex11` 仍被 `Reflection.glsl` 的调试热图分支引用，避开 |
| GI/SSS half-res | `colortex2/14/18/19/20/21/22/23/24/25/26` | `size.buffer` 改为 `RENDER_SCALE_HALF` |
| DOF CoC | `colortex15` 保持全屏 | 只写画布区域；不改格式 |
| 云历史 | `colortex9/13` | 阶段 3f 单独处理（与 `CLOUD_TAAU_SCALE` 叠加） |
| 启动面板 | `colortex27/28` 保持全屏 | `composite32-34` 走 `NO_SCALE` |

### D3 升采样时机

- 位置：`composite6_b`（在 DOF `composite6/6_a` 之后、TAA `composite7` 之前），三套 world 都加。
- 输入 `colortex0`（本地是 **YCoCg**，不是上游 RGB）；输出 `colortex10` 也保持 YCoCg。
- `UPSCALE_MODE==0`：输出 texel → `uv = (texel+0.5) * viewPixelSize`，直接采样 `colortex0`
  （画布内容就在全屏 uv 的左下角 `0~renderScale`，无需再乘 renderScale）。
- `UPSCALE_MODE==1`：移植 `ffx_fsr1.glsl`，以 `colortex0` + `scaledViewSize` / `originViewSize` 调用。
  FSR1 的采样器用 `texelFetch` 到左下角画布，尺寸参数用 `scaledViewSize`。
- `RENDER_SCALE_1000X == 1000` 时该 pass 关闭（properties 控制），零开销。

### D4 TAA 与 jitter

- `composite7.vsh` 加 `#define NO_SCALE`（三套 world），TAA 必须全屏运行。
- `loadInput`：

  ```glsl
  #if (RENDER_SCALE_1000X != 1000) && !SR_ENABLE
      #define loadInput(texel) (texelFetch(colortex11, texel, 0).rgb)
  #else
      #define loadInput loadSceneMain
  #endif
  ```

- `taaJitter` 幅度改基于缩放像素：`frameX / scaledViewSize.x`（否则 50% 下抖动只有半像素，AA 退化）。
- TAA 的历史仍是全屏 `colortex1`；`CrossClosestFragment`、`viewPixelSize` 全部保持全屏。
- 手部 `depth < 0.56` 的 motion blur 分支保持不变。

### D5 边界处理（方案 A 的唯一系统性风险）

画布只占左下角，所有"屏幕边缘"逻辑必须改用 `CANVAS_END`，否则会在画布右/上边缘采样到空白：

| 文件 | 现有写法 | 改为 |
|---|---|---|
| `lib/surface/SSRT.glsl` | `saturate`/`vec2(1.0)` | 画布边界 `renderScale` |
| `lib/surface/Reflection.glsl` | `clamp(..., vec2(1.0))` | `clamp(..., renderScale)` |
| `lib/lighting/SSAO.glsl`、`GTAO.glsl`、`SSILVB.glsl` | `uvToTexel` + 全屏边界 | `uvToTexel` + 画布边界 |
| `program/Translucent.comp` | `uvMax = 1 - viewPixelSize` | `uvMax = renderScale - scaledTexelSize` |
| `program/IntegrateScene.frag` | 折射/偏移采样 | 画布边界 |
| `lib/SpatialUpscale.glsl` | `halfViewSize`/`viewSize` clamp | `scaledHalfViewSize`/`scaledViewSize` |

**执行策略**：先只加 `CANVAS_END` 宏与"画布外直接 return/discard"，把可见瑕疵修到"只在画布边缘 1~2px"，
再逐库精修。每个库单独提交。

### D6 SR mod 兼容

- 阶段 5 才做。`superresolution.json` 按上游 schema 2 直接引入；`SR_*` 宏全部条件编译。
- SR 接管时手动 `RENDER_SCALE_1000X` 强制视作 1000（`#if SR_ENABLE` 覆盖），避免双重缩放。
- 26.3 实例没有 `super_resolution` mod ⇒ SR 路径只在 1.21.11 实例验收；26.3 只验手动路径。

### D7 mod 冲突

- `renderscale` 与 `super_resolution` 互相 `breaks`。
- 手动路径测试：禁用 `renderscale`（否则它先改主渲染目标尺寸，`viewWidth` 已变，叠加后不可解释）。
- SR 路径测试：启用 `super_resolution`，禁用 `renderscale`。

---

## 6. 分阶段实施

### 阶段 0：基线（不改代码）
1. 分支 `feat/render-scale-port`（已完成）。
2. 记录 1000 档基线：同一视角/同一天气/同帧数区的截图 + fps + 当前选项文件。
3. 跑三套检查记录**当前**命中数（preproc/semantic/static），后续只看"新增"。
   > 注意：工作区被标记为 untrusted，仓库内脚本是否可直接执行由用户决定；如不允许，由用户手动跑。

**回滚点**：无代码改动。

### 阶段 1：选项与基础设施（默认零变化）
- `settings.glsl`：`RENDER_SCALE_1000X` + `UPSCALE_MODE` + 派生 `RENDER_SCALE/RENDER_SCALE_HALF`。
- `shaders.properties`：`screen.SuperResolution` 分组、`sliders`、自定义 uniform、程序开关
  （`composite6_b`、`composite8`）、`size.buffer`（half-res 清单）、`profile.Default` 不改（默认 1000）。
- `lang/zh_CN.lang` + `en_US.lang`：选项文案。
- 新增 `lib/utility/RenderScale.glsl`：`scaleTexelPos` / `scaleScreenUv` / `CANVAS_END` / `CANVAS_END_HALF`。
- `lib/utility/Load.glsl`：加 `uvToTexelScaled` / `texelToUvScaled`（先只定义，不用）。
- `lib/universal/Uniform.glsl`：加 `scaledViewSize/scaledHalfViewSize/scaledTexelSize/renderScale`。
- `lib/Utility.glsl`：包含 `RenderScale.glsl`；`SR_*` 守卫骨架（`#if SR_ENABLE` 分支先留空）。
- `config.glsl`：`colortex11Format = RGBA16F; colortex11Clear = false;` + Buffer Table 补一行。

**验收**：1000 档画面与阶段 0 截图一致；三套检查无新增；properties 纯 ASCII；GUI 出现新分组。

### 阶段 2：几何缩放（世界缩到左下角）
- `program/Simple.vert`：加 `renderScale` uv 缩放 + `NO_SCALE` 守卫。
- 三套 world 的 `composite7.vsh`、`composite31.vsh`、`final.vsh`、`composite32-34` 相关入口按需加 `NO_SCALE`。
- `program/gbuffers/*.vert`（Basic/Block/Entities/Hand/Overlay/Terrain/Textured/Water/
  ParticlesTranslucent/Spidereyes）+ `world*/gbuffers_skytextured.vsh` + `world*/gbuffers_weather.vsh`
  + `program/DH/Terrain.vert` + `program/DH/Water.vert`：加 gl_Position 缩放。
- gbuffers frag（Block/Terrain/Entities/Water）：`deltaUv *= renderScale`；画布外 discard。
- `world*/voxy.json`：加 `renderScale`；`program/voxy/Blit.comp` 的 `workGroupsRender` 乘 `RENDER_SCALE`。

**验收**：1000 不变；50% 时世界只画在左下 1/4，其余区域为清屏色；纹理无 mip 闪烁；手部/天气/星空位置正确。

### 阶段 3：缩放域 pass（按依赖顺序，逐个提交）

| 子阶段 | 文件 | 关键改动 |
|---|---|---|
| 3a | `program/DeferredLight.frag` | `screenCoord` 保持全屏坐标；诊断门限、`uv` clamp 用画布边界 |
| 3b | `program/IntegrateScene.frag`、`program/Translucent.comp` | 画布边界、`workGroupsRender *= RENDER_SCALE` |
| 3c | `program/post/SubsurfaceBlur.comp` + `config.glsl` | SSS 三张 buffer 尺寸 → `RENDER_SCALE_HALF`；`viewSize.y*0.5` → `scaledViewSize.y*0.5` |
| 3d | `program/post/DOF/Prepare.comp`、`Gather.comp`、`lib/post/DOF.glsl` | `viewSize` → `scaledViewSize`；`colortex15` 边界 |
| 3e | `program/diffuse/*`（13 个） | `canvasEnd` → `scaledViewSize/scaledHalfViewSize`；`workGroupsRender *= RENDER_SCALE`；`SpatialUpscale.glsl` 的 clamp |
| 3f | `program/clouds/Render.comp`、`Reconstruct.frag` | 云 TAAU 与全局缩放叠加：先 `CLOUD_TAAU_ENABLED` 关验证，再处理 `CLOUD_TAAU_SCALE` |
| 3g | `lib/surface/Reflection.glsl`、`SSRT.glsl`、`lib/lighting/*` | 画布边界；`colortex4` 象限写入口径 |
| 3h | `program/ReprojectScene.comp` | `currentUv = texelToUv(texelPos)*2` 在缩放下的象限映射；workGroups 乘 RENDER_SCALE |

**验收**：每个子阶段单独 A/B：1000 不变 + 50% 无错位/无黑块；GI 静止对齐；SSS 无边缘泄漏；云不重复。

### 阶段 4：升采样 + 全屏后处理
- 新增 `program/post/SR/Upscale.comp`（双线性/FSR1 两分支）。
- 新增 `ffx/fsr1/ffx_fsr1.glsl`（整目录新引入，不改现有 ffx）。
- 新增三套 `world*/composite6_b.csh`（include Upscale.comp），`workGroupsRender = vec2(1.0, 1.0)`。
- `shaders.properties`：`program.world*/composite6_b.enabled = RENDER_SCALE_1000X != 1000 && !SR_ENABLE`。
- `TemporalAA.frag`：`loadInput` 分支 + `taaJitter` 幅度。
- `composite7.vsh`（三套）加 `NO_SCALE`。
- 复核 `MotionBlur.comp`、`bloom/*`、`Grade.frag`、`Final.frag`、`LumHistogram.comp`、`AutoExposure.comp`：
  这些在升采样之后，全部保持全屏坐标，不改。

**验收**：50% 下画面铺满全屏；双线性 vs FSR1 可区分；TAA 无重影；bloom/DOF/CAS 位置正确；fps 提升。

### 阶段 5：SR mod 接口 —— **不做**（用户已排除路径 B）
上游的 `superresolution.json` + `SR_*` 宏由 `super_resolution` mod 注入（已核实 mod 的 `SRCompatV2Processor`），
与本地启用的 `renderscale` 互斥。本轮不引入该文件，也不加 `composite8` 占位 pass；
上述 3.5 节仅作研究存档。

### 阶段 6：收尾
- 三套检查无新增；双语 lang 同步；`STATUS.md` 更新"现在"；`docs/archive/` 不动。
- 提交拆分：基础设施 / 几何 / 各 pass 子阶段 / 升采样 / SR 接口。
- 更新 `CONTEXT.md` 的 buffer 表与链路（若新增 pass）。

---

## 7. 文件清单

### 新增（8 项）

| 文件 | 阶段 | 说明 |
|---|---|---|
| `shaders/lib/utility/RenderScale.glsl` | 1 | 缩放宏与画布边界 |
| `shaders/program/post/SR/Upscale.comp` | 4 | 升采样 pass |
| `shaders/ffx/fsr1/ffx_fsr1.glsl` | 4 | FSR1 EASU（AMD 原文件） |
| `shaders/world0/composite6_b.csh` | 4 | 主世界升采样入口 |
| `shaders/world1/composite6_b.csh` | 4 | 末地 |
| `shaders/world-1/composite6_b.csh` | 4 | 下界 |

### 修改（按阶段）

- **阶段 1**：`settings.glsl`、`shaders.properties`、`lang/zh_CN.lang`、`lang/en_US.lang`、
  `lib/Utility.glsl`、`lib/utility/Load.glsl`、`lib/universal/Uniform.glsl`、`config.glsl`。
- **阶段 2**：`program/Simple.vert`、11 个 `program/gbuffers/*.vert`、`world*/gbuffers_skytextured.vsh`、
  `world*/gbuffers_weather.vsh`、`program/DH/Terrain.vert`、`program/DH/Water.vert`、
  4 个 `program/gbuffers/*.frag`、`world*/voxy.json`、`program/voxy/Blit.comp`。
- **阶段 3**：`DeferredLight.frag`、`IntegrateScene.frag`、`Translucent.comp`、`SubsurfaceBlur.comp`、
  `DOF/Prepare.comp`、`DOF/Gather.comp`、`lib/post/DOF.glsl`、13 个 `program/diffuse/*`、
  `lib/SpatialUpscale.glsl`、`clouds/Render.comp`、`clouds/Reconstruct.frag`、
  `lib/surface/Reflection.glsl`、`lib/surface/SSRT.glsl`、`lib/lighting/*.glsl`（SSAO/GTAO/SSILVB/shadow Render）、
  `ReprojectScene.comp`、`config.glsl`（buffer 尺寸）。
- **阶段 4**：`TemporalAA.frag`、三套 `composite7.vsh`、`shaders.properties`、`lang/*`、`config.glsl`（colortex10）。

---

## 8. 风险登记

| # | 风险 | 后果 | 应对 |
|---|---|---|---|
| R1 | 画布外采样（边界未改） | 边缘黑边/漏光/反射采样到空白 | D5 表格逐库审计；先加 `CANVAS_END`，再精修 |
| R2 | GI half-res buffer 与画布不匹配 | 噪点、错位、历史污染 | `RENDER_SCALE_HALF` 尺寸表 + 逐 pass A/B；先 50% 单档验证 |
| R3 | `size.buffer` 的宏展开在 Iris 1.10.8 不支持 | 加载失败/尺寸错误 | 参照上游写法；properties 里用 `#if` 档位直接写数值（不依赖表达式） |
| R4 | TAA jitter 幅度错 | 50% 下锯齿/拖影 | 用 `scaledViewSize` 计算；静止/移动各截一组 |
| R5 | 云 TAAU 与全局缩放叠加 | 云错位/重复 | 先关 `CLOUD_TAAU_ENABLED` 验证，再开 |
| R6 | 26.3 Vulkan image 格式 | `no image registered` | `colortex10` 用 RGBA16F；改完先看日志 |
| R7 | mod 冲突 | 画面双重缩放/加载失败 | 测试前二选一；文档写进 STATUS |
| R8 | 1000 档未逐位一致 | 默认观感回退 | 所有改动 `#if` 守卫；阶段 1 结束先做像素对比 |
| R9 | 启动面板/全屏 UI 被缩小 | 启动 logo 只占左下角 | `composite32-34`、`final`、`composite31` 加 `NO_SCALE` |
| R10 | 手部/SSR 判定被误改 | 手部消失/玻璃变暗 | 27 条硬事实（STATUS §37-52）不动，只改坐标 |

---

## 9. 验收矩阵

| 维度 | 取值 |
|---|---|
| 分辨率 | 1000 / 750 / 667 / 500 |
| 升采样 | bilinear / FSR1 |
| TAA | 开 / 关 |
| DOF | 开 / 关 |
| Bloom | 开 / 关 |
| CAS | 开 / 关 |
| MotionBlur | 开 / 关 |
| GI_MODE | 0 / 1 / 2（重点 1/2 的 half-res 链） |
| 世界 | world0 / world-1 / world1 |
| 场景 | 静止、移动、水面/金属反射、手部、云、雨、水下 |

**通过判据**：
1. 1000 档与基线截图一致（允许噪声级差异）。
2. 各档画面构图正确：无黑边、无重复象限、无拉伸、无错位。
3. 50% + FSR1 的清晰度优于 50% + bilinear（人眼确认，标 `⏳` 待回填）。
4. 50% 档 fps 高于 100% 档（同场景、同设置）。
5. 三套检查无新增命中。

---

## 10. 已知坑与前置检查

1. **`shaders.properties` 只能纯 ASCII（含注释）** —— 一个中文即整文件截断，`image.*` 静默消失。
2. **改选项先 grep 真实名字** —— 键不在 `settings.glsl` 的选项表里 ⇒ Iris 静默丢弃。
3. **`viewSize`/`viewPixelSize` 不要全局替换** —— 全屏后处理（TAA/bloom/Grade/Final/MotionBlur）必须保留全屏；
   只有缩放域 pass 用画布边界。
4. **`colortex3` 不能当升采样目标** —— 本地是 GI 中间缓冲（`SpatialUpscale.glsl` 读它）。
5. **`ffx/` 现有文件不要动** —— 新增 `ffx/fsr1/` 子目录并保留 AMD 许可头。
6. **测试前确认 mod 状态** —— 1.21.11：`renderscale` 启用、`super_resolution` 禁用；两者不可同时启用。
7. **抓屏测量分辨率约 0.3 级** —— 小差异不要下结论；报"闪"必须带 fps。
8. **只靠肉眼判定的项标 `⏳`** —— 不允许自行勾 `✅`。
9. **26.3 是 Vulkan** —— 新 image 格式必须 RGBA16F；先查日志有无 `no image registered`。
10. **G-Buffers 画布外 discard** —— 不加会浪费 overdraw（本地已实测 overdraw 2.47×，缩放的意义会被抵消）。

---

## 11. 执行顺序与暂停点

```
阶段 0（基线）→ 阶段 1（选项/宏）→ 暂停：确认 1000 零变化
→ 阶段 2（几何）→ 暂停：确认 50% 左下角画布正确
→ 阶段 3a-3d（光照/SSS/DOF）→ 阶段 3e（GI，最高风险）
→ 阶段 3f-3h（云/反射/重投影）→ 暂停：50%/750 全功能 A/B
→ 阶段 4（升采样/TAA）→ 暂停：清晰度与 fps 验收
→ 阶段 6（收尾）
```

每个暂停点都要用户实机确认；未确认前不进入下一阶段。
