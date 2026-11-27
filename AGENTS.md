# AGENTS.md

**入口文件。先看这张表，不要通读仓库。**

| 你要做什么 | 读这个 |
|---|---|
| 知道现在卡在哪、下一步做什么 | `STATUS.md` |
| 知道这包是什么、GI 链怎么走、术语 | `CONTEXT.md` |
| 遵守协作规矩（验证口径、操作禁忌、文档该写哪） | `RULES.md` |
| 改 shader（命名 / 注释 / 选项四件套 / 提交前自检） | `docs/CODE_STYLE.md` |
| REBLUR 对齐进度与勾选状态 | `REBLUR-CHECKLIST.md` |
| 查历史某次踩坑、某个决策为什么这么定 | `docs/archive/MEMO-INDEX.md` → 对应原文 |
| 架构取舍（一个决策一篇） | `docs/adr/` |
| 提 issue / 协作流程 | `docs/agents/issue-tracker.md` |
| NRD 官方文档与论文（离线） | `docs/reference/nrd/` |

新能力一律默认"无观感变化"；默认值要改变观感时单独提交并说明。

## 三条硬约束（不遵守就是白干）

1. **`shaders.properties` 只能纯 ASCII**，注释也不行。一个中文字符会让整个文件被静默截断。
2. **改选项前先 grep 真实选项名**。不在 `settings.glsl` 里的键会被 Iris 重载时静默丢弃。
3. **本机没有 GLSL 编译器**。三套脚本只查语义与预处理，能不能编译只有 Iris 能证明 ⇒
   功能改动必须写清"进游戏怎么验"。

## 一次改动的收尾（缺一步都算没做完）

1. 跑三套检查，确认无**新增**命中：
   `node scripts/preproc_check.js --all` / `shader_semantic_check.js` / `shader_static_check.js`
2. 勾 `REBLUR-CHECKLIST.md` 的对应行 —— 只能肉眼定的项**标 `⏳`，不许自勾 `✅`**。
3. 更新 `STATUS.md` 的"现在"（一句话现状 + 下一步）。
4. 往 `.workbuddy/memory/YYYY-MM-DD.md` 追加当天过程（可以啰嗦，那是给人看的）。
5. 提交信息按 `docs/CODE_STYLE.md` §7 的格式，一个提交只做一件事。

## 不要做

- 不 `git reset` / 不覆盖工作区（长期带未提交成果）
- 不抢前台焦点（重载要人按 `i`）
- 不动 `shaders/ffx/`、不批量重命名或格式化
- 不在 `docs/archive/` 里继续追加内容（只读）
