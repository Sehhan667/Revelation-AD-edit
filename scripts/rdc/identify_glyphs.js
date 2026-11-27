/*
 * identify_glyphs.js — 按**几何特征**给字体里每个下标打上字母标签，不靠 ascii 猜偏移
 *
 * 背景：这份 hersheytext.json 的下标与 ascii 的差不是固定值（同一个下标的形状
 * 在不同区间对不上同一套偏移），所以改用几何指纹识别：
 *   把每个字形的折线按"起点->终点方向 + 长度"归一化，和标准的 Hershey 大写/小写
 *   形状特征比对。这里只识别 "AD Edit" 需要的 6 个字母 + 空格，用人工写死但**可验证**
 *   的特征描述。
 *
 * 用法：node rdc_analysis/identify_glyphs.js
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

const G = F.map((g, i) => {
    const P = parsePath(g.d);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, seg = 0;
    for (const p of P) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (const p of P) seg += p.length - 1;
    return { i, o: g.o, P, x0, y0, x1, y1, seg, d: g.d, nsub: P.length };
});

const cap = G.filter(g => g.x1 > 0 && g.y0 >= 0 && g.y0 <= 3 && g.y1 >= 20 && g.y1 <= 24 && g.x1 - g.x0 >= 8);
console.log(`大写区候选 ${cap.length} 个下标：${cap.map(g => g.i).join(', ')}\n`);

// 特征判定
const isVertPair = g => g.P.length === 1 && g.P[0].length === 2 && g.P[0][0][0] === g.P[0][1][0];
const isA = g => g.nsub === 3 && g.P[0].length === 2 && isVertPair({ P: [g.P[0]] }) &&
    g.P[0][0][1] < 4 && g.P[0][1][1] > 20 &&
    g.P[1][0][0] === g.P[0][0][0] && g.P[1].length === 9 &&
    g.P[2].length === 10;
const isD = g => g.nsub === 4 && g.P[0].length === 2 && g.P[0][0][0] === g.P[0][1][0] &&
    g.P[0][1][1] - g.P[0][0][1] > 18 && g.seg === 4 &&
    g.P[1][0][1] === g.P[0][0][1] && g.P[1][1][0] - g.P[1][0][0] > 10 &&
    g.P[2][0][1] > 8 && g.P[2][0][1] < 14 && g.P[3][0][1] > 20;
const isE = g => g.nsub === 3 && g.seg === 3 && g.P[0].length === 2 && g.P[0][0][0] === g.P[0][1][0] &&
    g.P[0][1][1] - g.P[0][0][1] > 18 && g.P[2][0][1] > 8 && g.P[2][0][1] < 14;

const tests = { A: isA, D: isD, E: isE };
for (const [name, fn] of Object.entries(tests)) {
    const hits = cap.filter(fn);
    console.log(`${name}: ${hits.length} 个 -> 下标 ${hits.map(h => h.i).join(', ')}`);
    for (const h of hits) console.log(`    idx ${h.i} (o=${h.o}) ${h.d}`);
}

// 小写区
console.log('');
const low = G.filter(g => g.x1 > 0 && g.y0 > 3 && g.y1 >= 20 && g.y1 <= 24 && g.x1 - g.x0 >= 6);
console.log(`x-height 区候选 ${low.length} 个下标：${low.map(g => g.i).join(', ')}`);
const is_low_d = g => g.y0 < 10 && g.P.some(p => p.length === 2 && p[0][0] === p[1][0] && p[1][1] - p[0][1] > 12);
const is_low_e = g => g.nsub >= 2 && g.P.some(p => p.length === 2 && p[0][1] === p[1][1] && p[1][0] - p[0][0] > 4) &&
    g.P.some(p => p.length >= 6);
const is_low_t = g => g.y0 < 10 && g.y1 >= 20 && g.P.length === 2 && g.seg <= 5;
for (const [name, fn] of Object.entries({ d: is_low_d, e: is_low_e, t: is_low_t })) {
    const hits = low.filter(fn);
    console.log(`${name}: ${hits.length} 个 -> 下标 ${hits.map(h => h.i).join(', ')}`);
    for (const h of hits.slice(0, 6)) console.log(`    idx ${h.i} (o=${h.o}) seg=${h.seg} ${h.d.slice(0, 70)}`);
}
