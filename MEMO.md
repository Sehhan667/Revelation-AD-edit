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
  （SEUS PTGI 同款：有限步数后取天空）。

## 本会话其他已提交项（供复盘）
- `167ccac` IRC 缓存三线性读取（参考 SEUS PTGI GFME）：`FetchVoxelRadianceTrilinear`
  8-tap 三线性采样，消除 1m 体素块状/表面冲突；越界时 itrp 同款
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
（itrp 同样是体素级小球，不保留形状）。对齐 itrp 的关键是两个参数，之前都偏大/带底：
| | 半径 | 底保 |
|---|---|---|
| itrp | 0.5（格内切球） | 无（擦边/未命中=0） |
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
- **未完成/已知方向**：逐像素 PBR 发光（对齐 itrp 的 LABPBR_EMISSIVENESS）本轮未做。
  要做需恢复 Shadow.frag 存 texRes+midCoord（当前固体块 w/xy 被染色 albedo 占用），
  采样 atlasSpecular2D 的 emissive 通道；代价是 64³ 下"光源印子"风险（当初砍掉逐纹素的原因）。



