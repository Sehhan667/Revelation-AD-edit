/*
 * glyph_sheet2.js — 只挑"可能是大写字母 / 小写字母"的字形，画成带下标的大图对照表。
 * 用来**肉眼**确定 "AD Edit" 每个字母到底是哪个下标（这份字体的下标不能按 ascii 推算）。
 * 用法：node rdc_analysis/glyph_sheet2.js [--px 44]
 */
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'hersheytext.json'), 'utf8'));
const F = j.futural.chars;

const argOf = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };
const PX = argOf('px', 44);

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
    return { i, o: g.o, P, x0, y0, x1, y1, seg, nsub: P.length };
});

// 大写候选：高约 1..22，宽 8..24
const caps = G.filter(g => g.x0 >= 2 && g.y0 <= 3 && g.y1 >= 20 && g.y1 <= 24 && g.x1 - g.x0 >= 8);
// 小写候选：x-height 起（y0≈8），到基线 22
const lows = G.filter(g => g.y0 >= 6 && g.y0 <= 12 && g.y1 >= 20 && g.y1 <= 24 && g.x1 - g.x0 >= 5);

function sheet(list, title, cols) {
    const CELL = PX * 1.5, ROWH = PX * 1.75;
    const rows = Math.ceil(list.length / cols);
    const W = cols * CELL, H = rows * ROWH;
    let s = '';
    list.forEach((c, k) => {
        const cx = (k % cols) * CELL, cy = Math.floor(k / cols) * ROWH;
        // 原始 y 1..22 映射到格子内 10..10+PX
        const sc = PX / 20;
        s += `<g transform="translate(${(cx + 8).toFixed(1)},${cy.toFixed(1)})">`;
        s += `<text x="0" y="${(PX + 24).toFixed(0)}" fill="#6cf" font-size="13" font-family="monospace">${c.i}</text>`;
        s += `<g transform="translate(${(PX * 0.7).toFixed(1)},${(-(c.y0 - 1) * sc + 6).toFixed(1)}) scale(${sc.toFixed(4)})">`;
        for (const p of c.P) {
            s += `<polyline points="${p.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="#fff" stroke-width="${(1.7 / sc).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        s += `</g></g>`;
    });
    return { W: Math.ceil(W), H: Math.ceil(H), s, title };
}

const A = sheet(caps, '大写候选', 12);
const B = sheet(lows, '小写候选', 14);

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>字形对照</title>
<style>body{margin:0;background:#111;color:#ccc;font:13px/1.5 monospace}
h2{font-size:13px;color:#9fd0ff;margin:8px 12px 2px}svg{display:block}</style></head><body>
<h2>大写候选（${caps.length} 个）—— 找 A / D / E</h2>
<svg width="${A.W}" height="${A.H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/>${A.s}</svg>
<h2>小写候选（${lows.length} 个）—— 找 d / i / t</h2>
<svg width="${B.W}" height="${B.H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/>${B.s}</svg>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'glyph_sheet2.html'), html, 'utf8');
console.log(`大写候选 ${caps.length}：${caps.map(g => g.i).join(', ')}`);
console.log(`小写候选 ${lows.length}：${lows.map(g => g.i).join(', ')}`);
console.log(`已写出 glyph_sheet2.html  ${A.W}x${A.H + B.H}`);
