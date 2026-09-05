# Revelation-AD-edit — GI 调试进度 & 待办（2026-09-04）

## 一、当前生效方案（IRC_GI，逐格、免 SVGF）

- **IRC_GI**：64³×1m 逐格辐照度光场（`voxelRadiance`，deferred22/VoxelGI.frag 逐格注入+传播），
  查询端（deferred1_a 内）一次三线性采样。**无每像素追踪、无 SVGF**。
- **IRC_GI 只出「阳光 + 方块光」**：用 IRC 的**天空曝光度 alpha** 门控 `_irc *= (1 - alpha)`
  （露天 alpha≈1 → 天光/环境部分收掉交给 SH；洞里 alpha≈0 → 满上补方块/被遮挡阳光）。
- **完整方向性 SH 天空**：露天环境光仍由 `ConvolvedReconstructSH3(global.skySH, worldNormal)` 提供
  （还原了 1.0.2b 的方向性），IRC_GI **不再屏蔽 SH**（VXGI 仍屏蔽，走原路径）。
- **夜晚亮度旋钮（已接线）**：`NIGHT_BRIGHTNESS`（原为空定义，已接到夜晚环境光+月光直射）、
  `MOON_BRIGHTNESS_MULTIPLIER`（已加入 GUI MiscLighting）。
- **VXGI 未动**：所有门控为 `VOXEL_GI_ENABLED || IRC_GI_ENABLED`（或含 SSILVB/PROBE），VXGI 打开时行为不变。

## 二、已废弃（代码保留，暂不启用）
- **DDGI 探针（4m 方向性探针缓存）**：`PROBE_GI_ENABLED` 已注释；`screen.ProbeGI` 已移除；
  探针 image 绑定（`probeIrradiance/2, probeDistance/2`）已删除（也解决了 16-image 超限）。
  ProbeTrace/ProbeUpdateSlice 等代码还在 `#ifdef PROBE_GI_ENABLED` 下，以后可再启用。

## 三、主分支结构（diffuse/DiffuseIndirect.comp, deferred1_a）
```
#ifdef IRC_GI_ENABLED        -> 三线性采样 voxelRadiance IRC（×0.01）× (1-天空曝光) × IRC_GI_STRENGTH
#elif defined PROBE_GI_ENABLED -> [已废弃探针路径，未定义不编译]
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
2. **去掉 screen 定义时必须同步父菜单的 `[XXX]` 引用**（删 `screen.ProbeGI` 但 `[ProbeGI]` 还留在
   `screen.GlobalIllumination` → GUI 残留"点不开的 ProbeGI"）。
3. **新增 image 槽位会挤爆 16 上限**（probe 4 张 + voxel 6 张 + reservoir 4 张 → `Only up to 16 images`）。
4. **GI 分支的 `program.*/deferred1_a.enabled` 门控必须包含新 GI 宏**，否则 compute 不调度 → 没GI + 曝光/天空缓冲脏。
5. DeferredLight 复合（`sceneOut += colortex3`）和「网格内屏蔽 SH」的门控也要跟着 GI 宏扩展。
6. `NIGHT_BRIGHTNESS`、`MOON_BRIGHTNESS_MULTIPLIER` 原本都是空定义（两版）——要接线才有效。

## 五、待办
- [ ] **露天 IRC 阳光反弹**：目前 `(1-alpha)` 门控在露天把 IRC 的阳光反弹也压掉（露天交给 SH）。
      如需露天也能看到 IRC 阳光反弹 → 放松门控（如 `_irc *= (1 - 0.75*alpha)` 留 25%）或做"阳光 vs 天空"分离。
- [ ] **全场景对照测试**：白天露天 / 夜晚 / 洞穴火把 各截一张，确认无漏光、无色偏、方向性正确。
- [ ] **夜晚亮度定标的默认值**：对齐 1.0.2b 的目标，把 `NIGHT_BRIGHTNESS`/`MOON_BRIGHTNESS_MULTIPLIER` 预设到合适值。
- [ ] **清理废弃 DDGI 代码**：删 / 注释无用的 ProbeGI.glsl、ProbeTrace、ProbeUpdateSlice（在 PROBE 关闭下已不编译，但留作死代码）。
- [ ] **lang 文件**：给 `screen.IRCGI`、`MOON_BRIGHTNESS_MULTIPLIER` 加中文/英文标签（zh_CN.lang / en_US.lang）。
- [ ] **提交/收尾**：确认最终状态后 `git commit`，并更新 MEMO.md 的 GI 关键点。

## 六、关键入口（改了这些要重选包/F3+R）
- settings.glsl：`IRC_GI_ENABLED`、`IRC_GI_STRENGTH`、`NIGHT_BRIGHTNESS`、`MOON_BRIGHTNESS_MULTIPLIER`。
- shaders.properties：`program.*/deferred1_a.enabled`（含 IRC_GI）、`program.*/deferred22.enabled`、
  `screen.IRCGI`、`screen.MiscLighting`。
- diffuse/DiffuseIndirect.comp：IRC_GI 分支（查询端三线性 IRC + 门控）。
- VoxelGI.frag：IRC 注入门控（`VOXEL_GI_ENABLED || IRC_GI_ENABLED`）。
- DeferredLight.frag：复合门控、网格内 SH 屏蔽门控、夜晚亮度（nightAmt）。
