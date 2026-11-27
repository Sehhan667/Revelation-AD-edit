#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lookme.rdc -> ranked "most expensive features" table.

Program -> pass names are pinned by hand (see MANUAL): the automatic
fingerprint could not separate gbuffers variants that share the same libs, so
each big program was identified from its fragment outputs / vertex attributes
in the captured glsl-transformer source.
"""
import collections
import lookme_lib as L

MANUAL = {
    # --- vanilla / mod side (not shaderpack code) -------------------------
    "281": ("原版 精灵动画图集插值 (SpriteAnimationInfo, 4096x2048 图集 5 级 mip)", "vanilla"),
    "351": ("原版 精灵动画图集插值 (SpriteAnimationInfo, 4096x2048 图集 5 级 mip)", "vanilla"),
    # --- shadow ------------------------------------------------------------
    "815300": ("shadow - Shadow.frag (1024x1024 阴影贴图)", "pack"),
    "815396": ("shadow - Shadow.frag (1024x1024 阴影贴图)", "pack"),
    "815401": ("shadow - Shadow.frag (1024x1024 阴影贴图)", "pack"),
    "815406": ("shadow - Shadow.frag (1024x1024 阴影贴图)", "pack"),
    # --- gbuffers ----------------------------------------------------------
    "815410": ("gbuffers_terrain - Terrain.frag (Sodium 紧凑顶点, 不透明/裁剪变体)", "pack"),
    "815414": ("gbuffers_terrain - Terrain.frag (Sodium 紧凑顶点, 不透明/裁剪变体)", "pack"),
    "815418": ("gbuffers_water - Water.frag (写 waterOut)", "pack"),
    "815129": ("gbuffers_entities - Entities.frag", "pack"),
    "815159": ("gbuffers_hand - Hand.frag (主手/副手)", "pack"),
    "815209": ("gbuffers_basic/textured - Basic/Textured.frag", "pack"),
    "815064": ("gbuffers 粒子/覆盖层类 (仅写 albedoOut)", "pack"),
    "815054": ("空通道 (main(){discard;})", "pack"),
    # --- deferred ----------------------------------------------------------
    "814963": ("deferred20 - DeferredLight.frag (直接光照)", "pack"),
    "814979": ("deferred21 - SpecularIndirect.frag (间接高光)", "pack"),
    "814982": ("deferred23 - gi/VoxelGI.comp (体素 GI)", "pack"),
    "814948": ("deferred1 - ReprojectScene.comp (重投影)", "pack"),
    # --- 尾部：原版 GUI / 呈现 ---------------------------------------------
    "307": ("原版 呈现 blit (InSampler 全屏三角形)", "vanilla"),
    "289": ("原版 呈现 blit (InSampler 全屏三角形)", "vanilla"),
    "226": ("原版 GUI/HUD 绘制 (DynamicTransforms)", "vanilla"),
    "321": ("原版 GUI/HUD 绘制 (DynamicTransforms)", "vanilla"),
    "331": ("原版 GUI/HUD 绘制 (DynamicTransforms)", "vanilla"),
    "318": ("原版 GUI/HUD 绘制 (带 Fog)", "vanilla"),
    "172": ("原版 GUI/HUD 绘制 (DynamicTransforms)", "vanilla"),
    "814938": ("Iris 内部辅助 compute (仅 fog uniform)", "pack"),
    # --- composite / final -------------------------------------------------
    "814987": ("composite4 - Translucent.comp (半透明合成)", "pack"),
    "814985": ("composite4 - IntegrateScene.frag (场景合成)", "pack"),
    "815001": ("composite7 - TemporalAA.frag (时域抗锯齿)", "pack"),
    "815017": ("composite31 - Grade.frag (调色)", "pack"),
    "815021": ("final - Final.frag (最终输出)", "pack"),
    # --- begin / prepare ---------------------------------------------------
    "814936": ("begin - atmosphere/SkyView.comp (大气天空 LUT)", "pack"),
    "814940": ("prepare_a - GenSkyMap.comp", "pack"),
    "814942": ("begin1 / setup 图像清理", "pack"),
    "814946": ("deferred1 - ReprojectScene.comp", "pack"),
    "814954": ("deferred1_a - DiffuseIndirect.comp (间接漫反射)", "pack"),
    "814958": ("deferred2 - clouds/Render.comp (体积云)", "pack"),
    "814992": ("composite6 - DOF/Prepare.comp (景深)", "pack"),
    "814996": ("composite6_a - DOF/Gather.comp (景深)", "pack"),
    "814998": ("composite6_b - DOF/Postfilter.comp (景深)", "pack"),
    "815004": ("bloom Downsample/Blur.comp", "pack"),
    "815006": ("bloom Blur.comp", "pack"),
    "815008": ("bloom Blur.comp", "pack"),
    "815010": ("bloom Blur.comp", "pack"),
    "815012": ("composite21 - AutoExposure.comp (自动曝光)", "pack"),
    "815014": ("bloom Blur.comp", "pack"),
}

cost = collections.Counter()
calls = collections.Counter()
group = {}
vps = collections.defaultdict(collections.Counter)
pid_order = []
prog = None
vp = None
SYNC = collections.Counter()
NONSHADER = collections.Counter()

for c in L.chunks:
    if c["ci"] < L.frame_start:
        continue
    n = c["name"]
    if n == "glViewport":
        vp = "%sx%s" % (L.grab_int("width", c["body"]), L.grab_int("height", c["body"]))
        continue
    if n == "glUseProgram":
        prog = L.grab("program", c["body"])
        continue
    if n in L.DRAW or n == "glDispatchCompute":
        name, grp = MANUAL.get(prog, ("未识别 prog %s" % prog, "pack"))
        if prog not in group:
            group[prog] = (name, grp)
            pid_order.append(prog)
        cost[prog] += c["dur"]
        calls[prog] += 1
        vps[prog][vp] += 1
    elif n in ("glCopyTexSubImage2D", "glCopyImageSubData", "glBlitFramebuffer"):
        NONSHADER["帧缓冲拷贝 / blit"] += c["dur"]
    elif n.startswith("glClear"):
        NONSHADER["清屏 clear"] += c["dur"]
    elif n in ("glMemoryBarrier", "glTextureBarrier"):
        NONSHADER["barrier"] += c["dur"]
    elif "Sync" in n or n in ("glFinish", "glFlush"):
        SYNC[n] += c["dur"]

work = sum(cost.values()) + sum(NONSHADER.values())
gpu = sum(cost.values())

print("capture: lookme.rdc   frame chunks %d..%d" % (L.frame_start, L.chunks[-1]["ci"]))
print("GPU 工作总量 %d us   其中着色器 %d us (%.1f%%)   拷贝+清屏 %d us (%.1f%%)"
      % (work, gpu, 100.0 * gpu / work, sum(NONSHADER.values()),
         100.0 * sum(NONSHADER.values()) / work))
print("另有同步等待 %d us (glFenceSync/ClientWaitSync, 属 CPU 侧停顿, 未计入上表)\n" % sum(SYNC.values()))

print("%-6s %8s %7s %6s %-5s %s" % ("rank", "us", "% GPU", "calls", "type", "feature"))
print("-" * 110)
for i, (pid, v) in enumerate(sorted(cost.items(), key=lambda kv: -kv[1]), 1):
    name, grp = group[pid]
    vstr = ", ".join("%s x%d" % (k, n2) for k, n2 in vps[pid].most_common(4))
    print("%-6d %8d %6.1f%% %6d %-5s %s" % (i, v, 100.0 * v / gpu, calls[pid], grp, name))
    print("%-6s %8s %6s %6s %-5s   viewport: %s" % ("", "", "", "", "", vstr))
print("-" * 110)
for k, v in NONSHADER.most_common():
    print("%-6s %8d %6.1f%%      %-5s %s" % ("", v, 100.0 * v / gpu, "non", k))

print("\n=== 合并同名后的完整排名 ===")
agg = collections.Counter()
agc = collections.Counter()
agv = collections.defaultdict(collections.Counter)
for pid, v in cost.items():
    name, grp = group[pid]
    agg[name] += v
    agc[name] += calls[pid]
    for k, n2 in vps[pid].items():
        agv[name][k] += n2
for i, (name, v) in enumerate(agg.most_common(), 1):
    grp = next(g for p, (n2, g) in group.items() if n2 == name)
    print("%2d) %-58s %6d us %5.1f%% x%-3d [%s] %s"
          % (i, name[:58], v, 100.0 * v / gpu, agc[name], grp,
             " ".join("%s*%d" % (k, n2) for k, n2 in agv[name].most_common(3))))

print("\n=== 按类别汇总 ===")
byg = collections.Counter()
for pid, v in cost.items():
    byg[group[pid][1]] += v
for g, v in byg.most_common():
    print("  %-8s %8d us  %.1f%% of shader work" % (g, v, 100.0 * v / gpu))

pk = collections.Counter()
for pid, v in cost.items():
    if group[pid][1] == "pack":
        pk[group[pid][0].split(" - ")[0].split(" ")[0]] += v
print("\n=== 光影包内部 top (按 pass 名) ===")
for k, v in pk.most_common(12):
    print("  %-18s %8d us  %.1f%%" % (k, v, 100.0 * v / gpu))
