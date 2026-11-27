# CONTEXT — 这个仓库是什么

> 一份读完就知道"这是什么、东西在哪、什么不能碰"的底稿。**不含待办、不含现状**（那些在 `STATUS.md`）。

## 一句话

`Revelation-AD-edit` 是 Minecraft 光影包（Iris 平台），在上游 Revelation 基础上重写了体素追踪 GI，
并把 **diffuse 间接光的降噪链逐项对齐 NVIDIA NRD 的 REBLUR**。specular 明确不在对齐范围内。

## 运行环境（每一条都影响改法）

| 项 | 值 |
|---|---|
| 游戏 | MC 1.21.11 / Fabric 0.18.4；另有 26.3 实例（MC 26.3 + Iris 1.12 snapshot） |
| 渲染后端 | 1.21.11 走 OpenGL；**26.3 走 Vulkan**（`image.` 自定义图只能用 RGBA16F / RGB10_A2 / R32UI 这类保证支持的格式） |
| Iris 版本差异 | 1.10.8 与 1.12 的手部投影矩阵不同（1.12 多乘 `.m22(0.125).m32(0.4375)`）⇒ 深度还原公式必须双区间 |
| 选项文件 | `shaderpacks/Revelation-AD-edit.txt`，**Iris 每次重载会重写它，只保留自己认识的键** |
| 编译器 | 本机**没有** GLSL 编译器。三套脚本只查语义与预处理，**能不能编译只有 Iris 能证明** |
| 重载方式 | Iris 不监听文件变化，唯一途径是游戏前台按 `i` |

## GI 主链（diffuse，按真实 include 顺序）

```
deferred1_a   DiffuseIndirect.comp    体素 DDA 追踪，1spp 出原始间接光
deferred1_b   GIPrepass.comp          半分辨率预滤波：空间重用邻域（NRD_PREPASS_RADIUS）
deferred4     Accumulate.frag         时域累积（colortex2 / 21），alpha = 1/(1+k·N)
deferred5     GIHistoryFix.comp       历史不连续处用邻域重建（断奶台阶）
              VarianceEstimate.comp   → EAWF 用的方差
deferred6/7   EAWF.comp               a-trous 空间滤波（同一 shader 多级）
deferred10    GIHistoryStore.comp     TS 前的历史快照（compute 不 flip ⇒ 必须错开读写）
deferred11    GIStabilize.comp        时域稳定化（NRD 的 TS：只稳亮度，色度用本帧）
deferred30-32 SpecularFilter.comp     镜面滤波（不属于 REBLUR 对齐范围）
deferred40    PTGI_Median.comp        中值兜底
```

体素本身：`deferred23 VoxelGI.comp` 负责注入/更新，`deferred22 VoxelGI.frag` 负责可视化。

**累积器的关键性质**：历史被判不可信时 `A` 直接归 1 ⇒ `alpha≈0.81` ⇒ 那一帧屏幕上 81% 是裸 1spp 噪声。
所以"一动就满屏脏"首先是**判据问题**，不是滤波强度问题。

## 术语表

| 词 | 在本仓库的含义 |
|---|---|
| **REBLUR** | NRD 里的 diffuse 降噪器；我们逐项对齐的就是它（半分辨率输入） |
| **prepass** | 降噪前的空间重用，用邻近已收敛纹素补当前纹素 —— 不是"预处理" |
| **TA / accum** | 时域累积，靠重投影 + alpha 混合历史 |
| **TS / Stabilize** | 时域稳定化，NRD 在空间滤波**之后**再做一次时域 |
| **EAWF** | 边缘感知 a-trous 小波滤波，REBLUR 的空间滤波主体 |
| **HistoryFix / NLAS** | 历史修复 / 邻域抗噪累积，用于处理遮挡解除与历史不足 |
| **VXGI** | 本包的体素全局光照（追踪 + 体素光场），是"被降噪的对象" |
| **IRC** | 体素辐射度缓存，低频辐照度场，与 VXGI 追踪互补 |
| **DDGI / Probe GI** | 探针式辐照度缓存（已实现，与 VXGI 互斥可选） |
| **SSILVB** | 另一条 GI 路径，与 VXGI 互斥 |
| **A（累积帧数）** | `integratedDiffuse.a`，决定 alpha，也喂给 NLAS 与 TS 的 accumSpeed |

## 权威来源

- NRD 仓库：`https://github.com/NVIDIA-RTX/NRD`，**master = v4.18.0**（2026-11-10 校正）。
  引用时**必须写版本 + 文件路径**：v4.18.0 在 `Shaders/`，v4.11.4 在 `Shaders/Include/` 与 `Shaders/Source/`，路径完全不同。
- 官方文档快照：`docs/reference/nrd/README.md`（离线可读，不用联网）。
- REBLUR 论文原文：`docs/reference/nrd/REBLUR_paper_RTG2_ch49.pdf`。机制细节比 README 全，
  曾经因为只读 README 而漏掉一个核心机制 —— **对不上的地方先去论文里找**。

## 明确不做

- specular 的 NRD 对齐（只做 diffuse）
- OptiFine 兼容（硬性不兼容）
- 改 `shaders/ffx/`（AMD FidelityFX，整目录第三方，只随上游整体替换）

## 目录速查

| 路径 | 内容 |
|---|---|
| `shaders/settings.glsl` | 所有选项定义（唯一） |
| `shaders/shaders.properties` | GUI 分组/滑块/档位 —— **纯 ASCII，写中文整包失效** |
| `shaders/lib/**` | 可复用纯函数 |
| `shaders/program/**` | pass 实现体 |
| `shaders/world*/` | pass 入口（只有 `#version` + `#define PASS_*` + `#include`） |
| `docs/CODE_STYLE.md` | 代码规范（改代码前必读） |
| `docs/adr/` | 架构决策记录 |
| `docs/archive/` | 历史快照，**只读**，检索见 `MEMO-INDEX.md` |
| `scripts/` | 三套自检脚本 + `rdc/`（RenderDoc 分析脚本） |
