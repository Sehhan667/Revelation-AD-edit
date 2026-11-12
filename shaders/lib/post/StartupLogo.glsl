/*
--------------------------------------------------------------------------------
    Revelation Shaders
    - 启动 Logo：矢量（解析式）绘制 -

    为什么不用位图：位图放到全屏会被硬拉伸，边缘全是方块。
    这里改成**解析式矢量绘制**：字形由「直线多边形的距离场」构成，
    配合 fwidth 做抗锯齿，任何屏幕分辨率下边缘都是干净的 1px 过渡。

    字形 = ZV 组合标志，由**两个互不相连的笔画多边形**拼成（Z 的主体 + V 的主体）。
    轮廓是从干净原图逐像素描出来的（marching squares -> Douglas–Peucker ->
    顶点稳定化），栅格化回原图复验 IoU ≈ 0.995，误差集中在抗锯齿边缘的亚像素上。

    工具链（都在 rdc_analysis/，属于开发脚本，打包时不需要）：
        node rdc_analysis/marching_trace.js --tol=0.4   # 描轮廓 + 自校验
        node rdc_analysis/stabilize_trace.js            # 顶点稳定化（自动合并假拐点）
        node rdc_analysis/gen_logo_path.js              # 把顶点表写进本文件
        node rdc_analysis/make_logo_preview.js          # 生成 1:1 网页预览
        node rdc_analysis/make_logo_gameview.js         # 生成实机尺寸预览
--------------------------------------------------------------------------------


    Added for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
    Copyright 2026 AnotherCream.
*/

#ifndef INCLUDE_STARTUP_LOGO
#define INCLUDE_STARTUP_LOGO

//======// 配置 //================================================================================//

// 主字形高度（屏幕高度比例）
#ifndef LOGO_HEIGHT
    #define LOGO_HEIGHT 0.22
#endif
// 整体上下微调（负值向上），屏幕高度比例。
// 内容按"主字形 + 间距 + 一行字"的总高居中，这里再补一点视觉修正。
// 值取 -0.02：字号从 40 提到 52 后内容块变高，纯居中会把整块压低约 34px，
// 用这个偏移把重心提回来。
#ifndef LOGO_OFFSET_Y
    #define LOGO_OFFSET_Y -0.02
#endif

// 屏幕上/下翻转。
// 设计框的 y 是**向下**为正（与源图一致），而片元坐标 (gl_FragCoord) 的 y 是**向上**为正，
// 两者差一个符号。这里统一在设计框坐标里翻一次，主字形和下面那行字会一起翻，
// 相对位置不会乱。（之前漏了这一步，实机里整个 logo 是倒的。）
// 1 = 翻转（当前实机需要），0 = 不翻转。
#ifndef LOGO_FLIP_Y
    #define LOGO_FLIP_Y 1
#endif

// [2026-10-08 改成"简单的淡入淡出"] 启动 logo 现在整幅（主字形 + 文字）一起淡入、保持、一起淡出，
// 不再逐笔描画。做法是把下面两个"描画类"动画的时长置 0：
//   - LOGO_MARK_DRAW_FRAMES = 0 ⇒ markProgress = 1.0 ⇒ StartupLogoMask 直接返回完整覆盖率
//     （RenderStartupMark 的 sweep 是 mix(-0.02, vMax+0.02, progress)，progress=1 时扫掠线
//      已在最远端之外，等于整幅都画好了）；
//   - LOGO_AD_FADE_FRAMES = 0 ⇒ 文字不单独淡入（与主字形同相）。
// 时间轴改由 Final.frag 的两条淡入淡出常量控制（LOGO_FADE_IN_FRAMES / LOGO_FADE_OUT_FRAMES）。
// 想把逐笔描画调回来：LOGO_MARK_DRAW_FRAMES 设回 48.0、LOGO_AD_FADE_FRAMES 设回 30.0 即可
// （配 rdc_analysis/make_logo_gameview.js --frame=N 预览）。
#ifndef LOGO_MARK_DRAW_FRAMES
    #define LOGO_MARK_DRAW_FRAMES 0.0     // 0 = 不做逐笔描画（整幅一起淡入）；48 = 旧行为
#endif
#ifndef LOGO_AD_START_FRAME
    #define LOGO_AD_START_FRAME 0.0
#endif
#ifndef LOGO_AD_FADE_FRAMES
    #define LOGO_AD_FADE_FRAMES 0.0       // 0 = 文字不单独淡入（整幅一起）；30 = 旧行为
#endif

// [2026-10-09 按需求恢复字母] 启动 logo = 主字形（ZV 标志）+ 正下方的 "AD Edit"。
// 置 0 即回到 2026-10-08 那版"只画主字形"：字形表 AD_STROKES 与 RenderStartupText 都还在。
// 打开后 contentH 会多出"间距 + 文字墨迹高"（LOGO_AD_INK_H 那个 16.7% 的圆角下探），
// 居中与包围盒早退都跟着变（见 StartupLogoMask）——这也是当初文字底部被裁的原因。
#ifndef LOGO_SHOW_TEXT
    #define LOGO_SHOW_TEXT 1
#endif

// 字形墨迹的真实下边界（单位 = LOGO_AD_H 的倍数）：AD_STROKES 里最大 y = 1.1667，
// 即圆角底部**越过基线 16.7%**（字形空间约定 y=0 大写顶、y=1 基线）。
// 总高与包围盒必须按它算，否则字底会被裁 —— 2026-10-08 用户实测"AD Edit 底部缺了一点"
// 就是这个（当时 contentH 只算到基线），叠加之后包围盒余量只有 3px 又切掉几像素。
#define LOGO_AD_INK_H 1.1667

// 整体淡入 / 淡出时长（帧）。总时长是 LOGO_DURATION_FRAMES（240）：
// 淡出起点 = logoDuration - LOGO_FADE_OUT_FRAMES，所以两者之和必须小于 240
// 才有保持段（32 + 80 = 112 < 240，保持 128 帧）。
// [2026-11-11] 总时长 180 -> 240（+1s @60fps），淡入/淡出按 4/3 等比加长，
// 保持段与淡出的比例不变。
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

#ifndef LOGO_FADE_IN_FRAMES
    #define LOGO_FADE_IN_FRAMES 32.0      // 淡入 0.53s @60fps
#endif
#ifndef LOGO_FADE_OUT_FRAMES
    #define LOGO_FADE_OUT_FRAMES 80.0     // 淡出 1.33s @60fps
#endif

// 绘制速度曲线：先快后慢。
// 进度 p 走的是这条缓动：p = 1 - (1 - t)^LOGO_DRAW_EASE，t 是线性时间 0..1。
//   LOGO_DRAW_EASE = 1.0  线性（匀速）
//   LOGO_DRAW_EASE = 2.0  开头快、结尾慢（默认）
//   LOGO_DRAW_EASE = 3.0  更"急刹"
// 注意它只影响"多久画到哪"，不改变总时长和终点（t=1 时 p 仍是 1）。
#ifndef LOGO_DRAW_EASE
    #define LOGO_DRAW_EASE 2.0
#endif

//======// 面板：毛玻璃背板 ======================================================================//
// [2026-11-11] 启动 logo 背后加一块矩形毛玻璃：区域内是重度模糊后的当前画面，
// 区域外保持原样，边界轻微软化。
// [2026-11-11 v2] 单 pass 的 64 tap 核在实机里糊得不够，改成 ROI 局限的
// 1/8 降采样 + 可分离高斯（三个 composite32/33/34 计算 pass，见
// program/post/StartupPanelBlur.comp）。这里只放几何与外观常量，方便一次调到位。
//
// 形状是**直角矩形**（不做圆角）；四条边只做几像素的软化带，避免锯齿硬边，
// 不构成可见倒角。所以没有圆角半径这个常量。
//
// 尺寸：内边距 = 内容高的比例，四边等距 ⇒ 视觉上托住 logo。
// 不按宽高分别加，否则宽屏/窄屏留白不均。
// [2026-11-12 放大一圈] 0.28 -> 0.38：1080p 下内边距 92px -> 124px，面板 687x510 -> 752x576，
// 占屏高 47% -> 53%。再放大就接近「整屏卡片」，所以先给这一档；只想微调就改这个数，
// 边长增长 = 2 x 内边距 = 2 x 内容高 x 这个值，0.01 约等于每边 3px（1080p）。
// 注意：内边距同时决定模糊半径的口径（sigma = 面板高 x LOGO_PANEL_BLUR_SIGMA_FRAC），
// 面板变大 ⇒ 模糊等比变大，观感（「糊的程度」）不变，这是有意的。
#ifndef LOGO_PANEL_PAD
    #define LOGO_PANEL_PAD 0.38
#endif
// 边界软化半宽（像素，1080p 基准，随分辨率等比）。8px：比 1px 抗锯齿明显柔和，
// 又远小于模糊半径，不会让面板边缘看起来化开。
#ifndef LOGO_PANEL_FEATHER
    #define LOGO_PANEL_FEATHER 8.0
#endif
// ---- 模糊链：1/8 降采样 + 可分离高斯 ----
// 降采样倍率是三处共用的口径：本文件（区块尺寸 / sigma 折算）、
// StartupPanelBlur.comp 的 workGroupsRender（那里是字面量 0.125，
// 因为 Iris 只认源码里的字面量）、以及 Final 采样时的 UV 缩放。
// 缓冲本身**不缩放**（不用 size.buffer）：1/8 结果写在全分辨率缓冲的左上角区块里，
// 原因见 StartupPanelBlur.comp 文件头的 v8 说明。
#define LOGO_PANEL_BLUR_DOWNSCALE 8.0
#define LOGO_PANEL_BLUR_INV (1.0 / LOGO_PANEL_BLUR_DOWNSCALE)
// 高斯 sigma = 面板高度 x 这个比例（面板块高度，跟分辨率无关）。
// 0.11：1080p 面板高约 510px ⇒ sigma ≈ 56px，核的可见范围约 ±140px（面板高的 27%）。
// 观感上树叶/草地/栅栏会糊成只剩极低频色块，属于重度毛玻璃。
#ifndef LOGO_PANEL_BLUR_SIGMA_FRAC
    #define LOGO_PANEL_BLUR_SIGMA_FRAC 0.11
#endif
// sigma 的上下限（单位 = 1/8 缓冲的纹素）。上限防止 4K/8K 下 tap 数爆掉，
// 下限保证极小分辨率下面板也不会变回轻微模糊。
#ifndef LOGO_PANEL_BLUR_MIN_SIGMA
    #define LOGO_PANEL_BLUR_MIN_SIGMA 1.0
#endif
#ifndef LOGO_PANEL_BLUR_MAX_SIGMA
    #define LOGO_PANEL_BLUR_MAX_SIGMA 10.0
#endif
// 单侧 tap 上限（总 tap = 2*TAPS-1）。截断在 2.5 sigma：够到 +-2.5 sigma 时
// 残余权重 < 1.2%，肉眼看不出截断；上限 40 对应 sigma 16（8K 也够）。
#ifndef LOGO_PANEL_BLUR_MAX_TAPS
    #define LOGO_PANEL_BLUR_MAX_TAPS 40
#endif

// [2026-11-11 v6] 外观层全部撤掉，只保留纯模糊。
// 不再有雾面白、tint、亮度层、去饱和、加性提亮、渐变、颗粒、边缘高光，
// 也不再有背景全黑时的回退色 —— 所以这里没有对应的外观常量，
// 避免留一堆不起作用的层。需要再做玻璃质感时，从 Git 历史取 v5 的实现，
// 不要在 Final 里随手加常量。

// [2026-11-11 v7] 面板唯一的显示层旋钮：整体增益，作用在 Final 已乘过曝光、
// 已走完 gamma 尾巴（sqrt）的显示空间值上，不参与调色、不改变色相。
// 1.0 = 中性（与面板外相邻区域同量级），略大于 1 是允许的小幅提亮。
// 想更亮就调这个，不要回去加雾面层/亮度层。
#ifndef LOGO_PANEL_LIFT
    #define LOGO_PANEL_LIFT 1.0
#endif

// 启动画面（logo + 面板）总时长（帧）。240 帧 = 4s @60fps（原来是 180 = 3s）。
// 帧率不同则实际秒数不同（50fps 下 4.8s），与原实现同一口径：按帧计数，不引入时间驱动。
// 模糊链的三个 pass 也用这个常量做运行期门控（>= 就不干活）。
#ifndef LOGO_DURATION_FRAMES
    #define LOGO_DURATION_FRAMES 240
#endif

//======// 几何（设计框坐标，源像素）=============================================================//
// 设计框 = 主字形实测包围盒，宽高由轮廓工具给出。
#define LOGO_BOX_W    600.45
#define LOGO_BOX_H    283.29

// "AD Edit"：放在主字形正下方居中
// LOGO_AD_GAP 是设计框坐标（y 向下为正）里文字基线到大写底的距离，所以调大就是把字往下推。
#define LOGO_AD_GAP   46.0      // 与主字形底边的间距（源像素）
#define LOGO_AD_H     52.0      // 字号（源像素，即大写高）
// 笔画宽度（源像素）。
// 主字形虽然单条笔画窄，但墨迹面积大；这行小字太细就撑不住、屏幕上发灰。
// 演进：1.6（太细）-> 2.0（还是偏细）-> 2.8。屏幕上约 2.3px。
// 字距不在这里调：每个字形在生成时就按自己的墨迹宽度居中到一个固定宽的格子里，
// 步进值写在 AD_ADVANCE 里（见 gen_ad_font.js 的 LETTER_ADV / SPACE_W）。
#define LOGO_AD_STROKE   2.8

// 主字形轮廓：两个多边形的并集。
// 顶点是**归一化坐标**（相对字形中心，x 右 / y 下，两轴都按各自方向归一化到 [-0.5, 0.5]）。
// 顶点表的顺序与原图轮廓一致，渲染时用「射线法判内外 + 最短距离」求有符号距离。
#define LOGO_POLY_COUNT 2
#define LOGO_POLY0_COUNT 10
#define LOGO_POLY1_COUNT 18

const vec2 LOGO_POLY0[10] = vec2[10](
    vec2(-0.49450, -0.49566),
    vec2(-0.43311, -0.34740),
    vec2(-0.42968, -0.34319),
    vec2(-0.15377, -0.34034),
    vec2(-0.50000,  0.49626),
    vec2(-0.49963,  0.49984),
    vec2(-0.37139,  0.49968),
    vec2(-0.36784,  0.49626),
    vec2( 0.04187, -0.49919),
    vec2(-0.49297, -0.50000)
);

const vec2 LOGO_POLY1[18] = vec2[18](
    vec2(-0.03998, -0.15816),
    vec2(-0.30926,  0.49626),
    vec2(-0.30836,  0.49979),
    vec2( 0.03996,  0.50000),
    vec2( 0.04028,  0.49626),
    vec2(-0.02499,  0.33999),
    vec2(-0.11283,  0.33741),
    vec2(-0.04164,  0.16287),
    vec2(-0.03954,  0.16444),
    vec2( 0.09825,  0.49833),
    vec2( 0.09992,  0.50000),
    vec2( 0.22982,  0.49955),
    vec2( 0.23534,  0.48920),
    vec2( 0.50000, -0.15325),
    vec2( 0.49962, -0.15791),
    vec2( 0.37638, -0.15729),
    vec2( 0.16820,  0.34322),
    vec2(-0.03831, -0.15697)
);









//======// 文字字模：AD Edit（Hershey 单线字体）==================================================//
// 字形来自 Hershey 单线（1-stroke）矢量字体，公有领域。选它的原因：它本身就是"每笔画一条折线"，
// 和这里"线段距离场 + 圆头端点"的渲染方式完全对得上，不需要引入贝塞尔曲线。
//
// 坐标：字形局部空间，x 向右、**y 向下**（与设计框一致，此处不再翻 y）。
//   x=0 是格子左边，y=0 是大写顶，y=1 是大写底（基线），下伸部到约 1.5。
// 每段 = (ax, ay, bx, by)。长度为零的段不产生像素。
//
// 排版：每个字形已经按**自己的墨迹宽度**左对齐并居中到一个固定宽的格子里
// （AD_ADVANCE），所以 shader 只要按 AD_ADVANCE 步进就行，不用管字体自带的 o
// —— 那个对部分字形是偏的，而且字形自带负左边距，直接用会让字母叠在一起。
//
// 表由 rdc_analysis/gen_ad_font.js 生成，不要手改：
//     node rdc_analysis/gen_ad_font.js --text "AD Edit"
// 字形下标写在那个脚本的 GLYPH_INDEX 里（这份字体的下标不能按 ascii 推算），
// 改字符前用 rdc_analysis/sheet_table.js 渲染出来核对。
#define AD_GLYPH_COUNT 7
#define AD_GLYPH_SLOTS 16
const vec4 AD_STROKES[112] = vec4[112](
    // "A"
    vec4(0.4900, 0.0000, 0.0456, 1.1667),
    vec4(0.4900, 0.0000, 0.9344, 1.1667),
    vec4(0.2122, 0.7778, 0.7678, 0.7778),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    // "D"
    vec4(0.8233, 0.0000, 0.8233, 1.1667),
    vec4(0.8233, 0.5556, 0.7122, 0.4444),
    vec4(0.7122, 0.4444, 0.6011, 0.3889),
    vec4(0.6011, 0.3889, 0.4344, 0.3889),
    vec4(0.4344, 0.3889, 0.3233, 0.4444),
    vec4(0.3233, 0.4444, 0.2122, 0.5556),
    vec4(0.2122, 0.5556, 0.1567, 0.7222),
    vec4(0.1567, 0.7222, 0.1567, 0.8333),
    vec4(0.1567, 0.8333, 0.2122, 1.0000),
    vec4(0.2122, 1.0000, 0.3233, 1.1111),
    vec4(0.3233, 1.1111, 0.4344, 1.1667),
    vec4(0.4344, 1.1667, 0.6011, 1.1667),
    vec4(0.6011, 1.1667, 0.7122, 1.1111),
    vec4(0.7122, 1.1111, 0.8233, 1.0000),
    vec4(0.0),
    vec4(0.0),
    // " "
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    // "E"
    vec4(0.1289, 0.0000, 0.1289, 1.1667),
    vec4(0.1289, 0.0000, 0.8511, 0.0000),
    vec4(0.1289, 0.5556, 0.5733, 0.5556),
    vec4(0.1289, 1.1667, 0.8511, 1.1667),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    // "d"
    vec4(0.8233, 0.0000, 0.8233, 1.1667),
    vec4(0.8233, 0.5556, 0.7122, 0.4444),
    vec4(0.7122, 0.4444, 0.6011, 0.3889),
    vec4(0.6011, 0.3889, 0.4344, 0.3889),
    vec4(0.4344, 0.3889, 0.3233, 0.4444),
    vec4(0.3233, 0.4444, 0.2122, 0.5556),
    vec4(0.2122, 0.5556, 0.1567, 0.7222),
    vec4(0.1567, 0.7222, 0.1567, 0.8333),
    vec4(0.1567, 0.8333, 0.2122, 1.0000),
    vec4(0.2122, 1.0000, 0.3233, 1.1111),
    vec4(0.3233, 1.1111, 0.4344, 1.1667),
    vec4(0.4344, 1.1667, 0.6011, 1.1667),
    vec4(0.6011, 1.1667, 0.7122, 1.1111),
    vec4(0.7122, 1.1111, 0.8233, 1.0000),
    vec4(0.0),
    vec4(0.0),
    // "i"
    vec4(0.4344, 0.0000, 0.4900, 0.0556),
    vec4(0.4900, 0.0556, 0.5456, 0.0000),
    vec4(0.5456, 0.0000, 0.4900, -0.0556),
    vec4(0.4900, -0.0556, 0.4344, 0.0000),
    vec4(0.4900, 0.3889, 0.4900, 1.1667),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    // "t"
    vec4(0.4344, 0.0000, 0.4344, 0.9444),
    vec4(0.4344, 0.9444, 0.4900, 1.1111),
    vec4(0.4900, 1.1111, 0.6011, 1.1667),
    vec4(0.6011, 1.1667, 0.7122, 1.1667),
    vec4(0.2678, 0.3889, 0.6567, 0.3889),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0),
    vec4(0.0)
);

// 每格的步进宽度（× 大写高），已含左右留白
const float AD_ADVANCE[7] = float[7](
    0.9800,
    0.9800,
    0.5200,
    0.9800,
    0.9800,
    0.9800,
    0.9800
);

//======// SDF 工具 //============================================================================//

float RWSegDist(in vec2 p, in vec2 a, in vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
    return length(pa - ba * h);
}

// dist/halfWidth 的单位必须一致；aa 传 fwidth(dist) 即可（自动带上坐标缩放）
float RWCoverage(in float dist, in float halfWidth, in float aa) {
    return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, dist);
}

// 绘制进度缓动：先快后慢。
// t 是线性时间 0..1，返回"画到哪" 0..1。LOGO_DRAW_EASE=1 时为线性。
// 曲线 p = 1 - (1-t)^k 的两个端点都是精确值（t=0→0，t=1→1），
// 所以不会出现"画不满"（之前扫掠区间写错就吃过这个亏）。
float RWDrawEase(in float t) {
    float x = clamp(t, 0.0, 1.0);
    return 1.0 - pow(1.0 - x, LOGO_DRAW_EASE);
}

// 多边形的一条边对「最短距离」与「内外判定」的贡献。
// 距离用平方值累加（省一次开方），最后统一开方。
void RWPolyEdge(in vec2 q, in vec2 a, in vec2 b, inout float minSq, inout bool inside) {
    vec2 e = b - a;
    vec2 w = q - a;
    vec2 b2 = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    minSq = min(minSq, dot(b2, b2));

    // 射线法：边跨越 q.y 且交点在右侧就翻转内外
    if ((q.y < a.y) != (q.y < b.y)) {
        float xInt = a.x + (q.y - a.y) / (b.y - a.y) * (b.x - a.x);
        if (q.x < xInt) inside = !inside;
    }
}

//======// 主字形：ZV 标志 =======================================================================//
// p        设计框内坐标（源像素，原点 = 设计框左上角）
// progress 0 = 没开始画，1 = 画完
//
// 形状 = 两个多边形的**并集**。并集的有符号距离：
//   - 到边界的最短欧氏距离取所有边的 min；
//   - 内部判定取所有多边形的异或（两个多边形不相交，等价于并集）。
//
// [2026-10-08 性能] 距离改在**源像素的各向同性空间**里算，抗锯齿宽度改解析值：
//   · 顶点表 LOGO_POLY* 本来就是"源像素轮廓 ÷(W,H) − 0.5"归一化来的，这里乘回去
//     ((v + 0.5) * (W,H)) 就精确还原轮廓 —— 形状逐点等价，但距离变回真正的欧氏距离；
//   · 于是 AA 半宽可以直接算：半个屏幕像素 = 0.5 / pxPerUnit（源像素单位）。
//   原实现是 `fwidth(signedD * LOGO_BOX_H) * 0.5`：每像素一次导数，而且**会挡住包围盒早退**
//   —— 早退后 quad 内其它 lane 没执行，导数未定义，盒子边缘会渗出半亮细线。
//   去掉 fwidth 之后整套 logo 计算与屏幕导数无关，早退/跳格才是安全的。
float RenderStartupMark(in vec2 p, in float progress, in float pxPerUnit) {
    vec2 scale = vec2(LOGO_BOX_W, LOGO_BOX_H);

    float minSq = 1e9;
    bool inside = false;

    for (int i = 0; i < LOGO_POLY0_COUNT; i++) {
        RWPolyEdge(p, (LOGO_POLY0[i] + 0.5) * scale,
                      (LOGO_POLY0[(i + 1) % LOGO_POLY0_COUNT] + 0.5) * scale, minSq, inside);
    }
    for (int i = 0; i < LOGO_POLY1_COUNT; i++) {
        RWPolyEdge(p, (LOGO_POLY1[i] + 0.5) * scale,
                      (LOGO_POLY1[(i + 1) % LOGO_POLY1_COUNT] + 0.5) * scale, minSq, inside);
    }

    float d = sqrt(minSq);
    float signedD = inside ? -d : d;

    float aa = 0.5 / pxPerUnit + 1e-6;      // 半个屏幕像素，源像素单位
    float cov = 1.0 - smoothstep(-aa, aa, signedD);

    // ---- 绘制动画：沿斜向（v = x + y）自上而下把字形扫出来 ----
    // 用斜向而不是竖直，是为了贴合标志本身的剪切方向（每个笔画的起笔都在左上）。
    // 前沿带一点点宽度，看起来像"正在被画出来"而不是被硬切一刀。
    //
    // 注意方向：v 越小越靠左上，所以"从上往下画"= 让**未被扫到的部分隐藏**，
    // 即要求 v <= 扫掠线，于是用 1 - smoothstep(v) 的形式。
    // 另外 v 的实际范围是 0 .. (W+H)/W，这两端必须由 W/H 算出来，**不能写死数字**。
    float v = (p.x + p.y) / LOGO_BOX_W;
    float vMax = (LOGO_BOX_W + LOGO_BOX_H) / LOGO_BOX_W;
    float sweep = mix(-0.02, vMax + 0.02, progress);
    cov *= 1.0 - smoothstep(sweep - 0.012, sweep + 0.012, v);
    return cov;
}

//======// 文字：AD Edit ========================================================================//
// p        设计框内坐标（源像素）
// opacity  整体不透明度 0..1（整行一起淡入，不做逐段描画）
//
// 字形来自 Hershey 单线字体（见上面的 AD_STROKES）。字形局部空间里
//   x=0 格子左边、y=0 大写顶、y=1 基线，所以：
//     屏幕位置 = (origin + glyph 局部坐标 * LOGO_AD_H)
//   步进用每格自己的 AD_ADVANCE（生成时已按墨迹宽度居中，见 gen_ad_font.js）。
//
// 这里**不**做逐段描画：整行同时淡入，由调用方传 opacity。
// （之前是每个字形、每段按序号依次长出来，和主字形的扫掠叠在一起显得很碎。）
float RenderStartupText(in vec2 p, in float opacity, in float pxPerUnit) {
    if (opacity <= 0.0) return 0.0;

    // 笔画半宽直接由 LOGO_AD_STROKE 决定（源像素），不用"字号的比例"——
    // 那样一改字号粗细就跟着变，容易和主字形的笔画对不上。
    const float halfPx = LOGO_AD_STROKE * 0.5;
    // [2026-10-08 性能] AA 半宽解析值 = 半个屏幕像素（源像素单位）。
    // 原实现 `fwidth(d) * 0.5` 是在**内层循环里、还带着 continue** 求导：每像素 112 次导数，
    // 既慢又是规范上的未定义行为。d 本来就以源像素为单位，所以直接算即可（缩放均匀，两者等价）。
    float aaT = 0.5 / pxPerUnit + 1e-6;
    float padT = halfPx + 2.0 / pxPerUnit;    // 早退余量：笔画半宽 + 2 个屏幕像素

    // 先按各格字距算出总宽，用来做整体居中
    float totalAdvance = 0.0;
    for (int g = 0; g < AD_GLYPH_COUNT; g++) totalAdvance += AD_ADVANCE[g];
    float totalW = totalAdvance * LOGO_AD_H;

    float penX = LOGO_BOX_W * 0.5 - totalW * 0.5;
    float y0 = LOGO_BOX_H + LOGO_AD_GAP;

    // [2026-10-08 性能] 这一行字只占一条横带；带外像素（也就是主字形那一大片）直接返回。
    // 下边界用 LOGO_AD_INK_H 而不是 1.0：圆角底部越过基线 16.7%，按 1.0 会把它切掉。
    // 去掉 fwidth 之后这里的 return 不再牵涉导数，安全。
    if (p.y < y0 - padT || p.y > y0 + LOGO_AD_INK_H * LOGO_AD_H + padT) return 0.0;

    float cov = 0.0;
    for (int g = 0; g < AD_GLYPH_COUNT; g++) {
        vec2 origin = vec2(penX, y0);
        float gw = AD_ADVANCE[g] * LOGO_AD_H;
        // [2026-10-08 性能] 逐字形横向早退：本像素不在该格的 x 区间（含余量）内就整格跳过
        bool gHit = (p.x >= penX - padT) && (p.x <= penX + gw + padT);
        penX += gw;
        if (!gHit) continue;

        for (int s = 0; s < AD_GLYPH_SLOTS; s++) {
            vec4 st = AD_STROKES[g * AD_GLYPH_SLOTS + s];
            vec2 a = st.xy, b = st.zw;
            if (length(b - a) < 1e-4) continue;

            vec2 pa = origin + a * LOGO_AD_H;
            vec2 pb = origin + b * LOGO_AD_H;

            float d = RWSegDist(p, pa, pb);
            cov = max(cov, RWCoverage(d, halfPx, aaT));
        }
    }
    return cov * opacity;
}

//======// 合成入口 =============================================================================//
// logo 内容（主字形 + 可选的一行字）在屏幕上的布局：
// origin 左上角像素坐标，size 像素尺寸，contentH 设计框高度（翻 y 用）。
// 面板与字形共用这一份布局 ⇒ 两者永远同心，改 LOGO_OFFSET_Y / LOGO_SHOW_TEXT 时不会错位。
void StartupLogoLayout(in vec2 viewSize, out vec2 origin, out vec2 size, out float contentH) {
    // 每源像素对应多少屏幕像素（主字形与文字共用同一个缩放，保证相对大小不变）
    float pxPerUnit = LOGO_HEIGHT * viewSize.y / LOGO_BOX_H;

    // 完整内容：主字形 + 间距 + 一行字（含基线以下 16.7% 的圆角墨迹，见 LOGO_AD_INK_H）
    #if LOGO_SHOW_TEXT
        contentH = LOGO_BOX_H + LOGO_AD_GAP + LOGO_AD_INK_H * LOGO_AD_H;
    #else
        contentH = LOGO_BOX_H;      // 只剩主字形：设计框高就是总高（居中也跟着变）
    #endif
    size = vec2(LOGO_BOX_W, contentH) * pxPerUnit;
    origin = (viewSize - size) * 0.5;
    origin.y += LOGO_OFFSET_Y * viewSize.y;
}

// 面板的全分辨率像素尺寸（宽, 高）。模糊链用它把 sigma 折算成面板高的百分比，
// 与分辨率、宽高比都无关；Final 与 compute pass 共用，避免两处各算一套。
vec2 StartupLogoPanelSize(in vec2 viewSize) {
    vec2 origin, size;
    float contentH;
    StartupLogoLayout(viewSize, origin, size, contentH);
    // 四边等距内边距：内边距 = 内容高 x LOGO_PANEL_PAD（不按各轴自身尺寸缩放，否则宽度会偏大）
    float pad = size.y * LOGO_PANEL_PAD;
    return size + 2.0 * pad;
}

// 模糊链区块（「象限画布」）的像素尺寸 = 屏幕 x 1/8，只有整数个纹素。
// 两个消费方共用同一份口径：compute 用它做画布边界（缓冲是全分辨率，imageSize 是整屏），
// Final 用它把采样 clamp 在画布内（画布右/下 1~2 个纹素不属于画布，双线性会带进来）。
vec2 StartupLogoPanelTileSize(in vec2 viewSize) {
    return vec2(ivec2(viewSize * LOGO_PANEL_BLUR_INV));
}

// 毛玻璃面板覆盖率：直角矩形有符号距离场。1 = 完全在面板内，0 = 完全在外，
// 边界在 ±feather 像素内平滑过渡（见 LOGO_PANEL_FEATHER）。
// 与 logo 同心，四边内边距相同（都是 size.y * LOGO_PANEL_PAD）。
// 矩形 SDF 单独抽出来：覆盖率（向外羽化）与边缘折光（向内 1~2px）共用同一份几何。
float StartupLogoPanelSDF(in vec2 screenUV, in vec2 viewSize) {
    vec2 origin, size;
    float contentH;
    StartupLogoLayout(viewSize, origin, size, contentH);

    vec2 halfSize = StartupLogoPanelSize(viewSize) * 0.5;
    vec2 center = origin + size * 0.5;

    // 矩形的 SDF：内部为负、外部为正，角落不参与任何倒角
    vec2 q = abs(screenUV * viewSize - center) - halfSize;
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
}

float StartupLogoPanelMask(in vec2 screenUV, in vec2 viewSize) {
    // 软化宽度随分辨率等比：1080p 下就是常量本身，4K 下自动变宽，不会退化成硬像素线
    float featherPx = LOGO_PANEL_FEATHER * viewSize.y * rcp(1080.0);
    return 1.0 - smoothstep(-featherPx, featherPx, StartupLogoPanelSDF(screenUV, viewSize));
}

// screenUV  0..1 的屏幕坐标（左上为原点）
// viewSize  屏幕像素尺寸
// frame     自加载起的帧数
// 返回 { 覆盖率, 亮度 }，由调用方做淡出与混色。
vec2 StartupLogoMask(in vec2 screenUV, in vec2 viewSize, in float frame) {
    // 每源像素对应多少屏幕像素（主字形与文字共用同一个缩放，保证相对大小不变）
    float pxPerUnit = LOGO_HEIGHT * viewSize.y / LOGO_BOX_H;

    vec2 boxOrigin, boxSize;
    float contentH;
    StartupLogoLayout(viewSize, boxOrigin, boxSize, contentH);

    vec2 p = (screenUV * viewSize - boxOrigin) / pxPerUnit;   // 设计框内坐标（源像素）

    // 统一处理屏幕上下翻转（见 LOGO_FLIP_Y 的说明）。
    // 在这里翻一次，主字形和文字的相对位置就都对了。
    #if LOGO_FLIP_Y
        p.y = contentH - p.y;
    #endif

    // [2026-10-08 性能·主要优化] 整幅内容（主字形 + 间隔 + 一行字）只占屏幕中间一小块：
    // 1080p 下约 504×320 px ≈ 全屏的 7.8%。这里直接返回 ⇒ 省掉 ~92% 像素的
    // （28 次多边形边 + 最多 112 次线段距离）计算（用户实测：logo 在屏上时帧率骤降）。
    // 余量取 3 个屏幕像素：真正的抗锯齿过渡只有半个像素，且主字形设计框就是它的紧包围盒，
    // 余量必须盖住 AA 才能保证盒子边缘不会切到过渡（否则会出现一圈细线）。
    float padU = 3.0 / pxPerUnit;
    if (p.x < -padU || p.x > LOGO_BOX_W + padU || p.y < -padU || p.y > contentH + padU)
        return vec2(0.0, 1.0);

    // ---- 绘制进度 ----
    // 主字形：线性时间 -> 缓动后的"画到哪"（先快后慢，见 RWDrawEase）
    float markProgress = LOGO_MARK_DRAW_FRAMES > 0.0 ? RWDrawEase(frame / LOGO_MARK_DRAW_FRAMES) : 1.0;
    // 文字：整体淡入，和主字形同时开始（LOGO_AD_START_FRAME 默认 0）
    // [2026-10-08] LOGO_SHOW_TEXT = 0 时整段文字（含这条计算）都不参与
    #if LOGO_SHOW_TEXT
        float adOpacity = LOGO_AD_FADE_FRAMES > 0.0 ? saturate((frame - LOGO_AD_START_FRAME) / LOGO_AD_FADE_FRAMES) : 1.0;
    #endif

    float cov = RenderStartupMark(p, markProgress, pxPerUnit);
    #if LOGO_SHOW_TEXT
        cov = max(cov, RenderStartupText(p, adOpacity, pxPerUnit));
    #endif
    return vec2(cov, 1.0);
}

#endif // INCLUDE_STARTUP_LOGO
