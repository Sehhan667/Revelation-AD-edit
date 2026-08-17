# 排查备忘录：天空贴图异常（2026-08-09）

## 问题现象

新版光影（VoxelGI 重构后）出现：

- 环境光亮度整体过低
- 缺少天空光染色，朝上的表面尤其暗
- 打开 `DEBUG_SKY_MAP` 时，左下角天空贴图只有白色方块，屏幕其余部分全黑

旧版文件夹 `旧版环境光正常` 无此问题。

## 根因

**`shaders.properties` 中存在非 ASCII 字符，导致 Iris 的配置预处理崩溃，第 278 行之后的所有配置全部丢失。**

Iris 使用 C 预处理器（jcpp）解析 `shaders.properties`。遇到 `³`、`¼`、`→`、`—` 这类特殊符号时会直接抛异常：

```text
[Render thread/ERROR] [Iris/]: Properties pre-processing failed
org.anarres.cpp.InternalException: Bad token [³@278,0]:"³"
```

配置解析中断后，丢失的关键项包括：

| 丢失的配置 | 位置 | 后果 |
|---|---|---|
| `size.buffer.colortex5 = 256 256` | 第 459 行 | 天空贴图缓冲变成全屏尺寸，GenSkyMap 只写入左下角 256×256，其余为未初始化数据 |
| `program.world0/...` 等全部程序开关 | 第 378–410 行 | GI 链路（deferred/VoxelGI）程序启停错乱 |

## 症状与根因的对应关系

- **白色方块 + 其余全黑**：`colortex5` 尺寸丢失后，`DEBUG_SKY_MAP` 按 `textureSize` 覆盖整屏；左下角 256×256 是真实天空（HDR 高亮→白），其余是未初始化数据（黑）。
- **环境光过低 / 朝上表面暗 / 缺天空染色**：球谐光（skySH）从损坏的天空贴图采样，天空 SH 全部失效。
- **场景整体更暗**：程序开关丢失导致 GI 流程错乱。

## 已做的修复

1. `shaders/shaders.properties`：所有非 ASCII 字符清理为纯 ASCII（中文注释改为英文，`—`→`--`、`→`→`->`）。
2. `旧版环境光正常/shaders/shaders.properties`：清除 `³`（`128³` → `128^3`）。
3. 保留排查期间的两处正确修复：
   - `GenSkyMap.comp` / `GenCloudShadow.comp`：棋盘条件 `(tid & 1) == offset`（bvec2 放进 if，非法 GLSL）改为 `all(equal(tid & 1, offset))`。
   - `VoxelGI.frag` / `VoxelTracing.glsl`：恢复被临时 `* 0.0` 禁用的阳光 GI 散射。

## 以后怎么避免

- **`shaders.properties` 只能写 ASCII**：不要放中文注释，更不要放 `³` `¼` `²` `→` `—` `×` `≥` 等特殊符号。
- `.glsl` 文件不受影响：`//` 注释在预处理时会被剥除，中文注释可以正常使用。
- 排查同类问题先看日志：搜索 `Properties pre-processing failed` 或 `Bad token`，几秒钟即可定位。

## 排查时间线（供复盘）

- 8/6：VoxelGI 重构（`db1034a gi改进`）在 shaders.properties 新增含 `—`、`→` 的中文注释 → 配置预处理开始崩溃。
- 8/8：误判为 SkyView LUT 派发问题，多次改 `workGroups`/`workGroupsRender`。
- 8/9：从游戏日志抓到 `Bad token [³@278,0]`，确认根因；清理非法字符后所有问题消失。

---

# 备忘：阳光 GI 实现关键点（2026-08-09）

## 阳光阴影判定（VoxelSunShadow.glsl）

`SimpleShadow` / `SimpleShadowTracing` 两个函数：

- `VoxelSunShadowMap(camRelPos, normal)`：实时阴影贴图判定。**命中点必须传连续命中点（`origin + dir * rayLength`），不能传整数体素格坐标**——整数格坐标对体素化数据的逐帧更新极敏感，相机移动时 sunVis 会在 0/1 间跳变 → 阳光散射时有时无（实测踩坑）。
- `VoxelSunShadowTracing(voxelPos, sunDir)`：从命中体素向太阳走 3 格做 DDA，捕捉阴影贴图外的网格内小遮挡（屋檐/树冠/墙角）。

用法：追踪端 `sunVis = ShadowMap × ShadowTracing`，注入端 `sunVis = ShadowMap`。

## 彩色玻璃阳光反弹（shadowcolor0 alpha 通道）

实现"阳光穿过彩色玻璃 → 反弹光线染色"：

1. `Shadow.frag`：`shadowcolor0Out` 从 `out vec3` 改 `out vec4`，**a 存纹理原始不透明度**（实心 1.0、玻璃 0~1）；rgb 保持原有混合逻辑，PCSS 彩色阴影观感不变。
2. `VoxelSunShadowMap` 返回 vec3 彩色阴影：
   - shadowtex1（实心深度）被挡 → 0
   - shadowtex0（透明深度）没挡 → 1
   - 穿过玻璃 → `VoxelAlbedoToAbsorption(sRGBToLinear(颜色), 不透明度)` 得吸收色
3. 阳光反弹/注入项乘 vec3 彩色阴影。

未做：水吸收分支（当前光影水数据走 shadowcolor1，shadowcolor0 无水）。

## 实现过程中的两个编译坑

- **include 顺序**：共享文件必须在它依赖的声明之后 include。VoxelSunShadow.glsl 依赖 `DistortShadowSpace`（shadow/Common.glsl）和 `shadowtex1` 声明——VoxelGI.frag 里曾放在它们之前 → `C1503 undefined variable`。
- **sampler2DShadow 的 textureLod**：`shadowtex1` 声明为 sampler2DShadow 时，`textureLod` 要传 **vec3（xy + 参考深度）**，返回就是硬件比较结果（0/1），不要再 step；普通 sampler2D（shadowtex0）才用 `textureLod(vec2).x` 手动 step → 传 vec2 给 sampler2DShadow 会报 `C1115 unable to find compatible overloaded function`。

## 经验

- 尽量沿用原有坐标/参数语义（连续命中点、参考深度），不要自作主张简化成整数格或省掉转换。
- 改 shadow 缓冲输出格式前，先确认目标缓冲有没有对应通道（vec3 → vec4 需要缓冲支持 alpha）。

---

# 备忘：SVGF 同步与分辨率缩放（2026-08-09）

- 官方 SVGF 使用 `scaledViewSize` / `scaledTexelSize` 等 uniform，这些值由 shaders.properties 里的 `RENDER_SCALE` 体系提供。
- 本包没有这套渲染缩放体系；uniform 未赋值时 Iris 默认 0，`texelToUvScaled` 会把 UV 全乘成 0 → 表现为“分辨率缩放出错、画面错位/花掉”。
- 处理：SVGF 四道 pass 全部改回本包的 `viewSize` / `texelToUv` 坐标体系，删除 scaled uniform 与宏，保证无残留。
- 新增自定义 uniform（如 `historyReset`）时，必须在 shaders.properties 里同步赋值，否则恒为默认值，功能形同虚设。

---

# 备忘：天光 GI 方向化（2026-08-09）

- 天空光不再用标量 skyColor 平涂，改为采样 skyMapTex（OctEncodeUnorm 方向→UV），
  天然带天顶/地平线/太阳暖色/云影的方向信息。
- skyMapTex 是物理尺度（白天顶光 ≈110-130），除以 VOXEL_SKY_REFERENCE（300）
  换算到 0-1 尺度；调大变暗、调小变亮。
- 三条接入点：IRC 命中面（法线方向采样）、IRC/追踪出界（光线方向采样 × 上半球权重）、
  新暴露体素播种（天顶辐射 × EDGE_SEED）。
- 天光可见度门控 lightmap 0.02-0.24：洞穴无天光、户外全开、树冠缝隙半遮挡。
- 体素网格内屏蔽原版 SH 平涂环境光，避免方向性天光被盖掉；网格外保持非光追样式。
- 若 GI pass 里 skyMapTex 采样为 0（未绑定/尚未生成），VoxelSkyColor 退回
  skyColor；若该 uniform 也为 0，再按太阳高度给天蓝色下限，保证正午必有可见天光。
  map 正常时仍以 map 方向辐射为准。
- IRC 出界路径的天光同样乘 VOXEL_GI_SKY_STRENGTH（曾漏乘，导致该滑条只影响命中面）。
- DEBUG_VOXEL_SKY 实测：暗处泛红 = 天光路径已通，只是实际值偏弱被环境光盖住；
  对策是放宽门控中段（0.01-0.18）并提高兜底倍率（0.5→0.8）。深洞穴（lightmap=0）仍拦截。
- 阴影仍黑：IRC 命中面的天光可见度改用
  max(lightmap 门控, 上一帧天空曝光度 alpha)——能看见天空的阴影体素不再被 lightmap 压低；
  滑条上限同步放宽（注入 8.0 / 追踪 16.0）方便拉亮阴影。
- 读回端硬补解析天光会制造“阳光/天光分界线”并盖掉自然 AO（用户实测反馈）。
  正确做法：天光与阳光走同一条追踪/IRC 链路自然混合；IRC 自反弹提到 1.0
  （表面命中全强度），让天光沿遮挡逐级衰减，阴影形成自然 AO 梯度。
- 追踪信号链路里加解析天光填充（进 YCoCg/SVGF 前）：按法线方向 × lightmap 门控
  × 上一帧 IRC 天空曝光度（AO）平滑补光——暗处有蓝色天光、遮挡处更暗、与阳光同链路无分界线。
- 用户反馈亮度仍偏暗：新增 `VOXEL_GI_SKY_FILL`（暗处填充额外倍率）与
  `VOXEL_GI_SUN_TINT_RATIO`（天光阳光染色，同普通环境光思路，正午暖阳色、夜晚关闭），
  都已注册进 GUI 滑条与双语 lang。
- 室内“死板固定亮度”根因：体素网格内残留的最小环境光底（0.15）把窗口逸散/AO 梯度盖掉。
  改为网格内环境光底置零（仅夜视底），室内亮度完全由 GI 传播决定——窗边亮、深处暗。
- itrp 的 AO 不是静态 SSAO：是“光致 AO”——填充色/强度跟随天空（昼夜/天气/云影），
  可见度（IRC 曝光 alpha）只决定几何遮挡强弱。因此移除 SSAO 乘法，避免固定灰黑压暗。
- 洞穴漏天光根因：曝光 alpha 原先“向上逃逸就计数”，洞穴里也会高 → IRC 命中面/填充
  误判为可见天空；且新进入网格的洞穴体素会被天顶种子点亮。修正：曝光与种子都乘
  lightmap 门控，洞穴（≈0）完全不计数、不播种。
- 网格外的大洞穴远处墙壁：环境光底同样乘 lightmap 门控（洞穴≈0 → 不吃平铺底光）。

---

# 备忘：天光重构为物理天空采样结构（2026-08-10，最新）

- 彻底移除解析填充/曝光 hack/平铺兜底；天光只由“追踪出界 + IRC 出界”传播。
- `VoxelSkyColor(dir, lightmap)` = AtmosphereSkyView/基准 × 地平线衰减
  （saturate(dir.y*25+0.5)）× 线性漏光门控（saturate(lightmap*4.44)）。
- IRC 命中面不再单独注入天光；自反弹 1.0 负责把天光传入阴影/室内，形成自然 AO。
- 移除 `VOXEL_GI_SKY_FILL` / `VOXEL_GI_SUN_TINT_RATIO` 及其 GUI/lang 条目。
- 疑点确认：skyMapTex 在 GI pass 可能采样恒 0（之前天光全靠平铺兜底撑）。已改为
  直接调用 AtmosphereSkyView（大气 LUT，与可见天空同源），不再依赖 skyMapTex 绑定。
- Iris 选项解析坑：VoxelSkyLight.glsl 里不能放条件 include（会把 DEBUG_VOXEL_SKY 等
  选项搞成 “Unable to resolve”）；大气 include 移到 VoxelGI.frag/DiffuseIndirect 调用方。
  VoxelSkyColor 保留 skyColor×fade×gate 的方向性兜底，LUT 未绑定时也不会全黑。
- DEBUG_VOXEL_SKY 锚点改纯净格式（`//#define DEBUG_VOXEL_SKY`，说明注释另起一行），
  带斜杠的中文注释疑似干扰 Iris 布尔选项解析。
- 真正根因：重写 VoxelSkyLight.glsl 时把 `#ifdef DEBUG_VOXEL_SKY` 调试分支弄丢了，
  宏无任何使用点 → Iris 判定选项无效不显示。已补回 VoxelSkyColor 顶部的红色诊断分支。
- DEBUG_VOXEL_SKY 改为“门控放行才红”：洞穴 lightmap≈0 不显示红色，
  用于区分路径命中被拦截与真实吃到天光。
- 调试再升级：直接放大显示真实天光值（×8）——黑=值 0，亮=值正常。
- 洞穴普遍泛蓝：线性门控 lightmap×4.44 在低天空值太松。改为 smoothstep(0.10, 0.25)；
  新体素播种再加 step(0.15, skylight) 硬门槛，防写胜污染把洞穴整体点亮。
- 隐藏诊断开关 `DEBUG_VOXEL_SKY`（settings.glsl 取消注释）：天光路径命中时返回红色，
  用于区分“路径没跑通/门控放行”和“值太小看不到”。
- 新增宏要暴露到 GUI 必须三处同步：1) VoxelLighting.glsl 定义处带 `// [值列表]`；
  2) shaders.properties 的 `screen.voxel` 与 `sliders`；3) lang/zh_CN.lang + en_US.lang。
  properties 保持纯 ASCII（中文会崩预处理，skyMap 白块的根因）。

---

# 备忘：光追天光系统恢复（2026-08-17，最新）

## 背景
8/16 一次标注"临时"的改动把天光全部删了（追踪出界、IRC 出界、新暴露播种、
Phase1 曝光计数），`VoxelSkyColor` 变死函数、4 个天光滑条零使用点，RT 模式天光≈0
（只剩 NOLIGHT 常数 ~5e-4），室内/阴影黑、只有阳光直射处亮。8/17 恢复并接通。

## 已实施（提交 c722f4d → 1127259 → 本轮）
- 追踪（单级联+级联）出界注入 `VoxelSkyColor(dir, skyLightmap) × VOXEL_GI_TRACE_SKY_STRENGTH`
- IRC 出界注入 `VoxelSkyColor(dir, hitSkylight) × VOXEL_GI_SKY_STRENGTH` + Phase1 曝光计数恢复
- 两处新暴露播种：`VoxelSkyColor(天顶, skylight) × VOXEL_IRC_EDGE_SEED × step(0.15, skylight)`
- `AtmosphereSkyView` 天顶/天底奇点修复（cross(up,rayDir) 退化时用稳定正交方向）
- 漏光门控作用到主 LUT 路径（原来只乘 skyColor 兜底 → 室内过亮/洞穴漏光），
  阈值放宽 smoothstep(0.10,0.25)→(0.03,0.30)
- 滑条接线：VOXEL_GI_SKY_STRENGTH 1.0 / VOXEL_GI_TRACE_SKY_STRENGTH 1.5 /
  VOXEL_SKY_REFERENCE 300 / VOXEL_IRC_EDGE_SEED 0.35；VOXEL_GI_STRENGTH（追踪+IRC 输出乘）；
  VOXEL_GI_TRACE_STRENGTH 补值列表并进 GUI（screen.voxel/sliders/lang 三处同步）
- DEBUG_VOXEL_SKY 改染红（门控放行且有值才红，洞穴黑）；DeferredLight 左上角灰阶读数 HUD
- 网格内最小环境光底 = skyColor×lightmap.y×0.04（洞穴≈0 保持黑）
- ~~朝下表面天光下限（借鉴 itrp SimpleSkyLighting）~~ **已回退（2026-08-17 同日）**：
  全量叠加让天花板（NdotU=-1 权重 1.0）异常发亮（用户实测）；itrp 的 SimpleSkyLighting
  只在 IRC 越界兜底、不叠加在追踪结果上。阳光反弹修复（去 rPI + SUN_STRENGTH 1.0 +
  TRACE_SUN 12）后朝下表面已有反弹光，无需填充。
- 天光阳光颜色混合（SH 环境光同款 AMBIENT_SUNLIGHT_TINT_RATIO 机制）：VoxelSkyColor
  内按 worldSunDir.y 染暖阳色，正午金黄/夜晚关闭；色度取 sunIrradiance 归一化（无 SSBO 依赖）。

## 关键坑（本次新增）
1. **`shaderpacks/Revelation-AD-edit.txt`（Iris 记住的选项文件）覆盖代码默认值**：
   死滑条时期拉满的值（TRACE_SKY 16 / SKY 8 / REFERENCE 100 / SELF_BOUNCE 0.4 /
   TRACE_DISTANCE 16 / SUN 32）在滑条接线后全部生效 → 画面过曝/死黑/硬分界线。
   改代码默认值无效，必须改这个 txt 或在 GUI 里重置滑条。
2. GLSL 三元条件必须是标量 bool：`sky > vec3(0.01)` 是 bvec3，会编译失败；
   用 `max(max(sky.r,sky.g),sky.b) > 0.01`。
3. 引用外部成熟方案（itrp）时：它的"朝下表面不黑"靠 SimpleSkyLighting 的
   `NdotU*0.35+0.65` 曲线 + 无条件小底光（NOLIGHT 7e-6）+ IRC 自反弹；环境光与
   直射光解耦相加（阴影只乘直射项）。全部是连续函数，无一处 step()/二值。
4. 天光滑条全接线后，GUI 值是"现场调参"的最快途径（边拖边看），
   不需要每轮改代码默认值。
5. **IRC 自反弹强度决定室内对比度**：SELF_BOUNCE 1.0 会让缓存稳态放大 ~2×
   （C = D/(1-albedo×SELF_BOUNCE)），天光灌满全屋、方向对比被抹平；itrp 的反弹权重
   是缓存值的 ~1%/帧（prevIrcColor×0.006~0.01），0.15 已足够（实测对比见 TODO §5）。
6. **阳光方向性来自缓存空间对比**：门口/窗边的阳光亮斑 vs 室内深处暗——由追踪射线
   实际打到的体素决定（FetchVoxelRadianceSmoothed 三线性不会糊掉亮斑）。

---

# 备忘：级联辐射度缓存回退（2026-08-17）

## 结论
三级联（ADR-0001，near 0.5m/mid 1m/far 2m，后改"近=1m"方案）因问题无法收敛，
整体回退到级联前单 64³ 1m 网格（95cc0a5 + d6f62bc）。级联前版本
（d695d1f，2026-08-16）为已知稳定基线，天光链路当时正常（8/16 的天光移除发生在
级联时代之后，回退时保留我的天光修复：VoxelSkyLight 门控修复/染红/阳光染色、
Common.glsl 天顶 NaN 修复、阳光注入/追踪 GI 强度滑条、网格内最小环境光底、灰阶 HUD）。

## 级联的失败模式（全部用户实测）
1. **亚米格形状块锯齿**：形状子盒按 1m 整块设计（blockOrigin=voxelCoord-ray.ori，
   1/16 格单位），cell<1m 时形状压缩 → 命中/穿透交替成 cell 周期锯齿（0.5m 实测）。
   世界锚定换算可修：ray.ori/blockOrigin 换算到世界对齐米（格单位 ×cell，
   块锚点=floor((格+0.5-R)×cell)），命中距离换算回格单位（ray.rdir 单位与 boxMin
   同乘 cell 抵消，不需换算）；cell=1m 时逐项退化为旧公式。
2. **全块逐格填充的边界对齐问题**：面恰在格边界时 AABB=floor..ceil 只含面外侧一层，
   墙体内侧质心格不在 AABB 内 → 永不写入 → 墙镂空 → 黑方格（0.5m/1/4 方块大小）。
   修复：AABB 沿法线主轴向固体侧（-nrm）扩一层并 clamp。
3. **节流注入 + 单缓冲缓存**：near 隔帧/far 每4帧注入 + 单缓冲，移动时缓存陈旧
   → GI 时有时无。缓解：每帧注入 + 按 sld 跳过空气格追踪控成本。
4. **重投影单位错配**：cDi = cameraPositionInt - previousCameraPositionInt 是整数米，
   直接加到格坐标只对 1m 格正确；mid/far 过量 2×/4× → 移动时读到错误/空气格。
   须按级联格换算：ivec3(round(vec3(cDi)/cell))（IrcTraceVoxel 自反弹、IrcInject、
   main 循环、VoxelTracing 级联自反弹共 4 处）。
5. **"停下稳定二态"闪烁**（移动时 GI 有/无交替、停下保持、不随视角变）：级联网格
   相机居中 + 跨级联续接（射线出 near 后用累积 worldRel 换 mid 网格）+ 缓存稳态，
   机制未完全单点定位，回退即消除——说明是级联架构性因素叠加，不是单个 bug。

## 回退后的稳定基线
- 单 64³ 1m 网格（±32m）、VoxelTracePixel 查询、单网格 IRC 每帧乒乓注入、
  单级联体素化（Shadow.geom + Shadow.frag + VoxelClear）。
- 注意：VOXEL_DISTANCE 滑条已随级联移除（网格固定 ±32m）；配置文件里级联时代的
  旧滑条值（VOXEL_DISTANCE=32 等）会被忽略；天光/阳光滑条的旧值仍会覆盖默认值。
