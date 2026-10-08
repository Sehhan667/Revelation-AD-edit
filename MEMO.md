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

- **`shaders.properties` / `block.properties` 只能写 ASCII**：不要放中文注释，更不要放 `³` `¼` `²` `→` `—` `×` `≥` 等特殊符号。
- **`block.properties` 同理**：里面有 `#ifdef IRIS_TAG_SUPPORT` 等指令，同样走 Iris 的 C 预处理器（jcpp）。非 ASCII 字符会让解析中断，**该行之后的所有方块映射条目全部丢失**（不是只丢一行）。2026-08-19 实测：铁栏杆段的中文注释导致其后的楼梯/半砖/栅栏/墙/水平活板门等全部 fallback 到 `materialID=1` → 体素化丢失 → 光追漏光；门/竖直活板门因为排在中文注释之前所以没事。
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
- 这里的 AO 不是静态 SSAO：是“光致 AO”——填充色/强度跟随天空（昼夜/天气/云影），
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
- ~~朝下表面天光下限（借鉴 SimpleSkyLighting）~~ **已回退（2026-08-17 同日）**：
  全量叠加让天花板（NdotU=-1 权重 1.0）异常发亮（用户实测）；SimpleSkyLighting
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
3. 外部成熟方案的“朝下表面不黑”靠 SimpleSkyLighting 的
   `NdotU*0.35+0.65` 曲线 + 无条件小底光（NOLIGHT 7e-6）+ IRC 自反弹；环境光与
   直射光解耦相加（阴影只乘直射项）。全部是连续函数，无一处 step()/二值。
4. 天光滑条全接线后，GUI 值是"现场调参"的最快途径（边拖边看），
   不需要每轮改代码默认值。
5. **IRC 自反弹强度决定室内对比度**：SELF_BOUNCE 1.0 会让缓存稳态放大 ~2×
   （C = D/(1-albedo×SELF_BOUNCE)），天光灌满全屋、方向对比被抹平；反弹权重
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

---

# 备忘：阴影死黑根因修复——追踪端射程用尽未走出界路径（2026-08-18，用户验证成功）

## 结论（一句话）
追踪端 `VoxelTracePixel` 的 DDA 循环**步数走满但未命中/未越界时，exitGrid 保持 false，
出界天光路径被跳过** → 网格中央开阔阴影（正上方就是天空）只剩 NOLIGHT 微光 → 死黑；
只有网格边缘（射线几步内真越界）才吃到天光 → 用户 DEBUG_VOXEL_SKY 实测
"体素范围边缘才发红"。修复（9a6c710）：命中路径提前 return，循环结束后必然未命中
→ **无条件走出界路径**，与 IRC 注入端 `if (!hitSolid)` 语义统一。用户验证"终于亮堂了"。

## 为什么 `rayLength > VOXEL_TRACE_DISTANCE` 判定不触发
- DDA 中 `rayLength = min(totalStep)` 是**到下一格面的累计距离**（totalStep 每步累加
  `tracingNext * rdir`），不是"已走的步数"。
- 纯向上射线每步恰好 1 格：起点在格内（如 y=32.3）第一格面距离 0.7，迭代 i 的
  rayLength = (i-1)+0.7；第 24 次迭代 = 23.7 < 24 → `>` 为 false。
- 起点恰在格心（y=32.0）时第 24 步才 = 24.0，`24 > 24` 仍是 false。
- 斜方向射线每步主轴距离 <1，24 步累计更到不了 24。
- 网格半径 32 > 射程 24：中央区域射线 24 步内**永远走不到网格顶**，越界分支也不触发。
- 三重判定（距离/越界/命中）全不触发 → 循环自然结束 → exitGrid=false → 黑。

## 为什么 IRC 注入端一直正常、追踪端却黑（排查关键）
- IRC 端（VoxelGI.frag `IrcTraceVoxel`）用 `if (!hitSolid)` 判定出界——**无条件**，
  不依赖 exitGrid 标志 → 曝光度 alpha（DEBUG_VOXEL_SKY_LEVEL 实测阴影处=1 红）正常。
- 追踪端（VoxelTracePixel，真正上屏的信号源，经 DiffuseIndirect → SVGF → DeferredLight）
  用 exitGrid 标志 → 被此 bug 卡死。两个"出界"判定不一致是症状割裂的根源。
- 教训：同语义的出界判定在追踪端与 IRC 端必须一致，排查先对比两端的出界条件。

## 修复代码形态（VoxelTracing.glsl）
```glsl
// 命中路径提前 return，走到这里必然未命中 → 无条件视为出界
{
    contrib += VoxelSkyColor(dir, skyLightmap) * VOXEL_GI_TRACE_SKY_STRENGTH * absorption;
}
contrib += vec3(0.97, 0.99, 1.18) * VOXEL_NOLIGHT_BRIGHTNESS * saturate(rayLength * 0.2) * absorption;
return contrib * weight;
```
- 删除了 `bool exitGrid` 声明与两处赋值（射程/越界处只 break，不再置标志）。
- 防漏光仍由 `VoxelSkyColor` 内部承担：leak gate `smoothstep(0.03, 0.30, lightmap)`
  + 地平线衰减 `saturate(dir.y*25+0.5)` → 洞穴/室内 lightmap≈0 天光≈0，不会漏。
- 语义说明：射程用尽 = 视线一路畅通 = 通向天空，本就是光追的合理近似
  

## 本会话其他已提交项（供复盘）
- `167ccac` IRC 缓存三线性读取
  8-tap 三线性采样，消除 1m 体素块状/表面冲突；越界时
  `SimpleSkyLighting` 按命中法线兜底（消费端）。
- `e2edd39` IRC 注入端每帧施加 `SimpleSkyLighting` 解析下限，且**必须在时间混合之后**
  施加（0.99 混合下每帧只接受 1% 新值，混合前施加冷启动永远爬不起来）。
- `bbb7c28` 追踪出界天光门控改用 `max(lightmap.y, FetchVoxelRadiance(voxelC).a)`：
  曝光度 = 射线追踪的真实天空可见度（DEBUG_VOXEL_SKY_LEVEL 实测阴影处 exposure=1 但
  lightmap 门控压光 → 画面黑）；max 兼容：开阔阴影 exposure=1 → 天光全量，
  洞穴 exposure≈0 且 lightmap≈0 → 仍门控。IRC 端同样改
  `VoxelSkyColor(dir, max(hitSkylight, FetchPrevExposure(c)))`。
- 工作区残留（已在 bbb7c28 一并提交，**待还原**）：`SimpleSkyLighting` 里的
  `* 50.0` 临时调试放大（验证阴影是否随下限变亮用），确认效果后改回
  `lightmap * 0.22` 原式。

## 当前滑条/配置状态（Revelation-AD-edit.txt，已归一化）
- VOXEL_GI_SKY_STRENGTH=1.0、VOXEL_SKY_REFERENCE=300、GAMMA_CORRECTION=2.2、
  MINIMUM_AMBIENT_BRIGHTNESS=0.03、VOXEL_GI_BOOST=4.0、AMBIENT_SUNLIGHT_TINT_RATIO=1.5、
  VOXEL_GI_SUN_STRENGTH=1.0、VOXEL_TRACE_DISTANCE=24、VOXEL_TRACE_SUN_STRENGTH=0.0
  （阳光反弹被关，用户可恢复 0.5~1.0 让阴影带暖色阳光弹射）。
- 代码默认：VOXEL_GI_TRACE_SKY_STRENGTH 8.0（配置文件未覆盖，生效 8.0）、
  VOXEL_GI_SELF_BOUNCE 0.5、VOXEL_GI_TRACE_STRENGTH 1.0。

## 下一步待办（用户未定）
1. 还原 SimpleSkyLighting ×50 临时值。  → **已处理**：×50 改为 ×8 + lightmap² 曲线
   （白天视觉等价饱和到 1.0，暗处有梯度），勿再"还原 ×50"。
2. 分支 fix/sky-indoor-outdoor 合并回主分支 codex/cascaded-radiance-cache（用户要求）。
   → **已处理**：用户改合并到 dev（最主要分支），快进合并 5bc112b 已推送 origin/dev。
3. 天光平衡收尾：室内是否漏光/过量（可调 VOXEL_GI_TRACE_SKY_STRENGTH）、
   VOXEL_TRACE_SUN_STRENGTH 是否恢复。

---

# 备忘：天光颜色与网格边缘收尾（2026-08-18 傍晚，用户确认"舒服了"）

## 1. SimpleSkyLighting 下限曲线化（修复暗处过亮 + 过渡生硬）
- 原 `step(0.15) 硬门槛 + 线性 ×50`：lightmap=0.5 → 0.5×0.22×50=5.5 保色压缩到 1.0，
  与白天(11→1)同样饱和 → 暗处和明处一样亮、0.15 处硬跳变（用户实测）。
- 改 `smoothstep(0.15,0.40) 软门槛 + lightmap² 曲线 ×8`：白天(≈1)仍饱和到 1.0
  （视觉同 ×50），暗处有梯度（0.6→0.63 / 0.4→0.28 / 0.2→0.07），洞穴(<0.15)仍归零。

## 2. GI 天光色度 = 非光追同源（修复网格内外色差/傍晚发绿）
- 非光追环境光链路：GenSkyMap(skyMapTex=AtmosphereSkyView+云+雾) → GenSkySH(3 阶球谐
  skySH) → DeferredLight = 灰白底 + ConvolvedReconstructSH3(skySH, worldNormal)×lm3 + 暖假反弹。
- **关键差异是采样方向**：非光追用 worldNormal（地面=天顶），GI 用射线方向 dir——
  傍晚太阳低，dir 半球平均被 SH 展平成微蓝白"没颜色"（用户实测网格内偏蓝/暗淡）。
- 修复：GI 色度固定 `ConvolvedReconstructSH3(skySH, vec3(0,1,0))`（天顶，与非光追
  地面像素同色），方向性由 LUT 亮度 fade 承担；色度全域一致。
- 傍晚亮度底：`skyColor * 0.05 * saturate(1 - worldSunDir.y*2.5)`（0.25→0.12→0.08→0.05
  逐步调暗，用户多次反馈傍晚偏亮）。只提亮度不染色（色度仍 SH 天顶）。
- 白天天光暖色：`bounceBlend = saturate(worldSunDir.y*2) * 0.30` 混入
  global.directIlluminance 色度（真实暖阳色，正午暖白/傍晚橙；勿用 settings.glsl 的
  sunIrradiance 纯白 vec3(1,0.949,0.937)——它中和不了蓝）。

## 3. 网格边缘环境光过渡带（VOXEL_EDGE_BLEND_DISTANCE）
- 问题：新方块进入 64³ 范围时，网格外 SH 环境光(亮) 瞬间切到 网格内"灰白底+GI"
  且 GI 新暴露种子(暗) → 边缘暗→亮跳变（用户实测）。
- 修复：DeferredLight 计算像素到网格表面距离，网格内边缘
  VOXEL_EDGE_BLEND_DISTANCE(默认 6) 格内按距离渐进混入网格外同款 SH+假反弹
  （权重 1→0 渐隐），外部光→内部 GI 平滑过渡。滑条已注册 screen.voxel。

## 4. 回归教训（重要）
- **关闭光追后整个世界没环境光**（用户实测）：边缘过渡把 SH 环境光乘 voxelEdgeBlend，
  声明默认值误给 0.0 → 关 VOXEL_GI_ENABLED 走 #else 时 SH 全乘 0。默认值必须 1.0，
  开启光追时由分支覆盖。教训：**新加的环境光权重变量，默认值要考虑"功能关闭"路径**。

## 5. 分支与状态
- fix/sky-indoor-outdoor 快进合并到 dev（5bc112b，已推送 origin/dev）；
  codex/cascaded-radiance-cache / backup-pre-filter / upstream 未动。
- 配置文件（Revelation-AD-edit.txt）当前：VOXEL_GI_ENABLED=false、SSILVB_ENABLED
  未写（默认注释关）——两者都关时走纯 SH 环境光，靠 voxelEdgeBlend=1.0 正常渲染。

---

# 备忘：封闭空间漏光收尾（2026-08-18 深夜，用户确认"ok了"）

## 现象
完全封闭的无光小房间/洞穴仍然亮；关键线索：**白天亮、午夜暗**（漏光依赖天光），
且**小房间也亮**（射线会撞墙，排除出界漏光）→ 是 IRC 不依赖射线的路径照亮的。

## 三个漏光源与修复（9f59e86 / 4de76a3 / 8256925）
1. **网格内最小环境光底无 lightmap 门控**（DeferredLight）：ambientAccum =
   (法线权重) × activeMinAmbient（0.03，补偿后最高 0.43）无条件施加——封闭空间
   也吃满。网格外早有 smoothstep(0.10,0.25,lightmap.y) 门控，网格内是 8/18 改
   MINIMUM_AMBIENT_BRIGHTNESS 时丢的。修复：网格内同样乘
   smoothstep(0.03,0.15,lightmap.y)，夜视底不受影响。
2. **IRC 出界路径漏天光**（大空间射程用尽也算出界）：!hitSolid 含"射程用尽"
   （16 步没撞墙）→ 封闭大洞穴/房间射程用尽 → 天光漏入；门控 max(hitSkylight,
   exposure) 在封闭空间都不为 0（写胜残留 + 射程用尽也计数）。修复：出界天光乘
   step(0.15, hitSkylight) 硬门槛，曝光度计数同样乘（封闭不计数）。
3. **SimpleSkyLighting 下限 + 新暴露播种用体素 skylight**（真正的小房间元凶）：
   - 时间混合后下限 nRC=max(nRC, SimpleSkyLighting(..., vd.w))——体素 skylight
     是 shadow pass 写胜残留（室内 0.2~0.5），SimpleSkyLighting ×8 曲线放大成
     可见下限 → 每帧强制 IRC 发光。改用 FetchPrevExposure(c)（曝光度=射线真实
     天空可见度，封闭≈0 → 下限归零；开阔阴影出界 → 正常）。
   - 新暴露播种 edgeSeedGate = step(0.15, edgeSky) → 阈值 0.15 误放行残留
     （0.2~0.5）→ 新暴露格被播种天光。阈值 0.15→0.7：户外 skylight≈1.0 放行，
     封闭残留(≤0.5)全挡。代价：户外半遮挡（树荫 0.5）也不播种，可接受
     （它们有正常 IRC 链路）。

## 经验
- **"封闭空间亮 + 午夜暗" = 漏光依赖天光**，不是恒定保底——先查所有出界天光
  路径，再查下限/播种。
- **"小房间也亮" = 排除出界漏光**（射线会撞墙），查 IRC 不依赖射线的路径
  （下限/播种/环境光底）。
- **体素 skylight(vd.w) 是写胜残留，不是可靠天空可见度**——封闭/室内残留
  0.2~0.5，用它当 lightmap 门控必漏。可靠判据：像素 MC lightmap（追踪端）或
  曝光度 exposure（IRC 端，射线真实出界比例）。

---

# 备忘：不完整方块漏光根因 + 非完整光源整格发光（2026-08-19）

## 一、漏光根因：block.properties 非 ASCII（主根因）

现象：光追模式下半砖/楼梯/栅栏/墙/水平活板门等不完整方块漏光（光线穿透），
只门/竖直活板门正常；直射 + 反弹都漏。

排查：用 DEBUG_VOXEL_GI（按体素 voxelID 标色）定位到**写端**：
- 门/竖直活板门 → 青（正确映射 155-158）
- 楼梯 → 黄（materialID=1，被当整块）
- 半砖/栅栏/墙 → 蓝（空，根本没进体素）

根因：block.properties 里新增的"铁栏杆"段用了**中文注释**（新增/铁栏杆/→/（）等非 ASCII）。
block.properties 里有 `#ifdef IRIS_TAG_SUPPORT`，同样走 Iris 的 C 预处理器（jcpp），
非 ASCII 让解析中断 → **其后所有方块映射条目全部丢失**（楼梯/半砖/栅栏/墙/水平活板门 → materialID=1），
而门（block.10155-10158）排在中文之前所以没事。这和第 1 节 shaders.properties 非 ASCII 是同一个坑。

修复：6 行中文注释改 ASCII 英文；改后 block.properties 全 ASCII（已验证非 ASCII 字节数=0）。

## 二、DEBUG_VOXEL_GI 原本是坏的（排查工具本身有 bug）

原 `#ifdef DEBUG_VOXEL_GI` 块有结构 bug（悬空 `} else if` + `lightData` 越界引用），
启用即编译失败，所以一直没人真正打开过。已重写为：按像素所在体素直读 voxelID，
青绿=活板门/门(155-158/201/205)、橙棕=其它形状块(155-294)、黄=全块(1-154)、蓝=空(<=0.5)、红=越界；
并加 `-geoNormal*0.05` 内偏移，修"读格边界 → 黄蓝疯狂闪烁"（ivec3 截断在面边界逐帧跳格）。
settings.glsl 保留为注释掉的备用开关 `//#define DEBUG_VOXEL_GI`。

## 三、非完整光源"整格发光"（追尾问题）

现象：火把/灯笼这类非完整光源，其所在体素被整格照亮、像完整光源；外围传播正常。

根因：不是 materialID 误判（火把正确识别为 21/发射体素）。而是发射光**体素级**：
Shadow.geom 对 20-31 光源写死 `emissive=0.995` 满亮度，整格标记发射，非完整形状在此丢失
（发射光同样是体素级小球，不保留形状）。关键是两个参数，之前都偏大/带底：
| | 半径 | 底保 |
|---|---|---|
| 参考方案 | 0.5（格内切球） | 无（擦边/未命中=0） |
| 本项目改前 | 1.0 | mix(hit,1.0,0.15) → 每条穿过格的射线至少 15% 光 |
| 本项目改后 | 0.5 | 0（纯球命中） |

修复：
- `VOXEL_GI_LIGHT_RADIUS` 1.0 → 0.5（VoxelLighting.glsl）
- `VoxelHitLightSphere` 去掉 `mix(hit,1.0,0.15)` 底保，改纯 `VoxelSphereHit`（VoxelData.glsl）

要点：**"整格发光"不是 radius 单方面**，先看有没有 min/mix 底保再谈半径；0.15 底保才是主因，
radius 单独减不够。

## 经验

- **block.properties 和 shaders.properties 一样只能写 ASCII**（jcpp）；排查"某段之后的方块全失效"
  先 grep 非 ASCII 字节（`[^\x00-\x7F]`），几秒定位，别逐条对映射。
- **debug 块写完先确认能编译**：悬空 else-if / 越界变量这类结构错误，会让 `#ifdef` 里的
  调试代码一启用就崩，形同虚设反而误导。
- **读体素做可视化时，别用面边界坐标 ivec3 截断**：沿表面法线向内偏移 ~0.05 格，落在方块内部，
  否则会在"自身格/邻接格"间逐帧跳色。
- **未完成/已知方向**：逐像素 PBR 发光（LABPBR_EMISSIVENESS 思路）本轮未做。
  要做需恢复 Shadow.frag 存 texRes+midCoord（当前固体块 w/xy 被染色 albedo 占用），
  采样 atlasSpecular2D 的 emissive 通道；代价是 64³ 下"光源印子"风险（当初砍掉逐纹素的原因）。

---

# 备忘：NRD 降噪增强 + 离线渲染 + IRC 天光脱原版复盘（2026-08-19 起一轮，跨多轮）

## 1. IRC 门控改连续曝光映射
- 对比参考实现发现：IRC 出界/播种/下限原来用 `step(x)` 硬门槛 + lightmap 门控，界定处硬跳变。
- VoxelGI.frag 三处统一改喂 `saturate(曝光 * 2 - 1)` 连续映射；`SimpleSkyLighting` 门控线性为 `max(水中, lightmap*0.22)`（去平方/阈值/*8）。

## 2. NRD 风格降噪增强（SVGF 链 EAWF/Accumulate）
三个新开关，均含 GUI slider + 双语 lang：
- `NRD_RADIUS`（滤波世界半径，米）：hit-distance 自适应空间步长——近处放大、远处收窄；
  值随 `pxPerWorldAtZ1 = halfViewSize.y * proj[1][1]`（分辨率相关）。默认 0.25；>0.5 会因
  9-tap a-trous 步长过疏 → 点状闪烁。**抖动必须与步长解耦**（否则每帧采样起点大跳 → 闪）。
- `NRD_RELIABILITY`（可靠性收敛速率）：历史因子 `1 - exp2(-N*rate)`，替代原 `saturate(N*0.1-0.125)`。
  帧数少（新暴露/刚重投影）→ 放宽滤波快速收敛。
- `NRD_DISOCCLUSION`（去遮挡修复）：colortex14 由 RGB16F 升 RGBA16F，alpha 存"不可靠"位
  （Accumulate 布位：重投影失效/越界=1），EAWF 消费→不可靠像素放大空间步长 + 放松边缘保持，几帧收敛。
  **DeepSeek 排查要点：改缓冲格式要同步 config.glsl 的 Format 声明 + 文档注释表。**

## 3. 离线渲染（OFFLINE_RENDER）
- 只做"提采样 + 持续累积 + 屏蔽空间滤波"，不改 SPP 之外的实时链路，关闭即与之前无差异。
- 开启：EAWF 透传（不空间滤波）；Accumulate 累积上限提到 1024；每像素追踪同帧多 SPP
  `VOXEL_TRACE_OFFLINE_SPP=20`、IRC SPP=8。参考实现是 `RENDERING_MODE_SPP`（同帧多射线），
  **不是单纯"Mai 空间滤波靠时域磨"**——提采样才是干净的关键。
- GUI（Debug → Voxel）可勾选；settings.glsl 用 `#define OFFLINE_RENDER` 默认关。

## 4. 夜晚天光/月光（多轮反复后结论）
- **thesis：问题根因不在 IRC 注入，而在 DeferredLight 的非光追环境光 + 弥漫高光**。
  反复调 SimpleSkyLighting 月光色/亮度都无效，因 IRC 那层本就低。
- 月光反弹 `VOXEL_MOON_STRENGTH`：`directIlluminance` 里 moon 项受 `moonlightMult(~0.001)` 压到近 0
  → 体素 GI 夜晚无间接月光。独立补 `albedo * 月光色 * dot(moonDir,hitNormal) * sunVis`（VoxelTracing +
  VoxelGI 两处对称），复用 sunVis（夜晚 shadow 贴图即月光投影）。
- 光追模式下体素范围内屏蔽 DeferredLight 的原版环境光 `activeMinAmbient`（lightmap 门控），只留夜视底，
  环境光交给光追 GI；网格外/关光追时保持原版环境光（非光追路径不动）。

## 5. 阳光高光/SSS 外泄到"无阳光处"的修复
- 现象：SSS 和方块表面阳光高光有时出现在没有阳光的地方（夜晚/洞穴口/背阴）。
- 根因：`sunlightFactor` 用 lightmap.y 门控，而无阳光处 skylight 常 >0 → 误放行；且 SSS 分支原来
  不乘完整 shadow。
- 修复：用 `VoxelPixelSunVisible(worldPos - cameraPosition)`（shadow map 深度比较 + 太阳在地平线下判定）
  只乘到**高光 specularDirect 和 SSS**（`*= sunVis`）。
- **血泪坑：不要把 sunVis 乘进整个 diffuse shadow**——`VoxelPixelSunVisible` 是硬 0/1（越界默认 true），
  乘进 shadow 会让**某视角下整个场景主阴影凭空消失**（用户实测）。diffuse 软阴影靠 PCSS+contactShadow，
  可靠，别动它。

## 6. IRC 天光是否靠原版光照 — 中途反复后的最终状态
- 过程：先"脱原版光照"删了 `SimpleSkyLighting`/`VoxelSkyLeakGate`/阳光 lightmap 门控；
  后又按用户要求恢复门控。
- 结论（教训）：**lightmap 门控本身不是夜晚/阴影问题的根因**（根因在 DeferredLight 非光追环境光 +
  高光外泄），不要因误判而删掉它。光追出界/阳光反弹用 lightmap（体素 sky）做半遮挡/遮挡门控是合理且必要的。
- IRC 天光链路（最终）：出界射线 → VoxelSkyColor（内部 lightmap gate+fade）→ 写入 64³ 缓存 →
  时域累积(0.99) + 自反弹传播 → 每像素追踪命中时 Fetch…Trilinear 读回。洞穴不漏光由
  "射程用尽 vs 真出界"区分 + lightmap 门控保证。

## 教训速记
- **改缓冲格式**：同步 config.glsl Format 声明 + 文档表 + 所有 texelFetch(.rgb) 读端（升 RGBA 后要补 .a 读取）。
- **硬 0/1 门控谨慎**：`VoxelPixelSunVisible` 这类只有 0/1 + 越界默认的逻辑，别用来盖主阴影/环境光，
  只适合做"专项防护"（高光/SSS）。
- **"Mai 空间滤波靠时域磨"不是离线渲染**：先提采样（多 SPP）再谈累积。
- **排查"某处太亮/太暗"先定位是光追还是非光追路径**：DeferredLight 非光追环境光（SH 假反弹/最小底）
  与 IRC 是两套层，反复调光追层无果时，查非光追层是否仍在网格内灌原版光。

---

# 备忘：体素 GI 阳光漫反射「背对太阳即消失」修复（2026-08-20）

## 现象
光追（体素）GI 的阳光漫反射，在相机朝向背对太阳时**整个世界的阳光反弹完全消失**，
连直接朝太阳的亮面也一起变黑（用户实测「亮面也黑」）；转回朝太阳又恢复。

## 根因
`VoxelSunShadowMap`（VoxelSunShadow.glsl）开头有一道硬门控：

```glsl
if (sunPosition.y < 0.01) return vec3(0.0);
```

`sunPosition` 是 **eye space（视图空间）**（Uniform.glsl:79 注释），背对太阳时它的 `.y`
掉到 0 以下 → 这道门把 `sunVis` 全判 0 → 追踪端/注入端的阳光反弹整体归零（亮面也黑）。

正确的世界空间太阳方向是 `worldSunDir.y`（shaders.properties 已带 sunlightSign，白天 >0、
夜晚 <0），只随昼夜变化、不随视角。 


## 修复
- VoxelSunShadow.glsl `VoxelSunShadowMap`：`sunPosition.y < 0.01` → `worldSunDir.y < 0.0`。
  该函数是两条链路（每像素追踪 VoxelTracing.glsl + IRC 注入 VoxelGI.frag）都经过的活函数，
  一处修改同时生效。

## 附：清理死代码
排查中发现两个旧版「体素是否被太阳直射」判定函数从未被调用（已被共用函数
`VoxelSunShadowMap` 取代），一并删除以免后人踩同一坑：
- `VoxelTraceSunVisible`（VoxelTracing.glsl）
- `VoxelGI_SunVisible`（VoxelGI.frag）
- 顺带把追踪端注释里残留的 `VoxelGI_SunVisible` 引用改为 `VoxelSunShadowMap`。

旧函数是 0/1 单点 shadowtex1 硬比较；返回 vec3 彩色阴影（玻璃染色）+ 命中面法线偏移防自阴影，
是后来 `VoxelSunShadowMap` 才具备的能力，所以旧函数被弃用后成了死代码。

## 经验
- **「背对太阳整个世界的阳光 GI 消失、且亮面也黑」= 全局因子被视角相关量关死**，
  先查所有 `sunPosition.y` / eye-space 变量做的门控。`sunPosition` 是视图空间，不能拿来做
  昼夜判断——昼夜用 `worldSunDir.y`（太阳方向）或 `worldLightDir.y`（光源方向）。
- 排查同类问题时，可开 `DEBUG_SUNBOUNCE_VIS`（VoxelTracing.glsl，R=sunVis / G=朝向太阳 /
  B=lightmap 门控）三通道定位是否 shadow 采样失效。

---

# 备忘：末地下界维度宏 + 批量写入编码损坏（2026-08-20）

## 一、维度目录与宏约定

- 三个维度目录后缀 = 维度 ID：`world0`=主世界、`world-1`=下界、`world1`=末地。
- 维度宏在**入口 shader 文件**第二行 `#define`，紧跟 `#version 460 compatibility`：
  - 下界：`world-1/*.fsh/.vsh/.csh/.gsh` 全部写 `#define DIMENSION_NETHER`
  - 末地：`world1/*.fsh/.vsh/.csh/.gsh` 全部写 `#define DIMENSION_THE_END`
  - 主世界：`world0/` **不写任何维度宏**（无宏即主世界默认）。
- 需要标识的文件 = 独立的编译单元（入口 shader），扩展名 `*.fsh/*.vsh/*.csh/*.gsh/*.fsh1/*.vsh1/*.csh1`，
  共 **103 个**/目录。注意 `voxy.json`（数据）、`voxy_opaque.glsl`/`voxy_translucent.glsl`
  （被 include 的库，非独立编译单元）**不算入口，不要加宏**。
- `DIMENSION_*` 宏被 DeferredLight.frag（网格内环境光保底、SSS 补偿、天光等）和
  settings.glsl（大气/blocklightColor）等大量 `#ifdef` 引用，正确接线后末地/下界
  才真正走专属分支，否则会被当主世界处理。

## 二、坑 1：PowerShell `Set-Content`/`Get-Content` 用 ANSI 写坏 UTF-8 中文（主坑）

现象：加宏后 Iris 报 `unexpected error: failed to read /world1/deferred.vsh`。

根因：PowerShell 5.1 的 `Get-Content`/`Set-Content` 默认编码是 **ANSI**，读取时把原本
UTF-8 的文件按 ANSI 解码，写回又按 ANSI 编码 → 所有中文注释的字节被破坏成乱码
（如 `// 标准全屏四边形变?`）。文件字节含非法序列后 Iris 读不了 → failed to read。

范围：当时用脚本 `Set-Content` 批量改了 world-1/world1 的 103 个文件，**全部**含
中文注释的都中招。`world0` 未被我改过，是干净 UTF-8 源。

## 三、坑 2：目录被误写成同名文件（Copy-Item 容器语义）

连续复制却始终只有 1 个文件、`Copy-Item -Path "world*\*"` 报
`Container cannot be copied onto existing leaf item` 的原因：目标路径 `world-1`/`world1`
之前因某次 `Remove-Item` + 失败的复制残留，变成了**一个 41 字节的文件**（PSIsContainer=False），
不是目录。`Copy-Item -Destination "world-1\"` 把反斜杠当文件名处理 → 写不进。
修复：用 `New-Item -ItemType Directory` 确认是目录后，再**逐文件** `Copy-Item -LiteralPath`。

## 四、正确做法（本次采用，已验证）

1. 删除损坏目录 → 从干净 `world0` **字节级**逐文件复制（`Copy-Item -LiteralPath $srcFile -Destination dst`，
   **不经任何文本编码处理**，UTF-8 内容原样保留）。
2. 插入宏用 **.NET `[System.IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)`**
   （UTF-8 无 BOM），**绝不碰 PowerShell ANSI 的 `Set-Content`**。
3. 校验三件套（都通过）：
   - world-1=103 / world1=103 个入口全部含本维度宏，无缺失
   - 所有入口都有 `#version 4`（宏没顶掉 version 行）
   - 中文注释完好（UTF-8 解码无 `?` 乱码）

## 验证命令（UTF8 安全读，别用 Get-Content）
```powershell
$utf8 = New-Object System.Text.UTF8Encoding($false)
$c = [System.IO.File]::ReadAllText("path\file.glsl", $utf8)
$c -match '(?m)^#define\s+DIMENSION_THE_END\b'   # 有宏
$c -notmatch '\?'                                  # 无乱码
```

## 经验速记
- **给含中文注释的 glsl 批量加宏/改字，必须字节级或 UTF-8 编码写入**，PowerShell 默认
  ANSI 会破坏中文 → Iris failed to read。用 .NET File + `UTF8Encoding($false)`。
- **复制目录前先确认目标是目录不是同名文件**（`Get-Item | PSIsContainer`），否则容器
  复制进 leaf 报错、静默失败只剩 1 文件。
- 维度宏只在入口 shader 加，`voxy_*.glsl` 是被 include 的库、不加；world0 主世界无宏。




---

# 备忘：Probe GI（DDGI 风格探针辐照度缓存）实现关键点（2026-09-03）

## 架构
- 独立第三套间接光信号源（与 VXGI/SSILVB 并列，互斥）。16^3 探针 x 4m = 64m = VOXEL_AREA，
  复用体素化(voxelData)当场景几何，无需重新体素化。单值各向同性辐照度缓存（每探针一个 rgba16f）。
- 写端并入查询端 compute：写入 DiffuseIndirect(deferred1_a) 同一 dispatch（写 B 读 A 乒乓），
  复用"compute 内 imageStore 该 3D 纹理 + 读回"的已验证机制。

## 翻过的坑（最终成型方案）
1. 独立写端 pass 不被调度：写端挂 deferred50/22(fragment) A/B 分屏均全红 -> 该额外 pass 根本不被
   Iris 调度。"写读链路/乒乓/imageStore"都是好的，问题只在 pass 是否跑 -> 方案B 写端并入查询端 compute。
2. 黑屏(第一次跑写端)：deferred22.fsh 里 `#ifdef` 包 `#include` 前没先 include 设置宏，宏未定义 ->
   两个 include 都不命中 -> 无 main() -> 编译失败 -> 黑屏。修：先 `#include "/settings.glsl"`（有
   INCLUDE_SETTINGS 守卫、只定义宏可重复包含）；不要 include Utility.glsl（含未守卫函数，会重定义）。
3. viewWidth/viewHeight 是 float：`>>` 只接受整型操作数，须先 `int(viewWidth) >> 1`。
4. NaN/负值防护：单条线 NaN/负值污染整个探针平均 -> EMA oldValid=false(跳过时域)->闪烁，并经 trilinear
   读取传播成"忽明忽暗/一闪一闪"。逐样本守卫坏样本置 0；newVal 钳 [0,7.9]。
5. (核心)移动"偏移/乱飞"根因 = 探针网格锚定 + 重投影方式：
   - 最初"固定格 + 分数格重投影[read (vc+cDi)/4]" -> 内容不钉世界、乱飞；
   - 试"整数格重投影[round(cDi/4)]" -> 内容跟随玩家但每~4格回卷(网格不重居中)；
   - 正解 = DDGI 式"世界锚定 + 相机跨 4m 边界整格重居中 + 整数格重投影"：
     gridOrigin=(round(相机/4m)-8格)*4m；探针世界位置->vc 采样体素；历史按 reCenter(整数格)重投影(无插值)。
6. vs VXGI：VXGI 用 1m 整数格 + 慢 EMA + SVGF 所以稳定；coarse 4m 探针格若用分数格重投影需插值、易错位。
   DDGI 式整格重居中(4m 边界)+ 整数格重投影才无插值、钉世界。

## 关键技术点
- 探针格坐标->vc：探针世界位置 - cameraPositionInt + VOXEL_RADIUS；读取：查询点世界位置 = vc + camInt - VOXEL_RADIUS。
- 整格居中：gridOriginThis/Prev 每帧从 cameraPosition/previousCameraPosition(round到4m)算，无需持久状态。
- 有效性标记 alpha=1.0 表示本管线写入；查询端 a<0.5 判"从未写入"(定位"缓存从没被写"的关键)。
- 全量更新(每帧4096探针)+ 激进 EMA(有效0.1/无效1.0)快速洗净垃圾；相机跨格边界时加速重锚。

## [重写] 完整 DDGI（2026-09-03 后段，替代上面的"单值各向同性"方案）
- 单值各向同性探针(每探针 1 个 rgba16f)无法表达方向性 → 正是"近处无光/只有方块光/移动跳变"的根因；
  且各向同性平均把方向信息抹平，近火把探针朝亮/背亮方向都一样 → 近黑远亮。
- 彻底改为 DDGI 纸面算法（对照 RTXGI Irradiance.hlsl / ProbeBlending.hlsl / ProbeOctahedral.hlsl）：
  - **每探针一整块 O×O 八面体贴图**(O=N+2, N=PROBE_OCT_SIZE=6，含 1-px 边界)。辐照度=RGB(gamma=5 编码方向辐照度)，
    距离场=RG(均值, 均值²)供 chebyshev 遮挡。纹理：image.probeIrradiance/2、probeDistance/2 各 128×128×16(乒乓)。
  - **写端**（ProbeUpdateSlice，仍并入 DiffuseIndirect.comp）：每探针 16 条线（hash 随机方向）；每条线 DDA 求出
    "命中面辐照度 + 命中距离"（背面命中记负距离，不加辐照度）。对每个内部纹素，cos(纹素方向, 线方向) 加权融合：
    辐照度 = ΣL·cos/(2·Σcos)；距离 = Σd·cos/(2·Σcos) 及二阶矩。**重时域滞后(hysteresis 0.97)**：变化大降滞后、
    变暗给最小步进(1/1024)避免卡死；首帧/越界/NaN → 重置。边界 O²-N² 由内部按八面体缝【镜像拷贝】(imageLoad 回读
    同线程已写纹素，可靠)。
  - **查询端**（ProbeSampleRadiance(vc, worldNormal, cameraDir)，3 参）：8 邻探针三线性位置权重 × wrap-shading(朝向法线)
    × chebyshev 遮挡(采样点距离 > 该方向平均距离 → 用方差/方差+v² 降权防穿墙漏光) × 小权重压制；辐照度按"表面法线方向"
    取各探针该方向纹素，归一化 ×2π 完成半球 MC 估计。返回线性辐照度 → DeferredLight 乘 albedo。
  - **方向一致性**：写端 texture→dir 用 OctDecode，读端 dir→uv 用 OctEncode，二者互逆，统一走 ProbeOctSample 双线性。
  - **坐标/锚定**：仍用世界锚定重居中(gridOrigin=(round(相机/4)-8)*4)；查询读上一帧另一块(偶读B/奇读A)，锚=gridOriginPrev。
- 与原单值方案的差异：无需 SVGF/额外线缓存——DDGI 靠"每帧每方向少数线 + 数百帧累积"天然收敛，低频平滑免降噪。
- 阳光/天光/方块光值计算沿用先前对齐 VXGI 的 ProbeTrace：阳光 sunIrradiance×128 + VoxelSunShadowTracing；底光
  SimpleSkyLighting(命中体素真实 skylight)；发射体素 VoxelHitLightSphere 累加进线辐照度(沿途发光)。
- **改动文件**：shaders.properties(4 条 image.probeIrradiance/2、probeDistance/2 绑定 + sizes)；
  settings.glsl(PROBE_OCT_SIZE / PROBE_IRRADIANCE_GAMMA / PROBE_HYSTERESIS / PROBE_NORMAL_BIAS / PROBE_VIEW_BIAS)；
  lib/lighting/ProbeGI.glsl(八面体编解码 + 图集坐标 + 完整 DDGI 查询)；diffuse/DiffuseIndirect.comp(ProbeTrace 出距离 +
  ProbeUpdateSlice DDGI 写端 + 边界镜像)；DeferredLight.frag 不变。
- **风险**：无法本地编译 → 首要风险点 = GLSL 编译错误(局部数组/图像读写/采样器局部变量)；其次寄存器压力(local 数组
  ×16 可能下探伤占用)、亮度尺度(×2π×128 可能偏亮，靠 PROBE_GI_STRENGTH 调)、chebyshev 细节。改 PROBE_OCT_SIZE
  必须同步 shaders.properties 纹理尺寸(128→G*(N+2) 同深)。
- **已修的正确性细节**：(a) 查询端不收采样器局部变量，按帧奇偶直接把 sampler 传给函数(sampler 三元/局部是 GLSL 最易编译
  失败点)；(b) 八面体双线性须 +0.5 落到块内纹素中心(原 +1.0 会让每个纹素中心 50/50 糊化、且左右折缝不对称)——修正后
  中心处权重=1、左右折叠对称；(c) 查询端跳过未写入/NaN 探针(写端 alpha=1 标记)，防首帧另一块未初始化的脏数据上屏。
- **[根因级大坑 2026-09-03] shaders.properties 的 image 行必须单空格分词**：为对齐加的多空格(如
  `probeIrradiance   = probeIrradianceSampler   rgba ...`)会让 Iris 解析失败——游戏日志出现
  `Unknown image type! / Image X is invalid! Format: null`，纹理根本没创建 → imageStore 写空、sampler 读黑 →
  **缓存永远为空 → GI 全黑，且一切读缓存的调试视图全黑**（不报编译错，极难定位）。教训：新加 image 行先查
  游戏 logs/latest.log 有没有该条目的 `Unknown image type` 错误。

---

# 备忘：景深 DoF 移植（2026-09-11，自 Revelation-dev 原版）

## 移植内容（A Life of a bokeh 三段式）
- `lib/post/DOF.glsl`（CoC 计算/圆形+六边形光圈/口径蚀/Vogel 采样）+ `program/post/DOF/`
  Prepare/Gather/Postfilter 三个 comp + `world0/composite6.csh / composite6_a.csh / composite6_b.csh` 入口。
- 数据流：Prepare 读 colortex0(场景)+depth1 → 写 colortex3(scene+CoC.a)+colortex15(CoC 传播数据)；
  Gather 读 colortex3 采样 + colortex15 读 gather 半径 → 写 colortex15(过滤色+原 alpha)；
  Postfilter 读 colortex15+colortex3.a 做 3x3 中值 → 写回 colortex0。输出位置在 composite7(TAA) 之前，
  采样噪声由 TAA 时域平滑（与原版 composite3/4/5 → composite7 的相对位置一致）。

## 关键适配（本包与原版的差异）
1. **无 RENDER_SCALE 体系**（MEMO SVGF 一节的老坑）：原版所有 scaled* 坐标全部换成全分辨率
   （scaledViewSize→viewSize、scaledTexelSize→viewPixelSize、texelToUvScaled→texelToUv、
   uvToTexelScaled→uvToTexel、scaleScreenUv→恒等），workGroupsRender 恒 vec2(1.0)。
2. **composite6/6_a/6_b 挂法**：Iris 的 compositeN.csh 是 compositeN.fsh 的附着 compute，按
   base→_a→_b 顺序派发（ShaderDoc；本包 prepare→prepare_a、deferred1→deferred1_a 依赖链已验证）。
   5/6/7 里只有 6 空着（5=HurtTimer、7=TAA），所以三段 DOF 全挂在 composite6 族下。
3. **colortex15 死缓冲复用**：原 RGBA8 "Voxel GI propagation"，唯一使用点 smooth.glsl 只被
   已禁用的 deferred1_b.csh1 引用。升 RGBA16F 作 DOF gather scratch（HDR 需半精度）。
   colortex3 在 composite4.csh(Translucent 写)→composite4.fsh(IntegrateScene 消费)之后空闲，
   TAA 的运动向量(composite7 写 colortex3)在 DOF 之后——无冲突。
4. **YCoCg 兼容**：IntegrateScene 在 TAA 开启时把 colortex0 编码为 YCoCg。DOF 的 gather 是线性
   加权平均，blur(YCoCg)==YCoCg(blur)，无需转色空间（TAA 读到的仍是合法 YCoCg）；
   Postfilter 的逐通道中值在 YCoCg 空间做，与 RGB 中值略有差异但仍是有效的离群值剔除。
   colortex0.a（1-fogMask）经 Gather(colortex15.a)→Postfilter 原样透传，语义不变。
5. **SSBO**：GlobalData 末尾追加 `float dofFocusDistance`（std430 尾部追加不动既有成员偏移），
   自动对焦时 Gather 的 DofUpdateFocus 单线程(texelPos==0)指数平滑写入；手动模式不写。
   初始值 0 由 Prepare 的 `max(global.dofFocusDistance, dofFocalLength)` 兜底。

## 其它
- 原版只有 world0 有 DOF（Revelation-dev 无 world-1/world1 目录），本移植同样只加 world0；
  下界/末地不开景深。
- 选项接线三件套已同步：settings.glsl 选项块、shaders.properties（screen.DoF 填充 + sliders 追加
  7 个滑条 + composite6/6_a/6_b.enabled = DEPTH_OF_FIELD）、lang 双语。
- Iris 选项 txt 无旧 DOF 残留值；DEPTH_OF_FIELD 默认关，GUI 后处理 → 景深里开启。
- 排查提示：DOF 三段任一没跑的症状是画面不模糊/CoC 数据错乱花屏——先查日志里 composite6/6_a/6_b
  是否编译失败，再确认 DEPTH_OF_FIELD 宏与 .enabled 规则生效。

---

# 备忘：色散 Chrstasic Aberration（2026-09-11）

## 实现
- 纯最终输出后处理，不改管线、不新增 pass/缓冲：Final.frag 的 `LoadChromaticScene(texel)` 替代
  原 `FFXCasFilter` 获取最终场景色。CAS 关闭时 FFXCasFilter 恒等返回中心色，色散分支仍独立生效。
- 算法：对已 tone-map 完成的 colortex0，R 略向外、B 略向内、G 不动径向分离，偏移按到中心距离
  线性增长（除以半对角 0.7071 使四角归一 = CHROMATIC_ABERRATION_STRENGTH 像素）。中心无色散，
  符合真实镜头横向色差。
- 玩法：glitch/R!G!B! 撕裂类效果覆盖在色散之上（它们自身就有错位感），色散作为底层镜头效果，
  静止画面观感不受干扰。

## 注意
- **shaders.properties 仍是 ASCII 硬约束**：本轮我在 screen.ChromaticAberration 注释里写了中文
  （横向色差）导致 25 个非 ASCII 字节，Iris jcpp 会崩——已改英文。properties 注释一律英文。
- 宏接线三件套：settings.glsl（CHROMATIC_ABERRATION 默认关 + CHROMATIC_ABERRATION_STRENGTH
  默认 0.8，RENDER_MODE==0 截图模式统一 #undef）、shaders.properties（screen.ChromaticAberration 分组
  + sliders）、lang 双语 + 说明。
- suffix.CHROMATIC_ABERRATION_STRENGTH=像素（px），GUI 后处理 → 色散 开启，滑条直接拖强度。

---

# 备忘：体积光并入体积雾（2026-09-12）

## 结论
独立的「体积光」（god rays）层已删除，改成**让体积雾的太阳散射吃阴影贴图**：
`RaymarchAtmosphericFog` 新增 `sunShadowVis`（逐射线阴影可见度）与 `lightEnergy`（定向光能量）
两个参数，`scatteringSun` 乘上 `cloudShadow × mix(1, sunShadowVis, VF_VOLUME_INTENSITY)`。
雾的密度闭式积分与透射率**没动**，只是多了一个逐射线系数，没有步进循环。

## 为什么不是「把雾改成步进」
用户明确要求体积雾保持解析（闭式）渲染 —— 那是 2026-09-10 修掉「雾层同心环」的成果
（`IntegrateFogDensityAlongRay`，在折点处精确切分）。所以光束不通过「沿射线累加 in-scatter」
实现，而是给**整条射线的太阳项**乘一个可见度系数：可见度沿射线的平均决定了这条视线的明暗，
逐像素的差异就形成光束。代价是光束比真步进软（靠 TAA 时域平均补）。

## 踩过的坑
- **阴影采样只能放在 IntegrateScene**：`prepare`（GenSkyMap 天空 LUT）在 shadow pass 之前，
  那里没有 shadowtex；而 AtmosphericFog.glsl 被多个 pass 共用（IntegrateScene / GenSkyMap /
  Translucent.comp）。所以「可见度」由调用方算好传进去，雾函数自己不做阴影采样。
- 原来那段「体积雾阴影采样」（`#if defined PASS_VOLUMETRIC_FOG`）是**死代码**：PASS_VOLUMETRIC_FOG
  只在 VolumetricFog.frag 里定义，而那个文件不 include AtmosphericFog.glsl。里面还写了
  `texelFetch(sampler2DShadow, ...).x` —— 根本编不过，只是从没被编译过，所以一直没暴露。
- **月光项不能直接写进 AtmosphericFog.glsl**：`VOXEL_MOON_STRENGTH` 定义在 VoxelLighting.glsl，
  而 IntegrateScene 是在它之前 include AtmosphericFog.glsl 的；宏取不到值会变成「GUI 旋钮失效」。
  所以定向光能量也由调用方传入（IntegrateScene 里算 directIlluminance + 月光补项）。
- 原 MODE1 的成本是 MODE0 的 4 倍（207 万像素 × 8 vs 13 万像素 × 32），而设置里的描述写反了；
  且 MODE1 下 `composite` pass 在默认配置里每帧空转。合并后这些都不存在了。

## 新选项
- `VOLUMETRIC_LIGHT`：雾中光束总开关（需要 `VOLUMETRIC_FOG` 开启）
- `VF_VOLUME_INTENSITY`：光束强度 = 阴影对比度（0 = 不压暗 = 没有光束）
- `VF_VOLUME_SHADOW_SAMPLES`：沿视线的阴影采样数（0 = 关；默认 4，8 档 ≈ 原 MODE1 的开销）
- 删除：`VOLUMETRIC_LIGHT_MODE` / `VF_VOLUME_MAX_STEPS` / `VF_SHAFT_COLOR_BRIGHTNESS` /
  `VF_MAX_SAMPLES` / `UW_VF_MAX_SAMPLES` / `VF_NOISE_QUALITY` / `VF_SHADOW_QUALITY`

---

# 已移除：「体积雾不透明度」+「云层模式」（2026-09-12 当天加入当天移除）

两个功能都已完整回退（`git checkout <加它们之前> -- AtmosphericFog/settings/properties/lang`），
但下面的结论值得留着 —— 免得以后又走一遍同样的弯路。

## 为什么做不出来

需求是「雾拉高之后要像体积云、要有明确边界的云」。结论：**「最后渲染不步进」与「看起来像体积云」
在数学上互斥**。非步进 ⇒ 每条射线只能有一个密度值，于是：
1. **图案被钉在射线上某个固定距离**（原取射线∩云带的中点，水平视线落在半个视距 ≈128 格 →
   一面「中距离云墙」，走动时从身边滑过）。改成「进入云带处 + 半厚度」只能减轻，治不了根。
2. **沿射线没有密度变化** —— 云的立体感有一半来自沿射线的自遮挡，一个采样点算不出来。
3. **单点阈值化的噪声是「剪纸」式硬块**，块内没有任何明暗层次。

## 顺带查清的两件事（有复用价值）

### 1) 包里的噪声纹理分布都很窄，阈值化前必须拉开

| 纹理 | 绑定 | 实测分布 | 备注 |
|---|---|---|---|
| Noise2D.png | `noisetex`（`texture.noise`） | R/G min 40/255 max 213/255 **std ≈ 0.11**；两次采样混合后 **std ≈ 0.06** | 直接 `smoothstep(0.5,0.65,·)` → 平均覆盖率仅 0.16、实心 3.6%、空隙 66% ⇒ 等于没有 |
| CloudMap.bin | `cloudMapTex` 2D RG8 512² | mean 0.617 / std 0.18 | 云的覆盖率贴图 |
| AlligatorFbm_128.bin | `baseNoiseTex` 3D R8 128³ | mean 0.387 / std 0.127 | 云的 FBM 形状 |
| SimplexGrad_64.bin | `curlNoise3D` 3D RGB8 64³ | mean 0.483 / std 0.11 | 云的 curl 侵蚀 |

- 这些纹理的 `.mcmeta` 都是 `{"blur":true,"clamp":false}` ⇒ **线性过滤 + repeat**，可任意缩放采样；
  三个 sampler 都声明在 `lib/universal/Uniform.glsl`（35/37/40 行），任何 pass 都能直接用。
- **尺度必须换算**：云的噪声按公里级标定（`cloudMapExtend = 96e3` m、噪声空间 = 世界/2000），
  搬到几十格的尺度上会变成一个常数。
- **标定手法**：把 `.bin` 当原始字节读进 Python，等价实现采样 + 阈值化，跑蒙特卡洛统计覆盖率
  （比在游戏里反复试快得多）。

### 2) 包里的体积云本来就是现成的，做「云海」不需要写代码

- `program/clouds/Render.comp`（compute）+ `Reconstruct.frag`：完整体积云渲染器，
  `CLOUD_TAAU_SCALE`（默认档 4）= 1/4 分辨率 + 时域累积，自适应步数 `CLOUD_LOW_SAMPLES_MIN/MAX` = 12/24。
- 三层选项在 `lib/atmosphere/clouds/Common.glsl`（**不在 settings.glsl**）：
  LOW/CU（高度 1100 / 厚度 1500 / 覆盖率 0.5）、MID/AS（4000 / 2000）、HIGH（8000）。
- **想要低空云海**：把某一层降下来即可 —— 滑条最低 400/500，例如
  `CLOUD_MID_ALTITUDE` 4000 → 500、`CLOUD_MID_THICKNESS` → 500~800、`CLOUD_AS_COVERAGE` 0.5~0.8，
  头顶 500~1000 格处就是一层真体积云。代价：那一层原来的高空云没了。

---

# 备忘：VXGI 阳光反弹「大片明亮鲜艳亮斑」收敛（2026-09-30）

## 现象与定位
- 用户实测：VXGI 模式偶尔出现**大片**、**鲜艳**的亮斑（自述「像溢出」）。
- 定位手段：滑条逐项归零 → **只把 `VOXEL_TRACE_SUN_STRENGTH` 归零即消失**
  ⇒ 来源是**每像素追踪端的阳光反弹项**（不是 IRC 注入，也不是天光/自反弹）。
- 注意「大片 + 鲜艳」这两个特征：不是 firefly（零星单点，已有 rcpPdf 钳制 + 中值滤波），
  而是**成片**（所以降噪压不住）；颜色是命中体素反照率原色（VoxelTracing 用体素平均色当 albedo）。

## 根因（三个叠加，都不是"数量级错误"）
1. **可见性只做 3 格 DDA**（`VoxelSunShadowTracing`）：薄遮挡物——半砖/玻璃/地毯/活板门/树叶，
   在 MC 里 **skylight 几乎不衰减**——下方天光门控照样全开；加上太阳掠射角时阴影贴图沿法线的
   屏幕偏移（`ssp.xy += normal.xy * 0.000125`）会把命中点"推出"薄顶 ⇒ 判成直射 ⇒
   薄屋顶/树荫下**整片地板**吃满 0.43 量级的彩色反弹。
2. **天光门控区间太松**（0.25-0.55）：skylight≈0.55（原版 lightmap 8/15）就全开，
   半遮挡（树荫/窗边/薄顶下）拦不住。DDGI 探针端早就用更紧的 `smoothstep(0.20, 0.80)`。
3. **量级本身偏高**：`directIlluminance/VOXEL_SUN_REFERENCE` = 128/300 = 0.427（正午峰值），
   比物理的 L=alb·E·cos/π（≈0.318）高 1.34 倍；且这条链路历史上被 1.0→2.0→8.0→32.0
   反复放大（32× 时期就是"彩色方块反弹出原色溢出像素"，2026-09-23 才回正 1.0）。

## 修复（4 处，均为最小改动）
| 文件 | 改动 |
|---|---|
| `VoxelSunShadow.glsl` | 新增宏 `VOXEL_SUN_TRACE_STEPS`（默认 **8**，原硬编码 3），DDA 循环用它 |
| `VoxelTracing.glsl` | 阳光门控 `smoothstep(0.25,0.55,…)` → `smoothstep(0.20,0.80,…)`（对齐 DDGI 探针端） |
| `VoxelTracing.glsl` | 阳光项加单次弹射上限 `min(sunBounce, alb)`（常态不触发，防未来加大倍率再次贴顶） |
| `VoxelLighting.glsl` | `VOXEL_TRACE_SUN_STRENGTH` 默认 1.0 → **0.5**（GUI 可调，阴影发暗就拖回去） |

顺手修：`DeferredLight.frag` 的 `voxelGI *= albedo * VOXEL_GI_TRACE_STRENGTH` 去掉重复乘的强度
（DiffuseIndirect 写信号时已乘过 → GUI 滑条原本是平方）。

## 第二轮（2026-10-01）：用户反馈「没有修复」→ 改打 IRC 注入端
上面 4 处（追踪端）**实测未消除亮斑** ⇒ 主因不在追踪端量级/可见性，改为收敛**注入端**：
`VoxelGI.frag` 的 `sunLighting` 去掉 `rPI`（与追踪端口径统一）。
- 量级链：普通方块全方向采样 pdf=1.6 → rcpPdf=0.625；本项期望 = alb×(128/300)×π×0.625
  = **alb×0.84** → 叠加自反弹(0.8)后必然 >1.0 → 撞上文件末尾的「保色压缩」
  （`if(maxC>1) nRC *= 1/maxC`）⇒ **整片日照区的 IRC 缓存钉在 1.0 天花板且色相被归一化成
  纯反照率原色**；这份贴顶纯色再经 0.995 时域混合 + 自反弹扩散 + 8-tap 三线性读出
  ⇒ 按 1m 体素尺度的**成片鲜艳亮斑**。去 rPI 后期望 = alb×0.27，远离钳位线。
- ⚠️ 待用户确认的诊断（两个滑条名字很容易混）：
  1. `阳光注入强度 VOXEL_GI_SUN_STRENGTH` 归零 → 亮斑消失？（= IRC 注入端，已改）
  2. `阳光反弹强度 VOXEL_TRACE_SUN_STRENGTH` 归零 → 亮斑消失？（= 追踪端，第一轮已改）
  3. 另需排除：`环境天空注入倍率 VOXEL_GI_SKY_STRENGTH`（用户配置 4.0 且
     `VOXEL_IRC_SKY_GATE=1` 无门控 → IRC 天光期望 ≈1.0，**同样会贴顶**）。
  4. `光追降噪 VOXEL_GI_DENOISE` 关掉 → 亮斑是否仍在（分辨"信号"还是"降噪链"）。

## 影响面 / 回滚
- `VoxelSunShadowTracing` 是**共用函数**，IRC 注入端（VoxelGI.frag）与 DDGI 探针端
  （DiffuseIndirect ProbeTrace）也一起变保守 ⇒ 阴影整体略暗（可用 `VOXEL_GI_SUN_STRENGTH` /
  `VOXEL_GI_TRACE_STRENGTH` 补）。嫌 IRC 注入端性能吃紧就把 `VOXEL_SUN_TRACE_STEPS` 降到 4-5。
- 逐项回滚顺序：先 `VOXEL_TRACE_SUN_STRENGTH` 拖回 1.0（量级）→ 再把门控改回 0.25-0.55
  → 最后把 `VOXEL_SUN_TRACE_STEPS` 改回 3（可见性）。

## 若下次仍复现，先用这个判据定位
`VoxelTracing.glsl` 里 `#define DEBUG_SUNBOUNCE_VIS`（解除注释）→ 三通道：R=sunVis（阴影贴图遮挡
判定，0=采样失败/判无阳光）、G=朝向太阳、B=天光门控。亮斑区域若 **R=1** ⇒ 仍是"误判直射"
（可见性问题，继续加 `VOXEL_SUN_TRACE_STEPS` / 查阴影贴图）；若 R=1 且 G=1、B=1 ⇒ 判定正确、
只是量级偏好问题 ⇒ 纯调 `VOXEL_TRACE_SUN_STRENGTH`。
（注：追/注两端代码已于 2026-10-02 整段移除，上述调试宏随之删除；重写后再按新实现补判据。）

---

# 备忘：阳光/月光反弹整段移除（2026-10-02，待重写）

## 为什么推倒
- 前两轮（2026-09-30 收敛量级+可见性、2026-10-01 去注入端 rPI）**都没修掉**。
- 用户补充的关键特征：**亮斑是单个异常像素，会被降噪放大；玩家站在特定位置时，即使转头也会
  在原位（同一世界位置）再次出现** ⇒ 不是"整片贴顶"（那会是成片），而是**单像素极端值/
  firefly**，且与**世界几何位置**绑定（体素网格是相机锚定的，同一世界点的体素内容/命中
  随相机位置变化 → 只在特定站位复现）。
- 处置：按用户要求**整段停用阳光/月光反弹**，先拿到「零反弹基线」——若亮斑仍在，说明来源
  根本不是反弹（应转向查 发射光 VoxelHitLightSphere / IRC 自反弹 / 保色压缩钳位 / 降噪链）。

## 本次移除的代码（3 个注入点 + 1 个辅助文件）
| 位置 | 内容 |
|---|---|
| `lib/lighting/VoxelTracing.glsl` | 追踪端阳光项（sunDir/sunLighting/directIlluminance 重算/sunVis/sunBounce）+ 月光项 + `DEBUG_SUNBOUNCE_VIS`；include 一并去掉 |
| `program/gi/VoxelGI.frag` | IRC 注入端阳光项（sunLight/sunLighting/sunVis）+ 月光项 + `sunDir` 本地量；include 去掉 |
| `program/diffuse/DiffuseIndirect.comp` | DDGI 探针端阳光项（sunSkyGate / VoxelSunShadowTracing）；include 去掉 |
| `lib/lighting/VoxelSunShadow.glsl` | **整份删除**（VoxelSunShadowMap + VoxelSunShadowTracing，已无调用点；git 历史保留供重写参考） |

保留（按用户要求「先保留滑条，只停用代码」）：`VOXEL_GI_SUN_STRENGTH` / `VOXEL_TRACE_SUN_STRENGTH` /
`VOXEL_MOON_STRENGTH` / `VOXEL_SUN_REFERENCE` 宏与 GUI 滑条 → 当前是**无效旋钮**，重写后接线。
注意 `VOXEL_MOON_STRENGTH` **不能删**：IntegrateScene 的**体积雾/月晕光能量**还在消费它（非反弹）。
`shadow/Common.glsl` 与 `shadowtex1` 的 include/声明在两个 compute 单元里保留（已无消费点，
但删掉有编译风险，重写时会用到）。

## 重写时的方向（下次商量）
1. **别在每像素追踪端直接产阳光项**：1 SPP 的随机采样天生是 firefly 源。本项目已有先例——
   发射光就是为这个原因从追踪端迁到 IRC 时域累积（见 VoxelLighting.glsl 的
   `VOXEL_GI_TRACE_LIGHT_STRENGTH` 注释）。阳光反弹应同样**只走 IRC 注入端**，
   追踪端靠「自反弹」读回。
2. **物理量级一次定死**：L = albedo·E·cosθ/π，E 用 `global.directIlluminance/128`，
   不要再用历史倍率补丁（1.0→2.0→8.0→32.0 那条链就是教训）。
3. **可见性判定要可靠**：阴影贴图 + 网格内体素 DDA（薄遮挡必须挡住），并且门控用
   `max(命中体素 skylight, 像素 lightmap)` 的 smoothstep，区间对齐探针端 `(0.20, 0.80)`。
4. **单样本硬上限**：`min(项, albedo)` 一类封顶要常驻，防止未来调参再次贴顶。

## 本轮附带修复（同一症状「单像素极值」的直接来源）
- **真 bug：NaN 体素被判成固体。** 三处追踪循环原本都写 `if (hvd.z <= 0.5) continue;`
  —— NaN 参与任何比较都返回 false，于是 **NaN 的 voxelID 会跳过"空气"分支**、
  落进命中路径：`IsHitBlock(abs(NaN), ...)` + 用垃圾 `hvd.r/g/w` 解出的 albedo
  参与 方块光/阳光/自反弹 ⇒ 该格贡献出极值。因为钉在体素格上，
  表现正是用户描述的「**单个异常像素 + 固定世界位置复现**（网格相机锚定，站着不动则格不动）+
  被降噪放大（a-trous pass3 步长 8px 会把它糊成一片）」。
  改为 `if (!(hvd.z > 0.5))`：有效数据逐位等价，NaN 归入空气。
  三处：`VoxelTracing.glsl` / `VoxelGI.frag`(IrcTraceVoxel) / `DiffuseIndirect.comp`(ProbeTrace)。
- **albedo `saturate()`**（同三处）：合法数据本就 0-1，只防垃圾/半精度残留被放大成极值。
- **逐像素追踪输出硬上限 `min(result.rgb, 8.0)`**（`DiffuseIndirect.comp`，VXGI 分支）：
  合法 GI 量级远低于 8，拦住"不可能属于该点"的极值，避免降噪把单像素糊成亮斑。
- 附带排掉一个自己引入的隐患：注释里 ASCII `"` **跨行未配对**（开引号在一行、闭引号在下一行）
  是 jcpp 最危险的形态；已改成 `「」`。顺带实测确认：本项目已有多处**同行配对**与**跨行**的
  ASCII 引号注释（VoxelTracing L35-36、VoxelLighting L132-133/L162-163、VoxelSkyLight L50-51）
  一直正常编译 ⇒ MEMO 早先"注释里绝不能有 ASCII 引号"的结论过严，真正要避免的是
  **`#include` 行尾注释**（那条才是确证的坑）。

## 源头定位（2026-10-02，用户确认"确实没有异常亮斑了"之后回查）
结论：**根因是写入端不收口，不是阳光反弹的倍率/门控。** 这解释了为什么 09-30、10-01 两轮
调倍率与门控全都无效。

1. **先排除一个**：`hvd.z`（voxelID）**不可能**是 NaN —— 写入端是 `float(uint(...))`（恒为有限值），
   且 GS 的 `clamp(voxelCoord, 0..63) == voxelCoord` 会拒掉 NaN 坐标（`NaN == NaN` 为 false）。
   ⇒ 我 10-02 加的「NaN 体素当空气」**不是这次的修复**，只是无害加固。**（更正我先前的归因）**
2. **真正的口子 = `voxelData.rg`（`rgStore`）**：`Shadow.frag` 里 `.b` 与 skylight 都 clamp 了，
   但 `rgStore` 是**原样**写进 rgba16f（半浮点上限 65504）。
   固体格存 `texture(tex, v_midCoord).rgb * vectorDataOut` 的 RG（反照率），
   透明格存 UV —— 一旦出现**非有限值**（UV 非有限时 `texture()` 是 UB，可能返回 NaN）
   或 **>1**，垃圾反照率就进了缓冲。读取端（VoxelTracing / VoxelGI / ProbeTrace）
   把它原样乘进 方块光/阳光反弹/IRC 自反弹 ⇒ **单像素极值** ⇒ 钉体素格（固定世界位置复现）
   ⇒ 被 SVGF 大步长 a-trous 放大成可见亮斑。
3. **收口**（本次）：写入端 `saturate(v_midCoord)`、`saturate(vectorDataOut)`、
   结果 `isnan/isinf → 0`、再 `saturate(rgStore)`；读取端保留 10-02 的 `saturate(albedo)`
   （第二道防线）与逐像素输出 `min(…, 8.0)`（兜底）。
   ⚠️ 注意 `clamp/saturate` 对 NaN 的行为依赖实现（按 GLSL 的 min/max 语义会返回 max 侧 = 1），
   所以**不能只靠 saturate 杀 NaN**，必须显式 `isnan/isinf` 归零。
4. 未确证的一点：具体是「NaN」还是「>1」触发（两者都被同一处收口覆盖）。
   若要确证，需在写入端加一次性诊断（把非有限/越界值染色上屏）；当前症状已消失，暂不做。
5. 残留隐患（未改，仅记录）：`Shadow.vert` 的 `uint materialID = uint(max(mc_Entity.x - 1e4, 1));`
   —— `mc_Entity.x` 若为 NaN，`uint(NaN)` 是 UB（可能得 0），materialID=0 ⇒ voxelID=0
   ⇒ 该格被当成"空气"写入，等于**墙上开了个 1 格洞**（漏光），而不是亮斑。地形阶段
   MC 不会送 NaN，属低概率，故未动。

---

# 备忘：阳光反弹重写（2026-10-02，追踪端 + IRC 注入端）

## 新结构
`lib/lighting/VoxelSunBounce.glsl`（新建）= **阳光反弹的唯一定义**，两端各自调用、不得各写一份：
| 函数 | 作用 |
|---|---|
| `VoxelSunShadowMap(camRelPos, normal)` | 阴影贴图判定（**权威**）：1=直射 / 0=实心挡 / 玻璃=吸收色；范围外保守判 0 |
| `VoxelSunOcclusion(voxelPos, sunDir)` | 体素 DDA（**补充**）：`VOXEL_SUN_TRACE_STEPS`(默认 12) 格内的薄遮挡；NaN 格当空气 |
| `VoxelSunVisibility(...)` | 两者相乘（DDA 只能压低，永不误放行） |
| `VoxelSunSkyGate(hit, pixel)` | `smoothstep(0.20, 0.80, max(...))`，与探针端口径一致 |
| `VoxelSunEnergy()` | 0-1 尺度直射辐照度：`global.directIlluminance / VOXEL_SUN_REFERENCE`，**不碰大气 LUT** |
| `VoxelSunBounce(...)` | 一次弹射项：`alb·E·cosθ·gate·vis·strength`，外层 `min(项, albedo)` + NaN/Inf→0 |

接线：`VoxelTracing.glsl`（追踪端，命中段）与 `VoxelGI.frag`（IRC 注入端，命中段）各一处调用。
滑条 `VOXEL_TRACE_SUN_STRENGTH` / `VOXEL_GI_SUN_STRENGTH` 都已重新接线（默认 1.0）。

## 相对被删旧实现的 5 处实质改动（都是踩过的坑）
1. **口径唯一**：旧实现两端各写一份，一端带 `rPI`、一端不带；一端用 SSBO、一端用常量；
   门控一端 `(0.25,0.55)`、一端 `(0.20,0.80)` ⇒ 怎么调都对不上。现在只有一份函数。
2. **不采大气 LUT**：旧追踪端在 **compute** 里调 `AtmosphereTransmittanceToSun` ——
   MEMO 的另一条硬结论是「compute 里大气 LUT 未绑定、采样得 NaN/garbage」。改用 SSBO +
   常量兜底（`VoxelSunEnergy()`），并把 NaN/Inf 显式归零。
3. **方向不再用 `shadowModelViewInverse`**：MEMO 记录该矩阵在 compute 无效；
   两端统一用 `worldSunDir`（世界空间、指向太阳，白天 y>0、夜晚 y<0）。
4. **量级一次定死**：E 已是 0-1 尺度，公式里没有任何"为了让反弹可见"的补偿系数
   （历史上 1.0→2.0→8.0→32.0 那条链就是教训）；要更亮请调滑条。
5. **三道极值保险**：单次弹射 `min(项, albedo)` → 逐像素输出 `min(result, 8.0)`（DiffuseIndirect）
   → 写入端 albedo `saturate` + `isnan/isinf→0`（Shadow.frag）。任何一层坏数据都成不了亮斑。

## 未做（明确记录）
- **探针端（GI_MODE=3）**未接阳光反弹（该模式内部启用、不暴露 GUI）。要对齐就照
  `VoxelSunBounce` 的结构在 `DiffuseIndirect.comp` 的 `ProbeTrace` 里追加，
  且必须用 `VoxelSunEnergy()`（compute 不能碰大气 LUT）。
- **月光反弹**本轮未一并重写（用户只要求阳光）。`VOXEL_MOON_STRENGTH` 目前只被
  IntegrateScene 的体积雾/月晕消费；要恢复照 `VoxelSunBounce` 再加一个函数即可。
- 注意**两端叠加**的固有语义：追踪端给"锐利近场"，IRC 自反弹给的则是缓存里的那份，
  两者都会带上阳光反弹 ⇒ 观感上约为单份 ×2。嫌亮先降 `VOXEL_TRACE_SUN_STRENGTH`。
- IRC 注入端在"特殊方块表面格"走半球采样（pdf=2cos），`rcpPdf` 最大 20（`VOXEL_IRC_PDF_MIN` 钳制）
  ⇒ 掠射角下单样本会被放大；这是**既有**估计器特性（对 blocklight 同样成立），
  由缓存末尾的保色压缩兜住，本轮未改。

---

# 决策：放弃重写、回到旧实现作基线（2026-10-02 晚）

## 为什么
用户提议：「旧反弹虽然有 bug 但**可以工作**，不如回到旧实现对齐再改进」。同意 —— 重写版
（`VoxelSunBounce.glsl`，已删除）**实测完全看不到反弹**，而旧实现至少能出效果。
在一个已验证能工作的基线上做最小改动，风险远低于从零重写（本次重写的教训是：
**手抄一遍 DDA/障碍判定这种"已经调对过的代码"很容易引入静默归零**，
嫌疑最大的就是我重写版里的 `VoxelSunOcclusion`，但无法在不进游戏的情况下证伪）。

## 现在的状态（working tree vs HEAD，共 9 文件 / +64 -12）
- **复活**：`lib/lighting/VoxelSunShadow.glsl`（`git checkout HEAD --` 字节级还原）+ 三个调用点
  的旧阳光项（追踪端 `VoxelTracing.glsl`／IRC 注入端 `VoxelGI.frag`／探针端
  `DiffuseIndirect.comp` ProbeTrace）= **与被删前完全一致的旧实现**。
- **保留的改进（都是根因修复/纯防护，不改旧观感）**：
  1. `Shadow.frag`：写入端 albedo `saturate` + 非有限值归零 —— **这才是"亮斑"的根因修复**；
  2. 三处读取端 `saturate(albedo)` + `!(hvd.z > 0.5)` NaN 归空气；
  3. 追踪端阳光项外层 `min(项, albedo)` 单样本上限（旧实现没有；防滑条拖到 32 烧白）；
  4. `DiffuseIndirect.comp` 逐像素输出 `min(result, 8.0)` 兜底；
  5. `DeferredLight.frag` 去掉重复乘的 `VOXEL_GI_TRACE_STRENGTH`（原本滑条是平方）。
- **一处小改**：追踪端 `sunDir` 从 `mat3(shadowModelViewInverse)*vec3(0,0,1)` 改为 `worldSunDir`。
  白天二者等价（`worldSunDir = sunlightSign · shadowModelViewInverse[2]`，白天 sign=+1）⇒ 对观感
  无影响；好处是晚上会自动跟随月亮的换边，并且不再依赖"compute 里矩阵是否有效"这个疑点。
- **未改**（列为下一轮候选）：注入端的 `rPI`（与追踪端口径不一致，但它是旧观感的一部分）、
  两端门控区间不一致（0.25-0.55 vs 0.20-0.80）、月光反弹仍未恢复。

## 用户须知
`shaderpacks/Revelation-AD-edit.txt` 里记着 `VOXEL_TRACE_SUN_STRENGTH=32.0`（追查亮斑时拖满的）。

## [同日撤回] 「单样本上限 min(项, albedo)」已删除 —— 它废掉了滑条
用户实测反馈：「阳光反弹有，但是很弱」。查证：`0.43 × strength ≥ 1` 之后该项一律被
`min(项, albedo)` 按回 1×albedo ⇒ **strength 从 2.4 到 32 视觉完全一样**，
用户把滑条推到 32 也看不出变化（相当于被强制降到 0.07 倍）。
⇒ 该上限从追踪端阳光项移除（保留旧实现原式）。

**教训（重要）**：不要把"防极值"做成**与反照率挂钩的乘性封顶**——它和"强度可调"直接冲突，
用户会以为功能坏了。防极值应该做在**产生端**（写入端收口、读取端 saturate）或
**输出端**（`min(result, 8.0)` 这种与调参量无关的绝对兜底），不要做在中间环节。
当前三层防护都在"与滑条无关"的位置，所以删除上限不重新引入亮斑风险。

## 诊断开关（已接好 GUI，随时可用）
`设置 → 调试 → 体素 → 阳光反弹因子调试`（settings.glsl / shaders.properties / 双语 lang 三处同步）。
三通道：**R=遮挡可见性（阴影贴图×体素DDA）/ G=命中面朝向太阳 / B=天光门控**。

---

# 后续：强度收敛 + 室内漏光修复（2026-10-02 深夜）

## 1. `VOXEL_SUN_BOUNCE_GAIN`（代码侧增益，当前 8.0）
滑条拖到 32 仍"有但很弱"的原因不是门控/遮挡（已用角落读数确认宏值=32 生效），而是
**追踪端是"半球 1 采样 + 时域平均"的估计器，收敛值 = 命中率 × 单次量级**；开阔地上多数
射线飞向天空、不命中任何面 ⇒ 命中率天然很低 ⇒ 平均值就是很淡，而强度滑条只放大
**单次量级**、改不了命中率（所以 32 也救不回来）。
⇒ 新增 `VOXEL_SUN_BOUNCE_GAIN`（VoxelLighting.glsl，与滑条相乘、不占 GUI）直接抬结果，
并把 `DiffuseIndirect` 的输出上限 8.0 → 32.0（否则增益被截平）。
**教训**：调不动的时候先分清"门控/遮挡问题"还是"估计器命中率问题"——前者调得动，后者调滑条无效。

## 2. 室内漏光：**改从几何根因解决**（门控维持原式）
用户反馈"阳光反弹会穿过厚度为 0 的缝隙漏进室内"，并明确指出**不要用 MC lightmap 做门控**
（会引出很多奇异景象——MC lightmap 与体素/光追两套光照语义不一致）。
⇒ 门控保持原式 `smoothstep(0.25, 0.55, max(hitSkylight, skyLightmap))` 不动。

**根因（用户指认，正确）**：两个方块斜向贴着时，接触面积 = 0，只剩一条**零宽度的棱/点**。
体素 DDA 在这类"角点 tie"步里会**多轴同时推进**、直接跳到对角格，
**中间那 2~3 个接触格从不被采样** ⇒ 射线顺着这条缝穿过去 ⇒ 漏光。

**修法**（`VoxelSunShadow.glsl` 的 `VoxelSunShadowTracing`，本次）：
在每一步判断 `dot(tracingNext, tracingNext) > 1.0`（= 多轴 tie），若是则对每个发生 tie 的轴
**各自回退一格**得到"侧格"（2 轴 tie → 2 个侧格；3 轴 tie → 3 个棱格，正好覆盖角点周围
除对角格外的全部格），任一侧格是**整块固体**（`abs(z) <= 154`）即判遮挡。
物理依据：这两格在棱/点上确实相接，光不该穿过。只测整块——形状块的子盒在棱接触时不封闭，
避免误判，交给主路径的 `IsHitBlock`。
**注意**：该补测只加在**阳光遮挡 DDA** 上（GI 主追踪/IRC/探针的 DDA 未动）；若以后发现
主 GI 也有同类缝漏，可照同一手法复制过去。
**待验证**：斜向贴着的方块（尤其形状块+整块混合）是否还有残留细缝；以及性能
（tie 步多 2~3 次 texelFetch，只在 3 步的短程 DDA 里）。

---

# 回归修复：非完整方块光源又变回「整格发光」（2026-10-02）

- 现象：火把/灯笼等非完整光源看起来像**整块方块**在发光（用户实测）。
- 原因：`VOXEL_GI_LIGHT_RADIUS` 在后续会话里被折中抬到 **0.8**（当时为修"走亮停暗"），
  0.8 半径在 1.0 的格子里几乎填满 ⇒ 光晕退化成"整个格子亮"。
  `VoxelHitLightSphere` 的 `mix(...,1.0,0.15)` 底保早已删除（2026-08-19），所以本次只有半径一项。
- 修复：代码 `VoxelLighting.glsl` + **`shaders.properties` 的 `profile.Default`** 同时回 **0.5**
  （profile 里也写着 0.8，只改代码默认会被 profile 覆盖回来——这类"同一选项三处写值"要一起改）。
- **教训（写进硬约束）**：`VOXEL_GI_LIGHT_RADIUS` 必须保持 **0.5（格内切球）**。
  命中率低引起的 1SPP 噪声/时域闪烁，要靠 `VOXEL_GI_BOOST`（默认 24）与时域累积解决，
  **不要再靠放大半径**——半径一过 0.5 就退化成"整格发光"，且会溢出相邻格。
- 顺带可见：用户 txt 里 `VOXEL_GI_BOOST=1.0`（默认 24.0）——若火把整体偏暗，先查这条
  （大概率是早前逐项归零排查时留下的）。

---

# 备忘：方块光「凭空发光」两处口径修复（2026-10-02 深夜）

## 现象（关掉天空光/阳光，只留方块光；用户实测）
- **没光源的情况下，斜着放两个方块，缝隙自己就开始发光** —— 是"凭空发光"，不是漏光。
- 有时还能看到「不存在的方块在遮挡光线」。
- 用户选项文件实测值（`Revelation-AD-edit.txt`）：GI_MODE=2、SKY/SUN/TRACE_SKY/TRACE_SUN 全 0、
  VOXEL_GI_DENOISE=false、**VISUALIZE_VOXELS=true**、VOXEL_GI_BOOST=1.0（默认 24）。

## 根因 1（主因）＝ 主 GI 的 DDA 缺 tie 接触格判定
阳光 DDA（`VoxelSunShadowTracing`）2026-10-02 早先已补过"多轴 tie → 回退侧格判整块遮挡"，
但**主 GI 追踪（`VoxelTracing.VoxelTracePixel`）与 IRC 注入（`VoxelGI.frag.IrcTraceVoxel`）
当时没同步**。两个方块斜向贴着时接触面积为 0，只剩一条零宽度的棱：DDA 在 tie 步直接跳到对角格，
中间侧格从不被采样 ⇒ 射线顺着这条缝穿过去。
**"凭空发光"的机理**：出界路径（`!hitSolid` / 循环走完）带 `VOXEL_NOLIGHT_BRIGHTNESS` 兜底底光，
命中路径在 return 前不带。于是无光源场景里"命中方块"的像素 = 0，而穿缝的射线一路走到出界 ⇒
唯一拿到底光 ⇒ 缝隙是整幅画面里唯一非零的地方（暗场 + 自动曝光再把它放大）⇒ 看起来就是缝自己发光。
> 教训：NOLIGHT 这类"兜底底光"在无光源场景会变成唯一光源，任何"该挡住却没挡住"的几何漏洞都会被
> 它点亮。所以排查"凭空发光"时要先查几何漏洞，而不是先动底光数值。

## 根因 2 ＝ `FetchVoxelRadianceTrilinear` 收整数坐标，插值退化
签名是 `(ivec3 c)`，函数体却写 `f = c + 0.5 → i = c → t`（恒为 0.5）：采样点落在 2×2×2 的
**格角**上 ⇒ 实际是「命中格 + 其 +X/+Y/+Z 八分体」8 格等权平均 = 半格偏移（还不对称）+ 2 格模糊，
且命中格自身辐射被稀释成 1/8。它唯一的调用点是自反弹（`VoxelTracing`），正是方块光链路的主干
⇒ 方块光会沿格边界/一格薄墙渗出来。
修法：改收**连续位置**（调用点传 `hitVoxelPos + vec3(cDi)`），先 `-0.5` 对齐纹素中心再插值；
格心处 t=0 ⇒ 命中格权重 1（不再稀释），平滑只发生在 ±半格内。
归一化变了 ⇒ `VOXEL_GI_SELF_BOUNCE` 默认 0.8 → **0.3**（近场最多亮 ~8×，平坦区几乎不变）。

## 本轮改动
| 文件 | 改动 |
|---|---|
| `lib/lighting/VoxelGI.glsl` | `FetchVoxelRadianceTrilinear` 改收连续位置 + 真三线性 |
| `lib/lighting/VoxelTracing.glsl` | 调用点传连续命中点；主 DDA 补 tie 接触格判定；**NOLIGHT 底光乘天光门控** |
| `program/gi/VoxelGI.frag` | `IrcTraceVoxel` 补同款 tie 判定；**NOLIGHT 底光乘曝光度门控** |
| `lib/lighting/VoxelLighting.glsl` | `VOXEL_GI_SELF_BOUNCE` 0.8 → 0.3 |

## 第二轮：tie 补测**没有**修掉现象 ⇒ 主因是 NOLIGHT 兜底底光
用户实测「不行」。回查 tie 判定的触发条件：`tracingNext = step(totalStep, vec3(rayLength))`
要**精确**浮点平局（两支的 totalStep 位相等）才成立，而两支只差一个恒定偏移（起点分数差），
所以 tie 在一般场景里本就极稀疏 ⇒ 它不可能是"每次都复现"的主因（补测留着，与阳光端同口径，
但别指望它治这个）。

真正对得上「无光源 + 凭空发光」的只有一处：**`VOXEL_NOLIGHT_BRIGHTNESS` 兜底底光**。
它字面就是"没有光源也加光"，而且**只加在出界路径上**（命中路径 `return` 前不带）：
- 暗场里它是唯一的非零加法项 ⇒ 被自动曝光（AUTO_EV_MAX=10，≈×1024）放大成可见辉光；
- "斜放两块"时，缝方向的射线走出界拿到它、旁边方块表面的射线全命中方块 ⇒ 0 ⇒
  缝是画面里唯一非零的位置 ⇒ 看起来就是缝自己发光。

修法（两端口径都收口，门控用各自可靠的天空可见度，**不用体素 vd.w 的写胜残留 skylight**）：
- 追踪端（每像素）：`smoothstep(0.03,0.15, 像素自身 skyLightmap)`（与 DeferredLight 最小
  环境光底同一口径）；
- 注入端（每体素）：`smoothstep(0.03,0.15, FetchPrevExposure(c+cDi))`（上一帧曝光度 =
  射线真实出界比例，封闭/暗室 ≈0）。
  ※ [2026-10-06 修编译错误] 这里原写成 `FetchPrevRadiance(c+cDi).a`：该函数返回 **vec3 辐照度**，
  没有 `.a` 分量 ⇒ Iris/NVIDIA 报 `C1031 swizzle mask element not present` + `C1068 array index
  out of bounds`（对 vec3 取第 4 个分量）。它只在 `GI_MODE == 2`（VXGI）分支里编译，所以直到
  把 GI_MODE 从 0 改成 2 才暴露。曝光度必须用同文件的 `FetchPrevExposure()`（读 voxelRadiance.a）。
代价：真正无天光的地方（暗室/洞穴）兜底底光归 0，会黑一些 —— 这正是"不凭空发光"的代价，
而且与本项目最小环境光底早已采用的 lightmap 门控方向一致。

## 未做 / 待验证
- 探针端（GI_MODE=3）的 `ProbeTrace` DDA 未加 tie 判定（当前不用；要用时照抄）。
- 「隐形挡光」本轮**未找到确证**：把 block.properties 全部材质 ID 分过组，非发光、非形状、
  非透明的只有 33/34/37/38/46/50；其中 33（weeping_vines / crimson_fungus / chorus_*）与
  34（brewing_stand / *_candle_cake）是薄方块，但它们走 **CUTOUT 层** ⇒ 被 `Shadow.geom` 的
  渲染层门限排除、**根本没进体素**（是"漏"不是"挡"）。若该现象仍复现，先按方块类型确认它走哪个
  渲染层，再决定是补形状子盒还是补渲染层放行。
- **`VISUALIZE_VOXELS=true` 是调试开关**：`Terrain.frag` 会把每格反照率换成"体素格里的图集中心色"，
  且与本帧写入存在读写竞争、用 `ivec3(pos)` 截断又没有内偏移 ⇒ 排查观感问题前先确认它是关的，
  否则看到的画面自带一层调试假象。

---

# 排查备忘录：体素"幻影格"根因——VS 剔除后 return，GS 读未定义值（2026-10-07）

## 结论（一句话）
`Shadow.vert` 里所有「把顶点踢到 NDC 角点后 `return`」的剔除路径（背面剔除 /
`SHADOW_CULL_UNDERGROUND` / `blockEntityId==10030`）会让 `texCoord`、`vectorData`、
`g_voxelCoord`、`g_voxelCoordBase`、`g_voxelID`、`g_mcLightLevel`、`g_posInvalid`
**全部保持"未写入"状态（GLSL 未定义值，实测表现为寄存器残留）**；而 `Shadow.geom` 的体素分支
**完全不看 `gl_Position`**，只按这些输出算格坐标并 `imageStore` ⇒ **每个被剔除的面都会往体素网格里
写一个"幻影体素"**。这就是上一节「未做/待验证」里那条"隐形挡光找不到确证"的答案，也是
黑格 / 蓝格 / 紫格 / "挡光↔不挡光疯狂切换" / 贴着墙角漏光的唯一来源（写入路径本身是确定的：
VoxelClear 每帧清空 + 体素瓦片 1 格 1 纹素精确光栅化，除此之外没有任何随机性）。

## 三种残留值分别对应已观测到的现象
| 残留内容 | 写进 voxelData 的结果 | 观测现象 |
|---|---|---|
| 未写入的 `texCoord`（UV 落到图集透明处） | `z>0.5` 但反照率 (0,0,0) | **黑色体素**：挡光但不反弹（"在挡光空气处放个方块就是黑的"） |
| 未写入的 `g_voxelID` = 负数（上一个顶点是水/玻璃/树叶） | `z<0` | **蓝色体素**：被当透明格吸收 |
| 未写入的 `g_voxelID` = 0（或残留坐标落到别处） | `z=0` | **紫色体素**；且把该格真记录**清成空气** ⇒ **贴着墙角/天花板漏光** |

幻影写入与合法写入同帧抢写（`voxelData` 是 `imageStore` 写胜），胜负随绘制顺序变 ⇒
同一格逐帧在"有数据 / 空气"之间跳 = 用户看到的"可以挡光和不可挡光之间疯狂切换"。

> **实测结论（2026-10-07，用户）：现象消失，本根因成立。** 三处改动都不动体素覆盖策略，
> 因此没有任何观感回归；只有"幻影格"本身不见了。

## 修法（三处，都不改变体素覆盖策略，因此无观感回归）
1. `program/shadow/Shadow.vert`：新增 `flat out float g_culled;`，`main` 入口先置 0，
   **每条"踢顶点 + return"的路径在 return 之前置 1**。
2. `program/shadow/Shadow.geom`：新增 `flat in float g_culled[]`（声明放在
   `#ifdef ENABLE_VOXELIZATION` **外面**——体素化关闭时真阴影分支同样需要它），两条分支各自
   在最前面 `if (g_culled[0] + g_culled[1] + g_culled[2] > 0.5) return;`：
   只要有一个顶点被剔除就整三角形不发射。
   - 与旧行为逐位对齐：MC 方块面三顶点法线相同 ⇒ 旧实现是三顶点一起被踢到 NDC 角点 → 零面积 → 丢弃；
   - 顺带修掉旧实现在**混合法线**三角形上"把一条边拉到 NDC 角点、带着未定义 varying 铺满阴影区"
     的垃圾三角形（smooth 法线模型/部分模组模型会踩到）。
3. `program/shadow/Shadow.frag`：不变量防御 `if (abs(v_voxelID) < 0.5) return;`。
   合法路径**不可能**写出 ID 0（`materialID = max(mc_Entity.x - 1e4, 1) ≥ 1`，透明取负），
   所以写出 0 必然是垃圾；宁可不写，也不允许用空值覆盖真值（覆盖 = 直接制造漏光）。

## 已修 / 实测通过
- **覆盖缺口（2026-10-07 已修 + 用户实测通过）**：体素分支原先只发"三顶点都朝光源"的三角形 ⇒
  若某方块的**全部**已网格化暴露面都背对光源（天花板底面、多层墙内侧、被相邻方块盖住的墙角），
  该格**永远没有体素** ⇒ 该格是空气 ⇒ GI 射线不在那一层停下、穿过去打到迎光外层
  （那层 `skylight=15`、`sunVis=1`）⇒ **室内被算成受直射的反弹面 = 室内漏光**。
  多层墙是"逐层依赖"的：N 格厚的墙在体素里只剩 1 格厚；用户实测表现正是
  "品红格总以三格长条为一组、三格之间互相影响"（拆/放一层会改变其余层的暴露面）。
  修法：`Shadow.vert` 新增 `flat out float g_backFace`（背光顶点在体素化开启时**不再早退**，
  照常把体素输出算完），`Shadow.geom` 里**真阴影分支**用 `backAny` 丢弃背光三角形
  （阴影观感与旧版逐位一致）、**体素分支照写**。
  代价（用户实测裁定："不得不付"）：GS 体素三角形量约翻倍 + 背光顶点不再省那段 ALU。
  附带效果：同格"写胜"竞争面变多，被遮挡格可能取到背光面的 `sky=0` ⇒ 阳光反弹门控关掉
  ⇒ 室内更不发光（方向正确）。若日后出现"走动时墙面某格忽明忽暗"，需把背光面改成
  "只在空格时才填"（read-modify-write，`voxelData` 要去掉 `writeonly`）。

## 未做 / 待验证
- `VOXEL_GI_DENOISE=false` 时 `DeferredLight` 直接读半分辨率棋盘信号（未降噪，选项说明里就写着
  "较闪烁"），1 SPP 噪声在 1m 体素网格上就是"格子大小、逐帧变"的斑块 ⇒ 排查"闪烁"类观感问题
  前先确认这个开关与 `VOXEL_TRACE_SPP`。
- 调试口径（2026-10-07 已改）：`VISUALIZE_VOXELS` 与 `DEBUG_VOXEL_GI` 统一色标——
  品红 `z==0` 真空气 / 蓝 `z<0` 透明格（有数据且吸收）/ 原色 = 固体格真实反照率 /
  偏黄 = 形状块格（吃 `HitShape` 子盒）；画面仍是方块自身纹理 = 该格在 64³ 网格之外。
  旧口径把"透明格"画成方块原色、并和真空气同画蓝色，是把水/玻璃/树叶读成"漏写"的直接原因。
- `HitShape`（`lib/lighting/VoxelShape.glsl`）末尾 `return hit;` 且 `hit` 初值 false ⇒
  **155-294 里凡是没有对应分支的 vID，一律按"不命中"返回（光线直接穿过去 = 确定性漏光）**。
  该区间很宽（含 farmland/dirt_path/cauldron/hopper/scaffolding/anvil/stonecutter/composter/
  end_portal_frame 等非形状块），值得对照 `block.properties` 10155-10294 逐条核一遍。

# 备忘：SSR/SSRT 反射审查 + 确定缺陷修复（2026-10-08）

## 结论（一句话）
反射链的算法骨架（线性屏幕空间步进 + 二分 + 上一帧重投影取光）与 MC 圈同类实现（Photon）一致，
不是落后方案；但读码查出 **5 处确定性缺陷**（2 处纯浪费、1 处坐标错误、1 处死代码、1 处厚度判据失控）
和 **1 处高度可疑的整趟白做 pass（deferred21）**，另有 `TODO.md #0` 反射拖影的架构性根因
（反射没有自己的运动向量）。完整审查（含文献与验证状态）见 `docs/SSR_REVIEW_2026-10-08.md`。

## 谁在跑（装配层事实，供以后排查直接引用）
- `world0/deferred1.csh` = `ReprojectScene.comp`：`workGroupsRender 0.5` + `loadDepth0(texelPos << 1)`
  ⇒ **colortex4 左上象限 = 半分辨率重投影场景历史**（反射的取样源；`texture(colortex4, uv*0.5)` 因此是**对的**）。
- `world0/deferred20.fsh` = `DeferredLight.frag:947`：**唯一可见**的反射，门槛
  `material.metalness >= 0.5 || materialID == 10050u`。
- `world0/deferred21.fsh` = `specular/SpecularIndirect.frag`：跑第二趟 SSR 写 colortex3（`RENDERTARGETS: 3`），
  **无 `.enabled` 规则 ⇒ 默认开**。
- `world0/composite4.csh` = `Translucent.comp`：自带**另一份** `rayTraceScene`，对**所有**像素
  `imageStore(colorimg3)` 覆盖 colortex3；`composite4.fsh` = `IntegrateScene.frag:317` 才把 colortex3
  当 specular 项合成。⇒ 见"待实测"第 1 条。
- `deferred30/31/32` 已显式关闭（`shaders.properties:1091-1099`），`SpecularFilter()` 本身是空 no-op
  ⇒ **反射目前没有任何专用降噪器**，只靠 TAA。

## 本轮已改（纯缺陷修复，工作区改动，**待实测**；尚未提交）
- `SSRT.glsl`：
  1. **推进量改为每轮必加**（对照开关 `SSRT_STALL_FIX`，默认 1）。原来只在"射线在表面前方"时推进 `t`；
     厚度测试失败（已穿过该表面但超容差）时既不 break 也不推进 ⇒ 同一个 `rayPos` 被重复评估，
     剩余迭代全部空转（最多 steps-1 次全分辨率深度读取白付），且该射线**此后永远找不到命中**
     （薄遮挡后面的交点被跳过）。已穿过的分支现按**名义步长**继续（普通 march 行为，避免 1% 下限那种爬行）。
  2. ~~同像素重复采样跳过深度读取~~ **已实测回退**（用户实测"近景反射有时出现条纹"）：本 march 的
     推进量**依赖刚读到的深度**（`advance = clamp(深度差/|dirZ|, ...)`），跳过读取就换了轨迹，
     大步长时会跨过薄表面（掠射角最明显）。jiaozi158 能这么做是因为它用**固定世界空间步长**
     （`for` 自增），读取与否不影响轨迹。
  3. ~~厚度容差加固定绝对上限 1.5 格~~ **已实测回退**（用户实测"远景反射质量下降"）：相对判据
     `0.2×|视深|` 是**随距离缩放**的，正对应"远处每步的深度跨度更大"；拍平会把远处**合法**命中判负，
     再叠加第 1) 条（射线不再空转）就变成看得见的漏反射。现改为默认关闭的可选上限
     `SSRT_MAX_THICKNESS = 0.0`（0 = 与原实现逐位一致）。正确修法：容差与**每步深度跨度**成比例，
     或 `GI_MODE >= 2` 时用 `voxelData` 占用网格对候选命中点做几何二次验证（本包独有优势）。
  4. **命中点按深度差线性插值**（`SSRT_HIT_INTERPOLATION`，默认 1，**保留待复测**）：在"前一点
     （表面前方，差>0）"与"当前点（表面后方，差<0）"之间插值出深度差为零的位置，作为二分细化的
     起点，替代"跨过表面的那格中心"。只影响命中点位置、不改变命中与否，与上面两处观感回归无关。

  5. **厚度容差下限** `SSRT_THICK_FLOOR`（默认 1.0，×本步视深跨度）：回退 2、3 之后用户复测仍是
     "**近景有条纹、且条纹匀速移动**" ⇒ 定位为"离散格点 + 每帧抖相位（STBN）+ **二元**命中判定
     `|Δ视深| < 0.2×|视深|`"的带状伪影：近景一步跨过的视深与阈值同量级（短射线 12 步 ≈ 0.4 格/步，
     z≈2 时阈值 ≈0.4 格）⇒ 相位一挪接受/拒绝就翻转（条纹），STBN 时域轴每帧推进一格 ⇒ 匀速滚动，
     TAA 用表面运动矢量收敛不掉（TODO #0）。修法：容差下限取"一步的跨度"，使一步之内的合法穿越
     恒被接受 ⇒ 判定与相位无关；大跨距的异常穿越（射线早已深穿背面）仍被拒。**与上限方向相反：
     上限（拍平远处）错、下限（覆盖近处一步）对。** 本仓同类先例：`VoxelTracing.glsl:99-103`
     记的"STBN 空间 tile 整齐密集斑纹"及 Cranley–Patterson 平移（备选手段）。

## 实测回归记录（2026-10-08，一次）
第一次落地时把两处"顺手的性能优化"和缺陷修复混在同一个补丁里 ⇒ 用户实测出现两类回归（见上 2、3），
无法归因，只能整批回退重来。**教训**：此后每条新改动都带独立对照开关（或独立提交），先 A/B 再收口。

- `Reflection.glsl`：
  5. **半坐标 bug**：`uvToTexel(hitCoord*0.5)` 去索引**全分辨率** `depthtex0`，
     `ScreenToViewPos(vec3(hitCoord*0.5, ...))` 的 ndc = `hitCoord-1 ∈ [-1,0]` 只对屏幕左上象限成立
     ⇒ `reflectionDist` 全错（`*0.5` 只该用于 colortex4 象限画布）。已改为 `hitCoord`（并 clamp 到
     `1 - viewPixelSize` 防越界）。
  6. 删除恒不成立的 `if (dot(worldNormal, skyLightDir) < EPS) return`（`skyLightDir` 与 `ssrRayDir`
     是同一向量，`dot(N,R) = NdotV > 0`），及其误导性注释。

## 待实测 / 未做
- **deferred21 是否整趟白做**：临时在 `shaders.properties` 加
  `program.world{0,-1,1}/deferred21.enabled = false`，画面若完全一致 ⇒ 该 pass 与其 fragment
  应删除；若有差异 ⇒ 反向处理（让 `Translucent.comp` 只写 colortex0）。两种情形下都有一整趟
  全屏 SSR 是白跑的。
- **修复 1 会改变部分反射结果**（原本因空转而不出现的命中会开始出现）：需实测是否引入"穿透薄墙"的观感。
- `edgeFade` 实际是硬边（`*= 1e2 + ...` 让中景恒饱和）+ `REFLECTION_SKY`/`SSRT_SKY_TRACING`/`TRANSLUCENT_SKY_REF`
  默认全关 ⇒ trace 失败即黑、金属 miss 被 `DeferredLight.frag:959-961` 当非金属。**修法必须等
  "miss 回退到预过滤天空/环境"到位**，否则单纯把边缘淡出改软只会让黑边更宽。
- 粗糙反射模糊半径 `roughness²×0.04×20`（`Reflection.glsl:244`）：roughness 0.5 即 0.2 画布 UV、
  0.9 即 0.65 再被 clamp 到 0.499 ⇒ 等于取半分辨率历史平均，不是 GGX 叶瓣。修法见审查文档 §四 P0。
- `Translucent.comp` 与 `Reflection.glsl` 的两份 `rayTraceScene` / `CalculateSpecularReflections` 已漂移
  （后者注释还写着"mode 2 default"而实际默认 1），建议把公共部分收回 `lib/surface/SSRT.glsl`。
- 死选项：`SSPT_ENABLED`（全仓无引用）、`SSPT_BLENDED_LIMBMAP` 的 lang 文案
  （"屏幕空间路径追踪结果与原版光照贴图混合"）证明本包历史上做过 **voxagon 式 SSPT 漫反射 GI**，
  后被 SSILVB/VXGI/IRC 取代 ⇒ 三个 `SSPT_*` 选项可直接清。

## 避免误引（文献核查结论）
- **SSPT 是 2018 年博客技术名，不是论文**：Dennis Gustafsson (Voxagon) 2018-01-03
  《Screen Space Path Tracing – Diffuse》+ 前置《A better depth buffer for raymarching》(2017-11-22)。
  Luksch et al. 2014《Real-Time Rendering of Glossy Materials with Regular Sampling》是环境贴图 MIP 过滤，
  **不是 SSPT 出处**；Ray Tracing Gems/RTG2 **没有** SSPT 章节。事实标准实现 = jiaozi158
  *UnitySSPathTracingURP*。
- **McGuire & Mara 2014 = 透视校正 2D DDA，不是 Hi-Z**（`SSRT.glsl` 顶部引了它但实现是线性步进；
  Hi-Z 是后续工业实践，本包 `6ac5ce9d` 试过、`efa5ff94` 因 CAS 下重编报 preprocess 失败而回退，
  **不是算法本身的问题**）。
- 查无此文，不要引：「Karis/Chen 2021 Reflection reprojection with implicit ray」、
  「NVIDIA specular denoising with the ratio estimator」（应写为 NRD/ReBLUR 的 pdf 加权与比值形式）。

