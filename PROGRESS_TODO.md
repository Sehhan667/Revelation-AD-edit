# Revelation-AD-edit — GI 调试进度 & 待办（2026-09-04）

## 体积光并入体积雾（2026-09-12）——待实机确认

按「体积雾保持解析（闭式）渲染」的要求，把独立的一层体积光并进雾：雾的太阳 in-scatter 乘上
「沿这条视线的阴影可见度」，被树叶/窗缝/洞口切开的明暗直接长在雾上。密度闭式积分与透射率
**一个字符都没动**，只是多了一个逐射线系数，没有引入步进循环。

链路：IntegrateScene(composite4) 的 `ComputeFogSunVisibility` 沿射线分层取
`VF_VOLUME_SHADOW_SAMPLES`（默认 4）个抖动采样点 → `SampleFogSunShadow`（shadowModelView/
Projection → DistortShadowSpace → 体素平铺 Shift → shadowtex1 硬件比较）→ 平均后传进
`RaymarchAtmosphericFog`。逐像素/逐帧抖动，噪声交给 TAA。超出 shadowDistance（默认档 64）
按未遮挡处理并在最后 8 格内连续淡出。

**实测清单**：
- F3+R 不报错、不退回原版渲染；GUI 的 雾 → 体积雾 页选项正常（新增
  `VF_VOLUME_SHADOW_SAMPLES`；`VF_VOLUME_INTENSITY` 语义已改成"阴影对比度"；`VF_DENSITY_MULT`
  现在也在滑条里）。
- 白天树林/窗边：光束是否随雾浓度、相机高度联动；`VF_VOLUME_SHADOW_SAMPLES` 0 / 2 / 4 / 8 / 16
  逐档看细腻度与噪声（4 档应该已接近原 MODE1 的观感）。
- 夜晚：月光下光束是否还在（月光项跟随 `VOXEL_MOON_STRENGTH`，默认档 2.0；如果夜里雾整体
  偏亮/偏蓝，就是这一项要下调）。
- 关掉 `VOLUMETRIC_FOG` 后光束应完全消失（设计如此：光束就是雾的一部分）；`VOLUMETRIC_LIGHT`
  关掉应回到"雾没有阴影"的旧观感。
- `COLORED_VOLUMETRIC_FOG` 开启后穿过染色玻璃的光束应带玻璃色（默认关；开启后每个采样点多 2 次
  纹理读取）。

**已知取舍**：光束比原 MODE0（1/16 分辨率 × 32 步）软 —— 采样点少、靠 TAA 补；要更锐就往上调
采样数。天空 LUT（GenSkyMap）里的雾不含月光补项（那里在 shadow pass 之前，也没有阴影贴图），
所以夜里夜空背景的雾与屏幕雾可能有轻微亮度差，需实测确认是否看得出来。

## 启动 Logo：改成矢量绘制 + 逐笔描画（2026-09-11）

原来的做法是在 `program/post/Final.frag` 里采样 `shaders/texture/logo.png`（128×128、一共 3 种
颜色）再放大贴到屏幕上 —— 等于把位图硬拉大，边缘全是方块。
现在整段换成**解析式矢量绘制**：`shaders/lib/post/StartupLogo.glsl`，
字形由多边形距离场构成，用 `fwidth` 抗锯齿，任何分辨率下边缘都是干净的 1px 过渡。

**字形**：项目根目录的干净原图（白色 ZV 组合标志 + 纯黑底）。轮廓是**描出来的**：

```
node rdc_analysis/marching_trace.js --tol=0.4   # marching squares 提轮廓 + Douglas–Peucker
node rdc_analysis/stabilize_trace.js            # 顶点稳定化：自动合并亚像素假拐点
```

结果写进 shader 的 `LOGO_POLY0` / `LOGO_POLY1` 两个顶点表（10 + 18 = 28 点），
设计中用「射线法判内外 + 到边界最短距离」求有符号距离，两个多边形取并集。

**标志其实是两个互不相连的笔画**（Z 主体 + V 主体），所以是**两张**顶点表、不能用单张外轮廓。

**验证**（这一步是必须的，之前正是因为没做才错了很久）：
- `rdc_analysis/stabilize_trace.js` 会把多边形栅格化回去和原掩膜比 IoU；
  顶点稳定化后 **IoU = 0.9949**（漏 156 / 多 206 px）。
- `rdc_analysis/diff_shader_vs_source.js` 直接读 shader 里的顶点表复刻一遍渲染，再和原图比：
  **IoU = 0.9872**。两者差值来自源掩膜 bbox（601×284）与设计框（600.45×283.29）之间
  约 0.5 px 的亚像素对齐不确定度，属于正常范围。
- `rdc_analysis/raster_shader_mark.js` 用 JS 复刻 shader 的算法栅格化，可以按 `--progress` 打印
  绘制过程的覆盖率 —— 用它抓到了下面那个"动画方向反了"的 bug。

**过程记录（踩过的坑，别再犯）**：
- **不要用矩形拼字形**。前几版用几十个轴对齐矩形去拼，斜边上必然留台阶，屏幕上就是一圈锯齿
  （IoU 只有 0.82~0.88）。标志是直边多边形，就该老老实实描轮廓。
- **Moore 邻域轮廓跟踪会走丢**：实测漏掉 1538 px，在细颈/斜角处跑偏。
  改用 marching squares 的等值线 + 端点配对串环就没有这个问题。
- **"所有边都是竖直或 45°"这个前提不成立**：原以为在剪切坐标 `(u=x, v=x+y)` 下能把楼梯合并成直线，
  结果一条边都合并不掉（实测 V 的右臂约 53°，不是 45°）。最后靠"顶点稳定化"（合并近共线/过近顶点）解决。
- **设计框常量必须和顶点表同源**。曾经手工填 `LOGO_BOX_*`，比实际 bbox 差 40 个单位，
  形状整体跑出轮廓。现在由追踪脚本输出，两处不会不同步。
- **动画方向容易写反**。`v` 越小越靠左上，所以"从上往下画"要用
  `cov *= 1.0 - smoothstep(sweep - w, sweep + w, v)`；
  一开始写成 `cov *= smoothstep(...)`，结果动画是**倒着擦掉**。
- **扫掠区间的两端必须由 `LOGO_BOX_W/H` 算出来，不能写死**：
  `v` 的实际范围是 `0 .. (W+H)/W`；写死过 1.50（大于真实上限），导致 `progress=1` 时字形是空的。
- 早期还用过 `shaders/texture/logo.png`（128×128、3 种颜色）当参考，它下采样太狠、
  中间几条 3~9px 的缝隙分不清是"缝"还是抗锯齿，不适合做矢量还原。现在 shader 不再引用它，文件保留方便对照。

**绘制动画**：`RenderStartupMark` 沿斜向 `v = (x + y) / LOGO_BOX_W` 自上而下扫出来
（用斜向而不是竖直，是为了贴合标志本身的剪切方向），前沿带一点点宽度。
节奏常量：`LOGO_MARK_DRAW_FRAMES`（主字形 48 帧）、`LOGO_AD_START_FRAME`（0，与主字形同时）、
`LOGO_AD_FADE_FRAMES`（文字整体淡入 30 帧）；总时长 `logoDuration = 180`（在 `program/post/Final.frag`），
**画完后停到第 110 帧**才开始淡出（`logoFadeStart = 110`，比原来的 80 多 0.5 秒）。

**文字不做逐段描画**：`RenderStartupText(p, opacity)` 整行一起按 `opacity` 淡入，
不再按字形/段序号依次"长出来"。原因是和主字形的扫掠叠在一起显得很碎；
而且它是从第 0 帧就开始淡入，**不等主字形画完**（`LOGO_AD_START_FRAME = 0`）。

**速度曲线（只作用于主字形）**：`LOGO_DRAW_EASE`，曲线 `p = 1 - (1 - t)^k`（t = 线性时间 0..1）。
默认 **2.0**（开头快、结尾慢）；`1.0` 就是匀速，`3.0` 更"急刹"。
端点精确（t=0→0、t=1→1），所以不会出现"画不满"。
实测 @k=2、48 帧：画到 25% 只需 0.11s（线性要 0.20s），每帧新增量从 0.160 递减到 0.015。

**预览任意一帧**：`node rdc_analysis/make_logo_gameview.js --frame=24`。
注意扫掠的裁剪区要在**设计坐标**里算 —— 预览里 `<g>` 是镜像过的，
`clip-path` 会跟着一起镜像，坐标不换算就会得到"倒着播"的动画（踩过）。

**"AD Edit"**：字模来自 **Hershey 单线（1-stroke）矢量字体**（`futural` = "Sans 1-stroke"，公有领域）。
选它是因为它本身就是"每笔画一条折线"，和这里"线段距离场 + 圆头端点"的渲染方式完全对得上，
不需要引入贝塞尔曲线。数据取自 `hersheytext.json`（npm 包 hersheytext），放在 `rdc_analysis/`。

```
node rdc_analysis/gen_ad_font.js --text "AD Edit"   # 取字形 -> 归一化 -> 写进 shader
node rdc_analysis/sheet_table.js                    # 把表里实际生效的字形逐个画出来核对
node rdc_analysis/preview_text.js --px=110          # 大字号看整行
```

**踩坑：这份字体的下标不能按 ascii 推算。**
试过 `ascii-32`、`ascii-31` 两种偏移都不对（`D` 会取到 `E` 的字形，屏幕上直接是 `ABEgU` 乱码）。
而且同一个字母的"部件"会单独占一个下标（`d/o/e` 的碗、`i` 的点各自一个条目）。
最后是先用 `gen_ad_font.js` 里的 `GLYPH_INDEX` 手写映射，再用**包围盒断言**自动校验
（每个字形的实测 bbox 必须和期望一致，不符就报错退出），才算钉死。
现在这份映射是：`A=32, E=36, D=67, d=67, i=72, t=83`（其中大写 `D` 借用了字体的 `d`，
因为这个字体里没有带直边的方框 `D`，借来的 `d` 视觉上是完整的 D）。

**排版**：字体自带的 `o` 对有些字形是偏的，而且字形带**负左边距**
（`d` 的墨迹从 -0.056 开始），直接拿 `o` 当步进会让相邻字母叠在一起。
所以生成时把每个字形按**自己的墨迹宽度**居中到一个固定宽的格子（`LETTER_ADV=0.98`，
空格 `SPACE_W=0.52`），步进值写进 `AD_ADVANCE`，shader 只按它步进。

**笔画宽度**：`LOGO_AD_STROKE = 1.6` 源像素（≈屏幕上 1.3px），刻意接近主字形自己的笔画宽度；
之前用"字号的比例"当笔画宽度，字一粗就比标志还重，而且字母会粘在一起。

**屏幕上下翻转（重要）**：`LOGO_FLIP_Y`（默认 1）。
设计框的 y 是**向下**为正（跟源图一致），而片元坐标的 y 是**向上**为正，两者差一个符号。
上一版漏了这一步，实机里表现为"**图案上下倒过来，而且文字跑到图案上方**"——两个症状必须同时出现
才算诊断对（只倒图案、文字位置不变是不可能的，两者共用 `p`）。
`LOGO_FLIP_Y=1` 时在 `StartupLogoMask` 里做一次 `p.y = contentH - p.y`，图案和文字会一起翻正。
对照图：`node rdc_analysis/render_flip_pair.js` → `rdc_analysis/flip_pair.html`。

**待实测**：F3+R 确认图案方向、逐笔描画是否顺畅、`AD Edit` 大小位置是否合适
（旋钮：`LOGO_HEIGHT` 0.22、`LOGO_OFFSET_Y` -0.02、`LOGO_AD_GAP` 46、`LOGO_AD_H` 52、
`LOGO_AD_STROKE` 2.8、`LOGO_DRAW_EASE` 2.0、`LOGO_AD_FADE_FRAMES` 30、`LOGO_FLIP_Y` 1）。

**调参记录（2026-09-12）**：实机反馈"文字偏小、太细、离标志太近"，之后又"再往下一些、绘制要前快后慢"，
再之后"文字不要逐段描画、要和 logo 同时开始淡入、还是偏细"。
- `LOGO_AD_H` 40 → **52**（屏幕上大写高 33.5 → 43.6px）
- `LOGO_AD_STROKE` 1.6 → 2.0 → **2.8**（屏幕上 1.34 → 1.68 → 2.35px）——偏细反馈了两次
- `LOGO_AD_GAP` 24 → 33 → **46**（分两次往下推；屏幕上净下移约 19px）
- 字号变大让内容块变高、整体被压低约 34px，所以 `LOGO_OFFSET_Y` -0.04 → **-0.02** 顶回来
- `LOGO_DRAW_EASE` 新增，取 **2.0**（先快后慢）
- 文字改为 `RenderStartupText(p, opacity)` 整体淡入；`LOGO_AD_DRAW_FRAMES`(24) 换成
  `LOGO_AD_FADE_FRAMES`(30)；`LOGO_AD_START_FRAME` 34 → **0**

## 阴影 warp（RTWSM）：修到可用，待实机确认（2026-09-11）

上一轮把 RTWSM 打开后整包不可用（F3+R 直接退回原版渲染），根因是**两个"注释里的字符"**，
不是算法问题：

1. `program/setup/ShadowWarp.comp` 的文件头注释里多写了一个半角双引号。Iris 是在**源码文本**上
   扫描 `#include` 行的，注释里成对的引号会被它当成字符串界定符 → 紧跟其后的
   `#include "/lib/lighting/shadow/Common.glsl"` 被解析成 `lib/lighting/shadow/Common.glsl" + 文字`
   → `java.nio.file.InvalidPathException: Illegal char <">` → 整包加载失败。
   **规矩**：`.glsl/.comp/...` 的注释块里不要出现半角双引号（`.lang` 里可以）。
2. `settings.glsl` 第 358 行的行注释里写了 `world*/composite1.csh`。`//` 注释里的 `*/` 会让
   Iris 的 GLSL 解析器把块注释状态搞错 → `setup12` 解析报
   `line 2602:7 extraneous input '?'`。**规矩**：行注释里别写 `*/`，用 `|` 分隔目录名。
3. 顺手在 `Warp.glsl` 里把新写的密度因子写成了 `SHADOW_WARP_CONTENT_STRENGTH`，而真名是
   `RTWSM_CONTENT_STRENGTH`（**Iris GUI 选项名**，`shaders.properties`/lang 都按它索引）
   → `setup12` 报 `error C1503: undefined variable`。Iris 管理的选项名不能自己改名。

### 防同类问题的离线检查（新增工具）

`rdc_analysis/preproc_check.js`：不依赖游戏，把某个入口的 `#include` 递归展开后跑一遍
`#define`/`#if*`，报告"全大写标识符里从未被定义、也没在条件编译里引用过"的名字 ——
上面第 3 条那种笔误（以及第 1 条那种 include 被引号劫持）都能在 F3+R 之前抓到。

```
node rdc_analysis/preproc_check.js shaders/world0/setup12.csh   # 单个入口
node rdc_analysis/preproc_check.js --all                        # 全部 350 个入口
```

已知会有若干"本来就命中"的碎片入口（DH / begin / blocks 等由 Iris 拼装后再编译，单独展开时
名字天然不全），已记进 `rdc_analysis/preproc_check.baseline.json`；只有**基线之外的新增命中**
才会亮灯。`--update-baseline` 重新记录基线。

当前状态：350 个入口全部无新增命中（三个 setup12、DeferredLight、shadow vsh/vert 单独复检也干净）。

同时修掉三处会让 RTWSM"能开但不好用"的问题：

3. **表项合法区间写读不一致**（`Warp.glsl` 的 `WarpEntryInvalid` 写 `[0.01, 64]`，填表端实际夹在
   `[0.05, 32]`）。校验比写入更严 ⇒ `RTWSM_CONTENT_STRENGTH` 一大就有成片**合法**表项被判坏、
   逐点回退解析曲线 ⇒ 表与兜底曲线混用 ⇒ 阴影边缘错位。现在上下界统一为
   `SHADOW_WARP_SLOPE_MIN/MAX`，由 `Warp.glsl` 提供、填表端复用。
4. **解析兜底没归一化**：表是 CDF 拉伸到铺满 `[-1,1]` 的，恒等于"解析曲线 × k"（k = 曲线在
   `|u|=1` 处的取值），而兜底直接用未归一化的曲线 ⇒ 角点只有表的一半左右，混用即突变。
   现在 `WarpAxisAnalytic` 乘上 `1/WarpAxisCurveAnalytic(1.0)`；`WarpAxisScaleAnalytic` 也补了
   下限（中心差分在 u→0 有抵消误差，可能算出 0 ⇒ 偏置归零 ⇒ 大面积自阴影）并夹到合法区间。
5. **体素平铺条带没有分辨率下限**：开体素化时阴影图左侧 256 纹素宽的竖条是体素立方体平铺区，
   而 warp 逐轴分配看不出这条竖条 ⇒ 内容驱动把它压扁 ⇒ 体素 GI 的太阳阴影花掉。现在
   `DeferredLight.frag` 的 `ShadowWarpImportanceAt` 对落在条带内的 x 给 `[0.6, 1]` 的渐变下限
   （渐变而非阶跃：阶跃本身就是 warp 条纹的来源）。

顺带把测量端与填表端各自一份的归一化/密度夹紧收成 `Warp.glsl` 里的
`ShadowWarpRelativeImportance` / `ShadowWarpDensityFactor`，并在 `ShadowWarp.comp` 里写清
"CDF 最后会整体归一化 ⇒ k 不改变总覆盖、只改局部斜率"（否则很容易误以为 k 应该改变总覆盖）。

**待实测**（改的都是编译期/数值问题，静态检查已全通过，但没有游戏内验证）：
- F3+R 换包不报错、不再退回原版渲染（这条是本次的主要目标）。
- `SHADOW_WARP_RTWSM` 开/关各走一圈：贴墙/贴地移动看有无整块自阴影、阴影边缘有无错位或条纹。
- `RTWSM_CONTENT_STRENGTH` 0 → 1 → 2 看是否**有梯度**（此前"和 0 没区别"是信号被夹平）。
- 开体素化时体素 GI 的太阳阴影是否仍正常（对应上面第 5 条）。
- 诊断：先关着 `SHADOW_WARP_RTWSM`、开 `DEBUG_SHADOW_WARP_DIFF`——R 沿两轴应接近 0、
  整屏不发蓝（发蓝 = 表没写进来）；再开 `DEBUG_SHADOW_WARP` 看分辨率挪到哪儿去了
  （B = 表项局部缩放，亮 = 该点分到更多阴影分辨率）。

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
- [2026-09-06 Voxel Cone Tracing 实验档 v1] 新增 VOXEL_CONE_GI（默认关，Debug→Voxel 页 GUI）：
  - lib/lighting/VoxelCone.glsl：IRC 辐照度+占用 mip 金字塔（32/16/8³，A/B 帧奇偶组）构建函数
    VoxelMipBuildTask（74752 任务由 deferred1_a 全 dispatch 分摊，读上一帧块→写当前奇偶组，
    采样读另一组 → 与 IRC 自反弹同级的 1 帧滞后，同 dispatch 无竞争）与半球 5 锥×4 档采样
    VoxelConeIrradiance（占用透射 exp2(-K·occ) 软遮挡；出界=skyColor 方向近似×lightmap 门控）。
  - DiffuseIndirect：VXGI 分支结果改用锥采样（×VOXEL_GI_TRACE_STRENGTH，与 DDA 档同数值链）；
    原 DDA/ReSTIR 路径在 #else 完整保留。
  - 新增 12 张 image（voxelRadMip2/4/8{A,B}、voxelOccMip2/4/8{A,B}），settings/lang 双语已加。
  - 待实测（A/B）：开/关亮度校准（VOXEL_CONE_STRENGTH vs 1.0）、墙体漏光（VOXEL_CONE_OCC_K 2.2 调大）、
    帧数提升幅度、与 COARSE/FINE/SSS 叠加效果。已知近似：近距细节与天空/阳光方向性弱于 DDA 档。
  - [2026-09-06 放弃并彻底移除] 定位澄清：锥追踪是"换质量换速度的低质量档"，不保留逐像素
    追踪的方块光/自发光近场（点光源采不到）→ 用户决定放弃。已删除 VoxelCone.glsl、properties
    image/screen 条目、settings/lang 定义与 DiffuseIndirect 接入。逐像素追踪本身的**无损**加速
    已有：VOXEL_COARSE_ACCEL/FINE_ACCEL（空洞跳跃，已 GUI 化）；另可恢复 ReSTIR（VOXEL_REUSE，
    需补 4 张 reservoir image + 去 VoxelLighting 强制 undef）。
