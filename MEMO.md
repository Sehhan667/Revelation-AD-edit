#一些规范（未来逐渐添加）
不要在文件里写昂长冗余的注释，有必要写简单明了的注释即可。修改记录写在提交里即可，如有要点记入本文件
工作时遇到以前留下的冗余注释顺手清理掉，不用特意找
代码要考虑可维护性，不能写出只有ai自己才能看懂的代码
提交时如无说明，只提交shader本体文件夹，其他文件不进仓库
校验规则：凡是只能靠肉眼看结论的项（拖影/渗色/斑点/滑条单调等），代码与数值只能证明"实现符合意图"，清单里必须标 `⏳` 并写明实机怎么看，**主人确认后才允许改 `✅`**。不要用"我检查过代码"替代实机确认。






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

## 后续改动（同日，工作区未提交，待实测）
  6. **环境回退** `SSR_ENV_FALLBACK`（`Reflection.glsl`，默认 0 = 行为不变；实机选项文件里已置 1）：
     trace miss（射线出屏/命中校验失败）时给反射兜底环境色，解决"屏幕边缘反射变黑"与
     "金属 miss 被 `DeferredLight.frag:959-961` 当非金属着色（金属变塑料）"。
     回退色 = `mix(skyMapTex 锐利环境, ConvolvedReconstructSH3(global.skySH, N), roughness²)`
     × `smoothstep(0.3,0.7,skylight)` × `REFLECTION_FALLBACK_BRIGHTNESS`
     —— colortex5 **没有 mip 链**，所以用"锐利 ↔ 余弦卷积 SH"插值当廉价 split-sum。
     与 `REFLECTION_SKY` 互斥（后者优先，它是用户的审美开关）。
     **配套要点**：仅环境回退时必须返回**有限** `reflectionDist`，否则消费端
     `reflectHit` 判 false，回退色算了也用不上（原 `.a = FP16_MAX` 是"无 SSR 命中"哨兵）。
  7. ~~**对照开关** `SSRT_DITHER_CP`（`SSRT.glsl`/`Reflection.glsl`，默认 0）~~：给射线起点抖动加
     per-pixel 固定平移（Cranley–Patterson），破坏 STBN 空间 tile 的整齐条纹；抄自本仓
     `VoxelTracing.glsl:99-103` 的既有先例。用于追残余闪烁条纹（用户暂缓该问题）⇒ **代码已从工作区
     撤回**，配方留档：`ssrDither = fract(SampleStbnVec2(pixel, frameCounter).x
     + fract(sin(pixel.x*0.1591549)*43758.5453 + sin(pixel.y*0.1591549)*78.233))`。

## 用户裁定不需要（同日撤回）
  6. ~~**环境回退** `SSR_ENV_FALLBACK`（`Reflection.glsl`）~~：trace miss 时用
     `mix(skyMapTex 锐利环境, ConvolvedReconstructSH3(global.skySH, N), roughness²)` 兜底，
     解决"屏幕边缘反射变黑 / 金属 miss 被当非金属（变塑料）"。
     **用户裁定"原本这方面我已经满足了"** —— 他的 `SSRT_SKY_TRACING=true` + `TRANSLUCENT_SKY_REF=true`
     已覆盖绝大多数 miss（屏幕内天空命中即命中），实测"看不出变化"也印证覆盖面很窄。
     代码与选项文件均已撤回。**但实现要点留档**（将来做随机采样反射/半分辨率追踪时 miss 率大涨，
     这个兜底会重新必要）：仅有环境回退时必须返回**有限** `reflectionDist`，否则消费端
     `reflectHit = (reflection.a < FP16_MAX && ...)`（`DeferredLight.frag:948`）判 false ⇒ 回退色白算。

## 未验证的前提（以后做 A/B 前先钉死）
- **不在任何 `screen.*` 列表里的选项，从 `Revelation-AD-edit.txt` 设定后是否真的生效？** 本轮新加的开关
  （`SSRT_THICK_FLOOR`/`SSRT_HIT_INTERPOLATION`/`SSRT_STALL_FIX`/`SSRT_DITHER_CP`/`SSR_ENV_FALLBACK`）
  全属这一类；"打开环境回退看不出变化"当时无法区分"机制不生效"与"没有覆盖像素"。
  ⇒ **规则：凡是要 A/B 的开关，一律按本仓"选项四件套"（settings / properties / lang×2 / profile）
  接进 GUI，否则对照实验不可信。** 已知的另一条 Iris 行为：选项文件只写回**与源码默认值不同**的项
  （等于默认值的会被清掉）。

## 已尝试并撤回（同日，用户裁定）
  8. **反光面空间的反射模糊（S2，两趟 pass）—— 失败并整体停用（2026-10-08）**。
     目标：把"反射物体的轮廓"真正糊掉。根因分析（保留，价值高）：单条镜面射线的**命中映射**在轮廓处是
     **跳变**的，而源空间模糊的等效半径在反光面上要除以 |dh/dp|（近距离反射该斜率很大）⇒
     源空间怎么糊都"内部摊平、轮廓照旧"。只有**在反光面自身的屏幕空间**滤波（或每像素多方向采样）才行。
     试过并全部失败的三条写出路径：① 片元 pass 里 `imageStore` 写半分辨率缓冲（读回来是空的）；
     ② 全分辨率 MRT 第二输出 + compute 两趟模糊（用户实测仍"清晰"）；③ 用布尔选项做 pass 门控
     （无法确认门控是否生效）。另外踩到的自伤：在**写的同一 pass 里采样**该缓冲（`writeonly` 图像）
     ⇒ 诊断色变黑、"无颜色无反射"。
     现状：`colortex11/21/22`、三个采样器、`program/specular/ReflectionBlur.comp`、三个 world 的
     `deferred30/31.csh` 全部**保留但停用**（pass 规则 = false，选项 `ROUGH_REFLECTION_SS_BLUR` 不再设置）。
     粗糙反射回到"单射线 + 源空间模糊"（`ROUGH_REFLECTION_PULL` 路径）—— 用户裁定：
     "除了有时能看到边缘外没有缺点"。清理这些停用件时，参考本条记录。

## 工具纪律（本轮新增）
- **`shaders.properties` 一律用编辑工具改，不要用 shell 重写**：`pwsh Set-Content -Encoding utf8`
  会写入 BOM（本仓要求 properties 纯 ASCII/无 BOM），本轮踩过一次，已用
  `[IO.File]::WriteAllText($p,$t,UTF8Encoding($false))` 修复。若必须用 shell，就用这个 .NET 写法并当场校验 BOM/非 ASCII 计数。

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

---

# 备忘：TAA 评审与收口（2026-10-15）

- **结构**：`program/post/TemporalAA.frag` 两个模式。0 质量（Playdead YCoCg + 方差裁切）吃
  `TAA_MAX_ACCUM_FRAMES` / `TAA_CLIPPING` / `TAA_AGGRESSION` / `TAA_ANTIFLICKER` / `TAA_SHARPEN`；
  1 性能（MakeUp RGB 凸包）只吃 `TAA_HISTORY_WEIGHT`。默认档是 1（`profile.Default`），质量模式专属
  旋钮已在 lang 标「仅质量模式生效」。
- **运动矢量只有相机运动**（深度 + 相机矩阵重投影），全仓没有速度缓冲。**实体/粒子/手臂拿不到
  「上一帧模型矩阵」**（Iris 只暴露相机的 `gbufferPrevious*`）⇒ 那类只能靠 `TAA_CLOSEST_FRAGMENT`
  （已默认开）和邻域夹逼兜底，不要再尝试给实体做速度矢量。植物/水面本可解析重算上一帧位移
  （`Terrain.vert` 的 `frameTimeCounter * WAVING_FOLIAGE_SPEED`、`WaterWave.glsl` 的 `waveTime`
  都能用 `frameTimeCounter - frameTime` 重算），本次裁定不做。
- **运动降权必须用像素单位**：`length((prevCoord - screenCoord) * viewSize)`。UV 单位下
  `* 10.0 * 0.02` 只有万分之几的权重变化，等于没有抗拖影（从上游继承的坑）。该段不再由
  `MOTION_BLUR` 门控 —— 关掉动态模糊不该关掉 TAA 的抗拖影。
- 性能模式的历史权重是 `TAA_HISTORY_WEIGHT`（0.9 = 当前帧占 10%，即原写死值），越大越干净、拖影
  越长；质量模式的 `TAA_MAX_ACCUM_FRAMES` 在性能模式无效，别去拖它。
- 历史按**未抖动网格**取（不加 `taaJitterPrev`），而 `Accumulate.frag` 用的是加 `taaJitterPrev` 的
  写法。两种读法都自洽、只差 <0.5 像素，谁更干净要实测 —— 本次裁定不做。
- 没有接 `historyReset`；`/time set`、切维度后靠凸包夹逼兜底（本次裁定不做）。
- 反射拖影（`TODO.md` #0）没有专用降噪器，只靠 TAA；运动降权的单位修复对它直接有效。
- 完整评审（证据、被否决方案、A/B 验法）在历史提交 `73fc196a` 的
  `docs/TAA_REVIEW_2026-10-15.md`，已按规范 4 移出仓库。

---

# 备忘：反射自激爆亮（2026-10-15）

- **现象**：掠射看水面/冰面/湿地面时反射面"左脚踩右脚"式发白爆表。
- **根因**：反射源 `colortex4` 是**上一帧已含反射**的画面（`ReprojectScene` ← `colortex1`），而
  `DeferredLight` 对电介质走**加算**合成，权重 = `min(F,0.5) × NONMETAL_REFLECTION_BRIGHTNESS(2.5)`
  最高 **1.25** ⇒ 回路增益 ≥1、发散（NdotV ≤ 0.22，入射角 ≳77°）；0.22~0.5 增益 0.5~1.0 ⇒ 放大 2~∞ 倍。
  水/玻璃的 `F²` 形式（Translucent）与金属的 `REFLECTION_METAL_MIX=0.9` 都严格 <1，**不是**爆表来源。
- **已修**：`REFLECTION_LOOP_WEIGHT_MAX = 0.85` 封顶（`Reflection.glsl`，按增强倍率预先折算）。
  对照验证：把它临时改成 1.25，爆表应复现。**2026-10-15 用户实测确认观感 OK**。
- **未做**（按优先级）：
  1. **自相交（反射面命中自身）——用户裁定先不处理（2026-10-15），已记入 `TODO.md #7`**。
     `SSRT_THICK_FLOOR=1.0`（容差 ≥ 一步跨度）与 `REFLECTION_NORMAL_BIAS=0.0`（起点不偏置）叠加，
     且没有自相交拒绝；封顶只让回路收敛，"镜子照自己"的观感仍在。判据可用现成的 `reflectionDist`。
  2. `colortex4` 左上象限与泛光 L0 共用，`ReprojectScene` 不写"重投影出屏"的纹素、TAA 清屏又在 SSR
     消费之后 ⇒ 相机移动时反射会采到上一帧泛光（反射面移动时发亮）。
  3. `metalness 0.1~0.5` 走加算那条（画布权重≈1.0）增益≈1.0，边际，未一起封顶。


# 备忘：GI 时域累积"运动满天星"（2026-11-07，已修）

## 现象与分诊
用户报告"画面稳定后一动就乱"，逐次缩小到决定性事实：
- 只 A/D 横移：稳定；
- W/S 前后移动：满天星；
- 转动视角：满天星；
- 全分辨率模式只是把噪点变细，不消失（⇒ 与分辨率/上采样无关）。

## 真因
`Accumulate.frag` 的历史几何检查拿**本帧视深**和**上一帧视深**比：

    distance(encodedNormalDepth.z, sampleAux.z)   // 本帧 z  vs  上一帧该 tap 的 z

视深 z ∝ 距离 × cosθ，**不是运动不变量**。同一世界点在相机运动后 z 就会变：
20 格处转 2° 变 0.7 格、转 5° 变 1.7 格，而判据阈值只有 8/|z| = 0.4。
⇒ tapGeo 掉到 0.7/0.3 ⇒ maxGeometryWeight 骤降 ⇒ 累积帧数 a = 1/(1-w) 塌到 1~2
⇒ 画布退回单帧样本 ⇒ 每像素独立噪点（满天星）。
A/D 横移垂直于视线、z 几乎不变，所以只有它表现正常。

## 修法（两行）
与 `prevViewPos.z` 比 —— 它是**本像素世界点在上一帧的视深**（重投影结果），与 `sampleAux.z`
同属"上一帧视空间"，任意相机运动下都是同帧口径：

    float invThresholdZ = 8.0 / prevViewPos.z;
    float tapGeo = saturate(fma(distance(prevViewPos.z, sampleAux.z), invThresholdZ, 1.0));

静止时 `prevViewPos.z == viewPos.z == encodedNormalDepth.z` ⇒ 行为逐位不变。

## 通用教训（比这个 bug 更值钱）
1. **跨帧比较必须"同帧、同空间"**：视深/屏幕坐标/视空间位置都是运动相关的量；只有
   "同一帧的同一空间里的两个同类量"才能直接比。要跨帧比，先把两边都换算到同一帧。
2. **先做读数，再改代码**：本例只要把「累积帧数 a」可视化出来，一眼就能看到"运动时 a 掉到 1"。
   绕的弯路（方差精度、采样几何、引导量相位、累积衰减公式）都是先动手后测量的代价。
   ⇒ 已加 `DEBUG_GI_ACCUM_STATS`（GUI 调试页）：R=a/上限、G=本帧是否判不可靠。
3. **一阶衰减复发式 `a = a*w + 1` 对 w 极敏感**：稳态 a = 1/(1-w)，w=0.98→50 帧、0.95→20、
   0.90→10。任何"轻微不匹配"都会被放大成"累积骤降"。看这类代码时要先算稳态。
4. **别用开关给 bug 打补丁**：本轮先加了 STABLE_GUIDE / ROBUST_ACCUM，只是掩盖症状，
   根因修好后立刻删掉（留着会误导下一次排查）。

# 备忘：ReBLUR 对照官方收口（2026-11-10）

对照 NRD v4.11.4 的 ReBLUR 源码/README，修了四处口径，并纠正一条误判。

## Iris 缓冲 flip 的真实语义（先记住，能省很多排查）

- **deferred/composite 的片元程序默认 flip**：读 main、写 alt，pass 结束交换。
  所以在 `Accumulate.frag`（deferred4）里读自己写的 `colortex2/14/21` **不是 UB**，
  "读自己 RT 导致拉丝"的旧结论只适用于 compute pass。
- **compute pass 不触发 flip**（Iris 文档明说），且 `colorimgN` 绑定的就是 main。
  所以 compute 里"imageLoad 邻居 + imageStore 自己"是**真竞态**。EAWF ×4 已改成
  `colortex3 ↔ colortex25` 乒乓（pass0/2 写 25，pass1/3 写 3，最终结果回到 3）。
- Iris ≥1.10.5 支持 colortex0–31，新增 25 号缓冲不需要动别的。

## 官方 ReBLUR 的最终输出是稳定化结果

- 官方 pass 顺序：PrePass → TemporalAccumulation → HistoryFix → Blur → PostBlur →
  Copy → TemporalStabilization。`maxStabilizedFrameNum=63` 时 TS 是最后一级视觉 pass，
  COPY 只在 rect 变化时搬历史；Blur **不读** stabilized（v4.11 不自引导）。
- 因此 `DeferredLight` 在 NRD 模式下改读 `colortex23`（稳定化），不再读 `colortex3`
  （空间滤波输出）。这是"静止小闪"的直接来源——滤波输出本身不保证时间平滑。
- 主历史只累积**输入信号**；空间滤波结果不写回（GIHistoryStore 默认 `_wb=0`，
  `GI_BISECT bit1` 保留旧 0.6 做 A/B）。0.6 回写会让空间核逐帧复合、细节被抹平。
- 官方 TS 的三件套：surface motion 重投影 + 邻域 σ 颜色盒 clamp + antilag；
  帧数上限要被 `maxAccumulatedFrameNum` 夹住。我们至少补了重投影与 clamp。

## 半分辨率画布不要逐帧轮转 2x2

官方 README：quarter-res 去噪用 `pixelPos/2`，rotated grid（每帧换 2x2 内的像素）
会显著提高 non-noisy 输入的熵、增加 disocclusion。`GI_CANVAS_PHASE`（现在在
`lib/utility/Offset.glsl`）固定为 `ivec2(0)`；旧的 4 帧轮转会让轮廓/台阶处
历史判据周期性失配，形成"四帧一循环"的边缘闪。

## 其他

- prepass 的法线必须取**本帧** G-buffer（`FetchSurfaceNormal(tapScreen)`），不能用
  `colortex14`（上一帧）；判据用官方 planeDistanceSensitivity=0.02 / lobeAngleFraction=0.15，
  命中距离要随颜色一起加权平均，否则 `minHitDistanceWeight` 是噪声。
- `scripts/preproc_check.js` 不认识 `settings.glsl`（它先替换标识符再处理 `defined`，
  `#if !defined INCLUDE_SETTINGS` 被判 false，整个文件被跳过）。新宏放 settings 里会误报
  "未定义"；放在 `lib/utility/Offset.glsl` 之类的 lib 文件即可被识别。

# 备忘：ReBLUR 对照 NRD v4.11.4 源码收口（2026-11-10，全部未实机验证）

## 三条源头结论（纠正此前的错误推断）

1. **NRD 不负责追踪**。它是纯降噪库，`denoiserResolutionScale` 只描述输入分辨率。
   "官方全分辨率追踪 + 半分辨率降噪"是错误说法；半分辨率追踪 + 半分辨率降噪 + 上采样
   就是常规集成方式，和我们一样。半分辨率唯一的固有代价是同样屏幕覆盖下样本数 1/4。
2. **ReBLUR 有 antilag**。`REBLUR_TemporalStabilization.hlsli:257` 调 `ComputeAntilag(...)`，
   注释写着 `// this is important`。之前按"配置项名"（`gAntilagSettings`）搜索才误判为
   只有 RELAX 有；ReBLUR 是直接调函数、常量在函数内部。**TS 的 antilag 必须保留。**
3. **官方 TS 最终混合**：`lerp(diff, smbDiffHistory, min(diffHistoryWeight, gStabilizationStrength))`，
   `diffHistoryWeight = getTemporalAccumulationParams(smbFootprintQuality, framesAccumulated)`，
   颜色盒 σ 随权重放宽。我们的结构与之逐行对应。

## 官方 firefly suppressor（此前写反方向，已按源码重写）

```
maxRel = 2.0 + 38.0 / (accumSpeed + 1.0)
amount = saturate(accumSpeed * maxBlurRadius * 0.1)
luma   = lerp(luma(result), min(luma(result), luma(history) * maxRel), amount)
```

判据是**混合结果相对历史过亮**，压的是本帧 1spp 的离群亮点，写在 TA 里。
不是"用邻域 min 压历史"（那是之前的错误实现，已删）。

## 已对齐的项（提交 a6616d45 → e6b7b7d2，均在 shaders/ 内）

- prepass：Poisson 盘 32 样本、半径 30 **画布纹素**（官方 30 是按降噪分辨率定义的，
  半分辨率下 = 60 屏幕像素；此前按全分辨率口径只给了 15，少一半）、平面判据用
  **几何法线**（含贴图的表面法线只用于瓣角判据）、命中距离加权平均 + Denanify、
  天空早退。
- hitDist：`colortex26` 做 EMA 0.15，EAWF 才敢用 `sqrt(hitDistFactor)` 缩半径与
  `minHitDistanceWeight`。官方有 hitdist reconstruction；我们确定性追踪 + 射程哨兵，
  无成片空洞，不做 reconstruction。
- EAWF：Vogel 盘 8 点、官方四类权重、半径下限 0.5、第 4 级 3×3 post blur、天空早退、
  删掉 SVGF 的亮度方差权重与 colortex23 引导。
- TA：删 `_preSmooth`（其动作门控用全分辨率 UV 减象限 screenPos，恒为 1，等于每帧
  无条件把上一帧滤波结果掺回累积——静止蠕动的主要来源）、删新像素 alpha 封顶 1/8、
  firefly 按官方公式、fast clamp 保留 5×5 σ 与暗部地板。
- TS：surface motion 重投影、4-tap 双线性、颜色盒 + `μ*0.1` 地板、footprint quality、
  antilag（保留）、RCRS 只替换 Y。
- 其他：`colortex25` 乒乓（EAWF 原地读写竞态）、`colortex26` 新增并在 config/properties
  注册、SVGF 路径下 `colortex26` 不读（已加 ifdef）。

## 刻意偏离（有理由，勿"优化"掉）

- prepass 16→32 样本：输入是 1spp 且无 reconstruction，噪声比官方假设高一档。
- a-trous 3 级 + post（官方最多 5 级）：基础半径只有官方的 1/4，加满无意义。
- fast clamp 用 5×5（官方 3×3）：半分辨率下 3×3 画布纹素只等于 6×6 屏幕像素。
- history fix 继承长度打 0.5 折：我们的邻域重建不如官方按 stride 分层精确。
- EAWF 半径下限 0.5：基础半径小，趋 0 等于关掉空间滤波、露时域残噪。
- firefly 压到 `2×邻域 min` 而非清零：清零会让该像素输出趋 0 形成黑块。
- 颜色盒/ clamp 加 `μ`、绝对地板：官方只有 σ 项，我们暗部 σ/μ 过大。
- RCRS 只改 Y：YCoCg 暗部色差极小，整体缩放会同比放大色差噪声。

## 已知未做 / 待实测

- **实测是唯一阻塞项**：以上全部改动均未进游戏验证。
- 回退对照表（按现象倒推）：
  | 现象 | 参数 | 从 → 到 |
  |---|---|---|
  | 细节糊 | prepass 半径 | 30 → 20 |
  | 墙角渗色 | hitDist EMA | 0.15 → 0.3 |
  | 稳定区块感 | EAWF 半径下限 | 0.5 → 0.25 |
  | 暗部黑块 | firefly 阈值 | 2.0 → 3.0 |
- 可选性能项（未做）：tile classification（省 10~30% 降噪开销，做错会块状缺失）；
  `VOXEL_TRACE_SPP=2`（噪声降 √2，光线数翻倍）。
- 已知小偏差（不急着动）：TS 重投影起点没扣当前帧 `taaJitter`（亚像素，理论贡献边缘细闪）；
  prepass 在屏幕边缘因 Poisson 盘越界而采样不足（官方同样存在）。
- 体素注入在 `deferred23`、追踪在 `deferred1_a`，**追踪用上一帧体素**。用户判断
  "前面的时候也没观察到异常"，保留不动。
- `GIHistoryStore` 在 `GI_BISECT=0` 时首行 return（空转一个半分辨率 dispatch）。
  无法删：`shaders.properties` 不能对 `const int GI_BISECT` 求值。
---

# 根因：REBLUR 链从未生效（2026-11-10，血债）

## 现象
REBLUR 全套改写后，反复调参实机**毫无变化**：噪点依旧、诊断视图里 prepass(colortex22)/最终 GI(colortex23) 全黑。

## 根因（共三层，最后一层是致命的）
1. `#define VOXEL_GI_NRD_ACTIVE` 的推导用 `#if GI_MODE == 2 && GI_ACTIVE_VXGI`，**却写在 `#define GI_MODE`（第 630 行）之前**。
   预处理器对未定义标识符按 0 处理 ⇒ `0 == 2` ⇒ 恒假。整条链（prepass / EAWF 的 NRD 分支 /
   VarianceEstimate 桥接 / 稳定化 / DeferredLight 读 colortex23）从未参与编译。
2. `shaders.properties` 的预处理器**只看得到选项宏**，看不到 settings.glsl 里推导出来的宏；
   在 properties 里 `#ifdef VOXEL_GI_NRD_ACTIVE` 永远假 ⇒ 三个 compute pass 从未派发。
   必须在 properties 里用选项宏重新推导（`#if GI_MODE == 2` -> `REBLUR_ON`）。
3. 宏真正生效后，一批**从未被编译过**的代码暴露出编译错误（`VarianceEstimate` 的 NRD 分支缺
   `texelPos`，改名后又与 main 后段重复声明）。这类只会在"开关第一次打开"时炸。

## 教训
- **任何 `#if` 判定的宏必须已在其上方定义**。settings.glsl 的选项定义集中在文件后半段，
  派生宏一律放在 `GI_MODE / GI_ACTIVE_VXGI` 定义之后。
- 改 properties 的 `#ifdef` 前，先确认那个宏是不是选项宏；不是就重新推导。
- 判断"开关是否生效"别靠猜：Final.frag 里放一个**无条件**的纯色探针（左下角，注意
  gl_FragCoord.y 是反的），比反复调参快一百倍。
- 调试视图直接显示线性 HDR 缓冲时**必须乘增益**，否则 1e-3 量级看起来就是"全黑"，
  会被误判成"缓冲没写"。

## 结果
修复后实机反馈：降噪干净、无蠕动、无噪点。

---

# REBLUR HistoryFix（2026-11-10，**待实测**）

针对剩下的唯一现象：**快速转头时出现几帧才消散的大团斑块（弱光更明显）**。

## 为什么原来会成团而不是细噪

旧路径只在"历史完全无效"时用邻居重建，而且**不检查邻居自己有没有有效历史**：
全屏/成片失效时是"用噪声重建噪声"，再把重建结果写回 `colortex2/21` 当历史
⇒ 团块顺着时间自我维持、逐帧扩散（"快速消散"= 要好几帧才被真信号冲掉）。
官方 `REBLUR_HistoryFix` 的两条硬约束正是这里缺的：**只从 historyLength ≥ 1 的邻居继承**，
以及**继承历史长度**（`historyFixFrameNum = 3`）。

## 实现

- 新 pass `program/diffuse/GIHistoryFix.comp` → `world{0,-1,1}/deferred1_c.csh`，
  位置 **deferred1_b（prepass）之后、deferred4（Accumulate）之前**，与官方顺序一致。
- 输入 `colortex2`（上一帧长历史 + a=帧数）、`colortex14`（上一帧法线/视深 + a=去遮挡标记，
  与历史同源同纹素）、`colortex22`（本帧 prepass 稠密输入）、`depthtex0`；
  输出 `colortex25`。
- 修复强度：**连续权重** `wFix = saturate((3 - age) / 2)`（1→1、2→0.5、3→0），见下面第二/第三版。
- 邻居两级：先取 `age ≥ 3` 的稳定像素，找不到再放宽到 `age ≥ 1`（降权 0.6）。
- 邻居搜索：**不用官方 `historyFixBasePixelStride = 14`**，改成画布 4 纹素（屏幕 8px）的
  紧凑 5×5 + 径向衰减。原因见下面"第一版实测翻车"。
  权重 = 切平面距离（`planeDistanceSensitivity = 0.02`）× 法线（邻居存下的上一帧世界法线）× 径向。
- 有效支撑不足（权重和 ≤ 0.4）时不用邻居，直接落到 `colortex22`（30px 稠密）当起点、长度 1。
- `Accumulate.frag` 在 `VOXEL_GI_NRD_ACTIVE` 下改读 `colortex25`（`GI_HISTORY_TEX`）。

## 第一版实测翻车（2026-11-10，已改）

第一版按官方 stride 14px（画布 7 纹素）做 5×5，实机反馈：
**"转头时出现隐约的边界，像 GI 跟不上；新像素在短时间内有比较不明显的模糊噪点，随时间消失"**。

根因不是 HistoryFix 的逻辑，而是**半径口径不能照搬**：
官方 history 是 63 帧累积的极平滑场，跨 14px 复制等于"同样平滑"；
我们的历史只有 8~63 帧、且输入本来就是 30 纹素 prepass 糊过的半分辨率场，
再平均 ±28 屏幕像素 ⇒ 在画面里贴一块**明显更模糊、带硬边界**的补丁。
修复只需要"别从噪声起步"，不需要大范围重建 ⇒ 半径收到 ±8 屏幕像素。
教训（通用）：**官方常量是按官方数据特性标定的，移植时先问"我的输入谱和它一样吗"**。

## 第二版：二值掩码才是那条分界线的真正来源（2026-11-10）

第二版把半径收到 ±8px 后，**转头时仍有一条平行于屏幕边框的硬分界线**。

根因不在半径，而在**判据形态**。第二版触发条件是 `重投影出屏 OR a<1 OR 去遮挡标记`：
"重投影出屏"这一项在屏幕上的区域，按定义就是上一帧视锥之外的部分 ⇒ 它的边界是一条
**平行于屏幕边框的直线**。二值掩码 + 掩码两侧内容不同 = 一条硬线。

官方怎么处理（关键认知）：
- `REBLUR_HistoryFix` **只**看该纹素存下来的 `historyLength`（`< historyFixFrameNum` 才补），
  **不做重投影判定，也没有二值去遮挡掩码**。
- "历史不可信"在 NRD 里是**连续量**：累积器把 `historyLength` 置回 1，之后逐帧长回来；
  空间滤波半径/权重也都用 `nonLinearAccumSpeed` 之类的连续量缩放，从不 switch。
- 重投影出屏这件事由累积器处理：它只是让历史权重塌到 0、把长度置 1，
  然后**下一帧**这个像素就落进 "length < 3" 的正常修复范围，不会在屏幕上盖章。

我们的改法：`wFix = saturate(1 - age / 3)` 连续混合修复值与历史值，删掉重投影判定与
去遮挡标记两个二值开关；邻居只取 `age ≥ 3` 的稳定像素。
教训（通用）：**降噪链里任何二值掩码，在屏幕上都会长出可见边界**；要表达"可信度"就用连续权重。

## 第三版：把"新像素的脏"也接手（2026-11-10，待实测）

第二版之后的现象变成：**"新像素在极短时间内是脏的，因为稳定得很快，只剩极窄一条脏"**
⇒ 看上去仍是一条分界线。也就是说剩下的不是掩码边界，而是**波前那一圈像素自己的初始值脏**。

据此两处调整：

1. `wFix` 在 `age = 1` 处取满：`saturate((3 - age) / 2)`（1→1、2→0.5、3→0）。
   刚重置那一帧的值本身是脏的，不该再让它占 1/3。
2. 邻居搜索分两级：先只要 `age ≥ 3`（稳定），**一个都找不到时**放宽到 `age ≥ 1`（降权 0.6）。
   以前这条波前会直接退到 prepass（1spp 起手 ⇒ 脏），现在沿波前逐层稀释，
   脏的程度按几何级数衰减。
3. 修复后的历史长度仍取 `min(maxNeighborAge, 3)`，让 Accumulate 以 alpha ≈ 0.25 起步。
4. 邻居样本必须用 **`offset5x5N`（不含中心）**。用含中心的 `offset5x5` 时，第二级（`age ≥ 1`）
   一定能采到中心自己，权重 0.6 已经越过 0.4 的支撑线 ⇒ `repaired ≈ 它自己`，
   修复变空操作，最脏那一圈原样保留。这类"自己给自己兜底"的坑在两级搜索里很容易出现。

## 第四版：删掉「第二个修复器」（2026-11-10，待实测）

现象（用户实机，之前被远控画质掩盖）：**转头时有时留拖影**；**静止时仍有斑点，且斑点基本不动**。

根因是 `Accumulate.frag` 里还留着**第二份 HistoryFix**（历史被拒时才走）：
步长 7 画布纹素（±28 屏幕像素）的 5×5、读 6 帧短历史 `colortex21`，
并且把历史长度写成 `clamp(_fixA / _fixW * 0.5, 1, accumCap)`。它和 deferred1_c 是两套判据、
两种半径，却写同一个「历史长度」语义：

- **静态斑点**：长度被抬到十几~几十帧 ⇒ `alpha ≈ 1/(1+kN)` 极小 ⇒ 那几帧平均出来的斑块
  几十帧不散，看起来"钉"在画面上。
- **拖影**：每帧都重算 ±28px 的短历史平均（6 帧、噪声大、跨屏位移大）⇒ 转头时内容对不上。

官方只有一个修复器（PrePass → HistoryFix → TA），修复**在累积之前**发生一次。
改法：

1. `Accumulate` 的不可靠路径改成「直接取 `GI_HISTORY_TEX`（= 已修复的历史），长度封顶 3」。
2. `GIHistoryFix` 增加一条判据：上一帧的**去遮挡标记**（`colortex14.a > 0.5`）等价于
   官方的「historyLength 置回 1」，`age` 直接取 1 ⇒ `wFix` 取满。
   官方在 prepass 里做这件事（我们没那一步），没有它的话，`a` 残留很大的去遮挡像素会被
   HistoryFix 漏掉（`wFix = 0`）⇒ 拖影。
3. 删除只为内联重建服务的 `GICanvasNeighbourViewDepth()`。

## 关键工程点（别再踩）

- **不能就地写 `colortex2`**：compute pass 不 flip、`colorimgN` 就是 main，
  "读 colortex2 邻居 + 写 colorimg2" 是真竞态（同 EAWF 当年的问题）。
  写 `colortex25` 后由片元 pass 读取：片元读 main、写 alt，读到的是 HistoryFix 的结果。
- 目标缓冲必须**逐像素全写**（含不需要修复的像素原样搬运），否则没写的纹素会留着两帧前的旧内容。
- `VOXEL_GI_DENOISE` 关闭时 Accumulate 不能读 `colortex25`（那个 pass 没派发）
  ⇒ 用 `#ifdef VOXEL_GI_NRD_ACTIVE` 选历史源，properties 也用选项宏重新推导 A/B。

## 待复验（HistoryFix 上线后单独做，不要混在一起）

1. `GIPrepass` / `EAWF` 的**天空早退**（`depth >= 1` 直接写 0）。
2. `EAWF` 的 `radiusScale` 下限 0.5 与 `hitDist` EMA 0.15。
   若团块仍在，下一个嫌疑是**低累积帧像素上的大核**（`stepBoost` + 半径随 age 变化），
   而不是 HistoryFix 没生效——先看团块是否只出现在 age 低的地方。

---

# REBLUR 前提违反项逐条清理（2026-11-10，待实测）

三套检查通过：语义 / 静态 / 预处理（345 入口，无新增命中）。

## 1. EAWF 半径口径（`EAWF.comp`）

旧写法 `clamp(NRD_RADIUS(米) · pxPerWorldAtZ1 / viewDist, 0.5, 1.5)` 有两处硬错：

- 1080p 下 `pxPerWorldAtZ1 ≈ 800`，**1 米以外全部顶到 1.5** ⇒ 滑条实际只有两档；
  单位还是画布纹素（1.5 画布 = 3 屏幕像素）。
- 同乘的各向异性因子 `oms(|n.xy| · oms(NdotV))` 在正对镜头（n≈(0,0,-1)）时恒为 0
  ⇒ 被 `max(offsetScale, 1.0)` 钉死在 **1 画布纹素**，四遍 a-trous 退化成同一个 3×3，
  滑条等于不存在。这是"怎么调都没变化"的真正原因。

改为 `NRD_RADIUS_PX`（**屏幕像素**，指第 0 级基础半径，每级 ×2）、各向同性 Vogel 盘、
下限 0.5 画布纹素。默认 1.0 ⇒ 半径 0.5 / 1 / 2 / 4 画布纹素，总覆盖 ≈ 15 屏幕像素
（仍远小于 prepass 的 30 画布 = 60 屏幕）。回调：细节糊 → 0.75；残噪 → 1.5~2.0。

## 2. 方差量纲（`VarianceEstimate.comp`）

- 删掉 `× 16` 魔数，删掉 `max(colortex24, momVar)` 分支——那个分支**永远走不到**：
  NRD 路径在该文件上半段就 return 了，而 colortex24 只在 NRD 路径由 prepass 写入。
- 现状：colortex3.a 的方差**没有任何消费者**（EAWF 已不用方差，调试视图 2 直接读
  colortex24），所以这一条只影响读数、不影响画面。
- 残留偏差（已知）：momVar 取自累积后的 colortex2，空间离散度已被时域平均 N 帧，
  比输入小 N 倍。要看真实输入方差请读 colortex24。

## 3. 累积上限按有效样本数折算（`Accumulate.frag`）

新宏 `GI_EFFECTIVE_SPP`（默认 2.0，1.0 = 官方 1 spp 口径）：

```
cap = clamp( GI_ACCUM_TIME / (frameTime · GI_EFFECTIVE_SPP), 8, SSILVB_MAX_ACCUM_FRAMES )
```

理由：输入早已不是 1 spp——prepass 32 样本做 30 纹素空间重用，追踪端还有 ReSTIR 复用。
照搬官方「时间 / 帧时间」会上限高估 ⇒ 过粘（拖影、火把挪走后近 1 秒才跟上）。
60 fps + `GI_ACCUM_TIME=1.0` 时上限从 ~56 帧降到 ~30 帧。
回调：噪点回升 → 1.5 / 1.0。

## 4. 两条"疑似违反"的核实结论（无需改代码）

- **EAWF 的法线不带噪**：colortex14 由 Accumulate **当帧**写出（`FetchSurfaceNormal` 的
  世界法线 + `ScreenToViewDepth`），是干净的 G-buffer 数据；片元 pass 已 flip，
  compute 读到的是本帧。此前"加过噪声"的说法不成立。
- **ReSTIR 复用无偏**：复用只在「静止 + 绝对世界坐标一致」时进行，合并的是同一个量的
  无偏估计（时域按样本数加权平均，空间只并几何一致的 4 邻域）⇒ 均值不变。
  真正的问题是**帧间相关**（同一批样本被反复计数），等效 spp 远低于样本计数——
  已在第 3 条用 `GI_EFFECTIVE_SPP` 吸收，不硬拆（拆了噪声会炸）。
  附带偏差：复用帧把 hitDist 写成 1.0 ⇒ 该帧 `hitDistFactor` 落到下限 0.28（偏"近"），
  只影响滤波半径，不影响辐射亮度。

## 待实测

- [ ] 静止：斑点是否减少（第 3 条会略升噪，属预期方向）。
- [ ] 转头：拖影 / 波前是否减轻。
- [ ] 整体变糊 → `NRD_RADIUS_PX` 0.75；噪点明显回升 → `GI_EFFECTIVE_SPP` 1.5。

---

# REBLUR 缺口核对（2026-11-10 第二轮：先纠正我自己的错判）

上一轮列了一张「还缺什么」的清单，逐条回到代码里核对后，有 4 条**判错了**，先更正：

| 原判断 | 实际 | 结论 |
|---|---|---|
| #1 我们是「双累积」，偏离 REBLUR 的单累积 | REBLUR 本身就是 `TA → Blur → TS` 三段，TS 有自己的历史、**不回流**到 TA | 结构一致，**不改拓扑**。真正差异只有 TS 上限（8 vs 63）和缺 `stabilizationStrength` |
| #3 画布相位固定是违反 | 官方 README（quarter-resolution）明确要求固定 `pixelPos/2`，轮转 grid 反而增加 disocclusion | 固定相位是**对的**，不动 |
| #5 prepass 缺命中距离归一化 | `GIPrepass` 已经是 `hitSum/wSum` 加权平均 + `normHit = hitDist/(A+\|z\|B)` | 已实现，补个注释即可 |
| #8 缺 denoisingRange | 三个 pass 都按 `depth >= 1` 早退；`denoisingRange=500` 远大于本包视距 | 加了也是死代码，**不加** |

## 这轮实际改的两处

### 1. `NRD_STABILIZATION_STRENGTH`（`GIStabilize.comp`）

官方 `ReblurSettings::stabilizationStrength`（默认 1.0），乘在 **accumSpeed** 上（不是乘结果），
所以同时影响 antilag 与颜色盒：`<1` 跟手、`>1` 更稳、`0` = 等价关闭稳定化。
实现：`stabAge = prevAge × strength`，之后 antilag 与 `historyWeight = stabAge/(1+stabAge)` 都用它。

### 2. `GI_FIREFLY_CLAMP`（`GIPrepass.comp`）

官方 `fireflyClampThreshold`（默认 **0 = 关闭**，与本包默认一致）。参与空间重用的样本若亮度
超过「中心像素亮度 × 该值」，等比缩回阈值（只削亮度、保色差比例）。默认 0 ⇒ 不生成任何代码。

### 3. 明确不做的

- **hit distance 重建**：官方用于「trace 无结果」的像素，按 5×5 邻域深度重建。我们 trace 端
  每个像素都有命中（miss 写天空/法线反弹），没有"无结果"分支；硬加等于给已有有效值的像素
  重写 hitDist，**是发明不是对齐**。
- **`fractionOfScreenUnderFirefly`**：需要一次屏幕空间 reduction（直方图/百分位），
  单 pass 做不到；先留 `GI_FIREFLY_CLAMP` 这个等价手段。

## 时域衰减数值对照（离线仿真，非实机）

模型：Accumulate 用 `alpha = 1/(age+1)` 截到 cap，TS 用 `hw = age/(age+1)` 截到 cap；
阶跃（灯灭）后串级输出降到阈值所需帧数，60 fps：

| 配置 | 10% | 5% | 1% |
|---|---|---|---|
| 当前（acc 30, TS 8） | 80 帧 / 1.33 s | 101 / 1.68 s | 150 / 2.50 s |
| 旧（acc 56, TS 8） | 139 / 2.32 s | 178 / 2.97 s | 269 / 4.48 s |
| 官方（acc 30, TS 63） | 186 / 3.10 s | 231 / 3.85 s | 334 / 5.57 s |
| acc 30, TS 16 | 93 / 1.55 s | 114 / 1.90 s | 164 / 2.73 s |
| acc 30, TS 4 | 75 / 1.25 s | 96 / 1.60 s | 145 / 2.42 s |

两个结论：

1. **当前已经比官方快 2.3 倍**（1.33 s vs 3.10 s），"完全对齐官方"会**更**拖影——所以 TS 上限 8
   必须保留，不能改成 63。
2. 主导项是 Accumulate 的 cap（30 帧 ≈ τ=0.5 s），TS 8 只加 0.18 s。再想短，调 `GI_ACCUM_TIME`
   到 0.5（cap 15 ⇒ 10% 约 0.7 s），调 TS 基本没用。
   （仿真没算 antilag，真实变化下会更快。）

---

# 备忘：§3 逐条重判 REBLUR Prepass（2026-11-10）

## 版本基线（先纠正混用）
- `master` 现在是 **v4.18.0**；HANDOFF 里的路径/行号全对应它。清单题头旧写 v4.11.4，
  那版 shader 在 `Shaders/Include/` + `Shaders/Source/`，路径完全不同。§3 用两版交叉核对，结论一致。
- 官方仓库自带 `.agents/skills/nrd-integration-review/SKILL.md`（集成审查要点），可当第二权威来源。
- 官方没有 `Integration.md`；HANDOFF 里提到的那个文件不存在。

## 3.1 半径口径（HANDOFF §8 的遗留疑问已收口）
- 官方 `diffusePrepassBlurRadius = 30` 的单位是 **NRD rect 像素**：v4.11.4
  `REBLUR_Common_DiffuseSpatialFilter.hlsli:83` 与 master `REBLUR_Common_SpatialFilter.hlsli:160`
  都是 `skew *= gRectSizeInv * blurRadius`，采样偏移按降噪缓冲尺寸换算；集成层对 30 不缩放。
- quarter-res README 原文：`From NRD's point of view this is full-resolution input`。
  ⇒ 半分辨率画布 30 纹素 = 60 屏幕像素**就是官方口径**，保持 30，别改 15。
- 官方另乘 `sqrt(hitDistFactor)` 自适应收缩、取 `minBlurRadius = 1` 下限；我们固定 30 ⇒ 记入清单 3.13。

## 继承的 ✅ 大半站不住（逐条证据见清单 §3）
| 项 | 官方 | 我们 | 判定 |
|---|---|---|---|
| 3.4 几何权重 | `ExpApprox(-3t)` | `exp(-t)` | t=1 时 0.077 vs 0.368，系数与形态都不对 |
| 3.5 法线权重 | 按角度连续指数衰减 | cos 的 smoothstep 硬阈 | 二值化阈值，会造边界 |
| 3.6 高斯 | `exp(-0.66r²)` | `exp(-2rn²)` | r=1 时 0.517 vs 0.135，边缘样本过度压低 |
| 3.9 方差 | prepass **不估** | `colortex24` 加权矩 | 自造项；旧引用「官方在 prepass 里估方差」是编造 |
| 3.10 中心权重 | `sum = 1` 起手，中心权重 1 | `sum = 0`，只作兜底 | 归一正确，语义不同 |
| 3.11 firefly | ReblurSettings **没有** `fireflyClampThreshold`（suppressor 在 TA） | 自造 `GI_FIREFLY_CLAMP` | 旧注释引错字段；默认 0 且此前 GUI 没接线 |
| 3.12 hitDist EMA | 无 | 0.15 EMA | 时间常数 ≈ 6.7 帧，旧判定「滞后 ≤3 帧」不成立 |

## 本轮代码改动（默认观感不变）
- `GIPrepass.comp`：方差补 `1/(1-S)` 无偏校正（S = Σw²/(Σw)²）。旧估计平场偏差 -4.1%、
  几何/法线判据拒掉半数样本时 -24%；蒙特卡洛校正后 0.9995 / 0.9991（真值 1）。
  `colortex24` 只被调试视图 2 读 ⇒ 只改读数，不改画面。
- `GI_FIREFLY_CLAMP`：此前只有 GIPrepass.comp 里的 `#ifndef` 兜底，settings/properties/lang 全无 ⇒ 半成品接线。
  补齐四处（settings.glsl、properties 的 screen.VXGI 与 sliders、双语 lang），默认 0.0 ⇒ 逐位不变。
  它是自造项，参考量取中心像素，暗处会连带压暗，只在亮场 A/B。
- 全量自检：语义 / 静态 / 预处理（345 入口无新增命中）全绿；properties 非 ASCII 0、lang 无 BOM、
  GIPrepass 预处理 8/8 配平。

## 下一步
- 权重类偏差（3.4/3.5/3.6/3.10/3.13）做成**默认关的 A/B 开关**，实机确认后才动默认值。
  别凭源码直接改数值：高斯 -2 → -0.66 会明显变糊，几何/法线权重变严会少渗色但可能留噪。
- §4 以后现存的 ✅ 同样是继承来的，推进到该节必须按 §3 同规则重判。动游戏前先问。

---

# 备忘：诊断视图语义错配 + 实机 A~G 回填（2026-11-10）

## 视图本身的三个坑（都让实测结论失真）
1. **视图 4 把 YCoCg 直接当 RGB 显示**（colortex22/2/23 的 g/b 是可能为负的色差）⇒ 串色/发黑，
   主人反馈「画面太诡异看不太清」。修：`YCoCgToRGB` 后再乘同一增益 64 + Reinhard。
2. **视图 3 用 `abs(滤波输出-累积值)/累积值`**：空间滤波本来就改掉大半亮度，暗处分母趋 0
   ⇒ 静止恒饱和全红，E 火点测试无法判读。修：改成相对 3x3 邻域均值的离群量
   （`excess = max(center-mean, 0) / max(mean, 1e-3)`，红=火点、绿=正常）。
3. **视图 5 三通道语义在三份文档里写了三种**：实际是 R=A/cap、G=几何可信度、B=不可靠
   ⇒ 黄=老且可信、**绿=新但可信（正常）**；旧清单写「绿满/红年轻」正好相反。
   主人看到「新像素绿、旧像素黄」以为奇怪，其实是期望行为。已同步 Final.frag / settings / 双语 lang / 清单 / HANDOFF。
   教训：**改调试视图必须四处文档一起改，否则诊断量本身就是错的测量仪器**。

## 实机回填（主人，一轮跑完）
- ✅ B（视图 6 基本全白；极短红色 = 兜底标记，属预期）、C（天空 σ 纯黑、交界 1px）、
  D（奇数分辨率无条带）、F（按修正语义黄→绿→黄）。⇒ 清单 1.6 / 2.4 / 2.5 改 ✅。
- ⏳ A（视图 4 修好后重看）、G 未测；E 被视图 3 缺陷阻塞（已修，待重测）⇒ 4.11 仍 ⏳。
- ❌ 1.3：新像素明显更噪、有些拖影。**不是重投影符号反**（无整屏拖影）。
  与 B 的极短红色兜底标记互证：Accumulate 的不可靠路径直接取 GIHistoryFix 输出、长度封顶 3
  ⇒ 新像素只有 1~3 帧历史、主要靠 prepass 稠密输入；修复值从 ±8 屏幕像素邻居复制 ⇒ 短拖影。
  隔离量：修好的视图 4 三段对比，一次平移 3 秒看「哪一段变脏」，判读表在清单顶部。
- 本轮**没有改任何降噪默认值**，只修诊断量；三套检查全绿。

## 下一步
重载一次跑完 A / E / G，顺带用视图 4 定死 1.3 的位置；再谈 HistoryFix 的 A/B 开关。动游戏前先问。

---

# 备忘：拖尾定位到时域链（2026-11-10 23:20 实机）

## 三段对比结论（视图 4 修好后）
- 主人回报「中段和右边都有拖尾」，左段（prepass）干净。
- ⇒ 输入信号与重投影方向都没问题；**1.3 的「符号反」「新像素起步脏」两个旧判断都撤回**。
- 中段（Accumulate）：沿墙平移时深度/法线不变 ⇒ 去遮挡判据全通过（B 全白互证，
  `maxGeometryWeight≈1` ⇒ 历史长度不重置）；`alpha = 1/(1+kN)` 在 N≈30 只给本帧 3% 权重；
  fast-history clamp 的门控地板 `+0.02` 还会吞掉暗处真实变化 ⇒ 旧内容保留几十帧。
- 右段（GIStabilize）：`quality = sqrt(mean(colortex21.a))≈1` ⇒ `historyWeight≈0.89`；
  antilag 只在历史亮度偏离邻域 μ±σ 时降权，拖影内容与邻域相似 ⇒ 不触发 ⇒ 再叠一层拖尾。
- **B 的「移动时全白」要重新解读**：静止全白正确；移动时全白 = 平面墙上判据无从识别新像素，
  它是拖尾的来源，不是「判据健康」的证明。
- 不是 bug，是「降噪换响应」的取舍被推过头（两级累积 + 两处 clamp 地板）。属观感取舍 ⇒
  按 `docs/CODE_STYLE.md` §8.5 先给旋钮与代价，由主人定，**不擅自改默认值**。

## 本轮代码（默认值全部等价现状）
- 补齐 4 个半成品接线：`GI_DEBUG_NO_HISTORY_FIX` / `GI_DEBUG_NO_TS`（settings 已有定义）、
  `GI_STABILIZE_FRAMES` / `NRD_STABILIZATION_STRENGTH`（原只写在 GIStabilize.comp 的 `#ifndef` 里）。
  settings.glsl 定义 + properties 的 screen.VXGI 与 sliders + 双语 lang 四处齐全。
- 现在 GUI 能直接拉：`GI_ACCUM_TIME`、`GI_STABILIZE_FRAMES`、`NRD_STABILIZATION_STRENGTH`，
  以及两个 A/B 直通开关。建议一次只拉前两个（1.0→0.5、8→4），看拖尾变短与噪点上升的权衡。
- 第二轮实机：诊断视图修复生效 ✅、E 火点 ✅ ⇒ 清单 `4.11` 改 ✅；A/G 仍未报。三套检查全绿。

---

# 备忘：调历史长度治不了拖影 → 运动自适应（2026-11-10 23:27）

## 为什么上一轮两个滑条无效（离线可证，不是没重载）
- 选项文件 `shaderpacks/Revelation-AD-edit.txt` 里 `GI_ACCUM_TIME=0.5`、`GI_STABILIZE_FRAMES=4.0` 已写入；
  `config/iris.properties` 的 `enableShaders=true`；`logs/latest.log` 无 `error C####` ⇒ **滑条确实生效**。
- `accumCap = clamp(GI_ACCUM_TIME / (frameTime × GI_EFFECTIVE_SPP), 8, SSILVB_MAX_ACCUM_FRAMES)`，
  `GI_EFFECTIVE_SPP=2` ⇒ 20 / 30 / 45 / 60 fps 下 0.5 s 的 cap = 8 / 8 / 11.3 / 15；1.0 s = 10 / 15 / 22.5 / 30。
  **低帧率下 0.5 直接撞下限 8**，几乎没变。
- 用户开着 `VOXEL_GI_DARK_ACCUM=true` ⇒ 暗处 `accumCap ×4`（60 fps 下 0.5 s 仍有 60 帧历史）。
  这是拖影的最大单一来源，上一轮完全漏算。
- `GI_STABILIZE_FRAMES` 8→4：`historyWeight = N/(1+N)` 从 0.889 → 0.800，**只降 10%**，人眼不可辨。
- 教训：**先算旋钮的实际量级再让用户拉**。改「历史长度」是 10% 级微调，治不了 60 帧的拖影。

## 本轮修复（默认启用，静止逐位不变）
- 新选项 `GI_MOTION_RESPONSE`（默认 1.0，值 [0.0 0.5 1.0]），四处接线齐全 + 两个 comp 的 `#ifndef` 兜底。
- `Accumulate.frag`：`_motionPx = length((prevCoord - screenPos.xy) * viewSize)`，
  `boost = smoothstep(2, 12, _motionPx) * GI_MOTION_RESPONSE`；
  `alpha = mix(alpha, max(alpha, 0.35), boost)` ⇒ 拖影时间常数从 cap 帧压到约 2 帧。
- `GIStabilize.comp`：同一位移 `historyWeight *= 1 - boost` ⇒ 右段不再叠一层拖影。
- 静止时 prevCoord == screenPos.xy（只剩 TAA 亚像素抖动 < 1 px）⇒ boost = 0 ⇒ **逐位不变**；
  暗处 cap×4 也被这一步覆盖。代价：移动时噪点上升，一键回退 `GI_MOTION_RESPONSE=0`。
- 三套检查全绿；待实机：重载后平移 3 秒，报拖影与噪点。

---

# 备忘：判定标准要单一（2026-11-10 23:40，主人裁定）
- **1.3 只判「运动矢量 / 重投影本身」**，拖影、新像素噪点属于下游多环节问题，不许混在一项里。
  之前把「拖影仍在」写成 1.3 ❌ 是错的：它把 4.x / 5.x / 7.x / 2.4 的现象算到结构项头上。
- 主人确认矢量没问题 ⇒ 清单 **1.3 改 ✅**（证据：公式解析 N + 实机无整屏波前 / 整体错位、
  B 视图 6 全白 V）。拖影单独立 **9.6 运动拖影（跨阶段）**，状态 ❌，等 `GI_MOTION_RESPONSE` 实机。
- 通用规矩已写进清单题头规则第 5 条：结构项只判结构，观感现象另立项。
  以后判定标准里出现「且 / 同时不得…」这类把两个环节绑在一起的条件，一律拆开。


---

# 备忘：§4~§12 逐项重判（2026-11-11）

官方基线 `master = v4.18.0`，与 v4.11.4 交叉；新拉了 `REBLUR_HistoryFix.cs.hlsl` 和 v4.11.4 的
HistoryFix / Blur / PostBlur / TS `.hlsli`。结论：**§4~§8 继承的 ✅ 大半站不住**。

## 关键更正（旧认知作废）
- **官方 TA 没有颜色盒**：`MixHistoryAndCurrent` 是纯 lerp（REBLUR_Common.hlsli:193）；
  fast-history clamp 在 **HistoryFix** pass（HistoryFix.cs:278/487）。我们把 fast clamp 放在 Accumulate
  ⇒ 清单 4.4 ❌ / 4.7 ⚠️。旧 4.4 写「官方 m1±σk 一致 ✅」与 4.7 自相矛盾。
- **官方 HistoryFix 在 TA 之后**（HistoryFix.cs:99 注释）；我们在 deferred1_c（Accumulate 之前）
  ⇒ 新增 5.6 ❌ 拓扑偏离。HANDOFF §4 事实 6 原写「在 TA 之前，位置正确」是错的，已更正。
- **5.1 文档写反**：官方与实现都是 `frameNum < 3` 才修，清单旧写「age ≥ 3」。
- **5.2 stride**：官方 `historyFixBasePixelStride = 14`（NRDSettings.h:295）且动态缩放；
  我们固定 4 画布纹素（第一版按 14 实测出硬边界，MEMO 1682-1692）⇒ ⚠️ 刻意偏离。
- **6.3/6.4/6.5** 与 §3.4/3.5 同源错判：官方 `ExpApprox(-3t)` / 连续角度权重 / hitDist 差指数权重，
  我们是 `exp(-t)` / cos 硬阈 / 绝对 hitDist 线性。官方**没有 `postBlurRadius` 字段**（NRDSettings.h 全文无），
  旧 6.8 的「postBlurRadius=4」无出处。
- **7.1 footprint** 是上一帧 occlusion 双线性（TS.cs:98-104），我们用当帧 colortex21.a max ⇒ ⚠️。
- **7.6 stabilizationStrength** 官方是 `min(historyWeight, strength)`（TS.cs:171、v4114 TS:270），
  **不是**乘在 accumSpeed 上。MEMO 1845 的认知是误读，已更正；端点等价、中间值不同。
- **9.2 / 9.4 / 10.3** 旧状态撤回：官方 TS 的 σ 本就取滤波后信号；半径口径全链不统一（prepass 用 rect 像素、
  EAWF 用屏幕像素）；10.3 的离线仿真未含 antilag 与运动自适应，只能证模型自洽。

## 真正站得住的 ✅
4.5（convergence s=1 / b=0.2 / p=0.8 逐项一致）、4.10、4.11、5.3、5.5、6.7、7.4、7.7、
8.1~8.4、10.5。其余为 ⚠️ / ❌ / ⏳；新增 5.6 记录拓扑偏离。

## 工程
- 清单 §4~§12 用**一次性脚本整体写回**（上次多次 Edit 被外部格式化覆盖，只留最后一次），表格列数已校验。
- §11 批次重排为 B0 / B0b / B1 / B2 / B3 / B4 / B5；§12 说明同步更正。
- 本轮**未动 shader**，只改文档；三套检查全绿。

---

# 备忘：B0/B0b/B2 落地——官方权重与稳定化口径 A/B 开关（2026-11-11，待实测）

三套检查全绿（默认 0 与开关 =1 两种取值都跑过：语义 / 静态 / 预处理 345 入口无新增命中；
properties 非 ASCII 0、lang 无 BOM）。**默认观感逐位不变**：两个开关默认 0，走原有代码路径。

## 关键更正：官方权重形态（本轮最大发现）

`NRD_USE_EXPONENTIAL_WEIGHTS` 在 v4.11.4 与 master **默认都是 0**（Common.hlsli:59），
REBLUR 也不覆盖它 ⇒ 官方几何/法线权重的实际形态是
`ComputeNonExponentialWeight = SmoothStep(1, 0, |x·px+py|)` 三次窗（t≥1 全拒、t=0.5 时 0.5），
**不是** `ExpApprox(-3t)`——那是需要显式开启的指数变体，只在 hitDist 权重处被无条件使用
（`w *= minHitDistWeight + ComputeExponentialWeight(...)`，SpatialFilter:266）。
清单旧判定的「官方 t=1 ⇒ 0.077」是指数变体的值；默认配置下应为 0。
教训：**抄公式前先确认它挂在哪个开关下、默认开没开**，宏名 + 默认值要一起抄。

另一处：官方 Math/ImportanceSampling 命名空间不在 NRD 仓库里，在 CMake FetchContent 的
`NVIDIA-RTX/MathLib`（v11）里；`GetSpecularLobeTanHalfAngle(roughness, pov) = roughness·sqrt(pov/(1-pov))`。
瓣角参数链：pov = 0.75·lerp(saturate(lobeAngleFraction), 1, NLAS)，angleMax = max(atan(tanHalf), 1.5/255)，
param = 1/angleMax 再除 fractionScale（prepass=2，blur=1）。prepass 固定 NLAS = 1/11 ⇒ param = 1.175。

## 两个新开关（四处接线齐全）

- `GI_NRD_WEIGHTS`（B0+B0b 共用）：GIPrepass 3.4/3.5/3.6/3.10/3.13 + EAWF 主循环与 post-blur 3×3
  的 6.3/6.4/6.5 + EAWF 高斯（同源 GetGaussianWeight）。开启后：三次窗几何/法线、-0.66 高斯、
  中心权重 1、半径 = max(sqrt(hitDistFactor)·30, 1)、hitDist 权重 = minHitDistWeight + ExpApprox。
  EAWF 的法线 param 随像素 NLAS 收紧（新像素全拒角 60°、稳定 22°）。
- `GI_NRD_TS`（B2）：GIStabilize 7.1/7.2/7.3/7.6 + Accumulate 的 7.1 写端。
  - 7.1：Accumulate 把 colortex21.a 从「4-tap max」改为「足迹双线性均值」，TS 单点直读
    （同官方「TA 算好存 data2、TS 只读」拓扑）；`quality<0.25` 硬重置只在开关关闭时保留。
    视图 6 的读数含义随之从 max 变均值。
  - 7.2：magic 补 (2·fpsScale)² 的 4 倍。
  - 7.3：只夹亮度、tol = σ·(1+hw·6·fps)、无自造地板；最终混合改为官方 ChangeLuma 语义
    （本帧颜色整体缩放到稳定化亮度，色差来自本帧、比例不变）——旧实现是整 vec3 mix，
    这一处结构差异比清单 7.3 原来记的还大。
  - 7.6：hw = quality·(1-ANLAS(N))·antilag（ANLAS 用 4.5 的 1/(1+e·N)、maxAccum 取本级 cap），
    strength 夹最终混合权重（min(hw, strength)）、不再进 accumSpeed。
  - 运动自适应（GI_MOTION_RESPONSE）与 RCRS（7.4）在两个分支里都保留。

## 官方 TS 的结构认知（比清单 7.3 记载更深一层）

官方 TS **只时域稳定亮度**：`diffLumaStabilized = lerp(本帧亮度, 夹后历史亮度, min(hw, strength))`，
输出 = `ChangeLuma(本帧滤波结果, stabilized)`（xyz 整体乘 newLuma/oldLuma）。色差完全来自本帧、
不被时域稳定。官方 hw 也不是 N/(1+N)，而是 quality·(1-ANLAS)·antilag；antilag 在 hw 之前
先把 data1.x 拉回 historyFixFrameNum（REBLUR_USE_ANTILAG_NOT_INVOKING_HISTORY_FIX=1 默认开）。

## 待实测（一次重载跑完）

1. 9.6：`GI_MOTION_RESPONSE` 平移 3 秒，报拖影/噪点（先收口这条）。
2. H：开 `GI_NRD_WEIGHTS`，看台阶渗色与糊度（判读表在清单顶部）。
3. I：开 `GI_NRD_TS`，暗处静看 10 秒（蠕动）+ 平移 3 秒（拖影）。
4. A/G 仍欠着（视图 4 修后未重看 / 离群钳制未测）。

---

# 备忘：TS 历史缓冲同帧读写竞态（2026-11-11，主人报「静止全是模糊的密集噪点 / 移动全是伪影」，且**不是本轮改动造成、一直如此**）

## 排查结论（离线可证，不需要实机猜）

主人澄清现象是老问题后，把 GI 链 pass 顺序与缓冲绑定逐个核对：
deferred1_a 追踪 → 1_b prepass → 1_c HistoryFix → 4 Accumulate(片元) → 5 Variance
→ 6~9 EAWF×4 → 10 GIHistoryStore → 11 GIStabilize → DeferredLight 读 colortex23。

- 选项文件时间戳 07:07 里**没有** `GI_NRD_WEIGHTS` / `GI_NRD_TS` ⇒ B0/B2 两个默认关开关没生效，
  排除本轮改动。日志无 `error C####`、无 properties 预处理失败。
- `GI_MOTION_RESPONSE` 静止也不触发：`taaJitterPrev = prevFrameX/viewWidth`（R2 序列，|frameX|≤1），
  加在 NDC 上再转 UV ⇒ 位移 ≤0.5 px/轴，合成 ≤0.71 px < smoothstep 起点 2 px。排除。
- `historyReset = abs(smooth(worldTimeCounter,0.2,0.2)-worldTimeCounter)>1.0`：
  worldTimeCounter 每帧约 +0.017，低通稳态滞后约 0.08 ⇒ 正常情况下恒 false。排除。

**真因**：`GIStabilize.comp`（deferred11，纯 compute、无 .fsh、不 flip）在**同一 dispatch** 里
`texelFetch(colortex23, sampleTexel, 0)` 当历史、又 `imageStore(colorimg23, texelPos, ...)`
写本帧输出。compute 的 image 与 sampler 都绑 main ⇒ 读写竞态（EAWF 当年就是因为
「读 colortex2 邻居 + 写 colorimg2」改成 2↔25↔3 乒乓的，MEMO 1757）。
静止时重投影 p0 == 自身 ⇒ 4 个双线性 tap 里必有一个是自己；移动时邻居可能已被别的
invocation 写过 ⇒ 历史值不是上一帧稳定化结果，而是本帧/两帧前的混合 ⇒ 第二级累积
等于失效甚至自激 ⇒ 静止密集噪点 + 移动伪影。**清单 §7 完全没有这一项**。

## 修复（零新增缓冲、零下游改动、默认观感严格等价）

- `GIHistoryStore.comp`（deferred10，原本 `GI_BISECT=0` 时首行 return 空转）现在先把
  **上一帧**的 colortex23 逐像素快照到 colortex25（EAWF 乒乓在 deferred6~9 已跑完、
  Accumulate 在 deferred4 早已读完，此刻 colortex25 空闲）。
- `GIStabilize.comp` 历史改读 colortex25 快照，输出仍写 colortex23；DeferredLight / Final.frag 不变。
- 两个 pass 派发条件同为 `REBLUR_ON`（GI_MODE==2），10 在 11 前，中间无片元 pass ⇒ 无 flip，
  **读到的内容与修复前严格等价**，只是把 UB 变成确定的上一帧值。
- 下一帧 deferred1_c（HistoryFix）会重写 colortex25 ⇒ 闭环成立，不会串台。
- 快照写入包在 `#ifdef VOXEL_GI_NRD_ACTIVE` 内（语义检查 R3：colortex23 只在 NRD 模式写入）。

三套检查全绿。清单新增 §7.0 与待实机 J 行；Uniform.glsl 的 colortex25 注释补用途。

## 待实机（一次重载，只报一件事）

J：站定 10 秒看墙面、再平移 3 秒，报「静止密集噪点是否消失 / 移动伪影是否明显减少」。
若仍满屏噪点 ⇒ 竞态不是主因，下一嫌疑是 **4.4（TA 里自造的 fast clamp，官方在 HistoryFix）**
与 **5.6（HistoryFix 拓扑位置）**，用视图 4 一次定位左/中/右段，不再做反复 A/B 归因。

---

# 备忘：二次对齐——「静止糊噪点 / 稍微一动狂闪」的量级根因（2026-11-11）

主人反馈：竞态修完仍不行，「全是模糊过的噪点，稍微一动更是狂闪」，要求按官方从头到尾对齐。

## 先排除的
- 两个默认关开关（选项文件无键）、`GIStabilize` 竞态（已修）、`GI_MOTION_RESPONSE` 静止不触发
  （TAA 抖动 ≤0.71 px < 2 px 起点）、`historyReset` 恒 false（低通滞后 ~0.08 < 1.0）。

## 真正的四处量级偏差（按影响排序）

1. **空间滤波有效覆盖只有官方的 1/4**（最致命）
   官方 `maxBlurRadius = 30`（NRDSettings.h:314，NRD rect 像素 = 半分辨率画布纹素），
   Blur 单级 8 tap，稳定像素实际半径约 9 画布纹素。
   我们 4 级 a-trous：`offsetScaleBase = NRD_RADIUS_PX·0.5·2^level`，名义总覆盖
   = (1+2+4+8)·0.5·NRD_RADIUS_PX；再乘 `radiusScale`(0.5~1) 与 `hitDistFactor`(0.3~0.5)。
   旧默认 1.0 ⇒ 实际有效覆盖 **~2.5 画布纹素**（≈5 屏幕像素）⇒ 空间滤波形同虚设，
   残噪全留 ⇒ 「糊过的噪点」（prepass 的 30 纹素已经糊过一遍，但 EAWF 没接着压）。
   改 **3.0** ⇒ 有效 ~7.5，与官方同量级。

2. **累积上限被腰斩**：`GI_EFFECTIVE_SPP = 2.0` 让 0.5 s / 60 fps 的 cap 从官方 30 掉到 15
   （alpha 1/16 vs 1/31，稳态噪声 0.176σ vs 0.127σ）。VOXEL_REUSE 已 `#undef`，
   与官方 1 spp 同构 ⇒ 改 **1.0**，cap 恢复 30。

3. **TA 里的 fast clamp（官方没有）**：每帧把长历史拉向 6 帧短历史的 5×5 μ±2σ。
   短历史 σ 是长历史的 2~3 倍，门控地板 0.02 在暗处又完全放开 ⇒ 静止时历史被反复
   拉向噪声。`GI_FAST_CLAMP_SIGMA` 2.0 → **0.0**（官方 TA 无颜色盒；>0 保留做 A/B）。

4. **运动自适应（官方没有）**：`GI_MOTION_RESPONSE=1.0` 在位移 >2 px 时把 alpha 抬到 0.35、
   TS 历史权重压到 0 ⇒ 移动时每帧只剩单样本 ⇒ **狂闪**。默认改 **0.0**；
   拖影交给官方常数，需要跟手时手动开 0.5。

## 顺带对齐的口径
- EAWF 的 `hitDistFactor` 从 `sqrt(saturate(normHit))` 改为官方
  `sqrt(saturate(hitDist_m / frustumSize))`（GetHitDistFactor）。旧写法量纲错位：
  远距离 normHit 恒饱和到 1 ⇒ 半径永远按最大算。米值从 normHit 反解：
  `hitDist_m = normHit·(A + |viewZ|·B)`，A=3 / B=0.1。
- `frustumSize` 定义挪到 hitDistFactor 之前，避免重复声明。

## 选项文件
`shaderpacks/Revelation-AD-edit.txt` 里 `GI_STABILIZE_FRAMES=4.0`（第三轮治拖影调的）
覆盖了代码默认 ⇒ 改回 **8.0**，备份 `Revelation-AD-edit.txt.bak`。
`GI_ACCUM_TIME=0.5` 保留（= 官方 REBLUR_DEFAULT_ACCUMULATION_TIME）。

## 预期与取舍
累积 30 帧 + 有效覆盖 7.5 + 无颜色盒 + 无运动自适应 ⇒ 静止稳态噪声理论上降到原来的 ~1/7。
代价：更糊（官方就是糊的）、拖影变长（官方 3.1 s 阶跃衰减的量级）。
若嫌糊，`NRD_RADIUS_PX` 回调 2.0；若嫌拖，`GI_ACCUM_TIME` 调 0.35。
三套检查全绿（345 入口无新增命中）。

---

# 备忘：拖影的两个机制补齐 —— TS 逐 tap 几何 + HistoryFix fast clamp（2026-11-11）

主人反馈（上一版之后）：静止噪点改善、不闪了，但仍能看到斑点；移动仍有拖影，**且拖影会被拉到
不同深度的表面上**。最后这句是决定性线索。

## 1. 跨深度拖影 = TS 采样历史没有逐 tap 几何判据（清单 7.1）

官方 TS 的 `smbFootprintQuality` 用的是 TA 写下的 **逐 tap 二值 occlusion 位**，每一位的判据就是
「该历史纹素与本像素重投影点是否同一表面」。我们此前只读 `colortex21.a`——那是**每个像素自己**
重投影的质量（`maxGeometryWeight`），**不是 TS 这 4 个历史 tap 的质量**。语义错位导致：
移动时重投影足迹跨到另一个深度，那几块历史（每个自己的质量都正常）被无条件混进来
⇒ 拖影贴着错误深度表面出现。

修法：在 `GIStabilize` 内按同一判据重算逐 tap 几何权重
`tapGeo = saturate(1 - |prevViewPos.z - aux.z| / disocTol) × linearstep(0.5,0.8,dot(Ns,N))`，
`disocTol = frustumSize·saturate(0.01/max(0.05,NoV))`（官方 `GetDisocclusionThreshold` 等价式）。
4-tap 的颜色、历史长度、quality 全部按 `bilinearWeight·tapGeo` 加权。
静止时同一表面 ⇒ tapGeo=1，行为与之前一致；只在真正跨深度时才拒。

## 2. 同表面拖影 = 官方 fast clamp 在 HistoryFix，我们没搬（清单 5.7）

上一版把 TA 里的自造 5×5 clamp 默认关掉（对齐官方「TA 无颜色盒」），但官方那套 clamp 是在
**HistoryFix** 里：σ 取 fast history 5×5（半径 2）× `fastHistoryClampingSigmaScale=2.0`，
亮度夹到 μ±σ，再按历史长度软化 `lerp(clamped, orig, 1/(1+N·2))`，最后 `ChangeLuma`。
关掉 TA 的、又没补 HistoryFix 的 ⇒ 「长历史被短历史拉回」的机制整个消失 ⇒ 拖影变长。
已在 `GIHistoryFix` 的 `wFix<=0`（历史已稳定）分支按官方写法补上，常数 `FAST_CLAMP_SIGMA=2.0`。

静止时短/长历史的 μ 差远小于 2σ_fast ⇒ 不触发（不会重新引入噪点）；移动时滞后长历史被拉回。

## 3. 「静止仍有斑点」的性质判断

这不是时域噪声（那种会随累积下降），更像**体素 1m 网格量化造成的空间相关偏差**（清单 1.2 已记
「网格相关性是偏差不是方差」）。量级：10 m 处 1 体素在 1080p 的屏幕投影约 80 px，**比 prepass 的
60 屏幕像素半径还大** ⇒ 30 纹素核压不掉它。官方输入是路径追踪的连续 radiance，没有这个量化，
所以官方常数按它的输入谱标定，搬过来仍有残块——与 HistoryFix stride 14 那次同类的「输入谱不同」。
可选手段只有加大 prepass 半径（更糊），暂不动，等主人判断斑点是否可接受。

## 4. 待实机
- 移动时：跨深度拖影是否消失（7.1）、同表面拖影是否变短（5.7）。
- 静止时：斑点是否仍在（若在，属上面第 3 条，需决定「要不要为它更糊」）。
- 若仍有同表面拖影：`GI_ACCUM_TIME` 0.5 → 0.35（代价：静止噪点略升）。

---

# 备忘：离线全量对齐（2026-11-11，主人无法实机）

## 关于"官方论文"
REBLUR **没有独立论文**。权威来源只有三处（HANDOFF §3 早已记录）：
`README.md`（集成约定）、各 `*.cs.hlsl` / `*.hlsli` 的头注释、`Include/NRDSettings.h`（默认值）。
SVGF 有 2017 论文，但 REBLUR 不是它的实现（σ/颜色盒的位置完全不同）。本轮只按源码对齐，不引用文献。

## 本轮对齐的 5 处（都是"官方有、我们漏"或"数值错"）

1. **TA 负值历史 clamp**（清单新增 4.12）
   官方 `ClampNegativeToZero`：YCoCg 模式转回 RGB → `max(0)` → 转回（REBLUR_Common.hlsli:221-233）。
   我们只在入口挡 NaN/Inf，从没挡负值。负 Y 会让 `hL/hc`、`_ffLuma`、RCRS 的亮度判据拿到
   错误分母（黑块、滤波异常）。已加在 `Accumulate` 的 NaN 兜底之后；正值历史往返恒等。

2. **fast history 混合率**（4.8 由 ⚠️ 改 ✅）
   官方 `min(data1.x, maxFastAccumulatedFrameNum=6)` + `1/(1+N)`（TA:988-994）；
   我们固定 1/6。N=1 时官方 0.5、我们 0.167 ⇒ 新露出区域要多等 4 帧才跟上。
   已改为 `1/(1+min(prevAge,6))`。

3. **HistoryFix 邻居权重缺两项**（5.3）
   官方 `w *= 1 + data1.x`（长历史邻居更可信）与 `w *= ComputeExponentialWeight(hitDist_s, …)`
   （只从命中距离接近的邻居继承，HistoryFix.cs:176/187）。我们两项都没有。
   已补，并把支撑门槛从固定 1.5/0.7 改成官方 `sumd = 1 + min(age,3)`（5.4）。

4. **TS footprint 缺 sizeQuality**（7.1）
   官方在 TA 里给 footprintQuality 乘一项视角补偿
   `((NoVprev+eps)/(NoV+eps))² → lerp(0.1,1,saturate())`，**只罚拉伸、不罚收缩**（TA:322-329）。
   斜视墙面/地面时足迹被拉长，历史权重会偏大 ⇒ 拖影。已补在 TS 的 quality 计算之后。

5. （上一轮已做，本轮复核）TS 逐 tap 几何判据、HistoryFix fast clamp。

## 离线数值自检（Node，非实机）
- HistoryFix：age=1 需 2 个近邻、age=2 需 3 个才过门槛（不会永不触发）；
  跨 hitDist 的邻居权重被压到 0.20~0.33（有效拒绝）；同平面近邻 1.47~1.75。
- fast 混合率：N=1 → 0.500（旧 0.167）、N=6 → 0.143。
- sizeQuality：对称视角 1.000、拉伸 0.378、严重拉伸 0.145。

## 仍然保留的偏离（有意，不是漏）
| 项 | 官方 | 我们 | 原因 |
|---|---|---|---|
| CatRom12 历史采样（4.3） | 12 tap | 4-tap 双线性 | 半分辨率 + 已有大核，CatRom 收益小、开销大；将来可单独 A/B |
| HistoryFix stride（5.2） | 14 px 且动态缩放 | 4 画布纹素固定 | 14 会贴出硬边界（MEMO 1682-1692 实测） |
| HistoryFix 长度继承（5.4） | 连续混合 | 邻居最大值封顶 3 | 差异小，暂不动 |
| Blur 结构（6.1/6.8） | 单级 8 tap + 独立 PostBlur | 4 级 a-trous，第 4 级兼 PostBlur | 覆盖已按 6.2 对齐到官方量级；结构改动风险高 |
| TS 帧数（7.5） | 63 | 8 | 官方 63 会让阶跃衰减拖到 3.1 s |
| Prepass 样本数（3.2） | 8 | 32 | 我们的输入谱更差，多采样本换噪声 |

三套检查全绿（345 入口无新增命中）。**本轮全部是结构/公式级改动，观感仍需实机确认。**

---

# 备忘：EAWF 4 级 a-trous 的**前两级是空转**（2026-11-11，本轮最重要的量级缺陷）

## 发现过程
主人要求再仔细查一遍。从「prepass 半径 30 画布纹素（60 屏幕像素）之后画面不该有密集噪点」反推，
把每一级的**实际采样落点**算出来（Node 模拟 8 个 Vogel tap + round 到整数纹素）：

| 级 | 旧实际 offsetScale（画布纹素） | 8 个 tap 落点 |
|---|---|---|
| 0 | **0.50** | **8/8 全部 round 回中心** |
| 1 | **0.68** | 多数回中心 |
| 2 | 1.35 | 部分有效 |
| 3 | post-blur 固定 1 纹素 | 有效 |

⇒ **4 级 a-trous 的前两级等于把中心值原样写回，真正在滤波的只有第 3 级和 post-blur。**
这就是「prepass 已经糊过一遍、EAWF 再糊一遍却仍是密集噪点」的直接原因：第二级滤波基本不存在。

## 根因
旧写法 `offsetScaleBase × radiusScale × hitDistFactor`：
- `offsetScaleBase = NRD_RADIUS_PX·0.5·2^级`
- `radiusScale = max(sqrt(NLAS), 0.5)` ⇒ 稳定像素 0.5
- `hitDistFactor` 又是 0.3~0.5
三个小于 1 的因子连乘，把小步长压到 0.5 以下；而 `round()` 会把 0.5 以下全部吸到 0。

## 修法（官方公式 + 每级下限）
```glsl
float blurRadius = max(saturate(sqrt(hitDistFactor * nonLinearSpeed)) * (NRD_RADIUS_PX * 10.0), 1.0);
vec2 offsetScale = vec2(max(blurRadius * (1.0/15.0) * ldexp(1.0, FILTER_PASS_INDEX), 1.0));
```
- `blurRadius` 就是官方 `saturate(sqrt(areaFactor))·maxBlurRadius`，`NRD_RADIUS_PX` 语义改为
  「×10 = 画布纹素」，3.0 即官方 30。
- 下限 `minBlurRadius = 1` 画布纹素，保证每级至少 6/8 个 tap 落在半径 1 上。
- 同时移除了自造的 `stepBoost`（去遮挡放大 + 低帧数放大）：官方没有，且 NLAS 已经承担
  「新像素用大核」，叠加会过度放大。`NRD_DISOCCLUSION` 因此废弃（已从 GUI 与 profile 移除）。

## 数值验证（Node）
| 场景 | blurRadius | 每级步长 | 落点 |
|---|---|---|---|
| 稳定像素（hitDistFactor .45、NLAS .125） | 7.1 | 1.00 / 1.00 / 1.90 / 3.79 | 每级 6/8 有效 |
| 新像素（NLAS .992） | 20.0 | 1.34 / 2.67 / 5.35 / 10.69 | 全部有效 |

有效总覆盖从 **~2.5 → ~7.7** 画布纹素（稳定），新像素从 ~5 → 20。

## 顺带清理
- `EAWF` 的 `centerN`（未使用，注释还写着「用于瓣角判据」但实际上一直用几何法线）已删。
- `NRD_DISOCCLUSION` 从 `screen.VXGI`、`sliders`、`profile.Default` 移除，settings 里保留定义并标注废弃
  （兼容旧配置文件）。
- lang 的 `NRD_RADIUS_PX` 文案改成新语义（×10 画布纹素）。

三套检查全绿（345 入口无新增命中）。**待实机：这一项最可能带来「终于干净了」的可见变化。**

---

# 备忘：全链路逐段复核——四个「看起来对、实际没生效」的缺陷（2026-11-11，第四轮）

主人要求「从头到尾从输入到输出全部检查一遍」。本轮不看公式细节，专门查**执行没执行、口径一不一致**。
四处都是同一类问题：代码写得很像官方，但实际跑起来不是那个意思。

## ① `SVGF_QUALITY` 从未定义 ⇒ 半分辨率 GI 一直是**最近邻**放大（影响最大）

`shaders.properties` 的 `screen.VXGI` / `screen.SSILVB` 里登记了 `SVGF_QUALITY`，
`lang` 里也有它的中英文案，`SpatialUpscale.glsl` 里有两档实现 ——
但 `settings.glsl` **从来没有 `#define SVGF_QUALITY`**。Iris 只认 settings.glsl 里的宏，
所以：
- GUI 上那个「SVGF 质量」滑块是死的，拖了没反应；
- 配置文件里的 `SVGF_QUALITY=1` 不生效（主人这份配置里就有，一直没起作用）；
- `SpatialUpscale.glsl` 的 `#ifndef SVGF_QUALITY → #define 0` 兜底 ⇒ **0 = 仅取中心值**。

半分辨率画布 = 屏幕一半，最近邻放大 ⇒ 每个画布纹素铺成 **2×2 屏幕像素的硬方块**。
这是「静止时满是斑斑点点的密集噪点」里最容易被误判成噪声的一部分：它不是随机噪点，
是规则网格，而且**累积多少帧都不会消失**（它在上采样这一级，时域累积之后）。
已补 `#define SVGF_QUALITY 1 // [0 1]`（4 邻域深度感知上采样）。

## ② EAWF 第 4 级的 a-trous 从来没有执行过

`FILTER_PASS_INDEX == 3` 的分支里只跑一段 post-blur 的 3×3 就 `return`，
主循环（a-trous 大环）根本没进去。也就是说 4 级滤波里 **只有 1×/2×/4× 三级在工作**，
最大步长 `blurRadius·8/15` 一次都没跑过。Node 实测总覆盖：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 稳定像素（blurRadius≈4.4） | 4.2 画布纹素 | 6.5 |
| 新/移动像素（blurRadius≈20） | 10.3 | **21.0** |

新像素少一半覆盖，正是「移动时更脏」的直接来源。现在 4 级全跑真 a-trous；
官方 POST_BLUR 作为 `POST_BLUR_RING_WEIGHT = 0.25` 的 3×3 小环并进第 4 级
（同一 dispatch 读不到自己刚写的结果，只能用两环加权合并近似；小环权重必须小，
否则等于把大核半径丢掉）。顺带把两处手抄的权重合成 `SpatialTapWeight()` 单一实现。

## ③ `Accumulate` 的深度容差量纲错了一倍

`giDepthGrad` 是 **每画布纹素** 的视深变化（本 pass 就在画布分辨率下光栅化，
dFdx/dFdy 步长 = 1 画布纹素 = 2 屏幕像素），但旧写法：
- `_tapOffPx = 2.0 * length(sampleTexel - texelPos)` 把它当屏幕像素用 ⇒ ×2；
- `6.0 * giDepthGrad` 的本意是「6 个屏幕像素」，实际是 6 个**画布纹素** ⇒ ×2。

两处叠起来容差**大了整整一倍**。后果：深度差 10%~20% 的另一层表面也被判成「同一表面」
并混进历史 —— 正是主人上一轮报的「拖影会被拉到其他深度不同的表面上」。
另外 `GI_CANVAS_PHASE` 早已固定为 (0,0)（官方 README 要求四分之一分辨率用固定
pixelPos/2，不要逐帧轮转），棋盘相位偏移这一条前提**已经不存在**，固定补偿项从
6 纹素降到 1 纹素（双线性落点最多偏 1 纹素）。

## ④ 稳定化的逐 tap 几何判据跨帧混用两套坐标系

`GIStabilize`（deferred11）里 `colortex14` 存的是**本帧**内容（Accumulate 在 deferred4
已经写过它并 flip），但旧代码拿它的 `aux.z` 去比 `prevViewPos.z`（本像素世界点在
**上一帧**视空间的深度）。两侧不同坐标系，相机一平移/转动就产生系统性偏差：
判据时松时紧 —— 松则跨深度历史被混入（拖影贴错表面），紧则同一表面被判异面（闪）。
改为比 `viewPos.z`（本帧），两侧同帧同坐标系。代价：检测不到「历史过期」，
那由 Accumulate 的 `maxGeometryWeight` 与 `colortex14.a` 负责。

## 顺带修的配置问题

`GI_KERNEL_ROT_PER_FRAME` 在主人配置里是 `false`。这个选项关掉时随机核方向「每像素固定」，
而**固定图案的采样误差是时域相关的**：累积器平均不掉它，只会把它固化 ⇐ 静止时的不动斑点。
`lang` 原文案写反了（说「每像素固定，静止时最干净」），已改正为「必须开」，
并把配置改回 `true`（备份 `Revelation-AD-edit.txt.bak2`）。

## 验证

三套检查全绿（345 入口无新增命中），`GI_NRD_WEIGHTS` / `GI_NRD_TS` 两种取值都跑过。
properties 纯 ASCII、lang 无 BOM。

---

# 备忘：半分辨率契约审计——每个 pass 的输入/输出是否符合官方 REBLUR（2026-11-11，第五轮）

官方 README「IQ VS PERFORMANCE: TRACING AND DENOISING RESOLUTION」对 `{0.5; 0.5}` 只有两句硬要求：

1. "From *NRD*'s point of view this is **full-resolution input**, so checkerboarding is disabled."
   ⇒ 喂给降噪器的 signal / normal / viewZ / hitDist **全部用降噪分辨率**，`pixelPos = SV_Position/2`，
   不做棋盘轮转（所以 `GI_CANVAS_PHASE` 固定 0 是对的）。
2. "bind **downsampled guides** to *NRD* but **retain the original full-resolution guides for the
   application-side resolve**."
   ⇒ 上采样那一步必须用**全分辨率** guide。

## 逐 pass 契约表（本轮核对结果）

| pass (dispatch) | 输入：缓冲 / 尺寸 / 通道语义 | 输出 | 判定 |
|---|---|---|---|
| 1_a 追踪 | gbuffer 全分辨率，按 `rt = 2·canvasPos` 点采样 | colortex3（**全分辨率共享暂存**，只写左上 1/4）rgb=YCoCg、a=**原始米值** | ⚠️ a 用米值（官方在前端就归一化）；prepass 归一化后下游全读归一化值 ⇒ 内部自洽，不通到外部 |
| 1_b prepass | colortex3(rgb,a) + **同帧** depthtex0 / 表面法线 | colortex22（0.5）rgb=YCoCg、a=归一化 [0,1] | ✅ 本轮把「平均米值再用中心分母归一化」改成「逐 tap 归一化后平均」 |
| 1_c HistoryFix | colortex2(上帧) / colortex14(上帧) / colortex22(本帧) / depthtex0(本帧) | colortex25（0.5）rgb + `.a=frameNum` | ⚠️ `.a` 被 frameNum 占用（官方 `.a` 是 hitDist、frameNum 在独立 data1）；hitDist 由 colortex26 承担 ⇒ 自洽 |
| 4 Accumulate | colortex25(历史) + colortex22(本帧输入) + colortex14(上帧 guide) + colortex21(上帧 fast) | colortex2 / 14 / 21（均 0.5） | ⚠️ 同上（frameNum 打包进 alpha，官方是独立 data1） |
| 5 VarianceEstimate | colortex2 | colortex3（rgb 透传、`.a=0`） | ⚠️ 官方无此 pass（SVGF 遗留），非 NRD 路径依赖它 ⇒ 保留 |
| 6~9 EAWF | pass0 源=colortex2；其后 25/3 乒乓 | colortex3（画布象限） | ✅ 输入=TA 输出，符合官方 Blur |
| 10 HistoryStore | colortex23（上帧） | colortex25 | ✅ 官方没有（为消除 TS 同帧读写竞态新增），自洽 |
| 11 GIStabilize | colortex3 + colortex14(本帧) + colortex25(上帧快照) | colortex23（0.5）rgb + `.a=age` | ✅ 最终结果在降噪分辨率 |
| 上采样（DeferredLight） | colortex23(0.5) + **全分辨率** guide | 全分辨率 | ✅ 本轮修好（此前用半分辨率 guide） |

## 本轮实际改的三处

1. **上采样改用全分辨率 guide**（官方第 2 条）。旧实现用 `colortex14`（半分辨率）的深度/法线做权重，
   权重只在画布格点上取值，全分辨率像素之间的差异完全体现不出来 ⇒ 退化成 2×2 软混合，
   GI 边缘跟着画布格点走。现在改为 `depthtex0` + 法线包，与中心像素自己的全分辨率视深/法线比较。
   这一条对上采样边缘（台阶/柱子/树叶）的清晰度是直接收益。

2. **prepass 的命中距离改逐 tap 归一化**（官方 front-end 口径）。官方 alpha 是归一化值，
   `ExtractHitDist(s) * _REBLUR_GetHitDistanceNormalization(zs, ...)` 每个 tap 用**自己的**视深。
   我们此前平均米值、再用中心分母归一化：平坦面恒等，深度不连续处被最远 tap 主导
   ⇒ normHit 顶到 1 ⇒ hitDistFactor=1 ⇒ 半径永远取满 ⇒ 台阶/接触区过糊。

3. **`colortex3` 的读取口径**：`Accumulate` 的非 NRD 回退原来 `textureLod(colortex3,
   texelToUv(texelPos), 3.0)` —— `texelToUv` 是全分辨率像素尺寸，而 texelPos 是画布坐标，
   于是取的是「整张全分辨率缓冲的第 3 级 mip」，而 GI 只写在左上 1/4 ⇒ 内容完全错位。
   改为画布坐标 4-tap `texelFetch`，并删掉只为它申请的 `colortex3MipmapEnabled`
   （省一条全分辨率 mip 链）。另外 `DeferredLight` 的 SSILVB 分支 `texelPos >> 1` 改为
   `GICanvasCoord()`（奇数分辨率会越界 1 列/行）。

## 顺带确认：colortex3 为什么必须是全分辨率

它不是 GI 独占缓冲，而是**帧内共享暂存**：
`deferred1_a/5/6~9`（GI，画布象限）→ `DeferredLight` 读 → …… → `TemporalAA`（`RENDERTARGETS: 1,4,3`）
**全分辨率重写**成运动矢量 → `composite10_a` 的 MotionBlur 读 `.xy`。
所以：① 不能把它改成 0.5；② GI 只写左上 1/4 是安全的，TAA 会整帧覆盖；③ 任何"读 colortex3"
的地方都必须明确自己在读象限还是全图 —— 本轮修的两处正是这类混淆。

## 仍然偏离官方、但内部自洽的地方（不改的理由）

| 项 | 官方 | 我们 | 为什么可以不改 |
|---|---|---|---|
| 命中距离存放 | `.a`（贯穿全链） | `colortex26`（时域平滑后的标量） | 我们的 `.a` 要存 frameNum（官方有独立 data1 缓冲）；colortex26 反而更稳 |
| data1（帧数）| 独立纹理 | 打包进 `.a` | 没有外部消费者，通道够用 |
| 缓冲尺寸 | `resourceSize = rectSize` | 全分辨率共享缓冲的左上 1/4 | 见上：共享暂存不能改尺寸；索引全是画布相对的，数学等价 |
| CatRom12 历史采样 | 12 tap | 4-tap 双线性 | 半分辨率 + 已有大核，收益小 |
| denoisingRange | 500 m 裁剪 | 无 | 我们的 GI 只追踪 16 m，全在范围内 |

三套检查全绿。

## 追加（同日，第六轮自查）：把上一轮自己引入的两处 分支出错 修掉

主人看不到画面，所以这一轮专门"审自己刚改的代码"。抓到两处：新写的上采样与 TS 逐 tap 几何都用了
`samplePos * 2` 把画布坐标换算成屏幕坐标 —— 但 `VOXEL_GI_FULLRES` 模式下**画布纹素就是屏幕纹素**，
不能再乘 2。主人当前是半分辨率（`//#define VOXEL_GI_FULLRES`），所以实机不会立刻炸，
但这是个定时炸弹（一开全分辨率就整片错位）。两处都补了 `#ifdef VXGI_FULLRES` 分支。

另外把 TS 的逐 tap 判据从 `|ΔviewZ|` 换成**切平面距离**（`0.02 × frustumSize`）：
`|ΔviewZ|` 在掠射面上一个纹素的差值与深度断层同一量级，判据必然过拒（历史权重掉到 0 ⇒ 闪）；
平面距离对"同一平面上任意远的邻居"恒为 0、与视角无关。现在 prepass / EAWF / HistoryFix / TS
四处用的是**同一个**几何判据口径。

### 端到端数值复核（Node，非实机）

| 场景 | hitDistFactor | NLAS | blurRadius | 四级步长 | 8 tap 落点(心/1/远) | 总覆盖 |
|---|---|---|---|---|---|---|
| z=2 m 稳定（N=30） | 1.000 | 0.125 | 10.6 | 1.00/1.41/2.82/5.65 | 2/6/0 · 2/3/3 · 0/1/7 · 0/1/7 | 10.9 |
| z=10 m 稳定 | 0.280 | 0.125 | 5.6 | 1.00/1.00/1.49/2.99 | 2/6/0 · 2/6/0 · 2/3/3 · 0/1/7 | 6.5 |
| z=30 m 稳定 | 0.140 | 0.125 | 4.0 | 1.00/1.00/1.06/2.11 | 每级 ≤2 个落中心 | 5.2 |
| z=10 m 新像素（N=1） | 0.280 | 0.992 | 15.8 | 1.05/2.11/4.22/8.43 | 0/2/6 · 0/1/7 · 0/0/8 | 15.8 |

每一级都至少有 6/8 个 tap 落在中心之外（上一轮之前第 4 级是 0/8、前两级是 8/8 全落中心）。
累积：cap = 30 帧（= 官方 0.5 s），alpha 从 0.811（N=1）降到 0.032（N=30），稳态残噪 ≈ 单样本的 12.8%。

另做了一次括号/花括号配平自检（9 个改动文件全 OK），以及四个 EAWF pass 的派发条件一致性核对。


---

# 备忘：官方管线顺序的**确证**（2026-11-11，读 C++ 派发代码）

此前 5.6 的判定只是从 shader 头注释推的，本轮直接从
`Source/Reblur.cpp`（diffuse 分支，145~186 行）读到派发序列：

```
PREPASS
TEMPORAL_ACCUMULATION
HISTORY_FIX
BLUR
POST_BLUR
TEMPORAL_STABILIZATION
```

**结论一**：HistoryFix 在累积**之后**，我们是**之前** ⇒ 5.6 的 ❌ 成立。

**结论二（比原先记的更重要）**：官方 HistoryFix 的输出 `gOut_Diff` 只喂给 Blur，
**不回写历史**；下一帧历史用的是 TA 自己的输出 `gOut_Diff`（未被修复的那份）。
而我们把 HistoryFix 的输出写进 colortex25，Accumulate 直接把它当历史输入读取
⇒ **"从邻居借来的值"会进入长历史并被永久固化**。

每次修复只持续 age<3 的约 2 帧，但只要那 2 帧里有邻居的旧 GI，它就会留在本像素的历史里
继续被累积（alpha 逐帧变小、越来越难冲掉）。这是拖影的一条独立来源，
也是"修复值本身会自我复制"那类问题的另一个表现形式。

**为什么不现在改**：把 HistoryFix 移到 Accumulate 之后，需要
① 它读 colortex2（本帧 TA 输出）而不是读历史；② 输出到一个 EAWF 会读、但不参与历史回流的缓冲；
③ EAWF pass0 的源随之改变，乒乓链 `2→25→3→25→3` 要重排；④ TS 的历史快照缓冲不能与它冲突
（colortex25 目前被三者共用：EAWF 乒乓 / HistoryFix 输出 / TS 快照）。这是一次真正的拓扑改造，
必须实机 A/B 才能确认收益，否则可能把刚修好的稳定性再打乱。**留作 B1，等实机。**

---

# 备忘：**更正**——REBLUR 有论文，而且论文标题里的机制我们一直漏着（2026-11-11）

## 先更正事实错误

本文件前面（约 2250 行）写过「REBLUR **没有独立论文**，权威来源只有 README/头注释/NRDSettings.h」。
**这是错的**，已核实：

> Zhdan, D. "ReBLUR: A Hierarchical Recurrent Denoiser." In: Marrs, A., Shirley, P., Wald, I. (eds)
> *Ray Tracing Gems II*. Apress, Berkeley, CA, 2021. DOI 10.1007/978-1-4842-7185-8_49（Open Access）

摘要原文："By aggressively reusing information both spatially and temporally, the denoiser produces
noise-free images from only a few samples per pixel."

教训：这条错误断言直接导致我漏掉了标题里写着的核心机制（见下）。**引用文献前必须查，不能凭印象断言"没有"。**

## 漏掉的机制：Recurrent —— 主历史就是上一帧的空间滤波输出

证据不是推测，是 NRD 头文件里的资源生命周期标签：

| pass | `gOut_Diff` 的标记 |
|---|---|
| `REBLUR_TemporalAccumulation` | `NRD_RESOURCE_TRANSIENT` |
| `REBLUR_Blur` | `NRD_RESOURCE_TRANSIENT` |
| `REBLUR_HistoryFix` | `NRD_RESOURCE_OUT` |
| **`REBLUR_PostBlur`** | **`NRD_RESOURCE_PERMANENT`** ← 唯一 |

而 TA 的跨帧输入 `gHistory_Diff` 正是 `NRD_RESOURCE_PERMANENT`
（`REBLUR_TemporalAccumulation.resources.hlsli:34`）。
⇒ **下一帧 TA 的历史 = 本帧 PostBlur 的输出**，`H_{n+1} = Filter(lerp(H_n, 输入, alpha))`。
同一个核被逐帧反复迭代，等效滤噪力度随历史长度增长 —— 这就是官方能用 8 tap 小核做干净的原因，
也是它被叫作 *recurrent* 而不是 *recursive* 的原因。

## 我们做反了

`GIHistoryStore` 原来默认 `_wb = 0.0`，注释还写着「官方口径：主历史不掺空间滤波结果」——
方向正好相反。后果：整个回流机制不存在，等于把 REBLUR 降级成普通 SVGF，
噪声只能靠**单次**空间滤波压。**这就是「该修的都修了、画面仍有密集噪点」的根因。**

有意思的是 `lang/zh_CN.lang` 里 `VOXEL_GI_NRD` 的说明一直写的是
「长历史存滤波后的结果（安静、干净）」——**文案是对的，代码是错的**。
下一轮再有"代码和文案矛盾"的地方，应该先怀疑代码。

## 本轮改动

1. `GIHistoryStore.comp`：`_wb` 默认 **1.0**（全量回流），`GI_BISECT bit1` 保留为回退开关（置位 = 旧行为）。
   整个回写包进 `#ifdef VOXEL_GI_NRD_ACTIVE`（关降噪时 colortex3 不是 EAWF 输出，
   拿它回写会把累积冲掉——这是个潜在的数据破坏路径）。
2. `EAWF.comp`：`nonLinearSpeed` 的分母从 `SSILVB_MAX_ACCUM_FRAMES`(128) 改为**真实累积上限**
   （`clamp(GI_ACCUM_TIME/(帧时间·SPP), 8, 128)`，与 Accumulate 同一公式）。
   旧写法在 N=30 时把 NLAS 算成 1/9 而不是 1/31 ⇒ 半径大 2 倍。**回流一旦打开，这个 2 倍会被逐帧放大成"整体糊掉"**。

## 复核（Node）

改完之后半径与官方**逐项吻合**：

| 场景 | 我们的 blurRadius | 官方（同公式） |
|---|---|---|
| z=10 m 稳定（N=30） | 2.85 | 2.85 |
| z=10 m 新像素（N=1） | 15.62 | 15.62 |

稳定像素四级步长 1.00/1.00/1.00/1.52（每级 ≥6/8 tap 有效），新像素 1.04/2.08/4.16/8.33。

## 回退方法

嫌糊/出现异常时，把 GUI 的「二分排查」(GI_BISECT) 设为 **2**，即可回到"历史只存原始累积"的旧行为，其余不变。

---

# 备忘：实机两次 A/B 的对照结论（2026-11-11，第九轮，**重要**）

## 客观事实（从 `versions/1.21.11-Fabric 0.18.4/logs/latest.log` 读到）

- 09:56:30 `Using shaderpack: Revelation-AD-edit`，`enableShaders=true`，**全程无 `error C####`**；
  只有 sodium 的 link warning（历次会话都有）。⇒ 代码是活的，不存在"没加载/编译失败"。
- 真正的游戏目录是 **`.minecraft/versions/1.21.11-Fabric 0.18.4/`**（HMCL 版本隔离），
  它有自己的 `config/iris.properties`、`shaderpacks/`、`logs/`。`.minecraft/` 下那份是旧的
  （`latest.log` 停在 8/27），排查时别再看错。三处 `shaderpacks/` 指向同一份文件，我改的就是它。
- `profile.Default` 里的 `!VOXEL_GI_NRD` **没有生效**：用户的实际选项（`VOXEL_GI_SUN_STRENGTH=3.0`、
  `VOXEL_TRACE_DISTANCE=16`、`GI_FAST_CLAMP_SIGMA=0`）与 profile 的值全部不一致，
  而与 settings.glsl 默认值一致 ⇒ 已排除"REBLUR 链被 profile 关掉"这个可能。
- Iris 只把**非默认值**写进选项文件。所以要把一个"默认开"的布尔选项关掉，必须显式写一行
  `NAME=false`，光删掉那行等于恢复默认（本轮踩过一次）。

## 两次实机对照

| | 配置 | 反馈 |
|---|---|---|
| A（07:56） | 逐帧旋转**关**、回流**关**、第 4 级空转、最近邻上采样 | 静止噪点改善、**不闪**、仍有斑点、移动有拖影 |
| B（09:56） | 逐帧旋转**开**、回流**开**、第 4 级真跑、双线性上采样 | 斑点略降、**静止也在动**、**动起来更闪**、**拖影一大条** |

A→B 只多了四项改动。其中两项是客观修复（第 4 级、上采样），效果就是"斑点略降"；
另两项是我基于官方源码做的**判断性**改动（旋转、回流），而新增的三个坏症状恰好对应它们。

## 结论：回流与逐帧旋转在本链里**不能同时开**

- 本包的空间核每帧换旋转角（`GI_KERNEL_ROT_PER_FRAME`）。回流把"每帧不同算子的输出"直接写回历史
  ⇒ 滤波算子的不动点逐帧移动 ⇒ **没有稳态** ⇒ 静止时画面持续漂移、拖影层数叠加。
- 官方能同时用两者，是因为它的 rotator 是预计算的时域分层序列、核结构与我们的 4 级 a-trous 不同，
  而且它的 HistoryFix / Blur / PostBlur 拓扑与我们也不同（5.6 仍未对齐）。
- **所以：`GI_RECURRENT_HISTORY` 默认改为 0**（开关保留），并把逐帧旋转在用户配置里显式关掉。
  要试回流，必须同时关旋转。

## 另一个确定的拖影来源：暗处 ×4 累积

`VOXEL_GI_DARK_ACCUM` 把暗处的累积上限从 30 帧抬到 **120 帧（0.5 s → 2 s）**。
官方 REBLUR 全场 cap 一致，没有这个机制。用户配置里它是 `true` ⇒ 暗场景的光照恢复时间翻四倍，
正是"拖影一大条"的量级。**已关**（`VOXEL_GI_DARK_ACCUM=false`）。

## 本轮净变化（相对状态 A）

保留：第 4 级真 a-trous、双线性上采样、切平面距离判据、逐 tap 命中距离归一化、全分辨率 guide 上采样。
撤销：逐帧旋转（显式 false）、主历史回流（默认 0）。
新增关闭：暗处 ×4（false）。

---

# 备忘：按官方把剩下的拓扑做完（2026-11-11，第十轮）

主人反馈「拖影没改善、依旧跨表面拖影」，并明确要求「把没做的都做完，遇事优先参考官方」。
本轮做完的是**最要紧的三项**，都是结构性的。

## ① 5.6 拓扑重排：HistoryFix 移到 TA 之后，且修复值不再入历史

官方 `Source/Reblur.cpp:145-186` 的顺序已确证为
`PREPASS → TA → HISTORY_FIX → BLUR → POST_BLUR → TS`，且 HistoryFix 的输出
`gOut_Diff` 是 `NRD_RESOURCE_OUT`（当帧临时，只喂 Blur）。

我们原来做的是反的：HistoryFix 在 **prepass 之后、累积之前**，输出写 colortex25，
而 Accumulate 把 colortex25 当**历史**读 ⇒ 「从邻居借来的旧 GI」被永久固化进本像素历史。
这正是「跨表面拖影」的结构性来源：修复用的法线判据是 `smoothstep(0.4, 0.9, dot)`
（66° 锥），在墙角/台阶处必然把另一层表面拉进来，然后它就再也洗不掉。

**落地**：`deferred5` 槽位在 NRD 路径下改跑 HistoryFix（原 VarianceEstimate 在该路径只做
colortex2→colortex3 的复制，没有消费者，复用不丢功能；GI_MODE 1 仍走 VarianceEstimate）。
`deferred1_c` 退役。HistoryFix 本身按官方算法**重写**：

```
if (frameNum >= historyFixFrameNum) → 跳过重建
else  sumd = 1+frameNum; diff = 自己 × sumd
      for 5×5 邻域（去中心、去 4 角 = 20 tap，tap 间距 = stride）:
          w = 平面距离窗 × 法线瓣角窗 × (1+邻居帧数) × 命中距离指数
          diff += w × 邻居的**本帧 TA 输出**
      diff /= sumd
无条件：亮度夹到 fast history 的 μ±2σ，再 lerp(clamped, orig, 1/(1+frameNum·2))，ChangeLuma
```

stride 也按官方：`round(7 × lerp(0.25+0.75·sqrt(hitDistFactor), 1, NLAS))`（我们原来固定 2）。

## ② 5.8 Recurrent 回流改回默认开启（拓扑对了才有意义）

`GIHistoryStore` 帧末把 `colortex2.rgb` 覆盖成 `colortex25`（EAWF pass3 = 官方 PostBlur 位置），
保留 `.a` 帧数。上一轮"回流+逐帧旋转"同时开出现静止漂移，当时 HistoryFix 仍在历史链里可能是主因；
现在修复值不入历史，用户侧逐帧旋转也已关闭。

## ③ 去遮挡兜底改用**本帧输入**（官方 TA 的 disocclusion 分支）

原来历史失效时取 `colortex2` 的旧值、帧数压到 1~3 ⇒ 去遮挡像素继续复用旧的**滤波值**，
移动时沿物体边缘拖一条。官方是 `diff = 本帧输入, frameNum = 1`，已改。

## 缓冲重排（这是本轮唯一的"发明"，因为不能新增 pass 槽位）

colortex25 现在是 EAWF 的最终输出（官方 PostBlur），不能再兼作 TS 快照；
快照改到 **colortex24**（原 GIPrepass 调试方差，已让出，`colortex24Clear=false`）。

最终数据流：

```
1_a  → 3(trace)          1_b → 22(rgb+normHit), 26(平滑 normHit)
4    r:2(prev),22,14(prev),21(prev)   w:2(TA out, .a=帧数),14,21
5    r:2(now),14(now),26,depth        w:25(重建结果，当帧临时)
6-9  25→3→25→3→25（4 遍，最终在 25）
10   r:25,23(prev)        w:24(TS 快照), 2.rgb:=25（回流）
11   r:25,24,14           w:23
DL   r:23
```

## 仍未做的（明确列出）

| 项 | 为什么没做 |
|---|---|
| 4.3 CatRom12 历史采样 | 纯质量项，不影响拖影；4-tap 双线性已够 |
| 6.1/6.8 单级 Blur + 独立 PostBlur | 需要**新增一个 dispatch 槽位**，Iris 的 pass 名集合没法安全确认；现在仍用"第 4 级 + 0.25 权重小环"近似 |
| 6.6 官方 `g_Special8` 采样图案 | 与 8.1 的黄金角 Vogel 等价性高，属观感微调 |
| 7.5 TS 63 帧 | 官方虽有 63，但注释写明「>= maxAccumulatedFrameNum 会被夹到 30」；我们先保持 8（更短的拖影尾巴） |

---

# 备忘：把「剩下的都做完」——官方 Blur/PostBlur 两级 + CatRom + TS 单级累积（2026-11-11，第十一轮）

主人：「剩下的全部都做。仔细做完」。上一轮列的 4 项 + 2 项新发现，本轮全部落地，
**没有保留 A/B 开关**（官方实现即唯一路径，旧代码删除）。

## 一、官方 Blur / PostBlur 的真实结构（推翻我之前两处记录）

`REBLUR_Blur.cs.hlsl` 与 `REBLUR_PostBlur.cs.hlsl` 的**主函数完全一样**——它们都
`#include "REBLUR_Common_SpatialFilter.hlsli"`，差别只有三个编译期宏：

| 参数 | BLUR | POST_BLUR | 出处 |
|---|---|---|---|
| `REBLUR_*_RADIUS_SCALE` | 1.0 | **2.0** | REBLUR_Config.hlsli:86-93 |
| `REBLUR_*_FRACTION_SCALE` | 1.0 | **0.5** | 同上 |
| rotator | `gRotator` | `gRotatorPost` | 同上 |

**关键更正 ①**：PostBlur **不是 3×3**（我之前把它实现成「权重 0.25 的 3×3 小环并进第 4 级」），
而是**半径翻倍的同款 8-tap**：两者 `areaFactor` 相同，所以 PostBlur 半径 = Blur × 2。

**关键更正 ②**：官方的总覆盖 = Blur(1×) + PostBlur(2×) = 3×，不是"单级 8 tap"。
按 `NRD_RADIUS_PX=3.0`（maxBlurRadius 30）算，Node 实测：
- 稳定像素（z=10 m）：Blur 2.85 + PostBlur 5.70 = **8.6 画布纹素**
- 新像素：15.62 + 30.0 = **45.6 画布纹素**
（旧 4 级 a-trous 分别约 4.5 / 21 —— 本轮的覆盖是它的 1.9~2.2 倍）

`fractionScale` 的语义（这才是 6.8 真正的差异点）：
- `normalParam = (1/angleMax) / fractionScale` ⇒ PostBlur 的角度上限只有 Blur 的一半（更严）
- `minHitDistWeight = 0.1 · fractionScale · NLAS` ⇒ PostBlur 减半
- `roughnessWeightParams` 略（diffuse 不适用）

## 二、`g_Special8` 与各向异性 skew（6.6）

```cpp
g_Special8 = { (-1,0,1), (0,1,1), (1,0,1), (0,-1,1),
               (-0.25√2, 0.25√2, 0.5), (0.25√2, 0.25√2, 0.5),
               (0.25√2, -0.25√2, 0.5), (-0.25√2, -0.25√2, 0.5) }
```
xy = 单位盘内方向×半径分数，**z = 高斯半径分数**（`GetGaussianWeight(offset.z)` ⇒ 轴点 exp(-0.66)=0.517、
对角点 exp(-0.165)=0.848）。`NRD_USE_QUADRATIC_DISTRIBUTION = 0` ⇒ 采样点就是 `offset.xy`，不再乘 z。

屏幕空间偏移（SpatialFilter:158-166）：
```
skew = lerp(1 - abs(Nv.xy), 1.0, NoV);  skew /= max(skew.x, skew.y);
skew *= gRectSizeInv * blurRadius;
uv = pixelUv + RotateVector(ScaleRotator(rotator, skew), offset.xy);
```
正对镜头各向同性；掠射时沿表面倾斜方向拉长（保细节）。

顺带确认：`ApplyGeometryWeightLast(w, z, NoX, params)` 里 `NoX·a + b = dot(Nv, Xvs-Xv)/(sens·frustumSize)`
—— 与我们用的「切平面距离 / (0.02·frustumSize)」**数学等价**，所以四处统一用平面距离是对的。

## 三、CatRom12 到底用在哪（4.3 的更正）

之前记「CatRom12 用于历史采样」。核实后更准确：

| 数据 | 滤波 | 出处 |
|---|---|---|
| **颜色历史**（TA `gHistory_Diff`） | `BicubicFilterNoCornersWithFallbackToBilinear`（CatRom 12 tap） | TA:934-937 |
| **稳定化亮度历史**（TS `gHistory_DiffLumaStabilized`） | 同上 | TS:147-152 |
| 帧数 `data1.x` / `footprintQuality` | **双线性**（`ApplyBilinearCustomWeights` / `ApplyBilinearFilter`） | TA:311/326 |

门控：`smbAllowCatRom = dot(smbOcclusion0+1+2+3, 1.0) > 11.5`（16 个 occlusion 位里 > 11.5 个有效）。
我们等价为 `足迹有效率 > 11.5/16`。

**为什么这项在 Recurrent 下更重要**：主历史被逐帧重采样，双线性的模糊会**累加**
（H_{n+1} = CatRom(H_n) 与 Bilinear(H_n) 在 30 帧后的锐度差是累积的）。CatRom 的负瓣正好抵消。

实现细节：负权重 tap 也乘 `tapGeo`（否则跨表面的负权重会把另一层颜色「减」进来，边缘过冲）；
`abs(crW) < 1e-3` 时退回双线性（邻域几乎全被拒时避免除爆）。

## 四、TS 里最要紧的一处结构性偏差（7.5 的真正含义）

`Source/Reblur.cpp:303`：
```cpp
float stabilizationStrength = settings.maxStabilizedFrameNum / (1.0f + settings.maxStabilizedFrameNum);
```
⇒ `gStabilizationStrength` **不是** `maxStabilizedFrameNum` 本身，而是 `N/(1+N)`；
默认 63 ⇒ **0.984**。它只夹最终混合权重 `min(hw, strength)`。

**而 TS 根本不做帧数累积**：`data1.x` 由 TA 算好（`gIn_InternalData`），TS 只
`data1.x = lerp(min(data1.x, historyFixFrameNum), data1.x, antilag)` 后写回。

我们此前 `taAge = prevAge + 1` —— 那是在 TA 之外**又叠了一级时域累积**。这是「拖影一大条」
的结构性来源之一（两级 alpha 串联，等效历史长度 = 乘积）。本轮已删，改为直读 `colortex2.a`。

`GI_STABILIZE_FRAMES` 的语义随之从「本级帧数上限」改为「maxStabilizedFrameNum」，默认 8 → **63**。

## 五、HistoryFix 的两处（5.3 / 5.4）

- 官方的**几何**权重走 `ComputeWeight`（默认三次窗），但**法线**与**命中距离**显式走
  `ComputeExponentialWeight`（`ExpApprox(-3·|u|)` = `rcp(9u²+3u+1)`）。我们此前法线用三次窗 ⇒ 已改。
- `w *= 1 + UnpackData1(邻居).x` —— **不夹上限**（我们此前 `min(nAge, 3)`）⇒ 已改。
- HistoryFix **不改帧数**（没有 `gOut_InternalData` 写入）⇒ 输出 `.a` 改为透传 TA 的帧数（此前写死 1.0）。
- `stride` 公式复核无误：`stride = (frameNum < 3) ? 1 : 0` → `/2` → `×2/2` → `×14` → `×lerp(0.25+0.75√hitDistFactor, 1, NLAS)` → `round` ⇒ base 7。✅

## 六、删掉的开关

`GI_NRD_WEIGHTS` / `GI_NRD_TS`：官方分支已成为唯一路径，两个开关的 20+ 处 `#if` 分支全部删除，
GUI（`screen.VXGI` / `sliders`）与双语 `lang` 条目一并移除。
`settings.glsl` 保留定义（值写 1）只为兼容旧配置文件。

`deferred8.csh` / `deferred9.csh` / `deferred1_c.csh` 三个退役入口文件已删除；
`properties` 里对应的 `enabled = false` 行改成一行说明。

## 七、验证

- 三套检查全绿（342 入口，无新增命中）；properties 纯 ASCII、lang 无 BOM。
- 缓冲读写自动提取核对：1_a→3 / 1_b→22,26 / 4→2,14,21 / 5→25 / 6(25→3) / 7(3→25) / 10→24 + 2.rgb / 11→23。
- Node 数值：每遍 8 个 tap **全部落在不同位置**（无 round 回中心的空转），
  半径分配与官方同式同值。

## 八、仍然与官方不同、且是刻意保留的

| 项 | 官方 | 我们 | 理由 |
|---|---|---|---|
| prepass 样本数 | 8（g_Special8） | 32（黄金角） | 我们的输入是 1spp，多用样本换噪声；图案加密版等价 |
| 逐帧旋转 | `NRD_FRAME`（恒开） | GUI 可控，当前关 | 实测「回流 + 逐帧旋转」同时开会静止漂移，留给主人决定 |
| 缓冲尺寸 | `resourceSize = rectSize` | 全分辨率共享缓冲的左上 1/4 | colortex3 是帧内共享暂存（TAA 会全分辨率重写），不能改尺寸 |
| 命中距离存放 | `.a` 贯穿全链 | 独立 colortex26（时域平滑） | 我们的 `.a` 要存帧数 |
| 反萤火虫 | TA 内 fireflySuppressor | 未实现（GUI 有可选中值） | 2.4 面积覆盖率已压掉大部分孤立亮点 |
