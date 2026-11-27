/*
 * find_it.js — 专门找 'i' 和 't'：按"必须有独立的点/横"这种结构特征搜索全字体。
 * 用法：node rdc_analysis/find_it.js
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
const info = F.map((g, i) => {
    const P = parsePath(g.d);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (const p of P) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { i, o: g.o, P, x0, y0, x1, y1, d: g.d, nsub: P.length };
});

// 短横：长度 5..16、两端 y 相同
const isBar = p => p.length === 2 && p[0][1] === p[1][1] && Math.abs(p[1][0] - p[0][0]) >= 4 && Math.abs(p[1][0] - p[0][0]) <= 18;
// 竖：两端 x 相同
const isStem = p => p.length === 2 && p[0][0] === p[1][0];
// 点：包围盒很小
const isDot = p => { let a = 1e9, b = 1e9, c = -1, e = -1; for (const [x, y] of p) { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); e = Math.max(e, y); } return (c - a) <= 6 && (e - b) <= 6; };

console.log('=== 含"独立横 + 竖"、且竖贯穿到基线的字形 -> 候选 t ===');
for (const g of info) {
    const stems = g.P.filter(isStem);
    const bars = g.P.filter(isBar);
    for (const s of stems) {
        if (s[0][1] > 10 || s[1][1] < 20) continue;          // 竖要够长
        for (const b of bars) {
            if (b[0][1] > s[0][1] + 1 && b[0][1] < s[1][1]) {
                console.log(`idx ${String(g.i).padStart(3)} o=${g.o}  nsub=${g.nsub}  bbox(${g.x0},${g.y0})-(${g.x1},${g.y1})`);
                console.log(`    ${g.d}`);
            }
        }
    }
}

console.log('\n=== 含"竖 + 上方小点"-> 候选 i ===');
for (const g of info) {
    if (g.nsub < 2) continue;
    const stems = g.P.filter(isStem);
    const dots = g.P.filter(isDot);
    if (!stems.length || !dots.length) continue;
    for (const s of stems) {
        for (const dt of dots) {
            if (dt[dt.length - 1][1] < s[0][1] - 1) {
                console.log(`idx ${String(g.i).padStart(3)} o=${g.o}  nsub=${g.nsub}  bbox(${g.x0},${g.y0})-(${g.x1},${g.y1})`);
                console.log(`    ${g.d}`);
            }
        }
    }
}

console.log('\n=== 只含"一个小点"的字形（可能就是单独的 i 点） ===');
for (const g of info) {
    if (g.P.length === 1 && isDot(g.P[0])) console.log(`idx ${g.i} o=${g.o}  ${g.d}`);
}
