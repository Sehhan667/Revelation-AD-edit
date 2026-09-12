# 代码质量审查（2026-09-12）

审查对象：Revelation-AD-edit 当前 `dev` 分支工作区（含本轮所有改动）。
方法：脚本量化（规模 / 换行符 / 死代码 / 选项接线一致性 / 重复度）+ 抽样精读关键路径。
**结论先说**：代码质量**良好偏上**，注释质量尤其突出；**可以长期维护**，但有三个系统性短板
（见"高优先级"三条），建议先花半小时做掉，再进入常态开发。

---

## 一、量化概览

| 指标 | 数值 | 评价 |
|---|---|---|
| 项目着色器文件 | 470 个（.glsl/.frag/.comp/.csh/.vsh/.fsh/.vert/.gsh/.geom） | 规模中等偏大 |
| 项目代码行 / 注释行 | 29,019 / 9,541 ⇒ **注释占比 33%** | 很好（一般光影包 <10%） |
| 第三方代码 | `shaders/ffx/` 8 文件 **10,105 行**（AMD FidelityFX，MIT 头完整） | 占全部着色器行数 26%，需隔离看待 |
| 单文件 >400 行 | 10 个（前 3 是 ffx 第三方；自研最大 `DeferredLight.frag` 1022 行） | 自研部分可接受 |
| 选项 | 约 580 个 `#define`（含开关）/ 约 400 个进 GUI | 多，但接线有规律 |
| TODO / FIXME | 6 处 | 很干净 |
| 提交历史 | 1777 次；近期提交信息质量优秀，早期多为 `Update`/`Fix`（633/213 次） | 历史双峰，规范只需覆盖新提交 |

## 二、做得好的地方（不是客套，都有证据）

1. **注释解释"为什么"，而不是"做了什么"**。例如 `AtmosphericFog.glsl` 里"雾层同心环的成因 +
   为什么改成闭式积分"、`Warp.glsl` 里"表与兜底曲线混用会突变"、`settings.glsl` 里每条选项的
   量纲与标定来源。这类信息**无法从代码本身读出来**，是长期维护最值钱的部分。
2. **选项接线有稳定范式**：定义（settings.glsl）→ GUI（shaders.properties 的 `screen.*` + `sliders`）
   → 文案（lang 双语）→ 默认值 = 现状（新功能默认关）。本轮新增的 6 个选项全部按这个范式走。
3. **约定俗成的东西是自洽的**：函数 PascalCase、选项 SCREAMING_SNAKE、`// ---- 段落 ----` 分隔、
   `#ifndef` 兜底默认值、`PASS_*` 宏区分编译单元、用 `.csh1/.fsh1` 改名禁用 pass。
4. **已有自制验证工具**：`rdc_analysis/preproc_check.js`（递归展开 `#include` + 跑预处理，抓
   "全大写标识符从未定义"和 `#include` 被引号劫持这类 Iris 特有事故）、`stabilize_trace.js` 等。
5. **提交粒度与信息**：近期每个提交都写清"背景 / 改了什么 / 为什么 / 待实测"，还带校验结果。

## 三、风险清单

### 🔴 高优先级（建议本轮就做）

**H1. 验证工具没有入库** —— `rdc_analysis/` 在 `.gitignore` 里（第 6 行），而
`preproc_check.js` 是本项目**唯一能提前抓 Iris 解析事故的工具**。它现在只存在于本机工作区：
换机器、误删、或以后交给别人/AI 接手就没了。同时 `scripts/` 是入库的（含 LICENSE 与文本编码工具），
说明项目本来就有"工具入库"的先例。
→ **建议**：把 `preproc_check.js`（及其 `baseline.json`）移入 `scripts/` 并入库，`rdc_analysis/`
其余临时产物继续保持忽略。

**H2. 死代码没有清理机制** —— 实测：
- **10 个文件从未被 `#include` 也未被任何 pass 引用**：
  `lib/lighting/RSM.glsl`、`lib/lighting/SCNBGI.glsl`、`lib/lighting/SS1PT.glsl`、
  `lib/lighting/VoxelPropagate.glsl`、`lib/utility/Reshade.glsl`、`program/smooth.glsl`、
  `program/Template.comp`、`program/Template.frag`、`program/setup/GenBaseNoise.comp`、
  `program/setup/GenBRDFLUT.comp`（后两个已被 `texture/cloud/*.bin` 与
  `texture/BRDF_GGX_VNDF_512_16F.dat` 取代）。
- 其中 **`RSM.glsl` 是"地雷"**：它第 19 行重新定义了 `const float realShadowMapRes`，而
  `settings.glsl:26` 已经定义过同名常量 —— 一旦有人 include 它就会**重复定义编译失败**。
- 另有 **106 个顶层函数零引用**（定义总数 524）。多数是 BRDF/SH 库里的"备选公式"（可接受），
  但混着真正的死代码，例如 `AtmosphericFog.glsl` 的 `CalculateFogDensity`（唯一调用者已在
  合并体积光时删除）、`clouds/Shape.glsl` 的 `CloudMidDensity`（函数体直接 `return 0.0`）。
→ **建议**：删掉 10 个死文件（`RSM.glsl` 优先，它有害）；库文件里的备选公式保留但在文件头标注
"备选/未使用"，避免下次又被当成活代码去改。

**H3. 阴影空间链路被复制了 6 份** —— "世界坐标 → `shadowModelView/Projection` →
`DistortShadowSpace` → `×0.5+0.5` → `ShiftShadowScreenPos`（体素平铺）"这条链在
`shadow/Render.glsl`（2 处）、`VoxelSunShadow.glsl`、`DeferredLight.frag`、`IntegrateScene.frag`、
`RSM.glsl` 各写了一遍；`textureLod(shadowtex1, …)` 这类"阴影图硬件比较"出现 7 处。
**这不是风格问题，是维护风险**：改一处阴影空间约定（例如 RTWSM warp、体素平铺布局）就必须同时
改六处，漏一处就是"阴影错位"这种极难定位的现象 —— 本轮 RTWSM 与体素条带的修复就正是这个形状。
→ **建议**：抽成 `lib/lighting/shadow/Query.glsl` 里的两个函数
（`WorldToShadowScreenPos(vec3 worldPos)`、`SampleShadowCompare(vec3 ssp)`），先做新代码，
旧调用点逐个替换（可以分多次提交）。

### 🟡 中优先级

**M1. 换行符不统一**。工作区实测：`.csh` 43 CRLF / 73 LF、`.fsh` 31/62、`.glsl` 16/62、`.vsh` 33/62，
另有 **5 个文件同一文件内混用**（`world1/deferred*.vsh/csh`）。`.gitattributes` 只设了
`linguist-language`，没有 `eol=`，而 `core.autocrlf=true` ⇒ 每次提交都刷一堆
"LF will be replaced by CRLF" 警告，**真实警告容易被淹掉**；编辑器重写整文件时还会产生巨型 diff。
→ **建议**：`.gitattributes` 增加 `*.glsl text eol=lf` 等规则（或 `* text=auto eol=lf`），
再 `git add --renormalize .` 一次性归一到 LF（GLSL 不关心换行符，无功能风险）。

**M2. 部分选项有 GUI 没文案**。实测 11 个：`NOISE_SIZE`、`SUN_BRIGHTNESS_MULTIPLIER`、
`RSM_ENABLED`、`RSM_RADIUS`、`RSM_SAMPLES`、`RSM_BRIGHTNESS`、
`DEBUG_ATMOSPHERE_LUTS`、`DEBUG_CLOUD_NOISE`、`DEBUG_SHADOW_WARP`、`DEBUG_SHADOW_WARP_DIFF`、
`DEBUG_TONE_MAPPING_PLOT`（调试项可以不管，但 `NOISE_SIZE`/`SUN_BRIGHTNESS_MULTIPLIER`/`RSM_*`
是正式选项，界面上会显示原始英文名）。
→ **建议**：补 6 条正式选项的中英文案；调试项在 lang 里统一标注"（调试）"。

**M3. 文档索引不完整**。`AGENTS.md` 指向"仓库根的 `CONTEXT.md` + `docs/adr/`"，但
**`CONTEXT.md` 不存在**（`docs/adr/` 只有 1 篇）。结果：新人/AI 接手时，"这套管线长什么样、
数据怎么流"只能靠读 `MEMO.md` 里的历史笔记拼。
→ **建议**：补一份 `CONTEXT.md`（管线地图：pass 顺序 + 缓冲区表 + 关键模块职责，一页即可）。

### 🟢 低优先级（知道就好）

- **L1. 被改名禁用的 pass 有 9 个**（`world*/composite1.fsh1|vsh1`、`world*/deferred1_b.csh1`）。
  这个约定本身有效（Iris 只加载精确文件名），但**对工具完全不可见**，容易忘了自己关过什么。
  → 建议在 `MEMO.md` 维护一张"当前被禁用的 pass 清单 + 原因 + 怎么启回"。
- **L2. 早期提交信息无信息量**（`Update` × 633）。历史不用改，规范覆盖新提交即可。
- **L3. `settings.glsl` 已 518 行**。Iris 惯例就是单文件集中选项，暂不建议拆；但每新增选项请写在
  对应段落内、并保持"默认值 = 现状"。

## 四、长期维护结论

**可以长期维护，评级：B+ / 良好偏上。** 判断依据：

- 自研代码的**结构、命名、注释、选项接线**四项都有一致范式，且范式是"讲道理"的那种（能解释取舍）。
- 真正的短板不是"写得乱"，而是**工程化**：验证工具没入库（H1）、死代码没有清理习惯（H2）、
  关键约定被复制多份（H3）。这三条都会随着功能增加而**加速恶化**，越早处理越便宜。
- 好消息是三条都能在很短时间内显著改善：H1 移文件 + 提交（5 分钟），H2 删 10 个文件（5 分钟），
  H3 抽取函数（可分批，先立约定），M1 一次 renormalize（5 分钟）。

**建议的最小行动清单（按顺序，约 30 分钟）**：
1. 把 `preproc_check.js` + baseline 移入 `scripts/` 并提交（H1）。
2. 删除 10 个死文件，`RSM.glsl` 优先（H2）。
3. `.gitattributes` 加 `eol=lf` + 一次性 renormalize（M1）。
4. 补 `CONTEXT.md` 一页管线地图（M3）。
5. 把 `docs/CODE_STYLE.md`（同批产出）作为后续改动的验收依据。

## 五、附：本次审查用到的可复现检查

以下检查都是脚本化的，建议固化成"改完就跑"的例行自检（详见 `docs/CODE_STYLE.md` 的检查清单）：

- `node scripts/preproc_check.js --all`（预处理配平 + 悬空标识符，当前 344 个入口无新增命中）
- 死文件/死函数扫描：顶层函数定义 vs 全文引用计数；文件名是否被 `#include` 或被 pass 引用
- 选项三件套一致性：`settings` 定义 ∩ `properties` GUI ∩ `lang` 文案 的差集
- 平台硬约束：`shaders.properties` 必须纯 ASCII；`.lang` 必须 UTF-8 无 BOM
- 预处理嵌套配平：`#if*` 与 `#endif` 计数归零
