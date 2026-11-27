/*
 * fit_mapping.js — 用"多边形已知特征"反解 PNG 像素 <-> 设计坐标的仿射映射（等比+平移）
 *
 * 思路：多边形有几处非常好认的特征行/列：
 *   A) 主字形最低点 (245.5,187)  —— 多边形 y 最大处，只有它在该高度附近
 *   B) 左右两个"外侧最远点" x=0 与 x=486 出现在 y=187 一行
 *   C) 顶点 (161.3,0) 与 (486,0) 的 y=0 一行
 * 与其手算，不如把 PNG 里 mark 的包围盒直接和多边形的包围盒对齐，
 * 再用"内部两条缝"的位置验证。这里直接做最小二乘：对每个设计 y 取多边形的
 * 最左/最右端点，和实测该行最左/最右白像素做拟合，解出 scale/ox/oy。
 *
 * 用法：node rdc_analysis/fit_mapping.js <png> [--top N] [--bot N]
 */
const { readPNG, runs } = require('./png_read');

const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return parseFloat(process.argv[i + 1]);
        if (a.startsWith(`--${k}=`)) return parseFloat(a.slice(k.length + 3));
    }
    return d;
};

const im = readPNG(process.argv[2]);
const THR = argOf('thr', 200);

// 找出 mark 主体：取面积最大的连通块（粗略：按行分组，取行数最多的那一组）
const rowGroups = [];
let cur = null;
for (let y = 0; y < im.h; y++) {
    const r = runs(im, y, 'y', THR);
    if (r.length) { if (!cur) cur = { y0: y, y1: y }; else cur.y1 = y; }
    else if (cur) { rowGroups.push(cur); cur = null; }
}
if (cur) rowGroups.push(cur);
rowGroups.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
const g = rowGroups[0];
console.log(`${process.argv[2]}: mark 行范围 y ${g.y0}..${g.y1} (${g.y1 - g.y0 + 1} 行)`);

// 每一行的最左/最右白像素
const rows = [];
for (let y = g.y0; y <= g.y1; y++) {
    const r = runs(im, y, 'y', THR);
    rows.push({ y, min: r[0][0], max: r[r.length - 1][1], n: r.length });
}

// 多边形：从 shader 读
const fs = require('fs'), path = require('path');
const glsl = fs.readFileSync(path.resolve(__dirname, '..', 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl)[1]);
const W = num('LOGO_BOX_W'), H = num('LOGO_BOX_H');
const pb = /const vec2 LOGO_PATH\[(\d+)\] = vec2\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
let P = [...pb[2].matchAll(/vec2\(([^)]+)\)/g)].map(m => m[1].split(',').map(s => parseFloat(s.trim())));
const seen = new Set();
P = P.filter(p => { const k = p.join(','); if (seen.has(k)) return false; seen.add(k); return true; })
     .map(([x, y]) => [(x + 0.5) * W, (y + 0.5) * H]);

// 设计 y -> 最左/最右 x
function extent(dy) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        if ((a[1] <= dy && b[1] > dy) || (b[1] <= dy && a[1] > dy))
            xs.push(a[0] + (dy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    if (xs.length < 2) return null;
    return [Math.min(...xs), Math.max(...xs)];
}

// 拟合： 像素 = s * 设计 + o
// 用两族方程： y 方向 s2*dy + oy = y_px ；x 方向 s*dx+ox = x_px
// 我们需要 dy 与 y_px 的对应：用"归一化行进度" t=(dy-0)/(H) 对应 t=(y-g.y0)/(g.y1-g.y0)
// 先估 s2 = (g.y1-g.y0)/H
const s = (g.y1 - g.y0) / H;
console.log(`纵向比例 s = ${s.toFixed(5)} px/设计单位  (期望 1.4439)`);

// 对若干行做最小二乘，解 ox
let sw = 0, sx = 0, sd = 0, sdd = 0;
for (const r of rows) {
    const dy = (r.y - g.y0) / s;
    const e = extent(dy + 0.5);
    if (!e) continue;
    for (const [px, dx] of [[r.min, e[0]], [r.max, e[1]]]) {
        sw++; sx += px; sd += dx; sdd += dx * dx;
    }
    r.dy = dy; r.e = e;
}
const meanX = sx / sw, meanD = sd / sw;
let num2 = 0, den = 0;
for (const r of rows) {
    if (!r.e) continue;
    for (const [px, dx] of [[r.min, r.e[0]], [r.max, r.e[1]]]) { num2 += (dx - meanD) * (px - meanX); den += (dx - meanD) ** 2; }
}
const slope = num2 / den, ox = meanX - slope * meanD;
console.log(`横向最小二乘： 像素x = ${slope.toFixed(5)} * 设计x + ${ox.toFixed(2)}`);
console.log(`  纵向 ox 由包围盒解出： oy = ${g.y0} - s*0 = ${g.y0}`);

// 残差
let maxr = 0;
for (const r of rows) {
    if (!r.e) continue;
    maxr = Math.max(maxr, Math.abs(slope * r.e[0] + ox - r.min), Math.abs(slope * r.e[1] + ox - r.max));
}
console.log(`  拟合最大残差 ${maxr.toFixed(1)} px`);
console.log(`\n=> 用 poly_diff.js 时： --offx=${ox.toFixed(1)} --offy=${g.y0} --scale=${slope.toFixed(5)}`);
