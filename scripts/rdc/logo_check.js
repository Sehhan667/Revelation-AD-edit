/*
 * logo_check.js — 对实机尺寸截图做一组量化检查，替代肉眼判断
 * 用法：node rdc_analysis/logo_check.js <png>
 * 检查项：
 *   1) 主字形包围盒与"设计尺寸 × 比例"是否吻合
 *   2) 主字形上半部分（三条近共线细缝所在区）实际能分辨出几条
 *   3) "AD Edit" 的行高、笔画粗细、以及字母之间是否粘连
 */
const { readPNG, runs } = require('./png_read');
const fs = require('fs'), path = require('path');

const im = readPNG(process.argv[2]);
const THR = 200;

// 按行分组找连通块
const groups = [];
let cur = null;
for (let y = 0; y < im.h; y++) {
    const r = runs(im, y, 'y', THR);
    if (r.length) { if (!cur) cur = { y0: y, y1: y, rows: [] }; cur.y1 = y; cur.rows.push({ y, r }); }
    else if (cur) { groups.push(cur); cur = null; }
}
if (cur) groups.push(cur);
// 只保留在主画面竖直范围里的块，并按面积排序
const main = groups.filter(g => g.y0 > 100 && g.y1 < 1180);
main.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));

console.log(`${process.argv[2]}  ${im.w}x${im.h}`);
for (const g of main) {
    let x0 = 1e9, x1 = -1, tot = 0;
    for (const r of g.rows) { x0 = Math.min(x0, r.r[0][0]); x1 = Math.max(x1, r.r[r.r.length - 1][1]); tot += r.r.reduce((t, [a, b]) => t + b - a + 1, 0); }
    console.log(`\n块 y ${g.y0}..${g.y1} (${g.y1 - g.y0 + 1} 行)  x ${x0}..${x1} (${x1 - x0 + 1} px)  白像素 ${tot}`);
    const H = g.y1 - g.y0 + 1;
    // 每 10% 取一行，看有几条独立横段（判断细缝有没有分辨出来）
    console.log('  行分段（比例位置 -> 段数 / 各段宽度）:');
    for (let p = 0; p <= 10; p++) {
        const y = Math.round(g.y0 + (H - 1) * p / 10);
        const r = runs(im, y, 'y', THR);
        const w = r.map(([a, b]) => b - a + 1);
        console.log(`    ${String(p * 10).padStart(3)}%  y=${String(y).padStart(4)}  ${r.length} 段  [${w.join(', ')}]`);
    }
    // 连通块数（沿扫线最大段数）用来判断是否粘连
    let maxSeg = 0;
    for (const r of g.rows) maxSeg = Math.max(maxSeg, r.r.length);
    console.log(`  最大分段数 ${maxSeg}（主字形应为 3：左楔 / 中段 / 右楔）`);
}

// 笔画粗细：对每个块的竖直方向做"某列的白像素连续长度"统计
console.log('\n竖直笔画厚度估计（对块内每一列统计白色连续段长度的中位数）:');
for (const g of main) {
    const lens = [];
    let x0 = 1e9, x1 = -1;
    for (const r of g.rows) { x0 = Math.min(x0, r.r[0][0]); x1 = Math.max(x1, r.r[r.r.length - 1][1]); }
    for (let x = x0; x <= x1; x++) {
        const col = runs(im, x, 'x', THR);
        for (const [a, b] of col) lens.push(b - a + 1);
    }
    lens.sort((a, b) => a - b);
    const med = lens[Math.floor(lens.length / 2)];
    console.log(`  块 y${g.y0}..${g.y1}: 中位竖直厚度 ${med} px  (共 ${lens.length} 段)`);
}
