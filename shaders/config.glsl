/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

	Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
	Modified by AnotherCream, 2026.


--------------------------------------------------------------------------------

	- Pipeline Configuration -

	const int 	colortex0Format 			= RGBA16F;
	const int 	colortex1Format 			= RGBA16F;
	const int 	colortex2Format 			= RGBA16F;
	const int 	colortex3Format 			= RGBA16F;
	const int 	colortex4Format 			= R11F_G11F_B10F;
	const int 	colortex5Format 			= RGBA16F;
	const int 	colortex6Format 			= RGBA8;
	const int 	colortex7Format 			= RGBA16UI;
	const int 	colortex8Format 			= RGBA16_SNORM;
	const int 	colortex9Format 			= RGBA16F;
	const int 	colortex10Format 			= RG16F;
	const int 	colortex12Format 			= RG16;
	const int 	colortex13Format 			= R8I;
	const int 	colortex14Format 			= RGBA16F;	// 原 RGB16F；alpha 存 disocclusion 标记（去遮挡修复用）
	// [2026-09-11 DoF 移植] colortex15 原为 Voxel GI propagation 输出（RGBA8），
	// 但唯一使用点 smooth.glsl 只被已禁用的 deferred1_b.csh1 引用 = 死缓冲。
	// [2026-09-12] smooth.glsl 已随本批死代码一并删除（它只被 .csh1 禁用 pass 引用）；
	// 保留上句是为了说明 colortex15 当年为何能安全改格式。
	// 现改作 DoF gather scratch（移植自原版 Revelation，原版同编号 rgba16f）：
	// Prepare 写 CoC 数据 / Gather 写过滤色，需 HDR 半精度，故升 RGBA16F。
	const int 	colortex15Format 			= RGBA16F;

#ifdef VOXY
	// Translucent data
	const int 	colortex16Format 			= RGBA16UI;
	const int 	colortex17Format 			= RGBA16_SNORM;
#endif

	// [2026-09 SSS 屏幕空间扩散] 三张缓冲：源项由 DeferredLight(deferred20) 写入，
	// 两趟可分离模糊（composite1 横向 / composite3 纵向），IntegrateScene(composite4) 合成。
	// Iris 的常量指令解析是逐行文本匹配（不识别注释），所以这块即使被注释也生效——
	// 与上面的 colortex0-17 同一机制。
	const int 	colortex18Format 			= RGBA16F;	// SSS 源项（半分辨率；rgb = 源项×mask，a = mask）
	const int 	colortex19Format 			= RGBA16F;	// SSS 横向模糊结果（半分辨率）
	const int 	colortex20Format 			= RGBA16F;	// SSS 纵向模糊结果（半分辨率）

	// [2026-09-10] Iris 官方常量（location: composite/deferred/final/prepare）：
	// shadow.culling = reversed 时，玩家周围这个半径内的几何在 shadow pass 里不剔除、
	// 之外按正常视锥剔除；shadowDistance(64) 不能小于它。模式 0/1 下此常量不参与计算。
	// 见 shaders.properties 的 SHADOW_CULLING_MODE 与
	// https://shaders.properties/current/reference/constants/voxeldistance/
	const float voxelDistance = 48.0;

	const bool	colortex0Clear				= false;
	const bool 	colortex1Clear				= false;
	const bool	colortex2Clear				= false;
	const bool	colortex3Clear				= true;
	const bool	colortex4Clear				= false;
	const bool  colortex5Clear				= false;
	const bool  colortex6Clear				= true;
	const bool	colortex7Clear				= true;
	const bool	colortex8Clear				= false;
	const bool	colortex9Clear				= false;
	const bool 	colortex10Clear				= false;
	const bool 	colortex12Clear				= true;
	const bool 	colortex13Clear				= false;
	const bool 	colortex14Clear				= false;
	const bool 	colortex15Clear				= false;
	// [2026-09 SSS] 三张缓冲每帧都会被 DeferredLight / 两趟模糊完全覆盖，无需清除
	const bool	colortex18Clear				= false;
	const bool	colortex19Clear				= false;
	const bool	colortex20Clear				= false;

	const vec4	colortex6ClearColor			= vec4(0.0, 0.0, 0.0, 1.0);

	const float shadowIntervalSize 			= 2.0;
	const float ambientOcclusionLevel 		= 0.0;
	const float	sunPathRotation				= -35.0; // [-90.0 -89.0 -88.0 -87.0 -86.0 -85.0 -84.0 -83.0 -82.0 -81.0 -80.0 -79.0 -78.0 -77.0 -76.0 -75.0 -74.0 -73.0 -72.0 -71.0 -70.0 -69.0 -68.0 -67.0 -66.0 -65.0 -64.0 -63.0 -62.0 -61.0 -60.0 -59.0 -58.0 -57.0 -56.0 -55.0 -54.0 -53.0 -52.0 -51.0 -50.0 -49.0 -48.0 -47.0 -46.0 -45.0 -44.0 -43.0 -42.0 -41.0 -40.0 -39.0 -38.0 -37.0 -36.0 -35.0 -34.0 -33.0 -32.0 -31.0 -30.0 -29.0 -28.0 -27.0 -26.0 -25.0 -24.0 -23.0 -22.0 -21.0 -20.0 -19.0 -18.0 -17.0 -16.0 -15.0 -14.0 -13.0 -12.0 -11.0 -10.0 -9.0 -8.0 -7.0 -6.0 -5.0 -4.0 -3.0 -2.0 -1.0 0.0 1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0 13.0 14.0 15.0 16.0 17.0 18.0 19.0 20.0 21.0 22.0 23.0 24.0 25.0 26.0 27.0 28.0 29.0 30.0 31.0 32.0 33.0 34.0 35.0 36.0 37.0 38.0 39.0 40.0 41.0 42.0 43.0 44.0 45.0 46.0 47.0 48.0 49.0 50.0 51.0 52.0 53.0 54.0 55.0 56.0 57.0 58.0 59.0 60.0 61.0 62.0 63.0 64.0 65.0 66.0 67.0 68.0 69.0 70.0 71.0 72.0 73.0 74.0 75.0 76.0 77.0 78.0 79.0 80.0 81.0 82.0 83.0 84.0 85.0 86.0 87.0 88.0 89.0 90.0]
	const float eyeBrightnessHalflife 		= 10.0;

	const float wetnessHalflife				= 16.0;
	const float drynessHalflife				= 16.0;

	const bool 	shadowHardwareFiltering1 	= true;

--------------------------------------------------------------------------------

	- Buffer Table -

	|   Buffer		|   Format          |   Resolution	|   Usage
	|———————————————|———————————————————|———————————————|———————————————————————————
	|	colortex0	|   rgba16f  		|	Full res  	|	Scene data
	|	colortex1	|   rgba16f		    |	Full res  	|	Scene history
	|	colortex2	|   rgba16f         |	Half res	|	Indirect diffuse lighting history
	|	colortex3	|   rgba16f         |	Full res  	|	Indirect diffuse lighting -> Indirect specular lighting -> Motion vector
	|	colortex4	|   r11f_g11f_b10f  |	Full res  	|	Reprojected scene history -> Bloom tiles
	|	colortex5	|   rgba16f  		|	256, 256   	|	Sky environment map
	|	colortex6	|   rgba8           |	Full res  	|	Solid albedo, rain alpha
	|	colortex7	|   rgba16ui        |	Full res  	|	Material data
	|	colortex8	|   rgba16_snorm    |	Full res  	|	Normal data
	|	colortex9	|   rgba16f     	|	Full res	|	Cloud history
	|	colortex10	|   RG16F           |	Full res	|	Hurt timer/ripple phase
	|	colortex12	|   rg16          	|	Full res	|	Water data
	|	colortex13	|   r8i	        	|	Full res  	|	Cloud frame index
	|	colortex14	|   rgba16f         |	Half res	|	Encoded normal, linear depth, disocclusion(a)
	|	colortex15	|   rgba16f		    |	Full res  	|	DoF gather scratch (Prepare CoC data -> Gather filtered color); old voxel GI use was dead
	|	colortex18	|   rgba16f			|	Half res	|	SSS source (rgb = source x mask, a = mask), written by DeferredLight
	|	colortex19	|   rgba16f			|	Half res	|	SSS horizontal blur result
	|	colortex20	|   rgba16f			|	Half res	|	SSS vertical blur result (consumed by IntegrateScene)

--------------------------------------------------------------------------------
*/