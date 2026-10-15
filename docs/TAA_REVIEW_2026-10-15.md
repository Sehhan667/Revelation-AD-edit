# TAA 功能审查（2026-10-15）

**一句话结论**：TAA 的**骨架是完整的**（R2 抖动序列 + 当前/上一帧 jitter uniform、深度重投影、
历史缓冲、双模式、以及 YCoCg / 运动模糊 / 泛光 / DOF 的下游约定全部对齐，pass 顺序自洽），
但**接线与实现有 9 处不完善**，其中 3 处会在**默认配置下直接生效**：默认档（`TAA_QUALITY_MODE=1`
性能模式）下 8 个 TAA 旋钮里**有 5 个是死的**、**运动降权是空转**（等于没有抗拖影）、
以及**重投影整体差半个抖动像素**（历史永远对不齐，TAA 偏软 / 收敛不彻底）。

> 本次只做审查，未改动任何 shader。工作区原有的 `MEMO.md` 修改与若干未跟踪文件不是本次产生的。

---

## 0. 审查范围与方法

| 项 | 内容 |
|---|---|
| 主实现 | `shaders/program/post/TemporalAA.frag`（264 行，两种模式） |
| 入口 | `world0|world1|world-1/composite7.fsh` → 三世界同一实现 |
| 上下游 | `IntegrateScene.frag:484`（YCoCg 编码门）、`DOF/Gather.comp`（composite6_a，TAA 前）、
`MotionBlur.comp`（composite10_a，读 TAA 写的 colortex3）、`bloom/Downsample.comp` +
`bloom/Blur.comp`（composite20_a/21_a，读 TAA 输出）、`GradeCore.glsl:196-213` |
| 接线 | `settings.glsl:496-505`、`shaders.properties`（`profile.Default` / `screen.TAA` / `sliders` /
`uniform.taaJitter`）、`lang/zh_CN.lang:585-594`、`lang/en_US.lang:549-555` |
| 抖动施加点 | 全部 13 个吃抖动的顶点着色器（逐一扫过，见 §4） |
| 运行期配置 | `shaderpacks/Revelation-AD-edit.txt`（Iris 记住值，仓库外）：用户实际为 `TAA_MAX_ACCUM_FRAMES=24.0` |
| 静态检查 | `node scripts/preproc_check.js --all` → 329 入口"无新增命中"；`shaders.properties` 非 ASCII=0；
两个 lang 无 BOM；`#if*`/`#endif` = 688/688 |

**注（决定了两条结论的判断依据）**：Iris 的选项是从**包里所有着色器文件**里扫 `#define … // [候选值]`
得到的，不限于 `settings.glsl`。证据：`AMBIENT_BRIGHTNESS_MULTIPLIER`（只定义在
`program/DeferredLight.frag:73`）、`NOISE_SIZE`、`TONE_MAPPER` 等都出现在 Iris 的记住值文件里，
且 `docs/CODE_REVIEW_2026-09-12.md:80-85`（M2）明确说这类选项"界面上会显示原始英文名"。
所以 `TAA_QUALITY_MODE`（只声明在 `TemporalAA.frag:22-24` 的 `#ifndef` 里）**是**一个真选项。

---

## 1. 结论速览

| # | 严重度 | 问题 | 默认配置下生效？ |
|---|---|---|---|
| P1-1 | 🔴 | 默认档（性能模式）下 5 个 TAA 旋钮是死的：`TAA_MAX_ACCUM_FRAMES` / `TAA_ANTIFLICKER` / `TAA_AGGRESSION` / `TAA_CLIPPING` / `TAA_SHARPEN` | 是（含用户已设的 24.0） |
| P1-2 | 🔴 | 性能模式的"运动抗拖影"数值上等于空转（UV/像素单位搞错）⇒ 默认档**没有任何**运动降权 | 是 |
| P1-3 | 🟠 | 历史读**少加 `taaJitterPrev`** ⇒ 与 canonical 写法差半个抖动像素（继承自上游；`Accumulate.frag` 用的是 canonical 写法，两种读法见 P1-3） | 是 |
| P1-4 | 🟠 | `lang/en_US.lang` 缺 `TAA_QUALITY_MODE` 与 `value.TAA_QUALITY_MODE.0/1`（zh 有） | 英文界面可见 |
| P2-1 | 🟠 | 运动降权被 `#ifdef MOTION_BLUR` 绑架：关掉"动态模糊"会顺带废掉 TAA 唯一的运动拒绝 | 改设置后 |
| P2-2 | 🟠 | `historyReset`（仓库自带的"时域重置"信号）**没接进 TAA**，只有 GI 的 `Accumulate.frag` 用了 | `/time set`、切维度 |
| P2-3 | 🟠 | 质量模式的椭球裁切有 `0/0` 入口 `prevData / clipStdDev` ⇒ `saturate(NaN)` 未定义行为 | 切到"质量"档 |
| P3-1 | 🟡 | 死代码/死文件：`TemporalAA.fragold`（不在 H2 清单里）、`accumFrames`、`historyClipAABB` | 否 |
| P3-2 | 🟡 | 注释与选项落点：`RENDER_MODE` 0 的注释说成"手持物品模式"（实为离线渲染）；`TAA_QUALITY_MODE` 没写在 `settings.glsl`；`clearOut` 没写"为什么" | 否 |
| F1-F4 | 🟡 | 完善度缺口：无物体运动矢量、反射无专用时域策略、等效累积只有 ~10 帧、抗闪烁/锐化默认不可用 | 见 §3 |

### 1.5 本次已实施的改动（除 P1-2 外都默认「关 / 0.0」；P1-2 直接生效但静帧逐位不变）

| 改动 | 位置 | 默认值 | 怎么验 |
|---|---|---|---|
| P1-2 运动降权单位修复（UV → 像素，系数 0.01） | `TemporalAA.frag` 模式 1 | 直接生效（**静止镜头逐位不变**：velocityPixels=0 ⇒ 0.9） | 快速平移 / 贴近看生物与树叶边缘 |
| P1-4 en 文案 + P1-1 的「仅质量模式」标注 | `lang/en_US.lang`、`lang/zh_CN.lang` | 文案 | 切中英文各看一遍 GUI（含 tooltip） |
| P2-2 `historyReset` 接入 | `TemporalAA.frag` 两个模式 | `//#define TAA_HISTORY_RESET`（关） | `/time set night` 看有没有一帧旧光照残留 |
| P2-3 裁切标准差下限 | `TemporalAA.frag` 模式 0 | `TAA_CLIP_STDDEV_MIN 0.0`（= 现状） | 切「质量」档 + 平坦天空/纯色墙扫视，填 0.001 对比 |
| P1-3 历史抖动对齐 | `TemporalAA.frag` 两个模式 | `//#define TAA_PREV_JITTER`（关） | 开关各看一遍：静帧噪点/软硬、慢速平移拖影 |
| P3-1 删死文件 | `program/post/TemporalAA.fragold` | 已删（`git add` 已暂存删除） | `preproc_check --all` |
| P3-2 注释纠错（离线渲染分支） | `TemporalAA.frag` `RENDER_MODE 0` 分支 | 注释 | 读 |

三条新选项按 §4 四件套接线完毕：`settings.glsl:507-511`（定义）→ `shaders.properties` 的
`profile.Default` / `screen.TAA` / `sliders` → 双语 lang（含 `.comment` 说明"仅质量模式生效"）。
「仅质量模式」用**文案标注**而不是 properties 的 `#if` 分组，是因为 `PROGRESS_TODO.md:643` 记着
「Iris 有时拿不到整型选项值」；且本仓已有同样做法的先例——
`option.FXAA_ENABLED=FXAA（未接线）`（`lang/zh_CN.lang:977`，FXAA 实现已删，此开关本来就是死的，
属于既有已知项，不是本次发现）。**仍待用户裁定**：P1-1 修法 2（让性能模式吃累加权重，会改变观感）、
P2-1（去掉 `MOTION_BLUR` 门控）、F1（物体运动矢量）。

---

## 2. 缺陷详述

### P1-1 默认档下 5 个 TAA 旋钮是死的（含用户已设的 `TAA_MAX_ACCUM_FRAMES=24.0`）

**证据**

- `settings.glsl` 没有 `TAA_QUALITY_MODE`；唯一默认值在 `TemporalAA.frag:22-24`：`#ifndef` → **1（性能）**。
  `shaders.properties:8` 的 `profile.Default` 也**显式**写 `TAA_QUALITY_MODE=1` ⇒ 出货默认就是性能模式。
- 性能模式（`#if TAA_QUALITY_MODE == 1`，`TemporalAA.frag:123-160`）里：
  ```glsl
  float accumFrames = min(++temporalData.a, TAA_MAX_ACCUM_FRAMES);   // L149：算了不用
  const float historyWeight = 0.9;                                    // L152：固定权重
  ```
  ⇒ `TAA_MAX_ACCUM_FRAMES` 在默认档**零消费点**。
- `TAA_ANTIFLICKER`（L206）、`TAA_AGGRESSION`（L193）、`TAA_CLIPPING`（L181）、
  `TAA_SHARPEN`（L169）**全部只在 `#else`（质量模式，L163-213）里出现**。
- 用户在 Iris 里实际设了 `TAA_MAX_ACCUM_FRAMES=24.0`（`shaderpacks/Revelation-AD-edit.txt:53`），
  且它同时挂在 `screen.TAA`（`shaders.properties:209`）与 `sliders`（`:265`）上 ⇒ 界面上能拖、
  画面完全不变。这正是 `docs/CODE_STYLE.md` §8.6 禁止的"半成品接线：点了没反应的项"。

**为什么不能靠"把默认档改成质量模式"了事**：质量模式也吃同一套 GUI；两者是二选一，
所以旋钮必然有一半在任一档下失效。

**修法（按风险从低到高）**

1. **零观感变化**：把 4 个质量模式专属项从 `screen.TAA`（`:209`）与 `sliders`（`:265`、`:276`）
   里挪进 `#if TAA_QUALITY_MODE == 0` 分组——该文件已有 `#ifndef VOXY`（`:1126`）、
   `#if EXPOSURE_MODE != AUTO_HISTOGRAM`（`:1141`）先例。
   ⚠️ 但 `PROGRESS_TODO.md:643` 记着"Iris 有时在预处理里拿不到整型选项值"的坑 ⇒ 更稳的做法是
   **给每条文案加后缀说明**（如"仅质量模式"），或两者都做（分组 + 文案兜底）。
2. **让性能模式也吃累加权重**（`blendFactor = 1 - rcp(accumFrames)`）：这能让
   `TAA_MAX_ACCUM_FRAMES` 真正生效，但会改变默认观感（现在固定 0.9 ≈ 10 帧指数平均，
   改到上限 64 会**加重拖影、减轻闪烁/噪点**）。按 §4 铁律一必须**单独提交 + 用户 A/B**。

### P1-2 性能模式的"运动抗拖影"是空转

```glsl
// TemporalAA.frag:153-158（性能模式）
#ifdef MOTION_BLUR
    float velocity = length(prevCoord - screenCoord) * 10.0;
    float blendFactor = clamp(historyWeight - velocity * 0.02, 0.0, 1.0);  // 0.9 → 0.899
#else
    float blendFactor = historyWeight;
#endif
```

`prevCoord - screenCoord` 是 **UV 单位**（量级 0.001~0.03），×10 再 ×0.02 = ×0.2：
1920 宽下 10 像素/帧的运动只把历史权重从 0.900 降到 0.899（**万分之几**，肉眼不可见）。
即使把整屏当成位移（UV≈1.4）也不过 0.62。⇒ 默认档**实际上没有任何运动降权**。

对照质量模式（同文件 `:209-210`）用的是**像素**单位且带 `saturate`，才有效果：

```glsl
float motionPixels = length(motionVector * viewSize);                  // 像素
blendWeight = max(blendWeight * (1.0 - saturate(motionPixels * 0.02)), 1.0);
```

**影响**：移动物体、手臂、以及 `TODO.md #0` 的反射拖影，在默认档只能靠 3×3 凸包夹逼兜底
（夹逼能压住"历史飞出邻域"的极端拖影，但压不住"历史落在邻域内、方向不对"的中度拖影）。

**修法（已实施，1 行 + 注释）**：

```glsl
float velocityPixels = length((prevCoord - screenCoord) * viewSize);   // 像素
float blendFactor = clamp(historyWeight - velocityPixels * 0.01, 0.0, 1.0);
```

系数 0.01 的标定表（历史权重 → 当前帧权重 = 1 - 权重）：
10 像素/帧 → 0.80（当前帧 0.20）、20 → 0.70（0.30）、50 → 0.40（0.60）、90 及以上 → 0.0（完全让位当前帧）。
**静止镜头 `velocityPixels = 0` ⇒ 权重恰为 0.9，与改动前逐位一致**（静帧画质不受影响，
所以这条不需要对照开关；要回退就是改一个常数）。量级与质量模式的 50 像素饱和同向但更早介入，
因为性能模式固定只给当前帧 10% 权重，抗拖影余量本来就小。

**溯源**：这段与上游 `1reve-main/shaders/program/post/TemporalAA.frag` 逐字相同 ⇒ **继承缺陷**，
不是本次改动引入。但本仓 `Accumulate.frag:152-153` 已经用 `length(prevCoord - currCoord)`（UV）
配 `smoothstep(0.02, 0.06, …)` 做出了正确量级，说明"正确的做法就在隔壁"。

### P1-3 历史读少加 `taaJitterPrev` ⇒ 整条重投影差半个抖动像素

```glsl
// TemporalAA.frag:223 / 239 / 119 / 129
vec2 screenCoord = gl_FragCoord.xy * viewPixelSize;                      // 本像素中心（未抖动网格）
motionVector = screenCoord - ReprojectScreenPos(vec3(screenCoord, depth)).xy;
ivec2 texel = uvToTexel(screenCoord + taaJitter * 0.5);                  // ← 名义补偿
vec4 temporalData = texture(colortex1, prevCoord);                       // ← 没有 + taaJitterPrev*0.5
```

推理链：

1. 顶点端 `gl_Position.xy += taaJitter * gl_Position.w`（NDC 偏移，写法正确）⇒ 本帧像素 `j`
   的颜色/深度其实是"**抖动子像素位置** `c_j + J/2`"的采样。
2. `uvToTexel(c_j + J/2)` 因 `|J·W/2| ≤ 0.5` 恒等于 `j` ⇒ 这个 `+taaJitter*0.5` 实际是**空操作**
   （不会改选像素），"补偿"并没有把颜色搬回未抖动网格。
3. 于是当前样本在 `c_j + J/2`，而重投影原点传的是 `screenCoord = c_j`（差 J/2）；
   而历史 `colortex1` 同样是**抖动采样**（上一帧像素 `k` 存的是 `c_k + J_prev/2`），
   读的时候又没加 `J_prev/2`（再差 J_prev/2）。
4. 两个相位独立 ⇒ 历史与当前样本的错位是 ~0.35px RMS（各 ≤0.5px）。静止画面下 jitter 每帧变，
   历史永远取到"同一个表面点附近 ±0.5px"的位置 ⇒ **TAA 偏软、收敛不彻底**，
   并且这套错位会传给 `colortex3` 的运动矢量（动态模糊同源）。

**仓库内对照（这是最硬的自证）**：`Accumulate.frag:67-78` 是同一个问题的正确写法——
`ScreenToViewPos()`（内部 `ndcPos.xy -= taaJitter`）先把原点换算成**实际采样点**，
重投影后再 `prevNDCPos.xy += taaJitterPrev`（NDC 全程 ⇒ 等于 UV 的 J/2）。TAA 两半都缺。

**修法（自洽版本，两行）**：

```glsl
vec2 sampleCoord = screenCoord + taaJitter * 0.5;                        // 本帧实际采样位置
...
motionVector = sampleCoord - ReprojectScreenPos(vec3(sampleCoord, depth)).xy;   // 未抖动位移（给运动模糊）
vec2 prevCoord = sampleCoord - motionVector + taaJitterPrev * 0.5;              // 上帧实际采样位置
```

（`depth` 与颜色取自同一像素 ⇒ 本来就互相自洽，不需要动 `loadDepth0`。）
⚠️ 这是次像素改动，会让画面**略微变锐 / 收敛更干净**，属于观感变化 ⇒ 按仓库方法论
单独提交 + A/B（对照开关建议 `TAA_PREV_JITTER`）。

**被否决的替代方案（记录在案）**：还有第二种自洽读法——「按同一像素索引取历史」，
理由是抖动是**子像素**的（`taaJitter` 量级 = 1/viewWidth ⇒ 幅值 ≤0.5 像素），像素索引基本不变，
所以取该像素上一次的采样本身就是"同一表面点的另一个相位"，正是 TAA 想要的积分。
这一读法下现状代码是对的，而加 `taaJitterPrev` 会把双线性权重从邻居带进来（等价于多一点模糊）。
两种读法只差不到半个像素、都能自洽，因此**本次只提供默认关的开关 A（canonical 写法，
与 `Accumulate.frag` 一致），由实机 A/B 裁决**；A/B 结论应写回 `MEMO.md`，
免得下次又被当成"到底谁对"重新推一遍。（`RENDER_MODE 0` 的静止累积路径故意不套这个偏移，
理由见 `TemporalAA.frag` 该分支注释：那里每个像素就是要累积自己的抖动相位。）

### P1-4 `en_US.lang` 缺 TAA 模式文案

- `lang/zh_CN.lang:586-588`：`option.TAA_QUALITY_MODE=taa模式`、`value.TAA_QUALITY_MODE.0=质量`、`.1=性能`
- `lang/en_US.lang`：三条**全缺**（`:549-555` 只到 `TAA_ANTIFLICKER`）

⇒ 英文界面显示原始宏名 `TAA_QUALITY_MODE` 与裸数字 `0/1`。
这是 `docs/CODE_REVIEW_2026-09-12.md` M2（"有 GUI 没文案"，原清单 11 条）的**新增实例**，
不在原清单里。修法：补 3 条（`option.TAA_QUALITY_MODE` / `value.TAA_QUALITY_MODE.0` / `.1`），
顺手可把 `#if` 分组方案（P1-1 修法 1）的"仅质量模式"提示一起加进文案。

### P2-1 运动降权被 `#ifdef MOTION_BLUR` 绑架

`TemporalAA.frag:153-158`：TAA 的运动拒绝只在**动态模糊开着**时才编译进去。
把"动态模糊"这个**后处理**开关关掉（`settings.glsl:508`，Default 档默认开），
TAA 就退化成固定 0.9 历史权重 ⇒ 拖影变重，而用户完全不会把两件事联系起来。
（运动矢量的写出 `motionVectorOut`（`:37-40`、`:243-245`）才应该由 `MOTION_BLUR` 门控——
它现在也确实由它门控，所以两件事本来可以干净分开。）

**修法**：删掉这个 `#ifdef`，让 `blendFactor` 恒按速度降权；`MOTION_BLUR` 只保留
"写不写 colortex3"的职责。

### P2-2 `historyReset` 没接进 TAA

`lib/universal/Uniform.glsl:161` 的定义与注释写得很清楚：
`uniform bool historyReset; // 世界时间变化/维度切换时 true（时域累积重置信号）`。
仓库里只有 `Accumulate.frag:84`（GI）消费了它，**TAA 一次都没读**。
⇒ `/time set`、切维度后的第一帧，TAA 仍按 0.9（性能模式）混上一帧的历史；
因为 3×3 凸包夹逼会把历史拉回当前邻域，所以通常看不出大问题——
但这是"信号齐备却没人接"的接线缺口，正是拖影类问题的低成本保险丝。

**修法**：在 `TemporalReprojection` 开头与越界早退同形：
```glsl
if (historyReset) return vec4(currentRGB, 1.0);   // 计数归 1，与越界路径一致
```
代价 = 一次 uniform 读；质量模式那份 `currData` 需相应改成 `YCoCgToRGB(currData)`（同 `:166-167`）。

### P2-3 质量模式椭球裁切有 `0/0` 入口（NaN）

```glsl
// TemporalAA.frag:193-198（仅质量模式，且 TAA_CLIPPING 默认开）
vec3 clipStdDev = sqrt(abs(moment2 - moment1 * moment1)) * TAA_AGGRESSION;
prevData -= moment1;
prevData *= saturate(inversesqrt(sdot(prevData / clipStdDev)));   // ← clipStdDev 可为 0
prevData += moment1;
```

平坦 3×3 邻域（fp16 下天空、纯色墙面、饱和区很常见）`stdDev` 逐通道可为 **0**；
而收敛后 `prevData == moment1` 时 `prevData / clipStdDev` 是 **0/0 = NaN**，
`saturate(NaN)` 在 GLSL 里是**未定义**的（不同 GPU 返回 0 或 NaN）⇒ NaN 会顺着
`perceptualWeightInv`（除 `1-Y`）扩散，表现为局部黑/白噪点或闪烁。
上游 Playdead 写法同形，但通常配一个 `min` 下限。

**修法**（二选一）：
- `clipStdDev = max(clipStdDev, vec3(EPS_CLIP));`（最小容差，例如 `1e-4`，观感差异可忽略）；
- 或改用同文件 `:81-89` **已经写好但从未被调用**的 `historyClipAABB`（AABB 版无除法奇点），
  顺带消掉一个零引用函数（见 P3-1）。

### P3-1 死代码 / 死文件

| 对象 | 现状 | 建议 |
|---|---|---|
| `program/post/TemporalAA.fragold` | 模式拆分前的完整旧副本，**全仓零 `#include`**；且**不在** `CODE_REVIEW` H2 的 10 个死文件清单里（该清单按扩展名扫，漏了 `.fragold`） | 删（`rm` + `git add -A`），或按 §2 约定改名 `.frag1` 并在 `MEMO.md` 登记"被禁用 pass 清单"（L1 建议）。**留在原地最危险**：下次改 TAA 容易改错文件 |
| `accumFrames`（`TemporalAA.frag:149`） | 性能模式算了不用 | 随 P1-1 一起处理（要么真用，要么删，别留 `// 自增` 式误导） |
| `historyClipAABB`（`:81-89`） | 零引用 | 随 P2-3 一起启用，或删 |

### P3-2 注释与选项落点（`CODE_STYLE.md` §1 / §3）

1. `TemporalAA.frag:253` 注释写"手持物品等特殊渲染模式的快速混合逻辑"，但按
   `lang/zh_CN.lang:123-124`，`RENDER_MODE 0` 是**离线渲染/截图**、`1` 是实时渲染；
   手持物品走 `gbuffers_hand`（`program/gbuffers/Hand.vert` 照常吃抖动、照常被 TAA 处理）。
   注释与事实不符 ⇒ §3 要求"写为什么"且准确。顺带：`RENDER_MODE` 有 lang 文案却没有挂在
   任何 `screen.*` 上，GUI 里改不到（只能改 `settings.glsl` 或 Iris 记住值文件）。
2. `TAA_QUALITY_MODE` 声明在 `TemporalAA.frag:22-24`，而不是 `settings.glsl:496-505` 的
   `/* TAA */` 段。能跑通（Iris 扫全包、`profile.Default` 也注入 1），但读 `settings.glsl`
   时看不到这个选项，且 §1 明确要求"所有选项定义在 settings.glsl"。建议搬进 `/* TAA */` 段。
3. `clearOut`（`:35`、`:219`）只写了"做了什么"。它其实是**给泛光 L0 画布做每帧清零**
   （`colortex4` 左上象限半分辨率区，`GradeCore.glsl:61` 读它）；而 `colortex4` 同时还是
   **SSR 反射源象限**（`ReprojectScene.comp` 在 deferred1 写、TAA 之前就被
   `DeferredLight`/`Translucent.comp:223` 消费完，泛光重写发生在 composite20_a/21_a）。
   顺序上安全，但这是"靠 pass 顺序保命"的隐式契约，值得一行注释，否则下次调 composite
   编号就会踩（`config.glsl:71` 的 `colortex4Clear = false` 让这个清零点更不明显）。

---

## 3. 完善度缺口（feature 级）

### F1 没有物体运动矢量（最大缺口）

运动矢量完全由"深度 + 相机矩阵"重投影得到（`:239`），**只覆盖相机运动**。
会动的几何体在 TAA 眼里全是静止的 ⇒ 用错历史 ⇒ 拖影/闪烁：

- 生物、掉落物、船、盔甲架（`program/gbuffers/Entities.vert`）
- `WAVING_FOLIAGE` 摆动的树叶（顶点位移在 `Terrain.vert`，TAA 无法从深度复原）
- 水面波浪（`Water.vert` / `WaterWave.glsl`）、粒子、（第一人称之外的）手臂摇摆
- 动画纹理（熔岩/水/传送门）本身没有位移，但会改变亮度 ⇒ 靠夹逼兜底

上游把 `TAA_CLOSEST_FRAGMENT`（`TemporalAA.frag:48-68`，只取 4 个**对角**深度）当作
"改善运动物体拖影"的缓解手段，而 AD-edit 的 Default 档明确 `!TAA_CLOSEST_FRAGMENT`
（`shaders.properties:8`，性能考虑）⇒ **默认档连这个缓解都没有**。

**建议**：
- 便宜档：给"位移是时间闭式函数"的两类几何补上一帧位置——树叶摆动与水面波浪都能解析求
  上一帧相位，在 `Terrain.vert`/`Water.vert` 里把 `(本帧屏幕位置 - 上一帧屏幕位置)` 写进
  运动矢量缓冲。收益直接落在最显眼的两个场景（树叶/水面边缘）。
- 完整档：加一张速度 G-buffer（实体用 `gbufferPreviousModelView`，其它用 `.vert` 里的
  上一帧位移），TAA 优先读它、缺省才回落到深度重投影。成本中等，建议单独立项进 `TODO.md`。
- 另外：`TAA_CLOSEST_FRAGMENT` 若要在 GUI 里作为"抗拖影"选项推给用户，
  建议文案注明代价（4 次深度采样），并考虑把 4 对角扩成 4 邻域（对角会漏掉水平/垂直边缘）。

### F2 反射/半透明没有专用运动矢量或时域策略

`TODO.md #0`（2026-09-03 暂缓）与 `docs/SSR_REVIEW_2026-10-08.md`（§2.2 第二/三次实测）
已把根因写清楚：反射内容与表面运动不同步，只有 TAA 在兜。
本报告不重复该结论，只补一点：**P1-2 修好之前，反射区域连"动起来就少混历史"这个最低成本的
兜底也是空转的**。修 P1-2 的收益会直接体现在 `TODO #0` 的残余条纹上，且不需要动反射代码。

### F3 "噪声靠 TAA 磨"的模块，实际只有 ~10 帧等效累积

默认档固定 `historyWeight = 0.9`（指数平均，等效 ~10 帧，且**不收敛到极限值**），
而大量模块的设计前提是"TAA 会把它磨掉"：体积光光束（`VOLUMETRIC_LIGHT`/`VF_VOLUME_SHADOW_SAMPLES`
文案直接写"噪声交给 TAA 平均"）、云时域升采样、DOF 的随机 gather、SSR 的 STBN 抖动。
把等效累积提高（P1-1 修法 2 上 `TAA_MAX_ACCUM_FRAMES`）比给每个模块各配一个降噪器便宜得多，
代价是拖影变长 —— 这正是需要用户拍板的观感取舍（§8.5）。

### F4 抗闪烁 / 锐化在默认档完全不可用

`TAA_ANTIFLICKER 0.0`（`settings.glsl:503`；上游 `1reve-main` 同为 0.0，更早的
`Revelation-dev` 是 0.25）、`!TAA_SHARPEN`（`:505` + `profile.Default`）。
两者都只在质量模式生效 ⇒ 默认档 TAA 既不抗闪烁也不锐化，
栅栏/树叶/雨这类高频细节的闪烁只能指望 FXAA 与时间无关的抖动。

---

## 4. 已经做对的部分（改的时候别把这些改坏）

1. **抖动本身是正确的**：R2 序列（`shaders.properties:447-454`），
   `gl_Position.xy += taaJitter * gl_Position.w` 是 NDC 偏移的正确写法（不随投影矩阵缩放变形），
   `taaJitter*0.5` 的 UV 换算与 `1/viewWidth` 的 NDC 定义**量纲自洽**（±0.5 像素），
   `taaJitterPrev` 也备好了（只是 P1-3 没用上）。
2. **抖动覆盖完整**：逐文件扫过 13 个吃抖动的顶点着色器（`Basic/Block/Entities/Hand/HandWater/
   Overlay/ParticlesTranslucent/Spidereyes/Terrain/Textured/Water` + `DH/Terrain|Water` +
   三个 `gbuffers_skytextured`）。唯一"只声明不施加"的是 `gbuffers_weather.vsh:30`，
   但它只写 `colortex6`（雨 alpha，`gbuffers_weather.fsh` 的 `RENDERTARGETS: 6`），
   TAA 不读该缓冲 ⇒ **不是问题**（避免误报）。
3. **颜色空间没有漏点**：`IntegrateScene.frag:484` 的门（`TAA_ENABLED && RENDER_MODE == 1`）
   与两种模式的解码/再编码、DOF 的"blur 与 YCoCg 可交换"、
   `MotionBlur.comp:80`（读的是 TAA 输出的 RGB，写回 colortex0 的仍是 RGB）、
   `GradeCore.glsl:196-213`（`MOTION_BLUR` 决定读 colortex0 还是 colortex1）全部对齐；
   `RGBToYCoCg`/`YCoCgToRGB` 已严格互逆（`Color.glsl:68-86`）。
4. **缓冲与 pass 顺序自洽**：`RENDERTARGETS: 1,4` + 条件 `1,4,3`（`:33-40`）在 Iris 里按
   location 合并（0→1, 1→4, 2→3）；`colortex3` 只有 TAA 写运动矢量，而
   `composite4`(Translucent) 在此**之前**全量覆盖过它 ⇒ 无冲突；DOF(composite6_a) 在
   TAA 之前、泛光重写 colortex4 在 composite20_a/21_a（TAA 之后）⇒ `clearOut` 的清零安全。
5. **`RENDER_MODE 0`（离线渲染）与关闭 TAA 两条分支各自自洽**：离线模式下不做 YCoCg 编码，
   TAA 走 `:252-262` 的"静止相机才累积"路径（对出图实际上是有用的抖动超采样），
   关 TAA 时 `:250` 直接返回原始 colortex0（RGB↔RGB，不误解码）。
6. **性能兜底已有**：`colortex3` 在 `config.glsl:70` 是 `clear = true`，
   所以离线模式（不写运动矢量）下 `MotionBlur.comp:41-43` 会因 `inversesqrt(0) > 1e6` 命中早退
   ⇒ 不会读脏数据。
7. **`offset3x3N[8]` 只含 8 邻域**（`lib/utility/Offset.glsl:12`），
   质量模式 `moment1 = currData + Σ8`、再 `rcp(9)` ⇒ 中心没有被重复计入，方差估计正确。

---

## 5. 建议动作（按性价比排序，均建议单独提交 + 报告自检结果）

| 顺序 | 动作 | 风险 / 观感变化 | 验证方式 |
|---|---|---|---|
| 1 | 补 `en_US.lang` 3 条（P1-4） | 无 | 切英文看 GUI |
| 2 | 修性能模式运动降权的单位（P1-2，1 行） | 只会减轻拖影，理论上无反效果 | 快速平移/看生物与树叶边缘 |
| 3 | 质量模式专属旋钮加"（仅质量模式）"文案，或 `#if TAA_QUALITY_MODE == 0` 分组（P1-1 修法 1） | 无 | GUI 逐项对照 |
| 4 | 先实测对比：把 `TAA_QUALITY_MODE` 切到"质量"跑同一场景 | 无（只是 A/B） | 一次就能判定质量模式那 4 个旋钮值不值得复活 |
| 5 | `historyReset` 接入 + 椭球裁切加最小容差（P2-2/P2-3，各带对照开关） | 行为改动小 | `/time set` 与平坦天空区扫视 |
| 6 | 历史读 + 原点对齐 `taaJitter`（P1-3，带 `TAA_PREV_JITTER` 开关） | **观感会变（变锐/更收敛）**，需 A/B 后定 | 静帧看噪点/软硬，慢速平移看拖影 |
| 7 | 删 `TemporalAA.fragold` + 登记被禁用 pass 清单（P3-1） | 无 | `preproc_check --all` |
| 8 | F1（物体运动矢量）单独立项进 `TODO.md`；F3 的累积帧数取舍先问用户 | — | — |

---

## 6. 附：本次跑过的可复现检查

```
node scripts/preproc_check.js --all        → 检查了 329 个入口：无新增命中（基线内已知 35 条已忽略）
shaders.properties 非 ASCII 字节数          → 0
lang/zh_CN.lang / en_US.lang BOM           → False / False
shaders/** 的 #if* 与 #endif 计数           → 691 / 691（差 0；改动前 688，新增 3 对来自两个开关）
改过的 5 个文件换行符                        → 全 LF（CRLF 计数均为 0）
新注释里的半角双引号                         → 无（按 §5 改用「」）
git status --porcelain -- shaders docs     → 只出现本次打算提交的文件（另有工作区原有的 MEMO.md 改动与未跟踪文件，未触碰）
```

**本次改动的提交拆分（一提交只做一件事，§7；均已落在 `dev` 分支）**：

| 提交 | 内容 |
|---|---|
| `4b8c953c` `feat(taa)` | 三个默认关的修复开关 + 四件套接线（同时订正 `RENDER_MODE 0` 分支的旧注释） |
| `8871a0e0` `fix(taa)` | 性能模式运动降权的单位修复（UV → 像素，1 行 + 标定注释） |
| `efb08c94` `docs(taa)` | en 的 taa模式文案 + 四个质量模式专属旋钮的「仅质量模式」tooltip |
| 本条 `docs(taa)` | 本审查报告入库 |
| 下一条 `chore(taa)` | 删除死文件 `program/post/TemporalAA.fragold` |

**审查用到的旁证（仓库外）**：`shaderpacks/Revelation-AD-edit.txt`（Iris 记住值，2026-10-15 21:48）
里 TAA 相关只有 `TAA_MAX_ACCUM_FRAMES=24.0` ⇒ 用户从未切过 `TAA_QUALITY_MODE`，
即当前实际运行在**性能模式**，而 24.0 这个值是**完全无效**的（P1-1）。
