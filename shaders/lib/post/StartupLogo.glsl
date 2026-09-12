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

// 逐笔绘制节奏（帧）
// 主字形用 48 帧扫完（约 0.8 秒 @60fps）—— 再长的话开头会有明显的一段空屏。
#ifndef LOGO_MARK_DRAW_FRAMES
    #define LOGO_MARK_DRAW_FRAMES 48.0
#endif
// 文字在主字形画到约 3/4 时接上
// 文字：和主字形**同时**开始，整行一起淡入（不再逐段描画、也不等主字形）
#ifndef LOGO_AD_START_FRAME
    #define LOGO_AD_START_FRAME 0.0
#endif
// 淡入时长（帧）。30 帧 ≈ 0.5 秒 @60fps
#ifndef LOGO_AD_FADE_FRAMES
    #define LOGO_AD_FADE_FRAMES 30.0
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
// 边缘靠 fwidth 抗锯齿。
float RenderStartupMark(in vec2 p, in float progress) {
    // 设计框内坐标 -> 归一化居中坐标
    vec2 q = vec2(p.x / LOGO_BOX_W - 0.5, p.y / LOGO_BOX_H - 0.5);

    float minSq = 1e9;
    bool inside = false;

    for (int i = 0; i < LOGO_POLY0_COUNT; i++) {
        RWPolyEdge(q, LOGO_POLY0[i], LOGO_POLY0[(i + 1) % LOGO_POLY0_COUNT], minSq, inside);
    }
    for (int i = 0; i < LOGO_POLY1_COUNT; i++) {
        RWPolyEdge(q, LOGO_POLY1[i], LOGO_POLY1[(i + 1) % LOGO_POLY1_COUNT], minSq, inside);
    }

    float d = sqrt(minSq);
    float signedD = inside ? -d : d;

    // 归一化坐标里 1 单位 = 设计框高；换回"源像素"尺度做抗锯齿
    float aa = fwidth(signedD * LOGO_BOX_H) * 0.5 + 1e-6;
    float cov = 1.0 - smoothstep(-aa, aa, signedD * LOGO_BOX_H);

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
float RenderStartupText(in vec2 p, in float opacity) {
    if (opacity <= 0.0) return 0.0;

    // 笔画半宽直接由 LOGO_AD_STROKE 决定（源像素），不用"字号的比例"——
    // 那样一改字号粗细就跟着变，容易和主字形的笔画对不上。
    const float halfPx = LOGO_AD_STROKE * 0.5;

    // 先按各格字距算出总宽，用来做整体居中
    float totalAdvance = 0.0;
    for (int g = 0; g < AD_GLYPH_COUNT; g++) totalAdvance += AD_ADVANCE[g];
    float totalW = totalAdvance * LOGO_AD_H;

    float penX = LOGO_BOX_W * 0.5 - totalW * 0.5;
    float y0 = LOGO_BOX_H + LOGO_AD_GAP;

    float cov = 0.0;
    for (int g = 0; g < AD_GLYPH_COUNT; g++) {
        vec2 origin = vec2(penX, y0);
        penX += AD_ADVANCE[g] * LOGO_AD_H;

        for (int s = 0; s < AD_GLYPH_SLOTS; s++) {
            vec4 st = AD_STROKES[g * AD_GLYPH_SLOTS + s];
            vec2 a = st.xy, b = st.zw;
            if (length(b - a) < 1e-4) continue;

            vec2 pa = origin + a * LOGO_AD_H;
            vec2 pb = origin + b * LOGO_AD_H;

            float d = RWSegDist(p, pa, pb);
            cov = max(cov, RWCoverage(d, halfPx, fwidth(d) * 0.5 + 1e-6));
        }
    }
    return cov * opacity;
}

//======// 合成入口 =============================================================================//
// screenUV  0..1 的屏幕坐标（左上为原点）
// viewSize  屏幕像素尺寸
// frame     自加载起的帧数
// 返回 { 覆盖率, 亮度 }，由调用方做淡出与混色。
vec2 StartupLogoMask(in vec2 screenUV, in vec2 viewSize, in float frame) {
    // 每源像素对应多少屏幕像素（主字形与文字共用同一个缩放，保证相对大小不变）
    float pxPerUnit = LOGO_HEIGHT * viewSize.y / LOGO_BOX_H;

    // 完整内容 = 主字形 + 间距 + 一行字，按这个总高做居中
    float contentH = LOGO_BOX_H + LOGO_AD_GAP + LOGO_AD_H;
    vec2 boxSize = vec2(LOGO_BOX_W, contentH) * pxPerUnit;
    vec2 boxOrigin = (viewSize - boxSize) * 0.5;
    boxOrigin.y += LOGO_OFFSET_Y * viewSize.y;

    vec2 p = (screenUV * viewSize - boxOrigin) / pxPerUnit;   // 设计框内坐标（源像素）

    // 统一处理屏幕上下翻转（见 LOGO_FLIP_Y 的说明）。
    // 在这里翻一次，主字形和文字的相对位置就都对了。
    #if LOGO_FLIP_Y
        p.y = contentH - p.y;
    #endif

    // ---- 绘制进度 ----
    // 主字形：线性时间 -> 缓动后的"画到哪"（先快后慢，见 RWDrawEase）
    float markProgress = LOGO_MARK_DRAW_FRAMES > 0.0 ? RWDrawEase(frame / LOGO_MARK_DRAW_FRAMES) : 1.0;
    // 文字：整体淡入，和主字形同时开始（LOGO_AD_START_FRAME 默认 0）
    float adOpacity = LOGO_AD_FADE_FRAMES > 0.0 ? saturate((frame - LOGO_AD_START_FRAME) / LOGO_AD_FADE_FRAMES) : 1.0;

    float cov = RenderStartupMark(p, markProgress);
    cov = max(cov, RenderStartupText(p, adOpacity));
    return vec2(cov, 1.0);
}

#endif // INCLUDE_STARTUP_LOGO
