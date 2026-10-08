# 屏幕空间反射（SSRT）审查（2026-10-08）

审查对象：`dev` 工作区中反射这一条链的**全部**代码路径（不透明 / 半透明 / 水面 / 死 pass），
外加一轮文献与开源实现核查。
方法：读装配层（`shaders/world0/*.c[sf]h`）确定"谁真的在跑"→ 精读 `lib/surface/SSRT.glsl`、
`lib/surface/Reflection.glsl`、`program/specular/*`、`program/Translucent.comp`、
`program/DeferredLight.frag`、`program/IntegrateScene.frag`、`program/ReprojectScene.comp`、
`config.glsl` 缓冲表 → 用 `git log` 核查历史（含已回退的 Hi-Z）→ 文献核查（每条给链接与验证状态）。

**结论先说**：算法骨架（线性屏幕空间步进 + 二分细化 + 上一帧重投影取光）与 MC 圈同类实现
（Photon 等）一致，**不是落后方案**；但有 **5 处可立即修的确定性缺陷**（其中 2 处是纯浪费、
1 处是坐标错误、1 处是死代码、1 处是厚度判据失控），**1 处高度可疑的整趟白做 pass**，
以及一条一直躺在 `TODO.md #0` 里的**架构性短板：反射没有自己的运动向量**。
文献层最高性价比的两步是 **VNDF 采样**（本包 `BRDF.glsl` 已实现，只是反射没用）与
**STBN 时空蓝噪声**（已在用，需确认是渐进版）。

---

## 一、现状：谁在跑，数据从哪来

### 1.1 五个相关 pass（装配层事实）

| pass | 文件 | 触发条件 | 输出 |
|---|---|---|---|
| `world0/deferred1.csh` | `program/ReprojectScene.comp` | 恒开 | colortex4 **左上象限** = 半分辨率重投影场景历史 |
| `world0/deferred20.fsh` | `program/DeferredLight.frag:947` | `material.metalness >= 0.5 \|\| materialID == 10050u` | colortex0（**唯一可见**的反射） |
| `world0/deferred21.fsh` | `program/specular/SpecularIndirect.frag` | 无 `.enabled` 规则 ⇒ 默认开 | colortex3（`RENDERTARGETS: 3`） |
| `world0/composite4.csh` | `program/Translucent.comp` | 恒开 | colortex3（`imageStore(colorimg3)`，**全量覆盖**）+ colortex0 |
| `world0/composite4.fsh` | `program/IntegrateScene.frag:317` | 恒开 | 读 colortex3 当玻璃/水面 specular 项，合成 colortex0 |

- `deferred30/31/32`（`SpecularFilter.comp`）**已被显式关闭**（`shaders.properties:1091-1099`），
  且 `SpecularFilter()` 本身是空 no-op（`SpecularFilter.comp:48-51`）⇒ 目前**反射没有任何专用降噪器**，
  只有 TAA（`composite7`）。
- 反射源＝colortex4 左上象限：`ReprojectScene.comp:17` 的 `workGroupsRender = vec2(0.5, 0.5)` +
  `loadDepth0(texelPos << 1)`（用**双倍**索引读全分辨率 `depthtex0`）⇒ 半分辨率画布 + 全分辨率深度的
  约定在此确立。画布由 TAA 每帧用当前帧结果重写（`TemporalAA.frag:33` 的 `RENDERTARGETS: 1,4`），
  所以 SSR 读到的是**上一帧 + 重投影 + 半分辨率**的场景色。
- `SSRT.glsl` 引用的 McGuire & Mara 2014 是"透视校正 2D DDA"；**本实现不是那套**（见 §2.3）。
  同类实现（Photon `include/misc/raytracer.glsl`）也是线性 march + 折半二分 ⇒ 现状符合社区常态。

### 1.2 成本模型（实机参数）

`Revelation-AD-edit.txt`：`SSRT_MAX_SAMPLES=12`、`SSRT_REFINEMENT_STEPS=6`。
⇒ 被追踪像素最多 **12 次 march + 6 次二分 = 18 次串行全分辨率深度采样**
（`loadDepth2` = `depthtex2`，不透明无手深度）+ 1 次 `colortex4` 象限采样
（粗糙反射额外 6 次）。每一步都依赖上一步 ⇒ **延迟受限**，且循环内联在 `DeferredLight`，
存在波前内分歧放大（一个 warp 只要含 1 个金属像素就整 warp 付这笔钱）。

### 1.3 死选项（SSPT 遗留）

`SSPT_ENABLED`（`settings.glsl:260`）**全仓无引用**；`SSPT_BLENDED_LIGHTMAP` / `SSPT_MAX_ACCUM_FRAMES`
只有 `settings.glsl` + `lang/*` + `shaders.properties`(profile.Default) ⇒ 三处齐备、**零消费点**。
其中 `SSPT_BLENDED_LIGHTMAP` 的 lang 文案写的是"**屏幕空间路径追踪结果与原版光照贴图混合**"
⇒ 本包历史上确实做过 voxagon 式 SSPT（用于漫反射 GI），后来被 SSILVB / VXGI / IRC 取代。
（术语溯源见 §5.1：SSPT 是 2018 年的博客技术名，不是论文，也没有 Ray Tracing Gems 章节。）

---

## 二、已确认的缺陷（读码可复现，附修法）

### P0-1 命中判负后 `t` 不前进 ⇒ 剩余迭代空转（`SSRT.glsl:79-90`）

```glsl
if (rayPos.z > sampleDepth) {
    if (distance(sampleViewZ, stepViewZ) < -0.2 * stepViewZ) { ...hit...; break; }
    // ← 厚度测试失败时既不 break 也不推进 t
} else {
    t += clamp((sampleDepth - rayPos.z) * invDirZ, rSteps * 0.01, rSteps * 1.25);
}
```

循环顶部用 `rayPos = origin + rayDir * t` 重算。`t` 不变 ⇒ **同一个点被重复评估**：
最多浪费 11 次 `loadDepth2`（每次一个全分辨率纹素读取），且**这条射线再也找不到命中**
（薄遮挡后面的真实交点被跳过）。这是 MC 圈线性 march 里最典型的 bug 形态。

**修法**（口径 = McGuire & Mara 的"每步必前进、命中只由深度测试决定"）：
把 `t` 的推进移出 `else`，两个分支都推进；命中判定仍只在厚度测试处发生。

### P0-2 命中深度/反射距离用半分辨率坐标重建（`Reflection.glsl:225-228`）

```glsl
ivec2 texel = uvToTexel(hitCoord * 0.5);          // ← 用象限坐标索引全分辨率 depthtex0
float hitDepth = loadDepth0(texel);
vec3 reflectViewPos = ScreenToViewPos(vec3(hitCoord * 0.5, hitDepth));
reflectionDist = distance(reflectViewPos, viewPos);
```

`uvToTexel(u) = ivec2(u * viewSize)`（`Math.glsl:45`）、`ScreenToViewPos(vec3 uv)` 内部 `ndc = uv*2-1`
（`Transform.glsl:13`）⇒ 传 `hitCoord*0.5` 得到 `ndc = hitCoord - 1 ∈ [-1, 0]`，**只对屏幕左上象限成立**。
注意 `*0.5` 对 `texture(colortex4, ...)` 是**正确的**（象限画布需要 `uv*0.5` 映射，§1.1），
错的是"用同一套坐标去取全分辨率深度 / 重建视图位置"。

**影响面**：`reflectionDist` 全错 ⇒ 接触硬化（`ROUGH_REFLECTION_CONTACT_HARDENING`，默认关）
拿到错的模糊半径；`.a` 目前只当 `FP16_MAX` 哨兵用。**一旦接反射降噪/粗糙半径就立刻变成硬 bug**，
所以属于"现在便宜修、以后贵十倍"的项。
**修法**：深度取 `loadDepth0(uvToTexel(hitCoord))`；视图重建用 `hitCoord`；`*0.5` 只留给 colortex4。

### P0-3 厚度判据是相对量 —— **分析保留，但"拍平成固定值"的修法已被实测否决**

`distance(sampleViewZ, stepViewZ) < -0.2 * stepViewZ`，viewZ 为负 ⇒ 等价 `|Δz| < 0.2 × |视深|`：
10 格外允许 2 格厚、30 格外允许 6 格 ⇒ 远处可能出现**假命中**（幽灵反射、漏光）。

**但 2026-10-08 当日实测证明：这条相对判据是"随距离缩放"的，不能改成固定上限。**
改成 `min(0.2×|视深|, 1.5 格)` 后用户实测"**远景反射质量下降**"：远处每步的深度跨度本就比 1.5 格
大（100 格长的射线 12 步 ≈ 8 格/步），拍平等于把远处的**合法**命中判负；再叠加 P0-1 的修复
（射线不再原地空转），这些漏判直接变成看得见的漏反射。近景不受影响（z≈5 时相对项 ≈1.0 格 < 1.5，
`min` 未生效）——与"只有远景变差"的实测完全吻合。

⇒ 正确做法是让容差与**每步的深度跨度**成比例（jiaozi158：厚度随步长一起指数增长），
或用几何二次验证：
1. 步长比例项：`tolerance ≈ k × |本步跨过的视深|`（k≈1~2），天然随距离缩放；
2. **本包独有优势**：`GI_MODE >= 2` 时 `voxelData` 占用网格在手边，对候选命中点做一次 3D 采样
   即可二次验证"这一格到底有没有几何"（等价于文献里的两层/多层深度方案）。
当前代码保留原判据，另留一个**默认关闭**的可选上限 `SSRT_MAX_THICKNESS`（0 = 与原实现逐位一致）。

### P0-4 死代码：恒不成立的法线检查（`Reflection.glsl:163`）

`skyLightDir = reflect(worldDir, worldNormal)`，而 `ssrRayDir = worldDir + worldNormal*(NdotV*2)`
在 `NdotV = abs(dot(N,-worldDir))` 下**就是同一个向量**（镜像方向）；且 `dot(N,R) = NdotV > 0`
⇒ `if (dot(worldNormal, skyLightDir) < EPS) return` 永不触发。附带那句
"天空方向：原始金属方向 / SSR 方向：正确方向"的注释是误导（两者相同）。**删除即可**。

### P0-5 粗糙反射模糊半径失控（`Reflection.glsl:244`）

`blurRadius = roughness² × 0.04 × ROUGH_REFLECTION_BLUR_STRENGTH(默认 20)`：
roughness 0.5 → **0.2**（画布 UV 的 20 %）、0.9 → 0.65，再被 `clamp(..., 0.001, 0.499)` 截断
⇒ 实际等价于"取半分辨率历史的平均"，不是 GGX 叶瓣。而且它是**屏幕空间模糊镜面命中色**，
方向本身根本没按粗糙度采样（见 §5.3 的 VNDF 项）。
**修法**：改用屏幕空间足迹公式（`roughness² × hitDist × projScale` 形式，Karis/Stachowiak 的写法），
或干脆交给"按粗糙度选 mip 的预过滤环境图 + VNDF 单射线"（§5.3）。

### P0-6（附带）边缘淡出实际是硬边 + 无环境回退

`Reflection.glsl:222-223`：`edgeFade *= 1e2 + cube(...) * 1e3` 让中景恒饱和到 1，
只有离屏 1~2 px 才衰减；而 `REFLECTION_SKY` / `SSRT_SKY_TRACING` 在 `profile.Default` 里都是 `!`（关），
水面 `TRANSLUCENT_SKY_REF` 也关 ⇒ **trace 失败就是黑**。
**注（2026-10-08 核对实机选项文件）**：`Revelation-AD-edit.txt` 里 `SSRT_SKY_TRACING=true`
（覆盖了 profile 的 `!`）⇒ 在用户当前配置下，"射线撞到天空深度"这一支是**生效**的
（`hit = true` 并取样上一帧历史），所以黑色缺失只出现在"射线出屏 / 纹理判定失败"的情形，
而不是所有 miss。分析问题时必须先查这个文件。
金属 miss 时 `DeferredLight.frag:959-961` 直接把 `metalness = 0` 当非金属着色（"金属变塑料"）。
**修法**：miss 回退到按粗糙度预过滤的天空/环境（§5.4），并把淡出改成真正的 `smoothstep` 边缘带。

### P0-7（附带）两份实现已漂移

`Reflection.glsl` 的 `rayTraceScene(..., steps)` 与 `Translucent.comp` 自带的
`rayTraceScene(..., dither)`（无 steps、另有一套步数策略）是两份代码；两个
`CalculateSpecularReflections` 的天空回退、fresnel 处理、返回值都不同。
`Translucent.comp:20-23` 的注释还写着"mode 2 – default"，而 `#ifndef` 默认是 **1**（注释过期）。
⇒ 同一个修要改两处，建议把公共部分收敛回 `lib/surface/SSRT.glsl`。

---

## 二·附 实测回归与回退（2026-10-08 当日，用户实测）

第一次落地时除了 P0-1/P0-2/P0-4 的修复，还顺手带了两处"性能向"改动，**两处都被实测否决并已回退**。
记录在此，避免以后有人再想当然地改回去：

| 试过的改动 | 实测现象 | 为什么错（回退理由） |
|---|---|---|
| **亚像素早退**：同像素重复采样时跳过深度读取，改按名义步长推进 | **近景反射有时出现条纹** | 本 march 的**推进量依赖刚读到的深度**（`advance = clamp(深度差/\|dirZ\|, ...)`），跳过读取就换了轨迹：大步长时会跨过薄表面，掠射角（近景）最明显。jiaozi158 那边能这么做，是因为它的步长是**固定的世界空间步长**（`for` 自增），读取与否不影响轨迹。 |
| **厚度容差加固定绝对上限 1.5 格** | **远景反射质量下降** | 相对判据随距离缩放，正是远处每步深度跨度变大的对应物；拍平会把远处合法命中判负（见 P0-3）。 |

### 第二/三次实测（同日）：近景条纹仍在，且**条纹匀速移动**

回退上述两处后用户复测：**远景质量提升**（确认"上限拍平"就是元凶），但**近景条纹仍在**，并补了
关键特征——**条纹会匀速移动**。据此定位为"离散格点 + 每帧抖相位 + 二元命中判定"的带状伪影：

- 判定 `|Δ视深| < 0.2×|视深|` 是**二元**的；近景一步跨过的视深（短射线 12 步 ≈ 0.4 格/步）与该阈值
  （z≈2 时 ≈0.4 格）**同量级** ⇒ 起点相位每帧一挪，接受/拒绝就翻转 ⇒ 条纹；远景每步跨度远大于阈值
  ⇒ 不翻转 ⇒ 无条纹（与"只有近景"一致）。
- dither = `SampleStbnVec2(..., frameCounter)`（STBN），时域轴每帧推进一格 ⇒ 图案**匀速滚动**。
- 反射被 TAA 用**表面**运动矢量累积（`TODO.md #0`）⇒ 收敛不掉。
- 本仓已有同类先例：`VoxelTracing.glsl:99-103` 记着"STBN 空间 tile 在特定纹理/距离下显现的
  **整齐密集斑纹**"，并用 Cranley–Patterson 逐像素平移压掉 —— 可作后续备选手段。

**修法（两处，一起把"相位敏感"的入口堵掉）**：
1. **天空命中改解析交点**：`SSRT_SKY_TRACING` 开启时，命中天空原本取"第一个越过天空面的**格点**"
   （`screenPos = rayPos`）。天空面在屏幕深度上是常数而射线 z 随 t 线性 ⇒ 交点可解析求出
   （`tSky = (screenDepthSky - origin.z)/rayDir.z`）。取格点会把命中 UV 量化到步进栅格上、随抖相位
   整步跳变；近景反射常在一两步内打到天空、而近景一步在 UV 上跨度很大 ⇒ 这是"近景条纹且匀速移动"
   最直接、且与步数/厚度判据都无关的来源。**该路径默认关，但用户实机 `SSRT_SKY_TRACING=true`。**
2. **厚度容差下限** `SSRT_THICK_FLOOR × 本步视深跨度`（默认 1.0），让"发生在一步之内的合法穿越"
   恒被接受 ⇒ 判定与抖相位无关。它只放宽**浅**穿越（近景），对"射线早已深穿到背面"的大跨距异常
   穿越仍然拒绝，防漏光能力不丢。注意它与上面被否决的"上限"方向相反：
   **上限（拍平远处）错，下限（覆盖近处一步）对**，两者并存（`SSRT_MAX_THICKNESS` 默认 0 = 关）。

**实测结果（第二轮）**：明显滚动条纹消失，仅剩**极少量轻微闪烁条纹**，其余（远景质量、近景观感）
无异常。残余部分归因于"1 采样噪声 + TAA 用表面运动矢量无法收敛"（= `TODO.md #0` 的架构性根因），
继续压它需要 P1 的反射运动向量/时域累积，而不是继续加阈值类补丁。

**保留的改动**：P0-1（空转修复，带对照开关 `SSRT_STALL_FIX`）、P0-2（半坐标）、P0-4（删死代码）、
命中点深度插值（`SSRT_HIT_INTERPOLATION`）、厚度容差下限（`SSRT_THICK_FLOOR`）。

**方法论教训**：把"顺手发现的性能微优化"和"行为修复"混在同一个补丁里，会让实测反馈无法归因；
本轮之后新增的每条改动都带独立对照开关（或单独提交），先 A/B 再收口。

---

## 三、高度可疑：`deferred21`（SpecularIndirect）整趟白做

**证据链**：
1. `SpecularIndirect.frag` 对 `material.specularMask`（`Material.glsl:90`：
   `saturate(0.4-roughness) + metalness > 1e-2`，覆盖面很广）跑完整的 SSR 追踪，写 colortex3。
2. `composite4.csh`（`Translucent.comp:376`）对**所有**像素 `imageStore(colorimg3, ...)`
   （仅第 234 行有越界早退）⇒ colortex3 被全量覆盖。
3. colortex3 的下游读者：`IntegrateScene.frag:308/317`（在 `composite4.fsh`，晚于 2 步）；
   `DeferredLight`（`deferred20`，**早于** deferred21）；`Accumulate/EAWF/DiffuseIndirect`
   （deferred1_a/4~9，均早于 21）；`MotionBlur.comp`（`composite10_a`，读的是 TAA 写的运动矢量，
   `TemporalAA.frag:38` 的 `RENDERTARGETS: 1,4,3`）。
4. `config.glsl:108` 的缓冲表自己写着 colortex3 = "Indirect diffuse lighting → **Indirect specular
   lighting** → Motion vector"，说明"间接镜面"这一环就是 deferred21。

⇒ 无论 `composite4` 的 `csh`/`fsh` 谁先调度，**每帧都有一整趟全屏 SSR 追踪不会体现在画面上**：
要么它的结果被 `Translucent.comp` 覆盖后才被读（= 白跑），要么它是被读的那一份、
而 `Translucent.comp` 的写入是死的（= 另一半白跑）。两者都跑 SSR，不可能都有效。

**验证（5 分钟，无需改代码）**：临时把

```properties
program.world0/deferred21.enabled = false
program.world-1/deferred21.enabled = false
program.world1/deferred21.enabled = false
```

加进 `shaders.properties`，进游戏对比画面。**若画面完全一致，即为白做，应删除该 pass 与
`SpecularIndirect.frag`**（保留 `Translucent.comp` 那一份，它才是玻璃/水面反射的实际来源）。
若画面有差异，则相反：应让 `Translucent.comp` 只写 colortex0、把 colortex3 让给 deferred21。
（注意：`deferred21` 从未出现在 `shaders.properties` 的任何 `.enabled` 规则里，
这与"作者会显式关掉空转 pass"的既有做法不一致，是本次发现的直接动因。）

---

## 四、路线图（按投入产出）

| 优先级 | 改动 | 依据 | 收益 | 成本/风险 |
|---|---|---|---|---|
| **P0** | P0-1 空转修复（带对照开关 `SSRT_STALL_FIX`） | 本审查 §2 | 省最多 11 次深度采样/追踪像素 + 找回被跳过的命中 | 极低 |
| ~~—~~ | ~~亚像素早退（同像素跳过深度读取）~~ **已实测回退** | jiaozi158 `PathTracing.hlsl` | 仅适用于**固定步长** march；本 march 的推进量依赖刚读到的深度，跳过即换轨迹 | — |
| **P0** | P0-2 半坐标修复、P0-4 删死代码 | 本审查 §2 | 消除后续所有反射时域/降噪工作的地基性错误 | 极低 |
| **P0** | VNDF 采样替换（反射方向按 GGX 可见法线分布抽） | Heitz 2018 | glossy 方差显著下降（固定 SPP 下） | 低（`BRDF.glsl` 已有 `SampleGGXVNDF`） |
| **P0** | 确认/清理 `SSPT_*` 死选项；确认 `SampleStbnVec2` 是**渐进式 STBN** | Wolfe 2022 | 清理 + TAA 收敛更稳 | 极低 |
| **P1** | 实测 §3 → 处理 `deferred21` | 本审查 §3 | 潜在最大单笔性能收益 | 低（一条 properties 规则） |
| **P1** | P0-3 厚度判据改绝对/步长挂钩（或体素占用二次验证） | McGuire & Mara 图 3；本包体素网格 | 消幽灵反射/远距假命中 | 低~中 |
| **P1** | **反射自己的运动向量**（virtual motion，见 §5.5） | NRD/ReBLUR；Stachowiak 2015 | 解 `TODO.md #0` 拖影；随机采样反射的前提 | 中 |
| **P1** | miss 回退：按 roughness 预过滤的天空/环境（split-sum），可选叠加**已有体素辐射度场** | Karis 2013；RTG Ch.32 | 消屏幕边缘硬边 + 金属不再变塑料 | 低 |
| **P2** | 半分辨率追踪 pass + 克隆 EAWF 做反射降噪（lobe-aware 采样平面 + hitDist 自适应半径） | NRD；Schied 2017 | 追踪量 1/4 + 消波前分歧放大 | 中高 |
| **P2** | A-SVGF 式自适应时域 alpha（重投影 + 同随机序列重求值 → 时域梯度） | Schied 2018 | 消 ghosting/高光拖尾 | 中 |
| **P3** | 线性 march → 透视校正 2D DDA（论文 Listing 2/3/4）或重试 Hi-Z | McGuire & Mara 2014；`6ac5ce9d`/`efa5ff94` | 消跳像素/过采样 | 中（Hi-Z 需先解决 §6 的接线问题） |
| **P3** | reservoir + MIS（SSR 域 + 探针域）做反射样本复用 | ReSTIR 课程 / GRIS | 接近多 SPP 质量 | 高（且**纯屏幕空间必有偏**） |

---

## 五、文献（含验证状态）

### 5.1 术语溯源：SSPT

- **具名起点**：Dennis Gustafsson (Voxagon/Teardown)，*Screen Space Path Tracing – Diffuse*，
  2018-01-03，<https://blog.voxagon.se/2018/01/03/screen-space-path-tracing-diffuse.html>；
  前置 *A better depth buffer for raymarching*，2017-11-22，
  <https://blog.voxagon.se/2017/11/22/a-better-depth-buffer-for-raymarching.html>。
  核心要素：两层深度（front+back）、世界空间固定步长指数递增 march、命中从上一帧 reproject 取光、
  history ≈70 % 的时域重投影、7×7 两遍空间滤波（用 object/smoothing-group ID 防跨面模糊）。
- **事实标准实现**：jiaozi158，*UnitySSPathTracingURP*，
  <https://github.com/jiaozi158/UnitySSPathTracingURP>（`Assets/Shaders/ScreenSpacePathTracing/PathTracing.hlsl`）。
- **勘误**：Luksch et al., *Real-Time Rendering of Glossy Materials with Regular Sampling*,
  The Visual Computer 30(6-8):717-727 (CGI 2014), DOI 10.1007/s00371-014-0958-x
  <https://www.cg.tuwien.ac.at/research/publications/2014/LUKSCH-2014-RTR/>
  —— 内容是**环境贴图的 regular sampling + MIP 过滤**，与屏幕空间路径追踪无关，**不要引为 SSPT 出处**。
  Ray Tracing Gems / RTG2 **没有** SSPT 章节。SSPT 是社区/工业术语，不是学术术语。
- SSPT 原版就是 **GGX 半向量重要性采样 + lobe roulette**（`ImportanceSampleGGX_PDF` +
  `reflectProbability/specProbability/diffProbability` 按概率选 lobe、能量乘 `1/probability`），
  不是 uniform/regular 采样。

### 5.2 采样与追踪

- Heitz, *Sampling the GGX Distribution of Visible Normals*, JCGT 7(4), 2018，
  <https://jcgt.org/published/0007/04/01/>：VNDF 使权重中的可见性项相互抵消 ⇒ 固定 SPP 下方差降低
  （论文以方差度量，**未给单一倍数**，此处不编造）。实现成本≈换一个采样函数。**本包已有**
  （`BRDF.glsl:24/44`，含 Dupuy & Benyoub 2023 球冠版 <https://arxiv.org/pdf/2306.05044>）。
- McGuire & Mara, *Efficient GPU Screen-Space Ray Tracing*, JCGT 3(4), 2014，
  <https://jcgt.org/published/0003/04/04/>：透视校正 **2D DDA**（不是 Hi-Z）。保证：相邻采样、
  每像素最多一次、裁剪到视锥；`stride > 1` 换性能且**只建议用于粗糙表面**；多层深度 ≤4 层；
  实测 1080p、25 次迭代、对角射线：**Titan 1.2 ms / GeForce 650M 6.4 ms**；
  未来工作明确包含"最终区间二分"与"亚像素细化后双线性取样"，后者正是 jiaozi158 采用的路线。

### 5.3 Stochastic SSR 与降噪

- Stachowiak (Frostbite), *Stochastic Screen-Space Reflections*, SIGGRAPH 2015 ARTR，
  <https://advances.realtimerendering.com/s2015/>：filtered importance sampling 得到物理正确但有噪声的结果；
  **邻域射线复用**以极小成本模拟"每像素多条射线"；同一机制支持**降低分辨率追踪 + 全分辨率细节**；
  困难区域多投射线；时域重投影；关键处用精确层次化追踪。（讲义 PPTX 下载返回 406，
  以上全部来自课程页官方摘要，**未编造毫秒数**。）
- Schied et al., *SVGF*, HPG 2017，<https://cg.ivd.kit.edu/svgf.php>：1 spp → 1920×1080 **10 ms**，
  时域稳定性约 10×、SSIM 好 5–47 %。输入契约：颜色 + 深度/世界坐标 + 法线 + 运动矢量 + 历史长度（+ 亮度矩）。
- Schied, Peters, Dachsbacher, *A-SVGF*（Gradient Estimation for Real-Time Adaptive Temporal Filtering），
  PACMCGIT 1(2), 2018，<https://cg.ivd.kit.edu/atf.php>：1 spp、1280×720，**时域滤波约 2 ms**；
  机制 = **重投影上一帧表面采样点 + 用同一随机序列重求值** ⇒ 时域梯度 ⇒ 逐像素自适应 alpha；
  官方页点名 SVGF 的病是"光源关闭后光照仍在、高光留下拖尾"。**对症本包 `TODO.md #0`**。
- NVIDIA NRD，<https://github.com/NVIDIA-RTX/NRD>（ReBLUR/RELAX/SIGMA）；ReBLUR 章节见
  Ray Tracing Gems II Ch.49 <https://link.springer.com/book/10.1007/978-1-4842-7185-8>；
  源码级剖析 <https://www.cnblogs.com/KillerAery/p/16653203.html>（ReBLUR ≈10 ms @2K on RTX 2060，
  该文结论：**NRD 过于重量级，应参考其思路自建轻量管线**）。

### 5.4 粗糙反射的廉价替代

- Karis, *Real Shading in Unreal Engine 4*, SIGGRAPH 2013 PBS，
  <https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_slides.pdf>：
  **split-sum**（预过滤环境图 + 环境 BRDF 2D LUT）。与 SSR **叠加**而非互替：SSR 管屏内精确视差，
  预过滤图管离屏/高粗糙。
- *Accurate Real-Time Specular Reflections with Radiance Caching*, Ray Tracing Gems Ch.32，
  <https://link.springer.com/chapter/10.1007/978-1-4842-4427-2_32>；
  Eto et al., *Real-time Rendering of Glossy Reflections using Ray Tracing and Two-level Radiance
  Caching*, SIGGRAPH Asia 2023 TC, DOI 10.1145/3610543.3626167。
  ⇒ **本包可直接复用已有的 64³ IRC / VXGI 1m 辐射度场当"辐射缓存"**（`GI_MODE >= 2` 时数据在手边），
  这是文献方案在 Iris 下的等价物。

### 5.5 时域重投影 / 光线复用

- 最早形态即 §5.1 的 voxagon：命中后从上一帧 reproject 取光（跨帧弹射）。
- NRD/ReBLUR 的 **virtual motion**：由 `hitDist` 与 view 算出反射虚像位置 `X_virtual`，
  用上一帧相机投影得 `virtualPrev`，再用 `GetSpecularDominantFactor(NoV, roughness)` 往表面方向拉
  以适配非镜面 lobe；与 surface motion 按 accum speed 比例混合，virtual 置信度低则回退 surface。
  （与 NVIDIA 2021 "reliable motion vectors" 的 glossy motion vector 同源。）
- 轻量落地版：存上一帧**反射命中点的屏幕 UV + hitDist**（+ 命中法线/roughness），
  本帧用运动矢量 + virtual motion 重投影，校验通过就复用颜色而不重新追踪。

### 5.6 噪声

- Wolfe, Morrical, Akenine-Möller, Ramamoorthi, *Scalar Spatiotemporal Blue Noise Masks*, 2022，
  <https://arxiv.org/abs/2112.09629>（**正式标题/venue 未验证**，arXiv 标题为 Scalar…）：
  逐帧独立使用 2D 蓝噪声在时间维是白噪声 ⇒ 收敛更慢、时域滤波不稳；golden-ratio/R2 位移会
  **破坏空间频率内容**并有时间频闪；STBN 用**同层 2D + 同像素跨层 1D** 的能量函数、所有轴**环形**计算；
  关键性质 **toroidally progressive**：TAA 拒绝历史的像素能**立即从序列好位置重启**。
  本包 `Reflection.glsl:199/263` 已在用 `SampleStbnVec2` ⇒ 值得确认底层是 3D/数组 mask 的渐进 STBN。

### 5.7 ReSTIR / 重采样（含边界条件）

- Bitterli et al., SIGGRAPH 2020，DOI 10.1145/3386569.3392481；
  ReSTIR GI（CGF 40(8) 2021，DOI 10.1111/cgf.14378）；GRIS/ReSTIR PT（TOG 41(4) 2022，
  DOI 10.1145/3528223.3530158）；教程 *A Gentle Introduction to ReSTIR*（SIGGRAPH 2023 Courses，
  <https://intro-to-restir.cwyman.org/>）。
- **必需记下的限制**（课程笔记原文意译）：无偏的硬条件是"样本 support ⊇ 被积函数 support"，
  而"后处理降噪器完全忽略 support 问题，这就是它们常常损失能量的原因"。SSR 的 support
  （屏内可见几何）永远小于 BRDF lobe ⇒ **纯屏幕空间的 ReSTIR 必有偏**。
  实用折中：把探针/天空/预过滤环境图作为**第二样本域**做 MIS（Cyberpunk 2077 RT: Overdrive 的做法）。

### 5.8 工业实践（不可直接移植，作参考）

- AMD FidelityFX Hybrid Stochastic Reflections / Far Cry 6：
  <https://gpuopen.com/fidelityfx-hybrid-reflections/>、
  <https://gpuopen.com/download/GDC_Performant_Reflective_Beauty_Hybrid_Ray_Traced_Reflections_In_Far_Cry_6.pdf>
  —— SSLR + DXR 混合、**射线缓冲半分辨率**、BVH 只放 100 单位内、async compute 建 BVH。
  其中"半分辨率射线缓冲"与 §四 的 P2 同向（无 DXR 时只能做前半段）。
- Neural Radiance Cache（TOG 40(4) 2021）与 DLSS Ray Reconstruction：
  需要 tensor core / 硬件光追信号，**Iris 不可用**，仅记录为"文献到此为止"的边界。

---

## 六、历史与既有结论（避免重复劳动）

- `6ac5ce9d perf(ssr): Hi-Z 分层追踪` → `efa5ff94 revert: 回退 B'5 Hi-Z SSR`（2026-09-21，用户实测裁定）。
  回退理由是**开 CAS 时 Iris 报 GLSL source pre-processing failed、切选项触发全量重编、
  新 pass 首次进重编路径**（`PROGRESS_TODO.md:131-137` 同记），**不是 Hi-Z 算法本身不行**。
  ⇒ 若要重试 Hi-Z，先把"新 image + `program.world*/deferred.enabled` 门控 + CAS 下的重编路径"
  单独做成最小复现。
- `TODO.md #0 反射拖影（2026-09-03 暂缓）`：现象/根因/三个候选方向已经写全，本次审查给的
  是**具体可落地的第 4 个方向**（virtual motion + A-SVGF 式自适应 alpha），见 §5.3/§5.5。
- `TODO.md #3 ReSTIR Phase A`（时域 reservoir 复用）已完成 ⇒ 反射侧若要做复用，
  `image.reservoirA/B` 那套基建现成，但注意 §5.7 的 support 限制。

---

## 七、测量工具（先测再改）

- `rdc_analysis/`（.gitignore）里的 RenderDoc 抓帧分析：`lookme_cost.py`、`timings.py`、
  `pass_audit.py`、`cost_by_category.py`、`dispatch_sizes.py`。
- `scripts/perf/compare.js` + `scripts/perf/perf_compare_test_optimized.md`：既有 A/B 流程。
- 建议先量 `deferred20` / `deferred21` / `composite4.csh` 三趟的耗时占比，再决定 P1/P2 的投入顺序。

---

## 八、本文档范围声明

- 全部"已确认缺陷"均由读码得出，附 `file:line`；`§3` 的 deferred21 结论是**待实测的推断**，
  已给出 5 分钟验证法与两种后续处置。
- 文献条目均附链接；**无法从一手来源验证的数字一律未给**（Stachowiak 讲义具体毫秒、
  Eto et al. 2023 数字、ratio estimator 的确切首发标题、"Karis/Chen 2021 implicit ray" 一文均未找到出处，
  文档中不复述、不引用）。
- 本次审查文档本身不改代码；对应的修复在工作区（`shaders/lib/surface/SSRT.glsl`、
  `shaders/lib/surface/Reflection.glsl`），经 2026-10-08 一轮实测回归后收窄为
  **P0-1 / P0-2 / P0-4 + 命中点插值**（另两处已回退，见 §二·附），待复测通过后单独提交。
