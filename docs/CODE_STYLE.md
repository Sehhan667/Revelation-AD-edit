# 代码规范（Revelation-AD-edit）

本规范不是从外面搬来的，而是**把仓库里已经跑通的惯例写下来**，再补上平台（Iris/OptiFine）的硬约束
与验收清单。目标：任何一次改动，**三个月后**的自己（或接手的人 / AI）能看懂、能验证、能安全地改。

适用范围：`shaders/**`（自研部分，不含 `shaders/ffx/` 第三方）、`docs/**`、根目录文档。
> `shaders/ffx/` 是 AMD FidelityFX（MIT，文件头许可完整）：**不要改、不要格式化、不要重命名**，
> 升级时整目录替换。

---

## 1. 文件与目录职责

| 路径 | 放什么 | 不放什么 |
|---|---|---|
| `shaders/settings.glsl` | **所有选项定义**（`#define NAME 值 // [可选值]`，带量纲/标定说明） | 逻辑代码 |
| `shaders/config.glsl` | 缓冲区格式/清屏标志 + 缓冲区用途表 | 选项 |
| `shaders/shaders.properties` | GUI 分组 `screen.*`、`sliders`、`profile.*`、`program.*.enabled`、`size.buffer.*`、`image.*` | 中文（见 §5） |
| `shaders/lang/zh_CN.lang` / `en_US.lang` | `option.* / suffix.* / value.* / screen.*` 文案（双语必须同步） | 代码 |
| `shaders/lib/**` | 可复用函数（**纯函数优先**，不写 pass 入口） | `main()` |
| `shaders/program/**` | 真正的实现体（被 `world*/xxx.fsh/.csh` include） | 直接依赖某个 pass 的全局状态 |
| `shaders/world*/` | pass 入口，通常只有 `#version` + `#define PASS_*` + `#include` | 逻辑 |
| `docs/adr/` | 架构决策记录（一个决策一篇，含取舍与被否决的方案） | 流水账 |
| `MEMO.md` | 踩坑记录与"为什么这么写"的长期备忘 | 待办 |
| `PROGRESS_TODO.md` | 进度与**待实测清单** | 长期知识 |

**新功能落点**：先想清楚"属于哪个 pass、放哪个 lib 文件、选项怎么接线"，再动手。

## 2. 命名

| 对象 | 约定 | 例 |
|---|---|---|
| 选项 / 宏 | `SCREAMING_SNAKE_CASE`，前缀按模块 | `VF_HEIGHT`、`RTWSM_CONTENT_STRENGTH`、`SSS_BLUR_TAPS` |
| 函数 | `PascalCase`，动词开头 | `CalculateFogDensity`、`SampleFogSunShadow`、`ApplyFog` |
| 变量 / uniform | `camelCase` | `shadowClipPos`、`worldSunDir` |
| pass 标记宏 | `PASS_<大写>` | `PASS_TRANSLUCENT`、`PASS_SKY_MAP` |
| 调试开关 | `DEBUG_<大写>` | `DEBUG_SHADOW_WARP` |
| 被禁用的 pass | 原扩展名后加 `1`（`.csh1` / `.fsh1` / `.vsh1`），并在 `MEMO.md` 登记 | `deferred1_b.csh1` |

**禁止**：给 Iris 管理的选项改名（`shaders.properties`/`lang` 按名字索引，改名等于界面失灵）；
用同名常量在第二个文件里重复定义（会重复定义编译失败 —— 现存 `RSM.glsl` 就是反面教材）。

## 3. 注释：写"为什么"，不写"做了什么"

这是本仓库最值钱的部分，请保持。

- **必须写**：① 这个式子/常量是怎么标定的（量纲、来源、实测值）；② 为什么不用另一种写法（被否决的
  方案 + 否决原因）；③ 与平台约定相关的坑（Iris 解析、体素平铺、坐标系）。
- **不必写**：`// 自增 i` 这种把代码翻译一遍的注释。
- 语言用中文；函数头用 `// ---- 段落名 ----` 分隔；改动处标日期与意图，例：
  ```glsl
  // [2026-09-12 雾层厚度] 高度包络斜率 = 原斜率 × (12 / 厚度)：厚度翻倍 → 斜率减半。
  // 默认 12 = 现状（12/12 = 1.0 逐位不变）。闭式积分对 sEx→0 有级数分支，均匀档安全。
  ```
- **注释里禁止出现**（见 §5）：半角双引号、`*/`、会让解析器误解的字符。

## 4. 选项接线：三件套 + 两条铁律

新增一个选项，必须**同时**改这四处：

1. `settings.glsl`：`#define NAME 默认值 // 中文说明（含量纲/标定）。 [可选值列表]`
2. `shaders.properties`：加进对应 `screen.<页面>`；数值型再加进 `sliders`
3. `lang/zh_CN.lang` + `lang/en_US.lang`：`option.NAME=` / `option.NAME.comment=`（有单位加 `suffix.NAME=`）
4. 若属于某个默认档（`profile.Default`）：把默认值写进去

**铁律一：默认值 = 现状。** 新选项的默认值必须让画面与改动前**逐位一致**（例：`× (12.0/12.0) = 1.0`）。
需要改变默认观感时，单独提交并在提交信息里说明。

**铁律二：`#ifndef` 兜底。** 库文件里使用的选项，在库文件顶部给兜底默认值，保证单独展开也能编译：
```glsl
#ifndef VF_FOG_THICKNESS
    #define VF_FOG_THICKNESS 12.0
#endif
```

## 5. 平台硬约束（每条都是踩过的坑）

| 约束 | 症状 | 规则 |
|---|---|---|
| `shaders.properties` 只能 ASCII | 写中文注释 → Iris jcpp 崩、整包失效 | 该文件注释一律英文 |
| 源码注释里不能有**成对半角双引号** | Iris 在源码文本上扫 `#include`，引号被当成字符串界定符 → `InvalidPathException` | `.glsl/.frag/.comp` 注释里不要写 `"..."` |
| 行注释里不能出现 `*/` | GLSL 解析器块注释状态错乱 → 报 `extraneous input '?'` | 行注释里用 `\|` 分隔目录名，别写 `world*/composite1.csh` |
| `.lang` 必须 UTF-8 **无 BOM** | 带 BOM 时首条文案失效/乱码 | 用工具写，不要用记事本另存 |
| 改文件要**保留原换行符** | 整文件 diff、真实警告被淹 | 见 §7 检查清单；统一目标为 LF |
| 被禁用的 pass 改名后对工具不可见 | 忘了自己关过什么 | 在 `MEMO.md` 登记 |

## 6. pass 与缓冲区

- **新增 pass**：`world*/xxx.fsh`(+`.vsh`) 只写 `#version` + `#define PASS_*` + `#include "/program/..."`；
  在 `shaders.properties` 加 `program.worldN/xxx.enabled = <条件>`；**三个世界目录都要考虑**
  （只在 `world0` 生效要写明理由）。
- **新增缓冲区**：`config.glsl`（格式 + `xxxClear` + **用途表那一行**）、`shaders.properties`
  （`size.buffer.*`、必要时 `image.*`）、`lib/universal/Uniform.glsl`（sampler 声明）**三处同步**。
- **删除 pass/缓冲区**：同样三处都要删；删完跑一次全量检查（§7）。删文件用 `rm` + `git add -A`
  （**不要用 `git rm` 批量删**，本仓库历史上出现过递归误删整目录）。
- **compute 附着**：`compositeN.csh` 是 `compositeN.fsh` 的附着 compute，按 base→`_a`→`_b` 派发；
  挂新 pass 前先确认该编号是否空闲。

## 7. 提交与验收

**提交信息**（对齐本仓库近期风格，中文正文）：

```
<type>(<scope>): 一句话结论

背景/现象：……
改法：……
为什么这么改（被否决的方案）：……
待实测：……（没有就删掉这行）
静态自检：……
```

`type` 用 `feat|fix|perf|refactor|docs|revert|chore`；`scope` 用模块名（`vf`/`shadows`/`sss`/`gi`/`post`）。
**一个提交只做一件事**；重构与行为改动分开提交。

**改完必跑（5 项，全部可脚本化）**：

```bash
node scripts/preproc_check.js --all          # 预处理配平 + 悬空标识符（当前 344 入口应"无新增命中"）
python -c "…properties 非 ASCII 字节数…"      # 必须为 0
python -c "…lang 是否带 BOM…"                 # 必须 False
python -c "…#if* 与 #endif 计数…"             # 必须归零
git status --porcelain                        # 只应出现你打算提交的文件
```
> `preproc_check.js` 目前在工作区 `rdc_analysis/`（未入库），**建议移入 `scripts/` 并提交**。

**功能类改动**：提交信息里写清"待实测"清单（进游戏怎么验、看什么现象、旋钮在哪）。

## 8. 与 AI / 工具协作的额外约定

本仓库大量代码由 AI 生成，故补充：

1. **AI 不得擅自改变默认观感**。新增能力一律默认关或默认等价现状（§4 铁律一）。
2. **AI 不得批量重命名/格式化**（尤其 `shaders/ffx/`）；需要大范围格式化时单独提交并说明。
3. **AI 改文件必须保留原换行符与编码**；改完自行跑 §7 的 5 项检查并在回复里报告结果。
4. **删文件用 `rm` + `git add -A`**；不要 `git rm` 批量删（曾导致整目录被递归删除）。
5. **改不动的先问**：涉及观感取舍（雾多浓、光多亮）时，先给出"改哪个旋钮、预期效果、代价"，
   由人决定，再动代码。
6. **不要留下"半成品接线"**：新选项必须四处齐全（§4），否则界面上会出现点了没反应的项。

## 9. 已知技术债（清理优先级）

见 `docs/CODE_REVIEW_2026-09-12.md`：H1 验证工具入库 → H2 删 10 个死文件（`RSM.glsl` 优先）→
H3 抽取阴影空间查询函数 → M1 换行符归一 → M2 补 6 条 lang → M3 补 `CONTEXT.md`。
