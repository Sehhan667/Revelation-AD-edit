/*
 * find_glyphs.js — 在 Hershey 字体里按**几何指纹**定位 "AD Edit" 需要的字形
 *
 * 为什么不用 ascii-32：试了 31/32 两种偏移都对不上（出来的 D 少了中间的横、E 又不对）。
 * 与其猜偏移，不如按几何特征找：
 *   段数 / 子路径数 / 是否存在封口竖线 / 各子路径的走向 —— 这些对 Hershey 字形是唯一的。
 *
 * 用法：node rdc_analysis/find_glyphs.js
 */
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'hersheytext.json'), 'utf8'));
const F = j.futural.chars;

function parsePath(d) {
    const polys = [];
    for (const sub of d.trim().split(/\s*M/).filter(Boolean)) {
        const nums = [...sub.matchAll(/(-?\d+),(-?\d+)/g)].map(m => [+m[1], +m[2]]);
        if (nums.length >= 2) polys.push(nums);
    }
    return polys;
}
function feat(d) {
    const P = parsePath(d);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, seg = 0;
    for (const p of P) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (const p of P) seg += p.length - 1;
    return { P, x0, y0, x1, y1, seg, nsub: P.length };
}
// 一段是否是竖直线
const isVert = (a, b) => a[0] === b[0] && Math.abs(b[1] - a[1]) > 5;

// 所有字形的指纹表
const table = F.map((g, i) => ({ i, o: g.o, ...feat(g.d), d: g.d }));
console.log('idx  o  子路径 段数  bbox');
for (const t of table) {
    if (t.x1 < 0) continue;
    console.log(String(t.i).padStart(3) + String(t.o).padStart(4) + String(t.nsub).padStart(6) + String(t.seg).padStart(5) +
        `   (${t.x0},${t.y0})-(${t.x1},${t.y1})`);
}

// ---- 按特征找 ----
console.log('\n=== 候选 ===');
const find = (name, pred) => {
    const hits = table.filter(pred);
    console.log(`${name}: ${hits.length} 个 -> ${hits.map(h => h.i).join(', ')}`);
    for (const h of hits.slice(0, 4)) {
        console.log(`    idx ${h.i} (o=${h.o}) seg=${h.seg} ${JSON.stringify(h.d.slice(0, 90))}`);
    }
    return hits;
};

// E：3 条子路径，都是"一条竖 + 两条横"，总段数 4（竖 1 + 上横 1 + 中横 1 + ... ）
console.log('目标字符的特征：');
console.log('  E = 3 子路径(竖/上横/中横) 且没有下横 -> 典型"E"');
find('子路径=3 且含一条长竖(原 y 1..22)的', h => h.nsub === 3 && h.P.some(p => isVert(p[0], p[1]) && p[1][1] - p[0][1] > 15));
find('子路径=4 且含一条长竖', h => h.nsub === 4 && h.P.some(p => isVert(p[0], p[1]) && p[1][1] - p[0][1] > 15));
find('子路径=3 且 x 范围 0..18 左右、y 1..22', h => h.nsub === 3 && h.x1 >= 17 && h.y1 >= 21);
