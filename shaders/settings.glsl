/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

	Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
	Modified by AnotherCream, 2026.





--------------------------------------------------------------------------------

*/

#if !defined INCLUDE_SETTINGS
#define INCLUDE_SETTINGS

#define RENDER_MODE 1 // [0 1]
#define RP_SUPPORT

#define INFO   3 // [0 1 2 3]
#define AUTHOR 0 // [0]
#define AD 0 // [0]

const int shadowMapResolution = 1024;  // [1024 1536 2048 4096 8192 16384 32768]（体素化平铺要求 ≥1024）
const float	shadowDistance 	  = 64.0; // [32.0 48.0 64.0 80.0 96.0 112.0 128.0 160.0 192.0 224.0 256.0 320.0 384.0 512.0 768.0 1024.0 2048.0 4096.0 8192.0 16384.0 32768.0 65536.0]

const float shadowDistanceRenderMul = 1.0; // [-1.0 1.0]

// [2026-11-12 B4] 实体阴影距离倍率：Iris 常量指令，**只影响实体**（地形/方块仍按 shadowDistance）。
// 0.5 = 32 格外实体不进 shadow pass（实体多时省 0.1–0.4 ms/帧），代价是远处实体没有阴影。
// 1.0 = 旧行为。带值列表所以是可选的 GUI 项；不动 shadowDistance 本身是为了保留地形阴影距离。
const float entityShadowDistanceMul = 0.5; // [0.0 0.25 0.5 0.75 1.0]

const float realShadowMapRes = float(shadowMapResolution) * MC_SHADOW_QUALITY;

//======// Environment //=========================================================================//

#define SUN_RADIUS_MULT 2.0 // Multiplier of the sun radius (1.0 = real sun radius). [1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 21.0 22.0 23.0 24.0 25.0 26.0 27.0 28.0 29.0 30.0 31.0 32.0 33.0 34.0 35.0 36.0 37.0 38.0 39.0 40.0]

const vec3 sunIrradiance = vec3(1.0, 0.949, 0.937);


// 用宏统一控制，避免重复定义
#ifdef DIMENSION_THE_END
    const float sunAngularRadius = 0.004675 * 40.0;   // 0.187
#else
    const float sunAngularRadius = 0.004675 * SUN_RADIUS_MULT;
#endif

/* Clouds */
	#define CLOUDS
	//#define CLOUD_SHADOWS

	#ifndef CLOUDS
		#undef CLOUD_SHADOWS
	#endif

	//#define CLOUD_TAAU_ENABLED
	#define CLOUD_TAAU_SCALE 4 // [2 3 4 5]
	#define CLOUD_MAX_ACCUM_FRAMES 64 // [16 20 24 28 32 36 40 44 48 52 56 60 64 68 72 76 80 84 88 92 96 100 104 108 112 116 120 124 128 132 136 140 144 148 152 156 160 164 168 172 176 180 184 188 192 196 200 204 208 212 216 220 224 228 232 236 240 244 248 252]
	#define CLOUD_TAAU_CLIPPING
	#define CLOUD_TAAU_ANTIFLICKER 0.25 // [0.0 0.25 0.5 0.75 1.0]
	//#define CLOUD_CUMULUS

/* Fog */
	#define BORDER_FOG // Enables border fog
	#define BORDER_FOG_FALLOFF 2.5 // Falloff of the border fog. [0.0 0.5 1.0 1.5 2.0 2.5 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 25.0 30.0 35.0 40.0]

	// [2026-09 新增] 地面大气散射（空气透视）：远景地形向大气散射色衰减的独立一层。
	// 与体积雾解耦——不含噪声、不随 VF_TIME_FADE 在正午消隐，负责中远场的色彩与对比度衰减；
	// 只作用于主世界的地面/水面像素（天空走天空模型，下界/末地走各自维度雾）。
	// 洞穴/室内沿用体积雾同款门控 clamp(skylight*0.8+0.2)，保留 20% 底雾。
	// 实现与标定说明见 lib/atmosphere/GroundScattering.glsl。
	#define GROUND_SCATTERING // Ground atmospheric scattering (aerial perspective)
	#define GS_DENSITY 3.0 // 大气散射浓度（整体浓度旋钮）。 [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.4 1.6 1.8 2.0 2.5 3.0 4.0]
	#define GS_SUN_BRIGHTNESS 0.1 // 太阳散射亮度（米氏前向：朝太阳方向的远景发暖）。 [0.0 0.1 0.25 0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0 4.0]
	#define GS_SKY_BRIGHTNESS 1.0 // 天空散射亮度（各向同性底噪：远景整体偏蓝）。 [0.0 0.1 0.25 0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0 4.0]
	#define GS_MIE_G 0.2 // 前向散射各向异性 g（越大越集中在太阳方向）。 [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8]
	#define GS_RAIN_BOOST 4.0 // 雨天增浓倍率（跟随 wetness）。 [0.0 0.5 1.0 1.5 2.0 3.0 4.0]

	#define PER_BIOME_FOG // Enables per-biome fog

	#define LAVA_FOG // Enables lava fog
	#define POWDERED_SNOW_FOG // Enables powdered snow fog
	#define BLINDNESS_DARKNESS_FOG // Enables blindness & darkness fog
	#define BLINDNESS_STRENGTH 1.0 // 失明总强度（1.0 = 原版，0 = 关闭失明压黑，越大黑得越快）。 [0.0 0.25 0.5 0.75 1.0 1.25 1.5 2.0 3.0]

	#define VOLUMETRIC_FOG // Enables volumetric fog
	#define COLORED_VOLUMETRIC_FOG // Enables volumetric fog stained glass tint
	//#define VF_CLOUD_SHADOWS // Enables cloud shadows in volumetric fog
	#define VF_TIME_FADE // Adjussts the density of the volumetric fog based on time of day
	#define VF_HEIGHT 67.0 // Height of the volumetric fog. [0.0 1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 21.0 22.0 23.0 24.0 25.0 26.0 27.0 28.0 29.0 30.0 31.0 32.0 33.0 34.0 35.0 36.0 37.0 38.0 39.0 40.0 41.0 42.0 43.0 44.0 45.0 46.0 47.0 48.0 49.0 50.0 51.0 52.0 53.0 54.0 55.0 56.0 57.0 58.0 59.0 60.0 61.0 62.0 63.0 64.0 65.0 66.0 67.0 68.0 69.0 70.0 71.0 72.0 73.0 74.0 75.0 76.0 77.0 78.0 79.0 80.0 81.0 82.0 83.0 84.0 85.0 86.0 87.0 88.0 89.0 90.0 91.0 92.0 93.0 94.0 95.0 96.0 97.0 98.0 99.0 100.0 101.0 102.0 103.0 104.0 105.0 106.0 107.0 108.0 109.0 110.0 111.0 112.0 113.0 114.0 115.0 116.0 117.0 118.0 119.0 120.0 121.0 122.0 123.0 124.0 125.0 126.0 127.0 128.0 129.0 130.0 131.0 132.0 133.0 134.0 135.0 136.0 137.0 138.0 139.0 140.0 141.0 142.0 143.0 144.0 145.0 146.0 147.0 148.0 149.0 150.0 151.0 152.0 153.0 154.0 155.0 156.0 157.0 158.0 159.0 160.0 161.0 162.0 163.0 164.0 165.0 166.0 167.0 168.0 169.0 170.0 171.0 172.0 173.0 174.0 175.0 176.0 177.0 178.0 179.0 180.0 181.0 182.0 183.0 184.0 185.0 186.0 187.0 188.0 189.0 190.0 191.0 192.0 193.0 194.0 195.0 196.0 197.0 198.0 199.0 200.0 201.0 202.0 203.0 204.0 205.0 206.0 207.0 208.0 209.0 210.0 211.0 212.0 213.0 214.0 215.0 216.0 217.0 218.0 219.0 220.0 221.0 222.0 223.0 224.0 225.0 226.0 227.0 228.0 229.0 230.0 231.0 232.0 233.0 234.0 235.0 236.0 237.0 238.0 239.0 240.0 241.0 242.0 243.0 244.0 245.0 246.0 247.0 248.0 249.0 250.0 251.0 252.0 253.0 254.0 255.0]

	// [2026-09-12] 雾层厚度：高度包络的尺度（按 Mie 通道的半衰高度计，格）。它决定「方块与天空
	// 谁被遮得多」：薄层（默认 12）时站在层里抬头看天空，射线十几格就离开雾层 → 天空几乎不被遮，
	// 而水平方向的方块一直在层内 → 方块被遮得多；把厚度调大（尤其 ≥256 ≈ 均匀雾）后，遮蔽只由
	// 距离决定，天空（256 格）反而比方块更被遮。调厚时整体雾量会上升，需要相应降低「全局雾气密度」。
	#define VF_FOG_THICKNESS 24.0 // 雾层厚度（半衰高度，格；≥256 ≈ 均匀雾）。 [4.0 6.0 8.0 10.0 12.0 16.0 20.0 24.0 32.0 48.0 64.0 96.0 128.0 256.0 512.0 1024.0]
	// [2026-09-12] 夜晚雾色饱和度：夜里雾的蓝来自「月光项本身就是蓝的」+「Rayleigh 散射系数
	// 本身偏蓝（B/R ≈ 5，白天被暖白的太阳项压着看不出来）」。0 = 完全中性（只留亮度），
	// 1 = 保持原来的蓝。只作用于夜晚，白天完全不受影响。
	#define VF_NIGHT_FOG_SATURATION 0.5 // 夜晚雾色饱和度（0 = 中性，1 = 原来的蓝）。 [0.0 0.1 0.2 0.25 0.3 0.35 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
	// [2026-09-12] 雨天太阳项保留下限：雨天云的阴影乘子是 max(1 - wetness*CLOUD_SHADOW_STRENGTH, 0)，
	// 而 CLOUD_SHADOW_STRENGTH 默认 1.0、VF_CLOUD_SHADOWS 默认关闭 ⇒ wetness→1 时太阳项归零，
	// 雾只剩暗天空光（观感又黑又黄）。本项给这个乘子一个地板：雨天至少保留这么多太阳项。
	// 0 = 原来的行为（雨天归零），1 = 雨天完全不衰减。晴天 wetness = 0，完全不受影响。
	#define VF_RAIN_SUN_FLOOR 0.3 // 雨天太阳项保留下限（0 = 归零，1 = 不衰减）。 [0.0 0.05 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.8 1.0]

	#define VF_MIE_DENSITY 	 	1.0 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 3.0 5.0 7.0 10.0]
	#define VF_RAYLEIGH_DENSITY 1.0 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 3.0 5.0 7.0 10.0]
	#define VF_MIE_DENSITY_RAIN_MULT 3.0 // [0.0 0.5 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0 8.5 9.0 9.5 10.0 10.5 11.0 11.5 12.0 12.5 13.0 13.5 14.0 14.5 15.0 15.5 16.0 16.5 17.0 17.5 18.0 18.5 19.0 19.5 20.0]

	// [2026-09-21 水下体积雾] 混合式水下雾：透射闭式（无噪声无条带），散射按深度渐变步进
	// —— 由 eyeSkylightSmooth 反解相机水深，浅水青绿亮、深水浓蓝黑。
	// 关闭 UW_VOLUMETRIC_FOG = 回退原分析式水下雾（逐位一致）。步进位置带 BlueNoise
	// 抖动防条带，噪声交 TAA。实现见 WaterFog.glsl + IntegrateScene.frag 的 RaymarchWaterFog。
	// 仅在相机入水时生效，水面之上看水体（Translucent）不受影响。
	// **浓度总开关在 光照 → 水体 的 WATER_FOG_DENSITY**（它乘在水体的吸收/散射上）。
	// [2026-09-21 **水下体积光（光柱）已整体移除**] 用户裁定只保留雾：原来那条
	// "定向光 × 阴影可见度 × 水面波面焦散"的独立光柱层（及其 5 个旋钮）已全部删除。
	#define UW_VOLUMETRIC_FOG // 水下体积雾（深度渐变散射）
	#define UW_FOG_SAMPLES 8 // 水下雾步进数。 [4 6 8 12 16 24]
	#define UW_FOG_DEEP_RANGE 12.0 // 深度渐变范围（格：从水面到全浓的距离）。 [4.0 6.0 8.0 10.0 12.0 16.0 20.0 24.0 32.0]
	#define UW_FOG_DEEP_DENSITY 2.0 // 深水增浓倍率（散射与透射同步增浓）。 [1.0 1.25 1.5 1.75 2.0 2.5 3.0 4.0]


	// [2026-08-20] 水雾太阳光晕受"屏幕上太阳是否被遮挡"影响（默认开）。太阳被地形挡/出屏/在背后 → 压掉水中正对太阳的模糊光晕。
	#define UW_SUN_OCCLUSION // [OFF ON] 水中太阳光晕受太阳遮挡影响

	// [2026-09-21 **水下环境光豁免**（修"深水里背光面死黑"）]
	// 病因：游戏在水下把天光 lightmap 每格降 1 级（15 级制）、约 15 格归零。
	// **直射光早已豁免**（DeferredLight 的 sunlightFactor 里有 `+ float(isEyeInWater)`），
	// 而环境光没有：天空 SH 被 `lightmap.y > EPS` 整段跳过、体素天光下限只有 0.003、
	// 假反弹光被 lightmap³ 压没 ⇒ 深水里只剩 MINIMUM_AMBIENT_BRIGHTNESS 底光
	// ⇒ **没被直射的面接近死黑**（用户实测：直射面正常、背光面特别黑）。
	// 修法：给环境光算一个"等效天光"——按**水的消光**随相机水深衰减，而不是用被压死的 lightmap。
	// 相机水深用与 lib/water/WaterFog.glsl 的 EstimateCameraWaterDepth 同一套近似
	//（eyeSkylightSmooth 开四次方还原天光亮度，再线性反解 [0,15] 格）。
	// UW_AMBIENT_STRENGTH = 水下环境光整体强度（0 = 完全关掉本豁免，回到旧行为）。
	// 默认 1.0 = 实测确认的档位（用户实机裁定）
	#define UW_AMBIENT_STRENGTH 1.0 // [0.0 0.1 0.2 0.35 0.5 0.7 1.0]
	// 天空半球的光穿水柱的等效路径倍率（1.0 = 垂直路径；越大衰减越快）
	#define UW_AMBIENT_DEPTH_MULT 1.0 // [0.25 0.5 0.75 1.0 1.5 2.0 3.0]
	// 体素天光（SimpleSkyLighting）在水下的门控下限——原来是硬编码的 0.003（千分之三），
	// 等于把水下 GI 的间接光整个掐掉。0.003 = 旧行为。
	#define UW_VOXEL_SKY_WATER_FLOOR 0.05 // [0.003 0.01 0.02 0.05 0.08 0.12 0.2]

	// [2026-09-12 雾中光束] 体积光不再是独立一层，而是「让雾的太阳散射吃阴影贴图」：
	// 沿视线分层取 VF_VOLUME_SHADOW_SAMPLES 个抖动采样点估计这条射线的阴影可见度，
	// 乘在雾的太阳 in-scatter 上 —— 被树叶/窗缝/洞口切开的明暗直接长在雾上。
	// 原来的两种独立方案（1/4 分辨率光线步进 / 全分辨率屏幕空间太阳光轴）与
	// 相关选项（VOLUMETRIC_LIGHT_MODE / VF_VOLUME_MAX_STEPS / VF_SHAFT_COLOR_BRIGHTNESS）
	// 已删除；光束现在天然与雾同色、同浓度、同高度门控，也不再需要 colortex11 与上采样。
	// 前提：VOLUMETRIC_FOG 开启（光束就是雾的一部分）。雾的密度/透射率仍是闭式解析积分，
	// 这里只给太阳项加一个逐射线系数，不引入步进循环。
	#define VOLUMETRIC_LIGHT // 雾中光束（让雾的太阳散射吃阴影贴图）
	#define VF_VOLUME_INTENSITY 1.0 // 光束强度 = 阴影对比度：0=完全不压暗（等于没有光束），1=完全按可见度衰减。 [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0]
	#define VF_VOLUME_SHADOW_SAMPLES 2 // 光束阴影采样数（沿视线分层采样，0 = 关闭光束）。 [0 1 2 3 4 6 8 12 16]
	// 光束亮度：只乘太阳 in-scatter，不动环境雾 —— 「让光束更明显」的正解（抬雾浓度会把环境一起提亮，
	// 对比度不变）。1.0 = 现状；2~3 已经很明显；再往上会开始过曝。
	#define VF_SHAFT_BRIGHTNESS 2.0 // 光束亮度（只提亮被太阳照到的那部分）。 [0.25 0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0 4.0 6.0 8.0]
	// [2026-09-12] 光柱作用距离：光柱沿视线多远淡出（格）。此前光柱会一路延伸到 256 格不衰减，
	// 因为阴影可见度是整条射线的平均值、integralFactor 在远距离只是饱和而非衰减、且光柱对比度
	// 本身是常数。本项只让「对比度」随距离淡出，远处光柱淡成普通雾而不是变黑。
	// 256 ≈ 不衰减（等于关闭淡出，想对比改动前后时用）。
	#define VF_SHAFT_RANGE 48.0 // 光柱作用距离（沿视线多远淡出，格）。 [8.0 12.0 16.0 24.0 32.0 48.0 64.0 96.0 128.0 256.0]

	// [2026-09] 太阳/月亮"日晕"：与体积雾浓度解耦的保底光晕（天空像素上绘制）。
	// 完全独立开关 SUN_HALO：不开体积雾、不开体积光也生效，雾再薄也有基础强度。
	#define SUN_HALO // 独立日晕开关（不开体积雾也生效，仅天空区域）
	#define SUN_HALO_STRENGTH 0.2 // 日晕保底强度。 [0.0 0.2 0.4 0.6 0.8 1.0 1.5 2.0 3.0]
	#define SUN_HALO_WIDTH 1.0 // 日晕角宽（越大越宽越柔）。 [0.5 0.75 1.0 1.25 1.5 2.0 2.5 3.0]

	#ifdef PER_BIOME_FOG
	#endif
	#ifdef VF_TIME_FADE
	#endif

/* Transparent */
	#define WATER_PARALLAX
	#define WATER_CAUSTICS

	#define WATER_IOR 1.3 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.15 1.2 1.25 1.3 1.33 1.4 1.5 1.6]
	#define GLASS_IOR 1.5 // [0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 3.0 4.0 5.0 7.0 10.0 15.0]

	#define WATER_WAVE_HEIGHT 	1.0 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 3.0 5.0 7.0 10.0]
	#define WATER_WAVE_SPEED 	1.0 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.2 2.4 2.6 2.8 3.0 3.2 3.4 3.6 3.8 4.0 4.2 4.4 4.6 4.8 5.0 5.5 6.0 6.5 7.0 7.5 8.0 9.5 10.0]
	#define WATER_FOG_DENSITY 	1.3 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.7 2.0 2.5 3.0 4.0 5.0 7.0 10.0]

	#define WATER_ABSORPTION_R 0.25 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]
	#define WATER_ABSORPTION_G 0.08 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]
	#define WATER_ABSORPTION_B 0.05 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]

	#define WATER_SCATTERING_R 0.05 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]
	#define WATER_SCATTERING_G 0.11 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]
	#define WATER_SCATTERING_B 0.15 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]

	#define WATER_PARALLAX_SAMPLES 2 // [2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 32 34 36 38 40 42 44 46 48 50 52 54 56 58 60 62 64 66 68 70 72 74 76 78 80 82 84 86 88 90 92 94 96 98 100 102 104 106 108 110 112 114 116 118 120 122 124 126 128]

	#define TRANSLUCENT_ROUGHNESS 0.1 // [0.0 0.0005 0.001 0.002 0.003 0.004 0.005 0.006 0.007 0.008 0.009 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]

	const vec3 waterAbsorption = vec3(WATER_ABSORPTION_R, WATER_ABSORPTION_G, WATER_ABSORPTION_B) * WATER_FOG_DENSITY;
	const vec3 waterScattering = vec3(WATER_SCATTERING_R, WATER_SCATTERING_G, WATER_SCATTERING_B) * WATER_FOG_DENSITY * 0.1;
	const vec3 waterExtinction = waterAbsorption + waterScattering;
	const vec3 waterAlbedo = waterScattering / waterExtinction;

/* Weather */
	#define RAIN_PUDDLES // Enables rain puddles
	// [2026-11-11] 水坑尺寸倍率（不是频率）：1 = 旧默认观感，越大水坑越大。
	// 旧版该值是直接乘进噪声 UV 的频率，越大越碎（旧上限 0.5 只剩米粒），故改为尺寸正比、内部取倒数。
	// 覆盖率由 noise 阈值与降雨湿度决定，与尺寸解耦；调大不会让整片地面变湿。
	#define RAIN_PUDDLE_SCALE 1.0 // 水坑尺寸倍率：1 = 默认，越大越成片（下限 1.0，旧配置的 0.5 会按 1.0 处理）。 [1.0 1.25 1.5 2.0 2.5 3.0 4.0 5.0 6.0 8.0]
	#define RAIN_PUDDLE_SMOOTHNESS 0.9 // Smoothness of the rain puddles. [0.0 0.1 0.2 0.3 0.4 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.0]

	#define RAIN_VISIBILITY	0.5 // Visibility of the rain particles. [0.0 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0]
	#define RAIN_SCALE_X	3.0 // X-Scale of the rain particles. [0.5 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0 8.5 9.0 9.5 10.0 10.5 11.0 11.5 12.0 12.5 13.0 13.5 14.0 14.5 15.0 15.5 16.0 20.0 24.0]
	#define RAIN_SCALE_Y	2.0 // Y-Scale of the rain particles. [0.5 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0 8.5 9.0 9.5 10.0 10.5 11.0 11.5 12.0 12.5 13.0 13.5 14.0 14.5 15.0 15.5 16.0 20.0 24.0]

//======// Lighting //============================================================================//

/* Lighting */
	#define HANDHELD_LIGHTING // Enables handheld lighting
	#define HELD_LIGHT_BRIGHTNESS 3.0 // Brightness of the handheld light. [0.0 0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 2.0 2.5 3.0 4.0 5.0 7.0 10.0 15.0]
    #define BLOCKLIGHT_BRIGHTNESS 1.4 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.2 2.4 2.6 2.8 3.0 3.2 3.4 3.6 3.8 4.0 4.2 4.4 4.6 4.8 5.0 5.5 6.0 6.5 7.0 7.5 8.0 9.5 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0]
	#define BLOCKLIGHT_COLOR_R 1.00 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]
	#define BLOCKLIGHT_COLOR_G 1.00 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]
	#define BLOCKLIGHT_COLOR_B 1.00 // [0.00 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.10 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.20 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.30 0.31 0.32 0.33 0.34 0.35 0.36 0.37 0.38 0.39 0.40 0.41 0.42 0.43 0.44 0.45 0.46 0.47 0.48 0.49 0.50 0.51 0.52 0.53 0.54 0.55 0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63 0.64 0.65 0.66 0.67 0.68 0.69 0.70 0.71 0.72 0.73 0.74 0.75 0.76 0.77 0.78 0.79 0.80 0.81 0.82 0.83 0.84 0.85 0.86 0.87 0.88 0.89 0.90 0.91 0.92 0.93 0.94 0.95 0.96 0.97 0.98 0.99 1.00]

/* Lighting Brightness */
	#define MINIMUM_AMBIENT_BRIGHTNESS 0.05 // Minimum brightness of the ambient light. [0.0 0.00001 0.00002 0.00003 0.00005 0.00007 0.0001 0.0002 0.0003 0.0004 0.0005 0.0006 0.0007 0.0008 0.0009 0.001 0.0015 0.002 0.0025 0.003 0.004 0.005 0.006 0.007 0.01 0.05 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
	// 夜间总增益：月光直射与环境光各乘一次（同幂次），不影响月相与月面亮度。
	#define NIGHT_BRIGHTNESS 1.3 // Brightness of the night. [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.7 2.0 2.5 3.0 4.0 5.0 7.0 10.0]
	// [2026-11-11] 夜间环境光地板 = 该比例 × 月光直射亮度（消费点：program/DeferredLight.frag）。
	// 夜里天空 SH 仅约 1e-4，环境光原本由 MINIMUM_AMBIENT_BRIGHTNESS 常量提供、与月相无关，
	// 所以夜间阴面偏亮；本项随月光直射亮度联动，与直射同为 NIGHT_BRIGHTNESS 的一次幂。
	// 0 = 阴面只保留天空光与常量底光；0.07 为实测默认（满月夜 环境光/直射 ≈ 0.10）。
	#define NIGHT_AMBIENT_RATIO 0.07 // 夜间环境光 = 该比例 × 月光直射亮度。 [0.0 0.03 0.05 0.07 0.10 0.15 0.22 0.30]
	// [2026-09-04 加到 GUI] 月光亮度（月盘/月光强度）。原只定义在 DeferredLight.frag（非 GUI 选项）。
	#define MOON_BRIGHTNESS_MULTIPLIER 1.0 // Brightness of the moon. [0.0 0.5 1.0 1.5 2.0 3.0 5.0]
	// [2026-09 夜空修复] 月光大气散射（Hillaire 天空 LUT 的月光项）标定系数：
	// 1.0 = 严格按全家 dev 的 moonIrradiance 物理量级（实测夜空仍≈纯黑，贡献 1e-5 量级）；
	// 500 = 等效把月亮立体角放大（dev 的 MOON_RADIUS_MULT 方向），用于对齐 dev 夜空亮度。
	#define MOON_SKY_BRIGHTNESS 500.0
	// [2026-09] 夜空色偏修正：本包 Rayleigh 配比偏蓝（实测 B/R≈3.4，dev≈2.2），
	// 用偏暖的中性 tint 压蓝、略提红，把夜空蓝度对齐 dev。
	#define MOON_SKY_TINT vec3(1.25, 0.90, 0.62)

	// [2026-11-11] 天空环境光衰减标定（唯一消费点：program/prepare/GenSkySH.comp）。
	// 直射项有两重衰减：大气透射（随太阳高度角）与雨天 cloudShadow = 1 - wetness*0.96；
	// 而天空 SH 过去两者都没有，于是清晨/雨天的 环境光 / 直射 比反而上升。
	// 这里把两条衰减集中成一条曲线：正午晴天 = 1.0（不改既有白天标定），
	// 太阳没入地平线下不压（夜间由月光项驱动）。0.30 / 1.45 拟合天空水平辐照度
	// 随太阳高度角的下降（10 度约 0.36、30 度约 0.56、60 度约 0.87，正午 1.0）。
	#define SKY_AMBIENT_SUN_MIN 0.30 // 太阳贴地平线时天空辐照度倍率（1.0 = 关闭本修正）
	#define SKY_AMBIENT_SUN_POW 1.45 // 随 worldSunDir.y 上升的指数
	#define SKY_AMBIENT_RAIN_ATTEN 0.60 // 全雨天时天空辐照度降幅（0 = 原行为，0.96 = 与直射同深度）

/* Global Illumination */
	#define SVGF_ENABLED // Enables spatiotemporal variance-guided filtering（SSILVB 降噪）
	#define VOXEL_GI_DENOISE  // 光追降噪开关（SVGF 时域+空间）；注释此行或 GUI 关闭即关闭光追降噪
	// [2026-08-28] VXGI 降噪方案：0=SVGF(EAWF a-trous 空间×4，时域累积复用)；1=PTGI 风格(单次中值+深度/法线边缘，更省)。只影响 VXGI 链；SSILVB 不受影响。
	#define VOXEL_GI_DENOISE_MODE 0 // [0 1] 降噪方案：0=SVGF  1=PTGI
	// [2026-08-28] 派生布尔宏：mode==1 时启用 PTGI 降噪（供 shaders.properties program.enabled 用布尔判断，避免 Iris 对整数比较的解析问题）
	#if VOXEL_GI_DENOISE_MODE == 1
		#define VOXEL_GI_PTGI_DENOISE
	#endif
	// PTGI 风格中值降噪参数（GUI：光照→全局光照→PTGI 降噪；仅 VOXEL_GI_DENOISE_MODE==1 时用于 VXGI 空间降噪）
	#define PTGI_MEDIAN_RADIUS 2 // [1 2] 中值滤波半径（1=3x3, 2=5x5）
	#define PTGI_EDGE_STRENGTH 0.5 // [0.0 0.25 0.5 0.75 1.0] 边缘保持强度（0=全量中值偏糊，1=只在平坦区中值保边）
	#define PTGI_BLEND_STRENGTH 1.0 // [0.0 0.1 0.3 0.5 0.7 0.85 1.0] 中值结果与原始混合强度（1=纯中值，0=原始）
	// 离线渲染：每像素/IRC 提高同帧采样(SPP)、屏蔽 GI 空间降噪并持续时域累积，F2 出静帧。
	// 默认关（profile.Default !OFFLINE_RENDER），GUI(Debug→Voxel) 或取消下行注释开启。
	// 关闭时 #ifdef OFFLINE_RENDER 全不参与，与未加此宏完全一致。
	//#define OFFLINE_RENDER
	// [2026-08-19 暂时禁用 IRC] 完全禁用体素辐照度缓存（IR 缓存注入 + 自反弹传播），
	// 画面照明只靠每像素射线追踪（出界天光 + 阳光/月光反弹）。取消下行注释即禁用；当前已恢复 IRC。
	//#define DISABLE_IRC

	#define SSPT_ENABLED // Enables screen-space path tracing
	#define RSM_ENABLED // Enables reflective shadow maps

	#define SSILVB_BLENDED_LIGHTMAP 0.25 // [0.0 0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0]
	#define SSPT_BLENDED_LIGHTMAP 0.0 // [0.0 0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0]

	#define VOXEL_GI_BLENDED_LIGHTMAP 0.0 // [0.0 0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0] 原版 Lightmap 混合倍率（1.0=完全保留原版光照，0.0=完全屏蔽原版 Lightmap，间接光照仅由体素 GI 提供）

	#define VOXEL_IRC_UPDATE_INTERVAL 4 // [1 2 4] IRC 注入降频（每个体素每 N 帧重注入 1 次，算力降到约 1/N；体素光照变化慢，默认不降频，2/4 可显著提速且几乎无视觉差异）

	// [2026-09-06 GUI 恢复可用] VXGI 追踪加速/采样优化（Debug→Voxel 页可调；occupancy 由 shadow
	// 体素化端同帧原子置位、begin1 每帧清零，开启即有数据。默认关=现行为）。
	//#define VOXEL_COARSE_ACCEL  // 4³ 粗块空洞跳跃：纯空气粗块整块跳过（性能大头）
	//#define VOXEL_FINE_ACCEL    // 细格 occupancy 逐格空气跳过（比 coarse 更细；单独开即自动含粗块空洞跳跃。注：未被体素化但有注入光/发射光的格会被当空气→若见空洞请关闭）
	//#define VOXEL_COS_SAMPLING  // 余弦密度半球采样（pdf=cosθ/π、权重 1，期望同 均匀×2cos，方差更低）


	#define SSILVB_MAX_ACCUM_FRAMES 64.0 // [5.0 10.0 15.0 20.0 24.0 28.0 32.0 36.0 40.0 48.0 56.0 64.0 72.0 80.0 96.0 112.0 128.0 144.0 160.0 192.0 224.0 256.0 320.0 384.0 448.0 512.0 640.0 768.0 896.0 1024.0]
	#define SSPT_MAX_ACCUM_FRAMES 20.0 // [20.0 24.0 28.0 32.0 36.0 40.0 48.0 56.0 64.0 72.0 80.0 96.0 112.0 128.0 144.0 160.0 192.0 224.0 256.0 320.0 384.0 448.0 512.0 640.0 768.0 896.0 1024.0]
	#define RSM_MAX_ACCUM_FRAMES  20.0 // [20.0 24.0 28.0 32.0 36.0 40.0 48.0 56.0 64.0 72.0 80.0 96.0 112.0 128.0 144.0 160.0 192.0 224.0 256.0 320.0 384.0 448.0 512.0 640.0 768.0 896.0 1024.0]
	// 不模糊、只压尖峰（有轻微偏差：孤立的真实亮点会被压低）。0 = 关（默认，行为不变）。
	// 历史几何检查的深度容差 = max(固定相对 12.5%, 本值 x 屏幕空间视深梯度)。
	// 掠射面上一个纹素的视深变化可达自身深度的 5%~10%，固定容差会把历史 tap 全判成异面（累积不上去）。
	// 调大：掠射面更容易累积，但更容易把前方遮挡物的 GI 抹到墙上（拖影/渗色）。
	// 时域累积时间（秒）：NRD 的官方做法（REBLUR 漫反射默认 0.5 s）。
	// 代码里按 fps 换算成帧数上限：cap = clamp(时间 / frameTime, 8, SSILVB_MAX_ACCUM_FRAMES)。
	// 值越大越干净但拖影越长。官方 REBLUR 默认 0.5 s，但官方注释写明该默认的前提是
	// **有其它信号增强手段**（原文：casting more rays / SHARC 或其它 signal improving techniques
	// 「help to accumulate less」）。本包只有 1 spp、命中率 1~3%，累积 30 帧后相对噪声仍约 128%
	//（σ_rel = √((1-p)/(p·N))）⇒ 方向相反，应该 accumulate more：1.0 s ≈ 60 帧，噪声降到约 90%。
	// 嫌拖影就往下调（0.5 / 0.35）。
	// [2026-11-11 补定义] 半分辨率 GI（默认 GI 画布 = 屏幕一半）读回时的上采样档位。
	// 这个滑块一直在 shaders.properties 的 screen.VXGI / screen.SSILVB 里登记，但 settings.glsl
	// **从来没有 #define 过它** ⇒ Iris 认不出这个选项：
	//   · GUI 上的滑块对画面没有任何作用；
	//   · 配置文件里的 `SVGF_QUALITY=1` 也不会被应用；
	//   · lib/SpatialUpscale.glsl 的 `#ifndef SVGF_QUALITY` 兜底成 0 = **只取中心值**，
	//     等于最近邻放大 ⇒ 每个 GI 画布纹素铺成 2×2 屏幕像素的硬方块。
	//     这是「静止时满是斑斑点点的密集噪点」里最容易被看错成噪声的那一半：
	//     它不是随机噪点，而是 2×2 的块状网格，且不随累积收敛。
	// 1 = 4 邻域深度感知上采样（官方 NRD 集成同样要自己做上采样，NRD 本身不出全分辨率结果）。
	#define SVGF_QUALITY 1 // [0 1] GI 上采样质量（0=仅中心值/2x2 块，1=4 邻域深度感知）

	#define GI_DISOC_THRESHOLD 0.01 // [0.005 0.01 0.02 0.05 0.1] 历史去遮挡阈值（官方 disocclusionThreshold）
	#define GI_ACCUM_TIME 1.0 // [0.35 0.5 0.75 1.0 1.5 2.0] 时域累积时间（秒）
	// 每帧输入的等效样本数（1.0 = 官方 1 spp 口径）。prepass 32 样本空间重用 + ReSTIR 复用
	// 让每帧噪声远低于单样本；照搬官方「时间/帧时间」会把累积上限高估 ⇒ 过粘（拖影）。
	// 上限 = GI_ACCUM_TIME / (低通帧时间 × 本值)，下限 8 帧、硬上限 SSILVB_MAX_ACCUM_FRAMES。
	// 低通由 GlobalStorage.comp 的全局 SSBO 字段统一维护（官方 NRD README 要求 FPS 先平滑）。
	// [2026-11-11 官方口径修正] 官方 REBLUR 是 1 spp 输入（VOXEL_REUSE 已 #undef ⇒ 每画布像素
	// 每帧 1 条新射线，与官方同构）。旧值 2.0 把累积上限腰斩成官方一半（0.5s ⇒ 15 帧而不是 30），
	// 是「静止满屏噪点」的直接来源之一。改成 1.0 后 cap 恢复到官方 maxAccumulatedFrameNum=30。
	#define GI_EFFECTIVE_SPP 1.0 // [1.0 1.5 2.0 3.0 4.0 6.0] 每帧等效样本数（折算累积上限）
	// GI 诊断视图（0 = 关闭）：把内部量当颜色画出来，用于定位「闪 / 噪 / 拖影」来自哪一环。
	// 语义以 Final.frag 的实现为准（旧注释的分档配色/两段对比已作废，2026-11-10 统一）。
	//   1 = 历史长度(红) + 本帧不可靠(绿) + 年轻度(蓝)
	//   2 = 方差 σ 灰阶（白 = σ ≥ 3.3% 亮度）
	//   3 = 孤立亮点离群度（红 = 累积值显著高于 3x3 邻域，绿 = 正常）
	//   4 = 三段对比：左 prepass / 中累积 / 右最终（YCoCg 转 RGB 后同增益显示）
	//   5 = 三通道：红 = A/cap，绿 = 几何可信度，蓝 = 本帧不可靠
	//        ⇒ 黄 = 老且可信；绿 = 新但可信（正常）；蓝/青 = 走兜底；红 = 老却不可信（异常）
	//   6 = 几何可信度灰阶（白 = 全接受，灰 = 扣权重，红 = 没用上历史）
	// 诊断开关：1 = 取消一切历史拒绝（越界/重置/深度/法线都不看），强制历史永远有效。
	// 用途：一键判断闪来自「历史被拒+重建」还是「采样/滤波」。正常游戏保持 0。
	// 二分排查开关（静止不稳时用来切分责任层）：
	//   0 = 正常
	//   1 = 关「稳定化历史当引导」（EAWF 退回噪声输入引导）
	//   2 = 关「滤波结果回写历史」（GIHistoryStore 变成 no-op）
	//   3 = 两者都关
	//   4 = 忽略 historyReset（若该 uniform 恒为真，历史会被每帧重置）
	//   5/6/7 = 在 1/2/3 的基础上再加 4
	#define GI_BISECT 0 // [0 1 2 3 4 5 6 7] 二分排查（0=正常）
	#define GI_DEBUG_NO_DISOC 0 // [0 1] 诊断：取消历史拒绝
	#define GI_DEBUG_VIEW 0 // [0 1 2 3 4 5 6] GI 诊断视图（0=关）
	// HistoryFix A/B：1 = 直通（把本帧 TA 输出原样搬到 colortex25，不做重建、不做 fast clamp）。
	// 用途：判断「拖影 / 静止斑点」到底是不是这个 pass 造成的。正常运行保持 0。
	#define GI_DEBUG_NO_HISTORY_FIX 0 // [0 1] HistoryFix A/B（1=直通）
	// TS A/B：1 = 跳过第二个时间累加器（GIStabilize），直接把 EAWF 输出当最终 GI。
	// 用途：判断「拖影 / 斑点」是累积器造成的还是稳定化造成的。正常运行保持 0。
	#define GI_DEBUG_NO_TS 0 // [0 1] 稳定化 A/B（1=直通）
	// 稳定化历史长度上限 / 强度（官方 maxStabilizedFrameNum=63、stabilizationStrength=1.0）。
	// 上限刻意压到 8：官方 63 会让阶跃 10% 衰减从 1.33 s 变 3.10 s，拖影更长。
	// 这两个值原先只写在 GIStabilize.comp 的 #ifndef 里 ⇒ GUI 看不到（半成品接线），已挪到此处；
	// comp 里的 #ifndef 兜底保留，单独展开也能编译。
	// 官方 `maxStabilizedFrameNum`（NRDSettings.h:289，默认 REBLUR_MAX_HISTORY_FRAME_NUM = 63）。
	// 它**不是**帧数上限，而是被换算成 `gStabilizationStrength = N/(1+N)`（Source/Reblur.cpp:303）
	// 后去夹 TS 的最终混合权重：63 ⇒ 0.984（几乎不夹），8 ⇒ 0.889，2 ⇒ 0.667。
	// 调小 ⇒ 稳定化更弱、拖影更短、噪点更多。
	#define GI_STABILIZE_FRAMES 63.0 // [2.0 4.0 8.0 16.0 32.0 63.0] maxStabilizedFrameNum（换算成 N/(1+N) 后夹历史权重）
	#define NRD_STABILIZATION_STRENGTH 1.0 // [0.0 0.25 0.5 0.75 1.0 1.5 2.0] 稳定化强度（乘在 N/(1+N) 上，1.0 = 官方）
	// [运动自适应历史] 重投影位移 > 2 屏幕像素时，按位移抬高本帧权重、压低稳定化历史权重。
	// 只影响移动时；静止（含 TAA 亚像素抖动）位移 < 1 px ⇒ 逐位不变。
	// 0 = 关（回到纯时域累积），0.5 = 半强度，1.0 = 全强度（默认）。代价：移动时噪点略升。
	// [2026-11-11] 官方 REBLUR 没有运动自适应：移动时的「狂闪」正是它把 alpha 抬到 0.35、
	// 把第二级历史权重压到 0 的结果（每帧 35% 新样本 ⇒ σ 回到单帧量级）。默认关，
	// 拖影改用官方手段（累积/稳定化常数）处理；需要跟手时再手动开到 0.5。
	#define GI_MOTION_RESPONSE 0.0 // [0.0 0.5 1.0] 运动自适应历史响应（0=关）
	// [2026-11-11 已废弃] 这两个 A/B 开关的官方分支已成为**唯一路径**：
	// 预滤波与空间滤波的权重、以及稳定化口径都已逐行对齐官方，不再有旧实现可切换。
	// 保留定义只为兼容旧配置文件（Iris 对未定义的选项会报未知键），已无任何 shader 读取。
	#define GI_NRD_WEIGHTS 1 // (废弃) 官方权重现在恒生效
	#define GI_NRD_TS 1 // (废弃) 官方稳定化口径现在恒生效
	// 主历史回流（官方 "Recurrent" 的核心）：主历史 = 上一帧**空间滤波后**的结果，
	// 而不是只存原始时域累积。同一套核被逐帧反复迭代，等效滤噪力度随历史长度增长
	//（证据：NRD 里只有 PostBlur 的 gOut_Diff 标 NRD_RESOURCE_PERMANENT，而 TA 的
	//  gHistory_Diff 正是读这个持久资源；论文 Zhdan, Ray Tracing Gems II ch.49）。
	// 1 = 官方口径（更干净、更糊）；0 = 退回 SVGF 式（历史只存原始累积、更锐但残噪多）。
	// 嫌整体发糊就设 0；设 0 后仍嫌糊再降 NRD_RADIUS_PX。
	#define GI_RECURRENT_HISTORY 1 // [0 1] 主历史回流（1=官方 Recurrent，0=SVGF 式原始累积）
	// 新累积的像素用大半径压噪，随累积帧数把半径收到最小 ⇒ 细节随时间显现。
	// 值 = 衰减到最小半径所需的帧数（0=关）。
	// [2026-11-11 废弃] 这里原来有一个 TA（Accumulate）里的自造 fast-history clamp：
	// 5×5 μ±kσ + 门控地板，用来近似官方的 fastHistoryClampingSigmaScale。
	// 官方位置其实在 **HistoryFix**（本包 deferred5），对应 GUI 项 NRD_HISTORYFIX_CLAMP_SIGMA；
	// 旧实现会把 6 帧短历史的噪声逐帧拉进长历史（静止蠕动来源），已从代码与 GUI 移除。
	// 宏保留为 0、且不再被任何 shader 读取，只为兼容旧配置文件（Iris 对未定义键会告警）。
	#define GI_FAST_CLAMP_SIGMA 0.0
	// prepass 空间重用的离群样本钳制（自造项：官方 ReblurSettings 无对应字段，
	// 官方 anti-firefly 在 TA，见清单 4.11）。0 = 关（默认，画面逐位不变）。
	// >0 时把参与重用的样本亮度压到中心亮度 × 本值；参考量是中心像素，
	// 暗处会连带压暗 ⇒ 只在亮场做 A/B。
	#define GI_FIREFLY_CLAMP 0.0 // [0.0 2.0 3.0 4.0 8.0] prepass 离群样本钳制（0=关）
	// 0 = 关（保持旧行为：a<8 时 mip3 硬切换）。弱光下新暴露区域闪烁、且要很久才稳时先试 24~32。
	// 去图案化的随机核方向默认是「每像素固定」⇒ 相机一转内容在固定图案下滑动，GI 会被滤得「乱、不平滑」。
	// 打开本项：旋转角叠加逐帧变化（黄金角步进），由时域累积/TAA 平均掉固定图案。
	// [2026-11-10 默认开启] 固定图案的采样误差是**时域相关**的，累积器平均不掉它：
	// 静止时它会固化成不动的斑点，转头时随屏幕滑动成拖影。prepass（32 个稀疏样本）同样必须逐帧旋转。
	#define GI_KERNEL_ROT_PER_FRAME
	// 布尔宏未定义时不能直接进表达式（会报 undefined variable），这里转成数值供着色器使用。
	#ifdef GI_KERNEL_ROT_PER_FRAME
		#define GI_ROT_PER_FRAME 1.0
	#else
		#define GI_ROT_PER_FRAME 0.0
	#endif
	// 避免“逐像素从黑淡入”在屏幕上拼出流动的深浅补丁网（弱光下最明显）。 0=关。
	// 这是“先稳再长细节”的关键参数：只改起点（mip/邻居）而不封速率，单帧样本仍会一帧顶进来 ⇒ 忽闪。
	// 光照突变快速响应：已建立像素（a 足够大）且入样与均值偏离很大时，
	// 临时放大 alpha 让光照变化（火把移动/放挖）快速跟上，避免方块光拖影。 0=关。
	// ===== REBLUR 式降噪（默认开）=====
	// 结构（对齐 NRD v4.11 + Ray Tracing Gems II ch.49）：**主历史 = 上一帧的空间滤波输出**
	//（Recurrent 回流，见 GIHistoryStore.comp 顶部的资源生命周期证据）；短历史只累积原始输入、
	// 提供新鲜参考用于裁剪长历史；
	// 空间滤波（EAWF）的输出再经稳定化 pass 累积，**稳定化结果才是最终 GI**
	// （官方 ReblurSettings::maxStabilizedFrameNum，默认 63 帧）。
	#define VOXEL_GI_NRD // REBLUR 式降噪开关（需要 VXGI + SVGF 链路）
	// [2026-11-11 官方半径公式] 值 = maxBlurRadius / 10（画布纹素），3.0 即官方 30。
	// 每级步长由 blurRadius = max(saturate(sqrt(hitDistFactor × NLAS)) × maxBlurRadius, 1)
	// 按 1:2:4:8 分摊（和 = 15）得到，且每级下限 1 画布纹素。
	// 为什么必须下限 1：8 个 Vogel tap 在步长 0.5 时**全部 round 回中心**（8/8），那一级等于没滤波；
	// 旧写法在稳定像素上正好算出 0.50/0.68 ⇒ 4 级 a-trous 的前两级是空转，这是残噪的直接来源。
	// 调大更干净但更糊；调小保细节但残噪多（0.5-6.0 ⇒ 5-60 画布纹素）。
	#define NRD_RADIUS_PX 3.0 // [0.5 0.75 1.0 1.5 2.0 3.0 4.0 6.0] 最大滤波半径（×10 画布纹素）

	// ===== 官方 ReblurSettings 的四个可调项（2026-11-11 补齐 GUI 接线）=====
	// `diffusePrepassBlurRadius`（默认 30，单位 = NRD rect / 画布纹素）：
	//   **时域累积之前**的空间重用半径。1 spp 输入很稀疏，prepass 先在 30 纹素内加权平均，
	//   得到"稠密"信号再交给累积器。调大 ⇒ 单帧更平滑、收敛更快，但会把接触阴影、小凹槽
	//   和 1 米体素的块状结构一起摊平；调小 ⇒ 保细节、单帧更噪（时域压力更大）。
	//   官方 0 = 完全关闭；本包最低 1 画布纹素（8 个 tap 会全部落回中心，等价于近关闭）。
	#define NRD_PREPASS_RADIUS 30.0 // [1.0 2.0 4.0 6.0 8.0 12.0 16.0 20.0 24.0 30.0 36.0 48.0 64.0] 预滤波空间重用半径（画布纹素）

	// `minHitDistanceWeight`（默认 0.1）：空间滤波里「命中距离差很大」的邻居仍保留的最小权重。
	//   命中距离 = 该像素的 GI 射线打到多远的表面。两个像素命中距离差大 ⇒ 它们很可能处在
	//   不同深度的物体上（薄墙、栅栏、接触缝）。调大 ⇒ 跨深度更愿意混合（更平滑，但会漏进
	//   背景光、接触区发亮）；调小 ⇒ 保接触细节，代价是薄结构周围残噪。
	//   官方还会按 pass 再乘 fractionScale（Blur 1.0 / PostBlur 0.5）与 nonLinearAccumSpeed。
	#define NRD_MIN_HITDIST_WEIGHT 0.1 // [0.0 0.02 0.05 0.1 0.15 0.2 0.3 0.5 1.0] 跨命中距离的最小邻居权重

	// `planeDistanceSensitivity`（默认 0.02）：判定两个像素「是否同一平面」的相对阈值，
	//   单位是视锥短边在当前深度的世界尺寸（所以自动随距离放大）。
	//   prepass / Blur / PostBlur / HistoryFix / TS 五处共用同一个值。
	//   调大 ⇒ 更容易跨小台阶与凹凸混合（更平滑，但台阶边缘渗色、拖影变长）；
	//   调小 ⇒ 判据更严（保边缘，但斜面与法线贴图区域更难累积、残噪上升）。
	#define NRD_PLANE_DIST_SENS 0.02 // [0.005 0.01 0.02 0.03 0.05 0.08 0.1 0.15] 同一平面的距离容差（×视锥尺寸）

	// `fastHistoryClampingSigmaScale`（默认 2.0，官方在 **HistoryFix** 里生效）：
	//   把空间滤波后的长历史亮度夹到「未经滤波的短历史（6 帧）」的 mean ± kσ。
	//   作用：光照突变（火把移动 / 方块增删）时，滞后几十帧的长历史会被短历史拉回来。
	//   调大 ⇒ 夹得更松（细节保得多、拖影更长）；调小 ⇒ 夹得更紧（拖影短、残噪多）。
	//   官方注释：脏信号可降到 1.5，遮挡去噪用 1.1 更安全。
	//   注意与 `GI_FAST_CLAMP_SIGMA` 区分：那个是已移除的 TA 自造 clamp（宏保留为 0），这个是官方位置。
	#define NRD_HISTORYFIX_CLAMP_SIGMA 2.0 // [1.1 1.5 2.0 2.5 3.0] HistoryFix 短历史裁剪 sigma 倍数
	// 注意：VOXEL_GI_NRD_ACTIVE 在文件后段（GI_MODE / GI_ACTIVE_VXGI 定义之后）才推导。
	// 预处理器对"尚未定义的标识符"按 0 处理，因此任何 `#if GI_MODE == ...` 都必须写在
	// 第 630 行 `#define GI_MODE` 之后，否则恒为假——这里曾经因此让整条 REBLUR 链形同虚设。
	// 半分辨率 GI 画布的采样相位见 lib/utility/Offset.glsl 的 GI_CANVAS_PHASE。

/* Ambient Occlusion */
	#define OFF 0
	#define SSAO 1
	#define GTAO 2
	#define AO_ENABLED GTAO // Enables ambient occlusion. [OFF SSAO GTAO]
	// #define AO_MULTI_BOUNCE // Enables ambient occlusion multi-bounce

/* Shadows */
	#define COLORED_SHADOWS // Enables shadow stained glass tint

	#define SCREEN_SPACE_SHADOWS // Enables screen space shadows
	#define SCREEN_SPACE_SHADOWS_SAMPLES 10 // Sample count of screen space shadows. [2 4 6 8 9 10 12 14 15 16 18 20 22 24 26 28 30 40 50 70 100 150 200 300 500]

	#define SHADOW_BACKFACE_CULLING // Enables backface culling for shadows

	// 阴影视锥剔除（Iris 官方指令 shadow.culling，实际发射在 shaders.properties 的 #if 块里）：
	//   0 = DISTANCE   ：只做「shadowDistance(64) 格盒」剔除。实测最快（本包推荐）。
	//   1 = ADVANCED   ：视锥剔除，但**没有距离上限**——因为本包 shadowDistanceRenderMul=1.0 使
	//                    Iris 走 distance >= renderDistance*16 分支把 boxCuller 置空，阴影 pass
	//                    会覆盖到渲染距离(12 区块)扫过的整个体积：实测几何量 2.4 倍、帧时 15.9→28.3ms。
	//   2 = SAFE_ZONE  ：voxelDistance(48) 格内不剔除、之外视锥剔除 + 64 格上限。实测与 0 相当。
	// 另注：剔除掉的投影者变少会让更多像素走屏幕空间阴影/SSR（`shadow > 0.03` 早退），deferred 反而更贵。
	// 见 https://shaders.properties/current/reference/shadersproperties/rendering/#shadowculling
	#define SHADOW_CULLING_MODE 0 // [0 1 2]

//======// Materials //===========================================================================//

	#define TEXTURE_FORMAT 0 // [0 1 2]

	// #define MOD_BLOCK_SUPPORT
	#ifdef MOD_BLOCK_SUPPORT
	#endif

	#define NORMAL_MAPPING
	#define SPECULAR_MAPPING

	// #define LABPBR_HARDCODED_METAL

	#define DEFAULT_DIELECTRIC_F0 0.01 // Default dielectric F0. [0.0 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0]

/* Auto Generated Normal */
	// #define AUTO_GENERATED_NORMAL // Enables auto generated normal
	#define AGN_STRENGTH 2.0 // Strength of auto generated normal. [0.2 0.5 0.7 1.0 1.5 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0]
	#define AGN_RESOLUTION 4.0 // Resolution of auto generated normal. [4.0 8.0 16.0 32.0 64.0 128.0 256.0 512.0 1024.0]

/* Parallax */
	//#define PARALLAX // Enables parallax mapping
	//#define PARALLAX_DEPTH_WRITE // Enables parallax depth write

	//#define PARALLAX_SHADOW // Enables parallax shadow
	//#define PARALLAX_BASED_NORMAL // Enables parallax based normal

	// [2026-10-06 视差接线] 三个"数值型"选项必须保持启用（不能连注释一起关掉）：
	// 它们是 PARALLAX 的子参数，被 lib/surface/Parallax.glsl 无条件引用；一旦为空，
	// 只要用户打开「视差」就会编译失败（error C1503: undefined variable PARALLAX_SAMPLES）。
	// 父开关 PARALLAX 默认关，故把它们启用在画面上零影响（默认观感不变）。
	#define PARALLAX_SAMPLES 15 // Sample count of parallax. [5 10 15 20 25 30 35 40 45 50 55 60 65 70 75 80 85 90 95 100 110 120 130 140 150 160 170 180 190 200]
	#define PARALLAX_DEPTH 0.35 // Parallax depth. [0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0][0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.25 0.5 0.75 1.0 1.25 1.5 1.75 2.0 2.5 3.0 4.0 5.0 7.0 10.0]
	//#define PARALLAX_REFINEMENT // Enables parallax refinement
	#define PARALLAX_REFINEMENT_STEPS 8 // Sample count of parallax refinement. [4 8 12 16 20 24 28 32 36 40 44 48 52 56 60 64 68 72 76 80 84 88 92 96 100] [2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 18 24]
	//#define PHYSICS_OCEAN_SUPPORT
/* Reflections */
	//#define ROUGH_REFLECTIONS // Enables rough reflections
	// [2026-10-08 S2] 粗糙反射的**反光面空间**屏幕空间模糊：以上一帧的锐利反射缓冲（colortex11）为输入，
	// 用本帧的深度/法线/粗糙度做**边缘感知** gather。这是唯一能真正抹掉"反射物体轮廓"的廉价做法
	// （单条镜面射线的命中映射在轮廓处跳变，源空间模糊抹不掉）；材质/法线边界因权重≈0 保持锐利，
	// 所以木板旁的玻璃不会被糊。默认关 = 与原行为逐位一致。需要 shaders.properties 里的
	// flip.deferred20.colortex11 = true 配合（读上一帧、写本帧）。
	// [2026-10-08] 非透明物体也参与屏幕空间反射。原先 `DeferredLight` 的**调用点**硬编码
	// `metalness >= 0.5 || materialID == 10050`，于是反射页那几个判定选项（METAL_REFLECT_MODE /
	// METALNESS_THRESHOLD / ROUGHNESS_THRESHOLD）对不透明像素实际不可达。开启本开关后改用这些选项
	// 判定资格（默认 2 / 0.1 / 0.1 ⇒ 金属 + 极光滑电介质：冰面、抛光石、湿地面等），命中后按
	// Fresnel 叠加到已着色漫反射上（金属那条 mix 路径不变）。默认关 = 与原行为逐位一致。
	// 代价：符合条件的像素会真的跑一趟 SSR（覆盖率见反射页阈值）；GTX 1050 上建议同时降
	// SSRT_MAX_SAMPLES（本机当前 32）。
	//#define OPAQUE_SPECULAR
	#define ROUGH_REFLECTIONS_THRESHOLD 0.005 // Threshold for rough reflections. [0.0001 0.0002 0.0005 0.0007 0.001 0.002 0.005 0.007 0.01 0.02 0.05 0.07 0.1 0.2 0.5]

	#define REFLECTION_FILTER // Enables reflection filter

	#if RENDER_MODE == 0
		#undef REFLECTION_FILTER
	#endif

	#define SPECULAR_IMPORTANCE_SAMPLING_BIAS 0.5 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]

/* Refractions */
	// #define RAYTRACED_REFRACTION
	#define REFRACTION_STRENGTH 1.7 // [0.0 0.1 0.2 0.25 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 2.2 2.4 2.6 2.8 3.0 3.2 3.4 3.6 3.8 4.0 4.2 4.4 4.6 4.8 5.0 5.5 6.0 6.5 7.0 7.5 8.0 9.5 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0]

/* Emissive */
	#define EMISSIVE_MODE 1 // [0 1 2]
	#define EMISSIVE_BRIGHTNESS 1.0 // [0.0 0.01 0.02 0.05 0.07 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0 8.5 9.0 9.5 10.0 10.5 11.0 11.5 12.0 12.5 13.0 13.5 14.0 14.5 15.0 15.5 16.0 16.5 17.0 17.5 18.0 18.5 19.0 19.5 20.0 20.5 21.0 21.5 22.0 22.5 23.0 23.5 24.0 24.5 25.0]
	#define EMISSIVE_CURVE 0.5 // [0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0 1.05 1.1 1.15 1.2 1.25 1.3 1.35 1.4 1.45 1.5 1.55 1.6 1.65 1.7 1.75 1.8 1.85 1.9 1.95 2.0 2.05 2.1 2.15 2.2 2.25 2.3 2.35 2.4 2.45 2.5 2.55 2.6 2.65 2.7 2.75 2.8 2.85 2.9 2.95 3.0 3.05 3.1 3.15 3.2 3.25 3.3 3.35 3.4 3.45 3.5 3.55 3.6 3.65 3.7 3.75 3.8 3.85 3.9 3.95 4.0]

/* Subsurface Scattering */
	// [2026-09] 模型选择：
	//   0 = 旧版（默认）：还原 2026-09 之前的实现（sigmaS × phase × 阴影幂门控 × 接触阴影），
	//       唯一改动是去掉「阴影距离外朝太阳额外提亮」。
	//   1 = 重写版（备选）：lib/lighting/Subsurface.glsl —— 材质分类的真实厚度、天光/环境项、
	//       背光透光（默认关）、与屏幕空间阴影解耦、不含相机方向。
	// 注意：下面的 DIFFUSE / TRANSMISSION / AMBIENT / DIFFUSION 四项只对重写版生效。
	#define SUBSURFACE_SCATTERING_MODEL 0 // [0 1]
	// [2026-09 已移除] 阴影距离外的亮度限制（先做过 FAR_SCALE 倍率，后改成 FAR_LIMIT 亮度上限）：
	// 上限会让远处 SSS 变成与当地光照无关的固定亮度，看起来假，因此整条移除。
	// 现在远处 SSS 亮度与距离无关，明暗完全交给屏幕空间接触阴影（贴图停采时与直接光同刻接管）。
	#define SUBSURFACE_SCATTERING_MODE 1 // [0 1 2]
	#define SUBSURFACE_SCATTERING_STRENGTH 1.0 // [0.0 0.01 0.02 0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0 3.0 4.0 5.0 7.0 10.0 15.0]
	#define SUBSURFACE_SCATTERING_BRIGHTNESS 1.0 // [0.0 0.1 0.2 0.3 0.5 0.7 1.0 1.5 2.0 2.5 3.0 3.5 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5 8.0 8.5 9.0 9.5 10.0]
	// [2026-09] 阳面抑制（只对旧版模型 SUBSURFACE_SCATTERING_MODEL = 0 生效）。
	// **原版 Revelation 没有任何 N·L 抑制**（SSS 是平加性项，受光面也有一份）。
	// 这一项是 AD-edit 附加：按 (1 - N·L) 反向抑制，正对太阳的面（N·L = 1）降到 0，
	// 掠射（N·L ≈ 0）保持原强度 —— SSS 退化成「明暗交界处的透光」。
	//   0 = 原版行为（默认）；1 = 完全抑制（AD-edit 旧行为，用于压受光面的白送光）。
	#define SUBSURFACE_SCATTERING_FRONT_SUPPRESS 0.0 // [0.0 0.25 0.5 0.75 1.0]
	// [2026-09 移植原版] 旧版 SSS 是 vanilla Revelation 公式的逐行移植（见
	// DeferredLight.frag 的模型段来源说明）。**原版没有任何阴影/朝向门控**：SSS 只随
	// 太阳辐照变化，不看阴影可见性、不看面的朝向。AD-edit 在它之上加了两项（默认关）：
	//   ① 阴影幂门控 pow(sssFrontVisibility, 1.2 / SHADOW_CONTRAST_STRENGTH)
	//      —— 让 SSS 随阴影可见性衰减（即"旧 sss 会根据阴影自动补强度"）；
	//   ② 背光入射因子 saturate(N·L * 2.5 + 1) —— 修"阴影距离外朝太阳看时异常发亮"。
	// 关闭（默认）= 两项都不生效 = 原版行为；开启 = AD-edit 旧门控行为。
	// 注意：SUBSURFACE_SCATTERING_PCF_BLOCKER 开启时，①无论如何都会被停用（遮挡已由
	// 厚度项表达，再乘阴影可见性是双重遮蔽）。
	//#define SUBSURFACE_SCATTERING_EXTRA_GATES // Enables the AD-edit only SSS gates (shadow power gate + back-face entry factor)
	// [2026-09] PCF 下的 SSS 厚度（**只在 PCF 生效**；PCSS 例外地继续用真实 blocker 深度）。
	// PCF 没有 blocker 深度可用（sssBlockerDepth 恒为 0 ⇒ 厚度项 exp2(0) = 1），SSS 于是成了
	// 与厚度无关的平加项。这里按"是不是十字方块"分两类各给一条厚度：
	//   十字方块   = materialID 1000-1003：草/花/树苗等十字模型，含「植物判定补充」
	//                (UNLABELLED_FOILAGE_DETECTION) 检出的 1003；
	//   非十字方块 = 其余 SSS 材质（树叶 13、藤 27/28、羊毛/干草 37、冰/雪/蜂窝 38、黏液 51…）。
	// 厚度直接进原版的体积衰减项 exp2(-rLOG2 * 厚度 * (sigmaS + sigmaA))：
	//   0 = 该类别退回纯平加（= 原版在 PCF 下的行为），越大越暗越"厚"。
	// 注意这里的量纲是对着 blocker 深度调出来的（blocker 深度经 shadowProjInv2z 带一个 ×5 缩放），
	// 与重写版的 SUBSURFACE_SCATTERING_RADIUS（方块单位）不是同一把尺子，以实测观感为准。
	#define SUBSURFACE_SCATTERING_CROSS_THICKNESS 0.01 // [0.0 0.01 0.02 0.03 0.05 0.075 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.8 1.0 1.5 2.0]
	#define SUBSURFACE_SCATTERING_NONCROSS_THICKNESS 0.05 // [0.0 0.01 0.02 0.03 0.05 0.075 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.8 1.0 1.5 2.0]
	// [2026-09 复刻原版] PCF 遮挡深度采样：原版 Revelation 是纯 PCSS（CalculatePCSS 恒执行
	// BlockerSearch），SSS 厚度 = 真实遮挡深度 surfaceDepth。AD-edit 的 PCF 没有 blocker 深度，
	// 厚度只能退化为常量、树叶没有「越往深处越暗」的深度感。开启本项后，PCF 下对 SSS 材质
	// 像素做少量 shadow map 深度采样（BLOCKER_SAMPLES 次 texelFetch，仅 SSS 像素）估计同样的
	// 遮挡深度，厚度公式与原版一致：厚度 = BLOCKER_SCALE × 遮挡深度（无任何常量叠加）。
	// 量纲核实：原版 BlockerSearch 折算系数 ×10/8 与 AD-edit ×5/4 相同（都是 ×1.25），
	// SCALE = 1.0 即与原版 PCSS 同标定。仅 PCF（SHADOW_SOFT_TYPE = 1）生效。
	// 注意：开启时会自动停用旧版模型的「阴影幂门控」（见 DeferredLight.frag SSS 段）——
	// 原版本就没有该门控，遮挡已由厚度项表达，再乘阴影可见性是双重遮蔽。
	// （默认开启是显式决策：用户要求不开 PCSS 也能复刻原版 PCSS 的 SSS 外观，
	//   偏离 CODE_STYLE 的「新能力默认无视觉变化」约定。）
	#define SUBSURFACE_SCATTERING_PCF_BLOCKER // Enables a few shadow-map depth samples for legacy SSS in PCF mode (replicates vanilla PCSS thickness)
	#define SUBSURFACE_SCATTERING_BLOCKER_SAMPLES 4 // [2 4 6 8]
	#define SUBSURFACE_SCATTERING_BLOCKER_SCALE 1.0 // [0.25 0.5 0.75 1.0 1.5 2.0 3.0 4.0]
	#define SUBSURFACE_SCATTERING_RADIUS 0.25 // [0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.1 0.11 0.12 0.13 0.14 0.15 0.16 0.17 0.18 0.19 0.2 0.21 0.22 0.23 0.24 0.25 0.26 0.27 0.28 0.29 0.3 0.31 0.32 0.33 0.34 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0]
	// [2026-09 SSS 重构] 扩散平均自由程 = RADIUS × 4（方块）。RADIUS 此前是死选项（代码零引用），
	// 现在同时决定体积衰减强度，并将在屏幕空间扩散 pass 里决定模糊半径。
	// [2026-09] 薄片（树叶/草/藤）背光透光强度。这一项含相机方向，是**视角相关**的
	// （只有逆光看薄片才亮，转视角会明暗跳动）——所以默认 0（关）。想要逆光辉光再往上调。
	#define SUBSURFACE_SCATTERING_TRANSMISSION 0.2 // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.5 2.0 3.0]
	// [2026-09] 正面（受光面）扩散强度：不依赖相机，只随 N·L 与阴影可见性变化（旧实现的优点）。
	// 0 = 完全关闭正面项。默认 0.35 时受光面大约比普通方块亮 20%（x1.5 亮度倍率后约 30%）。
	#define SUBSURFACE_SCATTERING_DIFFUSE 0.0 // [0.0 0.05 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.6 0.8 1.0 1.5 2.0 3.0]
	// [2026-09] 天光/环境项强度：唯一不依赖太阳方向与面朝向的一项，阴影里/背光面也看得见 SSS。
	// 默认 1.0 时，羊毛/冰在阴影里的 SSS 约为环境光的一半（0.5 是上一版，效果几乎看不出来）。
	#define SUBSURFACE_SCATTERING_AMBIENT 0.3 // [0.0 0.1 0.2 0.3 0.4 0.5 0.7 1.0 1.5 2.0 3.0]
	// [2026-09] 屏幕空间扩散：SSS 源项先做半分辨率两趟可分离模糊（深度感知 + 抖动）再合成，
	// 边缘有真实渗色、大面材质过渡更柔和；关闭则退回逐像素 SSS（第 1 步行为），
	// 同时省掉源缓冲 colortex18 的写入与两趟模糊。
	// [2026-09 暂时停用] 按用户要求先关掉（保留全部实现，随时可启回）：
	//   代码仍在：colortex18/19/20、world0|world1|world-1 的 composite1.csh 与 composite3.csh、
	//   program/post/SubsurfaceBlur.comp、DeferredLight 的 imageStore、IntegrateScene 的合成。
	//   想启回来：取消下面这行的注释即可（shaders.properties 会同步打开两个 pass）。
	// #define SUBSURFACE_SCATTERING_DIFFUSION // Enables screen-space diffusion (two-pass separable blur) of the SSS source
	// [2026-09] 阴影距离外是否完全关闭 SSS（默认关）：
	//   关（保持注释）= 阴影距离外不关 SSS，只把太阳项（正面扩散 + 背光透光）按
	//                  1 - distanceFade 平滑淡出，只留下天光/环境项 → 远处半透明方块
	//                  不会因为"太阳透过"凭空变亮，也不会有硬跳变；
	//   开（取消注释）= 旧行为：阴影距离外整块关闭 SSS。
	// #define SSS_DISABLE_BEYOND_SHADOW_DIST

	#ifndef RP_SUPPORT
		#undef NORMAL_MAPPING
		#undef SPECULAR_MAPPING
	#endif

	#ifndef NORMAL_MAPPING
		#undef MC_NORMAL_MAP
		#undef PARALLAX
		#undef AUTO_GENERATED_NORMAL
	#endif

	#ifndef SPECULAR_MAPPING
		#undef MC_SPECULAR_MAP
	#endif

	#if defined AUTO_GENERATED_NORMAL
		#undef PARALLAX
	#endif

//======// Post-Processing //=====================================================================//

/* Depth of Field */
	#define DEPTH_OF_FIELD // Enables depth of field
	#ifdef DEPTH_OF_FIELD
	#endif
	// #define DOF_APERTURE_VIGNETTING // Enables aperture vignetting
	#define CAMERA_FOCUS_MODE 0 // [0 1]
	#define DOF_FOCAL_LENGTH 35.0 // [18.0 24.0 35.0 50.0 75.0 100.0]
	#define DOF_F_STOP 4.0 // [1.0 1.4 2.0 2.8 4.0 5.6 8.0 11.0 16.0]
	#define DOF_APERTURE_SHAPE 0 // [0 1]
	#define DOF_GATHER_SAMPLES 8 // [8 10 12 14 16 18 20 22 24 26 28 30 32 34 36 40 48 56 64]
	#define DOF_COC_SPREAD_SAMPLES 4 // [4 6 8 10 12 14 16 18 20 24 32]
	#define DOF_MAX_BLUR_RADIUS 8.0 // [4.0 6.0 8.0 10.0 12.0 16.0 20.0 24.0 32.0]
	#define DOF_FOCUS_HALFLIFE 0.05 // [0.04 0.05 0.075 0.1 0.15 0.2 0.25 0.3 0.4 0.5 0.75 1.0]
	#define DOF_MANUAL_FOCUS_DISTANCE 10.0 // [1.0 2.0 3.0 4.0 5.0 6.0 8.0 10.0 12.0 16.0 20.0 24.0 32.0 48.0 64.0 96.0 128.0 192.0 256.0 512.0]
	//#define DOF_FOCUS_IGNORE_HAND // Ignore the hand when finding the autofocus target

/* TAA */
	#define TAA_ENABLED // Enables temporal Anti-Aliasing
	#define TAA_CLOSEST_FRAGMENT // Caclulates the closest fragment for TAA. Improves ghosting in the motion objects
	#define TAA_MAX_ACCUM_FRAMES 64.0 // Maximum number of accumulated frames for TAA. [20.0 24.0 28.0 32.0 36.0 40.0 48.0 56.0 64.0 72.0 80.0 96.0 112.0 128.0 144.0 160.0 192.0 224.0 256.0 320.0 384.0 448.0 512.0 640.0 768.0 896.0 1024.0]
	#define TAA_HISTORY_WEIGHT 0.9 // 性能模式的历史权重：越大越干净、拖影越长（0.9 = 当前帧占 10%）[0.5 0.6 0.7 0.75 0.8 0.85 0.875 0.9 0.925 0.95 0.975 0.99]

	#define TAA_CLIPPING
	#define TAA_AGGRESSION 2.0 // [1.0 1.05 1.1 1.15 1.2 1.25 1.3 1.35 1.4 1.45 1.5 1.55 1.6 1.65 1.7 1.75 1.8 1.85 1.9 1.95 2.0 2.05 2.1 2.15 2.2 2.25 2.3 2.35 2.4 2.45 2.5 2.55 2.6 2.65 2.7 2.75 2.8 2.85 2.9 2.95 3.0]
	#define TAA_ANTIFLICKER 0.0 // [0.0 0.25 0.5 0.75 1.0]

	//#define TAA_SHARPEN

	#define TAA_CLIP_STDDEV_MIN 0.0 // 方差裁切的标准差下限（仅质量模式）：防平坦区域 0/0 = NaN [0.0 0.0001 0.001 0.01 0.1]

/* Motion Blur */
	#define MOTION_BLUR // Enables motion blur
	#define MOTION_BLUR_SAMPLES 4 // Sample count of motion blur. [2 3 4 5 6 7 8 9 10 12 14 16 18 20 22 24]
	#define MOTION_BLUR_STRENGTH 1.0 // Strength of the motion blur. [0.0 0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.4 1.5 1.7 2.0 2.5 3.0 3.5 4.0 4.5 5.0 7.0 10.0 12.0 14.0 16.0 18.0 20.0]

/* Bloom */
	#define BLOOM
	#define BLOOMY_FOG
	// #define BLOOM_KARIS_AVERAGE
	#ifdef BLOOM_KARIS_AVERAGE
	#endif

/* Exposure */
	#define MANUAL 0
	#define AUTO_BASIC 1 // TODO
	#define AUTO_HISTOGRAM 2

	#define EXPOSURE_MODE AUTO_HISTOGRAM // [MANUAL AUTO_HISTOGRAM]

	#define AUTO_EV_MIN -5.0 // Minimum EV value for auto exposure. [-32.0 -31.0 -30.0 -29.0 -28.0 -27.0 -26.0 -25.0 -24.0 -23.0 -22.0 -21.0 -20.0 -19.0 -18.0 -17.0 -16.0 -15.0 -14.0 -13.0 -12.0 -11.0 -10.0 -9.0 -8.0 -7.0 -6.0 -5.0 -4.0 -3.0 -2.0 -1.0 0.0 1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 21.0 22.0 23.0 24.0 25.0 26.0 27.0 28.0 29.0 30.0 31.0 32.0]
	#define AUTO_EV_MAX 10.0 // Maximum EV value for auto exposure. [-32.0 -31.0 -30.0 -29.0 -28.0 -27.0 -26.0 -25.0 -24.0 -23.0 -22.0 -21.0 -20.0 -19.0 -18.0 -17.0 -16.0 -15.0 -14.0 -13.0 -12.0 -11.0 -10.0 -9.0 -8.0 -7.0 -6.0 -5.0 -4.0 -3.0 -2.0 -1.0 0.0 1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 21.0 22.0 23.0 24.0 25.0 26.0 27.0 28.0 29.0 30.0 31.0 32.0]
	#define AUTO_EV_BIAS 0.0 // EV bias for auto exposure. [-2.0 -1.9 -1.8 -1.7 -1.6 -1.5 -1.4 -1.3 -1.2 -1.1 -1.0 -0.9 -0.8 -0.7 -0.6 -0.5 -0.4 -0.3 -0.2 -0.1 0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2.0]
	#define MANUAL_EV 4.0 // Manual exposure value. [0.1 0.3 0.5 1.0 1.5 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 12.0 14.0 16.0 18.0 20.0 25.0 30.0 40.0 50.0]

	#define EXPOSURE_SPEED_UP 2.0 // Dim to bright speed. [0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.6 2.0 2.5 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 25.0 30.0 40.0 50.0]
	#define EXPOSURE_SPEED_DOWN 1.0 // Bright to dim speed. [0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.6 2.0 2.5 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 25.0 30.0 40.0 50.0]

	#define HISTOGRAM_BIN_COUNT 32 // Number of bins for the histogram. [32 64 128 256]
	#define HISTOGRAM_LOWER_BOUND 0.4 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]
	#define HISTOGRAM_UPPER_BOUND 0.6 // [0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0]

/* FidelityFX */
	//#define CAS_ENABLED // Sharpens the final image using AMD FidelityFX CAS (Contrast-Adaptive Sharpening)
	#define CAS_STRENGTH 0.5 // Strength of the CAS. [0.0 0.01 0.02 0.03 0.04 0.05 0.06 0.07 0.08 0.09 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.65 0.7 0.75 0.8 0.85 0.9 0.95 1.0]

/* Chromatic Aberration */
	#define CHROMATIC_ABERRATION // Enables lateral chromatic aberration (RGB channel separation at the lens barrel)
	#define CHROMATIC_ABERRATION_STRENGTH 4.0 // Maximum offset in pixels at the screen corners. [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.4 1.6 1.8 2.0 2.5 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 12.0 14.0 16.0 18.0 20.0 25.0 30.0]

	#if RENDER_MODE == 0
		#undef MOTION_BLUR
		#undef CAS_ENABLED
		#undef CHROMATIC_ABERRATION
	#endif

//======// Debug //===============================================================================//

	// #define WHITE_WORLD
	#define DEBUG_NORMALS 0 // [0 1 2]
	// #define DEBUG_ATMOSPHERE_LUTS
	// #define DEBUG_SKY_MAP
	// #define DEBUG_BLOOM_TILES
	// #define DEBUG_CLOUD_MAP
	// #define DEBUG_CLOUD_NOISE
	// #define DEBUG_CLOUD_SHADOWS
	// #define DEBUG_TONE_MAPPING_PLOT
	// [2026-11-12 W6 临时调试] 染色玻璃「没有颜色」的定位开关。**必须用 #ifndef 包住**：
	// Iris 会把 GUI 里的值以 #define GLASS_DEBUG <值> 注入到源码最前面，这里再无条件
	// #define 一次会造成「重定义且值不同」的编译错误（表现就是整屏黑）。
	//   1 = 假设 translucent.a（纹理 alpha）接近 0 ⇒ 强制染色指数为 1
	//   2 = 假设命中了「回退 colortex6」分支 ⇒ 回退值改成洋红
	//   3 = 假设玻璃没进 glassMask ⇒ 对「深度上是半透明」的像素也当玻璃处理
	//   4 = 直接显示玻璃像素 c7.zw 里的 albedo（判断颜色有没有写进 gbuffer）
	#ifndef GLASS_DEBUG
		#define GLASS_DEBUG 0 // [0 1 2 3 4]
	#endif

// [2026-11-12 logo 跟随] 让启动 logo 像「浮在镜头前、略微延迟跟上视角」的板子：
// 相机的转向先低通，再用「低通朝向 - 当前朝向」的差换算成屏幕位移与滚转。
// 0 延迟 = 完全固定跟随（旧行为）；延迟越大，快速转身时板子越明显地「甩在后面」。
#ifndef LOGO_FOLLOW_DELAY
    #define LOGO_FOLLOW_DELAY 0.12 // [0.0 0.04 0.06 0.08 0.1 0.12 0.15 0.2 0.3 0.5] 跟随延迟（秒，0=固定跟随）
#endif
#ifndef LOGO_FOLLOW_STRENGTH
    #define LOGO_FOLLOW_STRENGTH 1.0 // [0.0 0.5 1.0 1.5 2.0 2.5 3.0 4.0] 滞后量→屏幕位移（焦距倍率，0=不位移）
#endif
#ifndef LOGO_FOLLOW_ROLL
    #define LOGO_FOLLOW_ROLL 0.35 // [0.0 0.15 0.3 0.45 0.6 0.8 1.0] 滞后量→滚转角（弧度/弧度）
#endif

	// #define FORCE_DISABLE_SUBGROUP_OPS
	#define GI_MODE 0 // [0 1 2 3]
	// Keep internal boolean aliases for Iris' program-toggle preprocessor.
	// GI_MODE is the only user-facing selector; these aliases are deliberately
	// not referenced by any screen entry.
	#undef SSILVB_ENABLED
	#undef VOXEL_GI_ENABLED
	#undef IRC_GI_ENABLED
	#undef GI_ACTIVE_SSILVB
	#undef GI_ACTIVE_VXGI
	#undef GI_ACTIVE_IRC
	#if GI_MODE == 1
		#define GI_ACTIVE_SSILVB
		#define SSILVB_ENABLED
	#elif GI_MODE == 2
		#define GI_ACTIVE_VXGI
		#define VOXEL_GI_ENABLED
	#elif GI_MODE == 3
		#define GI_ACTIVE_IRC
		#define IRC_GI_ENABLED
	#endif
	// REBLUR 式降噪生效条件：VXGI + 自动降噪模式。必须写在这里——GI_MODE / GI_ACTIVE_VXGI
	// 到这一行才真正定义，写在前面会让 `#if` 恒假（预处理器把未定义标识符当 0）。
	#if defined GI_ACTIVE_VXGI && defined VOXEL_GI_NRD && defined VOXEL_GI_DENOISE \
	    && VOXEL_GI_DENOISE_MODE == 0
		#define VOXEL_GI_NRD_ACTIVE
	#endif
	// [2026-10-08] SSILVB/VXGI 开启时自动关掉独立的 AO：这两种模式自带屏幕空间遮蔽
	// （SSILVB 的线性深度 AO / VXGI 的体素遮蔽），再叠一层 GTAO/SSAO 等于同一处遮蔽算两遍，
	// 角落和缝隙会过黑，而且白付一遍采样开销。
	// AO_ENABLED 是**值型**选项（OFF/SSAO/GTAO → 0/1/2，见本文件 AO 段），
	// 所以这里不能像 ENABLE_VOXELIZATION 那样 #undef 了事，必须重定义成 0（OFF）。
	// 消费点统一是 `#if AO_ENABLED == 1/2` 与 `#if AO_ENABLED > 0`（DeferredLight.frag），
	// 定义为 0 即等价于用户选 OFF。IRC(GI_MODE==3) 不在此列，仍按用户选择。
	#if GI_MODE == 1 || GI_MODE == 2
		#undef AO_ENABLED
		#define AO_ENABLED 0
	#endif

	// ===== 全分辨率 VXGI（默认关；只影响 GI_MODE==2）=====
	// 关 = 2x2 棋盘半分辨率：每帧只投 1/4 像素，画布存 colortex3 左上象限，时域由
	//      Accumulate 的 4 相位重建补全（追踪量 1x）。
	// 开 = 每像素每帧 1 条光线：无棋盘/无象限，GI 缓冲与画面同尺寸（追踪量与缓冲 4x）。
	// 观感默认不变；开之前看显卡，追踪成本直接 x4。
	// 弱光降噪：暗处把时域累积上限提高到 4 倍（只加长历史，不加大空间模糊；默认关）
	// 【2026-11-11 实测】暗处 ×4 = 累积上限 120 帧（0.5 s→2 s）：光照变化的恢复时间翻四倍，
	//   在暗场景里表现为「拖影一大条」。官方 REBLUR 没有这个机制（cap 全场一致）。
	//   默认保持关闭；只有在「暗处噪点实在压不住」时才考虑开。
	//#define VOXEL_GI_DARK_ACCUM
	//#define VOXEL_GI_FULLRES
	#ifdef VOXEL_GI_FULLRES
		#ifdef GI_ACTIVE_VXGI
			#define VXGI_FULLRES
		#endif
	#endif
	// GI 画布尺寸/坐标不在这里开宏：各 pass 内部按 VXGI_FULLRES 各取一次局部量，读起来更直观。
	// ENABLE_VOXELIZATION 是 GUI 布尔开关（shaders.properties screen.voxel + profile.Default 默认开）。
	// Iris 通过"注释/取消注释本行"来开关（setBooleanDefineValue）。要显示开关必须同时满足：
	//   1) 本行 `#define ENABLE_VOXELIZATION`（无值，可带注释）→ 布尔选项定义锚点；
	//   2) 存在单独一行的 `#ifdef ENABLE_VOXELIZATION` 引用（Terrain.frag 可视化块 + Shadow 系列）。
	//   缺任一 → GUI 只占位不显示（"空格子"）。注意不能用 `#if defined A && defined B` 复合条件。
	#define ENABLE_VOXELIZATION  // 体素化：shadow pass 直写 voxelData（3D 纹理）；关闭则无 GI

	// [2026-09-06 性能] GI 关闭(GI_MODE==0) 或屏幕空间 GI(SSILVB, GI_MODE==1) 时，体素数据
	// 没有任何消费者：VoxelTracePixel 的调用点只在 GI_ACTIVE_VXGI / PROBE_GI_ENABLED 分支内，
	// VoxelGI.frag(IRC 探针) 也只在 GI_MODE==3 编译；VoxelClear/VoxelGI 两个 compute 本身
	// 已按 GI_ACTIVE_* 早退。此时自动取消 ENABLE_VOXELIZATION = 等价于在 GUI 里手动关掉
	// "体素化"（作者已维护该分支），收益是 shadow pass 不再付出体素化代价：
	//   - Shadow.geom 走 #else「原样转发（全幅真阴影，无 Shift）」→ 不再用 GS 把整份投影
	//     地形重新展开、平铺进阴影贴图左侧 VOXEL_TILE_WIDTH(256px) 条带并光栅化；
	//   - Shadow.frag 的 imageStore(voxelData) / imageAtomicMax / imageAtomicOr 全部编译掉
	//     （阴影 pass 是帧内最大开销之一，这些是逐片元原子操作）；
	//   - Shadow.vert 的体素坐标打包（+cameraPositionFract 等）一并消失；
	//   - 阴影贴图恢复全幅（1280x1536 → 1536x1536 有效阴影区）。
	// 读取端 ShiftShadowScreenPos 全部由同一个宏守卫（Render/RSM/
	// IntegrateScene/AtmosphericFog/VoxelSunShadow），随写入端一起关 → 布局保持自洽。
	// 注意：若开着 DEBUG_VOXEL_GI / VISUALIZE_VOXELS 看体素格，需要 GI_MODE>=2 才会有数据。
	// GI_MODE>=2（VXGI 追踪 / IRC 探针）仍保留体素化：它们依赖 voxelData。
	#if GI_MODE < 2
		#undef ENABLE_VOXELIZATION
	#endif

	// ===== IRC DDGI backend（4m 方向性探针 + 距离可见性）=====
	// GI_MODE=3 内部启用，不作为独立 GUI 模式暴露。
	#undef PROBE_GI_ENABLED
	#if GI_MODE == 3
		// IRC backend: directional DDGI probes with distance visibility.
		#define PROBE_GI_ENABLED
	#endif
	#define PROBE_GI_STRENGTH 1.0       // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.5 2.0] 探针 GI 总强度

	// ===== IRC GI（DDGI 方向性探针后端，免 SVGF）=====
	// 16³×4m 探针，八面体方向辐照度 + 距离场遮挡；仅方块光与阳光。
	#define IRC_GI_STRENGTH 1.2         // [0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.2 1.5 2.0 3.0] IRC GI 总强度
	#define IRC_DISABLE_SUN_GI       // IRC/DDGI 调试：先屏蔽阳光反弹，仅保留方块光/自发光
	// [2026-09-05 射线预算+轮转分摊已接线] 每帧只更新 1/PROBE_UPDATE_PERIOD 的探针，每个更新一次投出
	// PROBE_RAY_SAMPLES×PROBE_UPDATE_PERIOD 条射线 → 总射线量/帧 = 探针数 × PROBE_RAY_SAMPLES（与周期无关）。
	// 单更新样本数 ×周期 → 单更新方差 ÷周期；时域滞后换算 hyst^P 保持"每帧"语义（响应/噪声不随周期漂移）。
	#define PROBE_RAY_SAMPLES 8        // [4 8 16 32 48 64 96 128 192 256] 每探针射线预算（平均每帧；更新时×周期投出）
	#define PROBE_UPDATE_PERIOD 1       // [1 2 4 8 16 32] 轮转周期（帧）：每探针每 N 帧更新一次；N=1=每帧全量（旧行为）
	#define PROBE_MAX_FRAMES 32.0       // [4 8 16 32 64 128] 预留（未接线）：EMA 帧数语义待后续接入
	// [DDGI 完整重写 2026-09-03] 八面体/边界/滞后/偏置参数。
	// PROBE_OCT_SIZE=八面体内边数(每探针方向分辨率)；改它必须同步 shaders.properties 的三张纹理尺寸(128→G*(O),同深)。
	#define PROBE_OCT_SIZE 6            // [4 6 8] 八面体探针映射内边数（含 1 像素边界 → 块边 O=+2）
	#define PROBE_IRRADIANCE_GAMMA 5.0  // [2.0 3.0 4.0 5.0 6.0 8.0 10.0] 辐照度亮度编码 gamma（DDGI 默认 5）：改善亮暗收敛与低亮度精度
	// [2026-09-05 恢复正常值] 早期为压低频浮动把滞后提到 0.98/0.95；轮转分摊(512线/更新)+图集双边滤波
	// 已接手降噪，恢复常规值 0.95/0.85（响应快、收敛自然）。若仍有浮动再自行提到 0.97/0.9 档。
	#define PROBE_HYSTERESIS 0.9       // [0.9 0.95 0.97 0.98 0.99] 时域滞后（每帧语义；高=更去噪/收敛慢）
	// [2026-09-05] 距离场（静态几何）常规值 0.85：快速收敛 → 遮挡更快生效、少漏光；重锚后新暴露走播种。
	#define PROBE_DIST_HYSTERESIS 0.85 // [0.85 0.9 0.93 0.95 0.97 0.98 0.99] 距离场时域滞后（每帧语义）
	// [2026-09-05 探针图集双边滤波] RTXGI 同思路：写入后对本探针八面体块内部做 3×3 边缘保持平滑，
	// 用距离场差异做边缘停止 + 纹素方向相似度^DIR_POW。不加射线即可压掉小光源(火把/萤石)周围的
	// 逐纹素方差与低频浮动。只滤辐照度；距离场不滤（滤距离会增加穿墙漏光）。
	#define PROBE_ATLAS_FILTER        // 探针图集双边滤波开关（写入后空间平滑，不加射线压噪）
	#define PROBE_ATLAS_FILTER_DIST_K 1.0    // [0.25 0.5 1.0 2.0 4.0] 距离边缘停止强度（大=更保边/更少滤）
	#define PROBE_ATLAS_FILTER_DIR_POW 8.0   // [2.0 4.0 8.0 16.0 32.0] 方向相似度指数（大=更方向局部化/小=更平滑）
	#define PROBE_NORMAL_BIAS 0.5       // [0.1 0.3 0.5 0.8 1.0] 采样点沿表面法线推向表面（世界尺度）
	#define PROBE_VIEW_BIAS 0.5         // [0.1 0.3 0.5 0.8 1.0] 采样点沿视线推离墙面（世界尺度）
	// [临时调试 2026-09-03] 只留方块光 GI：ProbeTrace 屏蔽阳光/天光项，仅保留
	// lightmap 方块光 + 发射体素光球（火把/萤石）。确认方块光 GI 用，调完删。
	// [2026-09-04] 已改走 IRC 光场直采样（自带天/阳/方块光），本开关不再使用 → 注释。
	//#define PROBE_GI_BLOCK_ONLY
	// [自检 DEBUG_PROBE_BIND_TEST] 非 GUI 开关（文件直接生效，Iris 不管理不覆盖）：
	// 屏分两半二分 image/sampler 绑定与写端。判读见 DiffuseIndirect.comp 该块注释。
	//#define DEBUG_PROBE_BIND_TEST  // [临时自检 2026-09-03] 左=image 直写直读，右=sampler 读回
	// [管线自检 2 DDGI] 全屏 A/B：左半 = 完整 DDGI 查询裸值，右半 = 16m 周期坐标渐变（钉世界基准）。
	// 判读：左半有暖光斑 → 查询端通；左半黑 → 查询端返回 0（配合上面的写端自检二分写端/查询端）。
	//#define DEBUG_PROBE_QUERY
	// [调试 2026-09-03] 整屏显示探针 GI 辐照度场(伽马增强)，无视地形门控与其余光照，
	// 直接看 GI 照明分布/亮度/伪影(blotchy 的 4m 探针块、颜色、时域稳定性)。
	//#define DEBUG_PROBE_GI_VIZ
	// [调试] GI 时域累积诊断读数（画在 Final）：R = 累积帧数 / 上限（亮 = 历史长，暗 = 掉回单帧样本），
	// G = 本帧该像素是否被判"不可靠"（1 = 越界/historyReset/几何不匹配）。运动时噪点问题先看这里：
	// R 变暗 + G 亮起 = 历史被拒，问题在重投影/判据，不在降噪器。
	//#define DEBUG_GI_ACCUM_STATS
	//#define VISUALIZE_VOXELS
	//#define DEBUG_VOXEL_GI  // 调试(备用)：按体素 voxelID 标色（青绿=活板门/门 橙棕=形状块[楼梯/半砖/栅栏/墙] 黄=全块 蓝=空 红=越界）
	//#define DEBUG_VOXEL_RADIANCE  // 调试：直接显示传播后的体素辐照度（验证"体素化+传播"链路）
	// 调试：天光路径命中时返回红色（验证路径是否跑通、门控是否放行）
	//#define DEBUG_VOXEL_SKY
	// 调试：方块表面显示 GI 天光等级（伪彩色 = IRC 天空曝光度 alpha；蓝=无天光 红=全开）
	//#define DEBUG_VOXEL_SKY_LEVEL
	// [2026-10-02] 调试：阳光反弹三通道读数（定位"看不到阳光反弹"卡在哪一环）。
	// R = 遮挡可见性（阴影贴图 × 体素 DDA；0=被判被挡/采样失败）
	// G = 命中面朝向太阳 saturate(dot(sunDir, hitNormal))（0=太阳方向/法线不对）
	// B = 天光门控 saturate(max(命中格 sky, 像素 lightmap)×444)（0=天光门控全关）
	// 哪个通道黑，就卡在哪一环；三通道都亮 ⇒ 因子正常，只是量级/观感问题（调滑条）。
	// [2026-10-02] 已确认宏值 = 32（角落读数纯白）⇒ 诊断目的达成，关闭读数，恢复干净画面。
	// 要用时把下面这行取消注释（GUI「调试→体素→阳光反弹因子调试」也能开）。
	// 因子替换视图需额外再定义 DEBUG_SUNBOUNCE_FACTORS（默认不定义，保持正常观感）。
	//#define DEBUG_SUNBOUNCE_VIS
	#include "/lib/lighting/VoxelLighting.glsl"
	// [2026-08-09] 方块光颜色：光追开启时忽略玩家 BLOCKLIGHT_COLOR_R/G/B 设置，
	// 全局置 0（体素内无原版方块光）；体素外需要原版方块光时由 DeferredLight 的
	// "网格外强制默认色"逻辑恢复。光追关闭时按玩家设置正常工作。
	#ifdef GI_ACTIVE_VXGI
		const vec3 blocklightColor = vec3(0.0);
	#else
		const vec3 blocklightColor = vec3(BLOCKLIGHT_COLOR_R, BLOCKLIGHT_COLOR_G, BLOCKLIGHT_COLOR_B) * BLOCKLIGHT_BRIGHTNESS;
	#endif
	#ifdef DIMENSION_THE_END
    	
		#undef VF_TIME_FADE
	
	#endif
	#ifdef DIMENSION_NETHER
    	
		#undef VF_TIME_FADE
		
	#endif


#endif
