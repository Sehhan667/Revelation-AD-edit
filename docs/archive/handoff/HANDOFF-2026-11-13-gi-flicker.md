> **已归档（2026-11-22）** — 本文件是历史快照，不再维护；其中的结论、路径、选项名可能已与现行代码不符。
> 现行对应文档：`STATUS.md`
> 归档说明：该轮「相机一动满屏闪」的现场交接。已确认的机制（累积器 alpha、historyReset 疑点）保留在 STATUS 与记忆日志里，本文件不再更新。

# Revelation-AD-edit —— 项目交接说明

> 最后更新：2026-11-13 18:00（本次会话结束时）
> 交接对象：下一个 agent。目标是"接手后 10 分钟内知道现在卡在哪、下一步按什么顺序做"。

---

## 0. 一句话现状

用户报告的病灶已从"静止时的脏斑"变成"**相机一动就满屏脏污疯狂闪**"。代码级已定位到
**GI 时域累积在运动时被打回单帧（alpha≈0.81 ⇒ 屏幕上 81% 是裸 1spp 追踪噪声）**。
头上还悬着一个未验证的元凶：`historyReset` 自定义表达式疑似**每帧恒真** ⇒ GI 的时域累积从未生效。
**下一步只需一次实验就能定性**（诊断浮层已就位，见 §7）。

---

## 1. 环境与路径

| 项 | 值 |
|---|---|
| 光影包工作区 | `D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit`（**是 git 仓库**） |
| Iris 选项文件 | `D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit.txt` |
| 游戏版本 | `1.21.11-Fabric 0.18.4`，`D:\Games\HMCL\.minecraft\versions\1.21.11-Fabric 0.18.4\` |
| 运行日志 | `...\1.21.11-Fabric 0.18.4\logs\latest.log` |
| 渲染器 | Iris（Shaderpack `Revelation-AD-edit`） |
| 白天志 | `.workbuddy/memory/2026-11-11.md` / `2026-11-12.md` / `2026-11-13.md`（**细节全在这三个文件里**） |
| 项目文档 | `REBLUR-CHECKLIST.md`（本包 REBLUR 链路的权威清单） |
| 自检脚本 | `node scripts/preproc_check.js <入口.glsl>`；语义检查 `scripts/shader_semantic_check.js` |

**当前 git 状态**：14 个文件已改未提交（832 插入 / 103 删除），改动面横跨
`Accumulate.frag`、`GIStabilize.comp`、`GIPrepass.comp`、`GIHistoryFix.comp`、`EAWF.comp`、
`VoxelLighting.glsl`、`SpatialUpscale.glsl`、`settings.glsl`、`shaders.properties`、两个 lang 文件、
`REBLUR-CHECKLIST.md`、`scripts/shader_semantic_check.js`。
**这些是本项目长期积累的成果，不要 `git checkout` 覆盖。**

---

## 2. 用户诉求与症状（原始描述）

1. 「静止时基本没脏污」——**静止是干净的**。
2. 「但是只要稍微碰一下鼠标直接满屏脏污疯狂闪」——**轻微转视角就崩**。
3. 「我 100% 确定只有 vxgi 有脏污」——直射阳光/天光区域干净，**只有 VXGI 照亮的表面脏**。
4. 用户当前在忙别的事（把 `C:\Users\46941\Not Welcome` 整目录搬到 E 盘），**不方便一直配合**。

⇒ 症状定义：**不是稳态偏差，是运动瞬态**。之前围绕"静止斑块"的归因方向要作废重做。

---

## 3. 已确认（代码级）的机制

### 3.1 累积器为什么一动就"满屏"
`shaders/program/diffuse/Accumulate.frag`：

- 累积帧数 `A`（`integratedDiffuse.a`）由**二值几何判据**推进（约 280 行）：
  `maxGeometryWeight > 阈值` ⇒ `A+1`；`>0.03` ⇒ `A-1`；否则 **`A=1`（全清零重来）**。
- 混合率 `alpha` 用官方收敛式 `alpha = 1/(1+k·N)`（约 318 行）：
  **N=1 ⇒ alpha≈0.81（本帧占 81%）**；N=80 ⇒ alpha≈0.012。
- ⇒ 只要历史被判不可信，屏幕上就是 **81% 的单帧 1spp 裸追踪噪声** = 满屏脏污。
- 历史被拒时输出走 `integratedDiffuse.rgb = texelFetch(colortex22, ...)`（prepass 的 30 纹素空间重用结果）+ `a=1`（约 430 行）。

### 3.2 为什么是"疯狂闪"而不是固定脏斑
`GI_KERNEL_ROT_PER_FRAME`（**2026-11-13 16:2x 由我开启**）每帧轮转采样核 ⇒ 每帧噪声图案都不同。
历史一失效就看到一片翻新的噪点。**这条要重估**：它可能把"静态斑块"变成了"动态闪烁"。
（2026-11-12 的教训说这个方向是对的——旧实现是"每 2×2 块随机+每帧乱跳"，改成"全屏同一角度逐帧推进"；
但"运动时历史失效"这个新场景下，它的副作用是放大闪烁。）

### 3.3 重投影本身对旋转是正确的
`Accumulate.frag` 约 108-130 行：`prevWorldPos = worldPos + (cameraPosition - previousCameraPosition) * step(0.56, screenPos.z)`，
再用 `gbufferPreviousModelView/Projection` 投影 → **旋转被正确包含**；平移补偿只在 `depth>=0.56` 处生效。
（`step(0.56, ...)` 这个 0.56 是手搓的"天/地"阈值，看着可疑但目前没证据表明它在本症状里出错。）

---

## 4. 头号待验证假设：`historyReset` 每帧恒真

`shaders/shaders.properties:417`：

```
uniform.bool.historyReset = abs(smooth(worldTimeCounter, 0.2, 0.2) - worldTimeCounter) > 1.0
```

- `shaders.properties:414`：`worldTimeCounter = ((worldDay % 256) * 24000.0 + worldTime) * 0.05` ⇒ 量级 **10³~10⁵**。
- `smooth(x, 0.2, 0.2)` 是退化写法（两个边界相等），x 很大时只会给常数 ⇒ `abs(1-10⁵)>1` **恒真**。
- `Accumulate.frag:145`：`_histOk = ... && !historyReset` ⇒ 历史**从未被使用**，GI 时域累积等于不存在。
- 静止时之所以看起来干净，是靠下游 `GIStabilize.comp`（NRD 稳定化）那一层兜底；
  一动，那层的 reprojection 同样失效 ⇒ 兜底也没了 ⇒ 满屏脏污。
- 作者自己的注释已经怀疑过这点（`Accumulate.frag:142`）：「若环境不支持 smooth() 可能恒为 true ⇒ 完全无法累积」。
- Iris 日志里**没有**表达式解析报错 ⇒ 说明 Iris 接受了这个表达式（是语义问题，不是解析问题）。

**候选修复（待蓝通道读数确认后再动）**：

```
# 只在真实世界时间回绕（午夜/换维度）的那一两帧为真
uniform.bool.historyReset = abs(worldTime - 1.0) < 1.0
# 保守替代：直接常假
uniform.bool.historyReset = false
```
（Iris 表达式语言支持 `abs` 与比较运算（见同文件 416 行）；`&&` 未必支持，故用单比较式。）

---

## 5. 当前**真实生效**的配置（Iris 重写后的 options 文件，86 行）

关键项（其余从略，文件在 `Revelation-AD-edit.txt`）：

```
GI_MODE=2                 ← VXGI 追踪模式（不是 IRC）
GI_ACCUM_TIME=2.0
VOXEL_GI_STRENGTH=2.0
VOXEL_GI_DARK_ACCUM=true  ← 包内注释警告：暗处累积 ×4 ⇒ 拖影一大条
VOXEL_GI_SKY_STRENGTH=6.0 / VOXEL_TRACE_SUN_STRENGTH=8.0 / VOXEL_TRACE_DISTANCE=24
VOXEL_GI_BLENDED_LIGHTMAP=0.05
TAA_HISTORY_WEIGHT=0.99 / TAA_ANTIFLICKER=0.25 / TAA_SHARPEN=true
```

⚠️ **不在文件里 = 未被 Iris 认识 = 我写的键被丢了**（见 §10 陷阱 1）。
特别是 `NRD_STABLE_MIN_RADIUS` / `NRD_PREPASS_RADIUS` / `GI_EFFECTIVE_SPP` /
`GI_MOTION_RESPONSE` / `GI_STABILIZE_FRAMES` 目前都停在 `settings.glsl` 的**默认值**上。
其中 `NRD_STABLE_MIN_RADIUS=3.0`、`NRD_PREPASS_RADIUS=30.0` 恰好等于默认值 ⇒ 上一轮"改成 3.0/30.0"是**空操作**。
（但 `shaders.properties` 的 `profile.Default` 里 `NRD_PREPASS_RADIUS` 已被历史改动为 **80.0**。）

---

## 6. 尚未复查的次要嫌疑（若蓝=0 就要看这些）

| 嫌疑 | 位置 / 旋钮 | 说明 |
|---|---|---|
| 几何判据在运动时误判 | `GI_DEBUG_NO_DISOC=1` | 一键取消所有历史拒绝；用它做 A/B 是最快的定性手段 |
| 判据容差没跟重投影位移走 | `GI_DISOC_THRESHOLD=0.01` | `depthTol` 只随深度梯度放大，不随重投影位移放大 |
| 暗处累积过长 | `VOXEL_GI_DARK_ACCUM=true` | 运动时暗部拖影 + 亮部闪噪，对比会很刺眼 |
| TAA 过度粘滞 | `TAA_HISTORY_WEIGHT=0.99` | 把 GI 噪声抹成拖影 |
| 火点未钳 | `GI_FIREFLY_CLAMP=0.0`（关） | 亮噪点会"忽然出现又消失" |

---

## 7. 本轮加的**诊断设施**（用完必须还原！）

| 文件 | 改动 | 还原方式 |
|---|---|---|
| `shaders/settings.glsl` | `#define DEBUG_GI_ACCUM_STATS`（原来是注释掉的） | 改回 `//#define DEBUG_GI_ACCUM_STATS` |
| `shaders/program/post/Final.frag` | 诊断浮层蓝通道改为 `historyReset ? 1.0 : 0.0` | 改回 `..., _dbgBad, 0.0);` |

**浮层读法**（`Final.frag` 的 `DEBUG_GI_ACCUM_STATS` 块，替换整个最终画面）：

- **R = 累积帧数 / 上限**（亮 = 历史在累积；暗 = 已掉回单帧样本）
- **G = 本帧被判"不可靠"的像素**（1 = 越界 / historyReset / 几何不匹配）
- **B = `historyReset` uniform 的实测值**（**1 ⇒ 头号假设坐实**）

判读表：

| 观测 | 结论 | 下一步 |
|---|---|---|
| 静止 R 亮、G 暗、B=1 | 历史被 uniform 每帧杀掉 | 改 `historyReset` 表达式（§4） |
| 静止 R 暗、G 亮、B=0 | 几何判据在拒绝 | 跑 `GI_DEBUG_NO_DISOC=1` A/B |
| 静止 R 亮、G 暗、B=0 | 累积正常，闪在下游 | 查 NRD 稳定化 / TAA |
| 运动时 R 掉、G 亮 | 运动导致历史失效 | 放宽判据容差或按位移自适应 |

---

## 8. 工具脚本（`.workbuddy/shots/`）

| 脚本 | 用途 |
|---|---|
| `gi_probe.py` | `info`=定位 Minecraft 窗口矩形/是否前台；`grab out.png`=抓帧并读 R/G/B 均值 + 拉普拉斯噪声能量 |
| `auto_capture.py <秒> <前缀>` | **等 Minecraft 窗口回前台 → 自动按 `i` 重载 → 连续抓帧**（本次用的主力脚本） |
| `flickpipe.js` | ffmpeg rawvideo 管道直读（**不落盘**）算分块时域 std |
| `key.py` | 向 Minecraft 窗口发按键（会抢焦点，**用户忙时别用**） |
| `setkv.sh` | 改选项文件（**改完必须核对键名在 settings.glsl 里真实存在**） |
| `probe.sh` | 老的一键探测（改设置+重载+抓帧） |

分析口径：抓屏测量的**分辨率下限约 0.3 级**；报"闪"必须同时报 fps（帧率一变，cap/半径/权重全变）。

---

## 9. 下一个 agent 的行动清单（按优先级）

1. **确认游戏窗口是否在前台**。若用户已恢复窗口且 `auto_capture.py`（后台任务 `EimwlE`）还在跑，它会
   自动按 `i` 并抓 100 秒；若已超时/退出，用 `python auto_capture.py 100 ov` 重跑。
   → 然后用 `gi_probe.py grab` 读 R/G/B，按 §7 判读表定性。
2. **若 B=1**：把 `shaders.properties:417` 改成 §4 的候选表达式 → 重载 → 用 `gi_probe.py grab`
   确认 R 变亮（历史真的在累积）→ 关掉两个诊断开关 → 再抓帧测拉普拉斯噪声能量对比。
3. **若 B=0**：跑 `GI_DEBUG_NO_DISOC=1` A/B（能消闪 ⇒ 几何判据问题 ⇒ 放宽 `depthTol` 或按重投影位移自适应）。
4. **无论哪种**：重估 `GI_KERNEL_ROT_PER_FRAME` 的取舍（它把静态斑块变成了动态闪烁）。
5. **收尾**：还原 §7 两个诊断开关；把新结论追加进 `.workbuddy/memory/2026-11-13.md`；
   有价值的结论同步进 `REBLUR-CHECKLIST.md`。

---

## 10. 已知陷阱（每一条都踩过）

1. **Iris 每次重载都会重写选项文件，只保留它认识的键**。手写键名若不在 `settings.glsl` 的真实选项表里
   （如本轮误用的 `TAA_ENABLED` / `VOLUMETRIC_FOG`），会被**静默丢弃**，实验等于没做。
   ⇒ 改任何选项前，先 `grep` 真实选项名。
2. **Iris 不监听光影目录的文件变化**：改 `.txt`、改 `settings.glsl`、改 mtime 都**不会**触发重载。
   唯一途径 = 游戏前台按 `i`。
3. **抢焦点会打断用户**。用户在忙时不要 `SetForegroundWindow`；用 `auto_capture.py` 的"等前台"逻辑，
   或请用户自己按 `i`。
4. **`historyReset`/`worldTimeChanged` 这类 Iris 自定义表达式很脆**：作者写了退化写法，
   语义等价于"恒真"，且 Iris 不报错 ⇒ 只能靠游戏内读数验证。
5. **报告"闪"必须同时报 fps**；抓屏测量下限约 0.3 级，别过度解读小差异。
6. **磁盘**：本轮一度被 900MB 抓帧文件塞满（`.workbuddy/shots` 里 ~530 个 PNG，沙箱权限拒绝删除）。
   现已释放到 24G 可用，旧 PNG 可手动清理。
7. **`GI_MOTION_RESPONSE` 官方语义是反的**：开 = 抬高本帧权重、压低稳定化历史 ⇒ **移动时噪点略升、拖影骤降**。
   它是"治拖影"的开关，**不是**"治闪"的开关。默认应为 1.0，本包 `settings.glsl:389` 里是 0.0（关）。
8. **`GI_DEBUG_VIEW=5/6`、浮层等诊断开关用完要关**，否则用户看到的画面是红绿蓝读数。

---

## 11. 已排除 / 暂缓的分支

- ❌ "脏污来自体素光场（IRC）的低频偏差" —— 与"静止干净"矛盾（偏差在静止时同样可见）。可作次要因素，不是主因。
- ❌ "GI 强度不够" —— `VOXEL_GI_STRENGTH` 与 `IRC_GI_STRENGTH` 是两个不同的开关；
  之前用它做"关 GI"归因是错的（只关了追踪分量，体素光场仍在）。**要关 IRC 必须用 `IRC_GI_STRENGTH`。**
- ⏸ "累积帧数下限/加大 cap" —— 2026-11-12 实测**反向**（cap 32 比 cap 22 更吵），不要再想当然加。
- ⏸ `GI_MOTION_RESPONSE=1.0` —— 留作"治拖影"的备选，不是治闪方案。
