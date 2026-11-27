/*
 * gen_ad_font.js — 从 Hershey 单线字体里取出 "AD Edit" 需要的 8 个字形，
 * 归一化后生成 GLSL 的顶点/段表，写进 shaders/lib/post/StartupLogo.glsl。
 *
 * 为什么换字体：之前是手写的线段字模，33px 下字母偏硬、D 的"内白"容易被笔画填死。
 * Hershey 是公有领域的**单线（1-stroke）矢量字体**，本身就是"每笔画一条折线"，
 * 和 shader 里"线段距离场 + 圆头"的渲染方式天然契合，不需要贝塞尔。
 *
 * 数据来源：hersheytext.json（npm 包 hersheytext，Hershey 字体本身为公有领域）。
 * 文件名 rdc_analysis/hersheytext.json。
 *
 * 坐标约定：Hershey 原始数据 x 向右、y 向下，基线 y=22，大写高 y=1。
 *   gx = (x - 4) / 18        以左间距边(x=4)为 0，大写高 18 单位归一化
 *   gy = (y - 1) / 18        以大写顶(y=1)为 0，向下为正
 *   advance = o / 18         字距 = 原始 o（含右间距）
 *
 * 注意 y 向下与 shader 设计框一致，所以这里**不要**再翻 y；
 * 整体上下翻转由 StartupLogo.glsl 的屏幕坐标那一处统一处理。
 *
 * 用法：node rdc_analysis/gen_ad_font.js [--font futural] [--text "AD Edit"]
 */
const fs = require('fs');
const path = require('path');

const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return process.argv[i + 1];
        if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
    }
    return d;
};
const PACK = path.resolve(__dirname, '..');
const FONT = argOf('font', 'futural');
const TEXT = argOf('text', 'AD Edit');

const hershey = JSON.parse(fs.readFileSync(path.join(__dirname, 'hersheytext.json'), 'utf8'));
const glyphs = hershey[FONT].chars;
console.log(`字体 ${FONT}（${hershey[FONT].name}），共 ${glyphs.length} 个字符`);

// 解析 "M4,1 L4,22 M4,1 L17,1 ..." -> 若干条折线（每条折线是一串点）
function parsePath(d) {
    const polys = [];
    for (const sub of d.trim().split(/\s*M/).filter(Boolean)) {
        const nums = [...sub.matchAll(/(-?\d+),(-?\d+)/g)].map(m => [+m[1], +m[2]]);
        if (nums.length >= 2) polys.push(nums);
    }
    return polys;
}

const U = 18;          // 归一化单位 = 大写高
const XOFF = 4;        // 原始 x 的左间距
const YOFF = 1;        // 原始 y 的大写顶

// 字符 -> 字体数组下标 + 该字形的期望包围盒（原始单位，用于自动校验）。
//
// **绝不能按 ascii 推算！** 这份 hersheytext.json 的下标与 ascii 差不是常数
// （大写区被 '=' 之类挤偏过，小写区起点也不同；而且同一个字母的"部件"会单独占一个下标，
//  例如 64/66/68 分别是 d/o/e 的"碗"或"点"，67/70 才是完整的 d/i）。
// 之前按 ascii-32 取，屏幕上出来 "ABEgU" 这种乱码。
//
// 这些值由 rdc_analysis/glyph_sheet2.js 生成带下标的字形图、肉眼核对得到。
// 要加新字符：先跑
//     node rdc_analysis/glyph_sheet2.js --px=44
// 在 rdc_analysis/glyph_sheet2.html 里找到字母对应的下标与包围盒，再加进这张表。
//
// 注意：这份字体里没有"无笔画的空格"条目，所有条目都带笔画。
// 所以空格不进段表，改成在排版时直接占一个固定宽度的空白。
const GLYPH_INDEX = {
    'A': { idx: 32, box: [1, 1, 17, 22] },   // 两条腿 + 横杠
    'E': { idx: 36, box: [4, 1, 17, 22] },   // 竖 + 上/中/下三横
    'D': { idx: 67, box: [3, 1, 15, 22] },   // 借字体的 'd'（竖 + 碗），当大写 D 用
    'd': { idx: 67, box: [3, 1, 15, 22] },
    'i': { idx: 72, box: [3, 0, 5, 22] },    // 竖 + 上方独立的点
    't': { idx: 83, box: [2, 1, 10, 22] },   // 竖 + 横 + 底部右收（idx 84 的尾部垂到 18 太深）
};

const perChar = [];
for (const ch of TEXT) {
    if (ch === ' ') { perChar.push({ ch, space: true, idx: -1, polys: [] }); continue; }
    const def = GLYPH_INDEX[ch];
    if (!def) throw new Error(`字符 ${JSON.stringify(ch)} 还没有下标映射；用 glyph_sheet2.js 查出后补进 GLYPH_INDEX`);
    const g = glyphs[def.idx];
    if (!g) throw new Error(`下标 ${def.idx}（字符 ${JSON.stringify(ch)}）超出范围`);
    const polys = parsePath(g.d);
    perChar.push({ ch, idx: def.idx, polys, advance: g.o / U, expected: def.box, raw: g.d });
}

// ---- 自动校验：每个字形的实际包围盒必须和期望一致 ----
{
    let bad = 0;
    for (const c of perChar) {
        if (c.space) continue;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (const p of c.polys) for (const [x, y] of p) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        const got = [x0, y0, x1, y1];
        const ok = got.every((v, k) => Math.abs(v - c.expected[k]) <= 1);
        if (!ok) {
            console.warn(`  !!! ${JSON.stringify(c.ch)} (idx ${c.idx}) 包围盒 ${JSON.stringify(got)} != 期望 ${JSON.stringify(c.expected)}`);
            bad++;
        }
    }
    if (bad) { console.error(`下标校验失败 ${bad} 处，请核对 GLYPH_INDEX`); process.exit(1); }
    console.log('字形下标校验通过（包围盒全部吻合）');
}

// ---- 统计 ----
let totalSeg = 0;
console.log('\n字符  段数  字距  包围盒(归一化)');
for (const c of perChar) {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, seg = 0;
    for (const p of c.polys) {
        for (const [x, y] of p) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        seg += p.length - 1;
    }
    totalSeg += seg;
    const fmt = v => isFinite(v) ? v.toFixed(3) : '-';
    console.log(`${JSON.stringify(c.ch).padEnd(6)}段 ${String(seg).padEnd(5)}` +
        `(${fmt((x0 - XOFF) / U)},${fmt((y0 - YOFF) / U)})-(${fmt((x1 - XOFF) / U)},${fmt((y1 - YOFF) / U)})`);
}
console.log(`段数合计 ${totalSeg}`);

// ---- 生成 GLSL ----
// 与之前的手写表保持同一结构：每个字形固定 SLOTS 个段槽位（不足补零段），方便 shader 里的
// "逐段描画"动画直接用 g*SLOTS+s 索引。SLOTS **必须 >= 所有字形里最多的段数**，
// 否则会静默截断（曾经取 16，把 'A' 的 18 段砍掉了 2 段）。
{
    let need = 0;
    perChar.forEach((c, gi) => {
        let n = 0;
        for (const p of c.polys) n += p.length - 1;
        console.log(`  ${JSON.stringify(c.ch).padEnd(6)} 段数 ${n}`);
        need = Math.max(need, n);
        c._segCount = n;
    });
    console.log(`最多段数字形需要 ${need} 个槽位`);
}
const SLOTS = Math.max(8, Math.ceil(Math.max(...perChar.map(c => c._segCount)) / 4) * 4);
console.log(`SLOTS = ${SLOTS}`);
const GLYPH_COUNT = perChar.length;
const rows = [];
perChar.forEach((c, gi) => {
    const flat = [];
    for (const p of c.polys) for (let i = 0; i + 1 < p.length; i++) flat.push([p[i], p[i + 1]]);
    const lines = [];
    for (let s = 0; s < SLOTS; s++) {
        if (s < flat.length) {
            const [[ax, ay], [bx, by]] = flat[s];
            const f = v => (v).toFixed(4);
            lines.push(`    vec4(${f((ax - XOFF) / U)}, ${f((ay - YOFF) / U)}, ${f((bx - XOFF) / U)}, ${f((by - YOFF) / U)})`);
        } else {
            lines.push('    vec4(0.0)');
        }
    }
    rows.push(`    // ${JSON.stringify(c.ch)}\n` + lines.join(',\n'));
});

// ---- 排版：统一基线 + 固定字距，不用字体自带的 advance ----
// 字体自带的 o 对有些字形是偏的，而且字形本身带负的左边距（例如 'd' 的墨迹从 -0.056 开始），
// 直接用 o 当步进会让相邻字母叠在一起（屏幕上真的会连成 "ADEdit"）。
// 所以：每个字形按**自己的墨迹宽度**左对齐到一个固定宽的格子（LETTER_ADV），
// 空格单独给一个宽度。这样字距一定是均匀的。
const LETTER_ADV = 0.98;   // 字母格宽（× 大写高），含左右边距
const SPACE_W = 0.52;      // 空格宽（× 大写高）
const placed = perChar.map(c => {
    let x0 = 1e9, x1 = -1;
    for (const p of c.polys) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    let shift = 0, inkW = 0;
    if (c.polys.length) {
        shift = -((x0 - XOFF) / U);            // 把墨迹左边推到格子的 0
        inkW = (x1 - x0) / U;
    }
    const adv = c.space ? SPACE_W : LETTER_ADV;
    return { ...c, shift, inkW, adv, pad: (adv - inkW) * 0.5 };
});

// 重新生成段表（应用 shift + 居中留白）
const rows2 = [];
placed.forEach(c => {
    const flat = [];
    for (const p of c.polys) for (let i = 0; i + 1 < p.length; i++) flat.push([p[i], p[i + 1]]);
    const lines = [];
    const put = (x, y) => (((x - XOFF) / U) + c.shift + c.pad).toFixed(4) + ', ' + ((y - YOFF) / U).toFixed(4);
    for (let s = 0; s < SLOTS; s++) {
        if (s < flat.length) {
            const [[ax, ay], [bx, by]] = flat[s];
            lines.push(`    vec4(${put(ax, ay)}, ${put(bx, by)})`);
        } else lines.push('    vec4(0.0)');
    }
    rows2.push(`    // ${JSON.stringify(c.ch)}\n` + lines.join(',\n'));
});
const advanceLines = placed.map(c => `    ${c.adv.toFixed(4)}`).join(',\n');
console.log('\n排版：');
placed.forEach((c, i) => console.log(`  #${i} ${JSON.stringify(c.ch).padEnd(6)} 墨迹宽 ${c.inkW.toFixed(3)}  格宽 ${c.adv.toFixed(3)}  居中留白 ${c.pad.toFixed(3)}`));
console.log(`  行总宽 ${placed.reduce((t, c) => t + c.adv, 0).toFixed(3)} × 大写高`);

const block = `
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
#define AD_GLYPH_COUNT ${GLYPH_COUNT}
#define AD_GLYPH_SLOTS ${SLOTS}
const vec4 AD_STROKES[${GLYPH_COUNT * SLOTS}] = vec4[${GLYPH_COUNT * SLOTS}](
${rows2.join(',\n')}
);

// 每格的步进宽度（× 大写高），已含左右留白
const float AD_ADVANCE[${GLYPH_COUNT}] = float[${GLYPH_COUNT}](
${advanceLines}
);
`;

const target = path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl');
let src = fs.readFileSync(target, 'utf8');
const re = /\/\/======\/\/ 文字字模：[\s\S]*?(?=\n\/\/======\/\/ SDF 工具)/;
if (!re.test(src)) { console.error('在 StartupLogo.glsl 里找不到字模区块，无法替换'); process.exit(1); }
src = src.replace(re, block.trimEnd() + '\n');
fs.writeFileSync(target, src, 'utf8');
console.log(`\n已写入 ${path.relative(PACK, target)}`);
console.log(`  字形 ${GLYPH_COUNT} 个 × ${SLOTS} 槽位 = ${GLYPH_COUNT * SLOTS} 段向量`);
