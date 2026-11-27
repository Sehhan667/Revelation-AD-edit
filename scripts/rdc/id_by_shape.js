/*
 * id_by_shape.js — 只用**几何签名**识别字母，不依赖任何"下标 = ascii ± 常数"的假设。
 *
 * 做法：把每个字形的子路径翻译成一段人类可读的"形状描述"
 * （几条子路径、每条是点/线/多段折线、起止点、是否竖直），然后按特征规则判定字母。
 * 这样即使字体下标乱序也能认出来，而且判定规则本身可以复核。
 *
 * 用法：node rdc_analysis/id_by_shape.js
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
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, seg = 0;
    for (const p of P) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (const p of P) seg += p.length - 1;
    return { i, o: g.o, P, x0, y0, x1, y1, seg, nsub: P.length, d: g.d };
});
const desc = g => g.P.map(p => p.length === 2
    ? (p[0][0] === p[1][0] ? `竖(${p[0][0]}):${p[0][1]}->${p[1][1]}` : `线(${p[0][0]},${p[0][1]})->(${p[1][0]},${p[1][1]})`)
    : `折线${p.length}点 (${p[0][0]},${p[0][1]})..(${p[p.length - 1][0]},${p[p.length - 1][1]})`).join('  ');

// 只在大写高度区里找（y 从 1 附近到 22 附近）
const caps = info.filter(g => g.y0 <= 4 && g.y1 >= 20 && g.x1 - g.x0 >= 12);
console.log(`=== 大写区 ${caps.length} 个 ===`);
for (const g of caps) {
    console.log(`idx ${String(g.i).padStart(3)}  o=${String(g.o).padStart(3)} 子${g.nsub} 段${String(g.seg).padStart(3)}  bbox(${g.x0},${g.y0})-(${g.x1},${g.y1})`);
    console.log(`      ${desc(g)}`);
}
