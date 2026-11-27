/*
 * emit_logo_svg.js �?�?StartupLogo.glsl 的顶点表导出 SVG 草稿 + 终端 ASCII 预览
 *
 * 用途：改标志形状时先在浏览器里�?SVG 草稿，确认后再把顶点写回 shader�? * 坐标：存储空�?(x,y) �?[-0.5,0.5]，y 向上；SVG 用设计框像素、y 向下 �?Y = (0.5 - y) * H
 * 用法：node rdc_analysis/emit_logo_svg.js
 */
const fs = require('fs');
const path = require('path');

const PACK = path.resolve(__dirname, '..');
const GLSL = path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl');
const src = fs.readFileSync(GLSL, 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(src)[1]);

const W = num('LOGO_BOX_W'), H = num('LOGO_BOX_H');
const COUNT = num('LOGO_POLY_COUNT');
const POLYS = [];
for (let i = 0; i < COUNT; i++) {
    const m = new RegExp(`const vec2 LOGO_POLY${i}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`).exec(src);
    let pts = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(Number));
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) pts = pts.slice(0, -1);
    POLYS.push(pts);
}

const X = v => (v[0] + 0.5) * W;
const Y = v => (0.5 - v[1]) * H;
const toDesign = (px, py) => [px / W - 0.5, 0.5 - py / H];

const insideUnion = (sx, sy) => {
    let inside = false;
    for (const p of POLYS) {
        let hit = false;
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
            const [xi, yi] = p[i], [xj, yj] = p[j];
            if (((yi > sy) !== (yj > sy)) && (sx < (xj - xi) * (sy - yi) / (yj - yi) + xi)) hit = !hit;
        }
        if (hit) inside = !inside;
    }
    return inside;
};

// ---- 新笔画（设计框像素；�?shader �?笔画 = 有一定宽度的形状"一致，这里用圆头粗线近似）----
const Q = (p0, p1, p2, n = 14) => {                       // 二次贝塞尔采�?    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                  u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    }
    return out;
};
const STROKES = [
    // y 型小分叉：从 V 右腿中下部向左伸出的一小段（自由端在口子里，另一端与腿留 ~12 空隙�?    { name: 'y 分叉', w: 30, pts: [[420, 132], [508, 150]] },
    // 半个圆弧：上臂长、下臂短（开口朝左），右侧鼓出；�?A 的尖/脚同�?    { name: '半圆�?, w: 45, pts: [[690, 14], [800, 14],
                                   ...Q([800, 14], [866, 12], [866, 99]),
                                   ...Q([866, 99], [866, 186], [800, 184]),
                                   [772, 184]] }
];

// ---- 粗细线栅格化（沿路径铺圆点）用于 ASCII 自查 + �?SVG 复用 ----
const stampHits = (px, py) => {
    for (const s of STROKES) {
        const r = s.w / 2;
        for (let i = 0; i < s.pts.length - 1; i++) {
            const [ax, ay] = s.pts[i], [bx, by] = s.pts[i + 1];
            const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1e-9;
            const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / L2));
            const dx = px - (ax + t * ex), dy = py - (ay + t * ey);
            if (dx * dx + dy * dy <= r * r) return true;
        }
    }
    return false;
};

// ---- 终端 ASCII 预览（含新笔画，�?* 表示；x 覆盖�?900 以便看全 D�?---
const COLS = 108, ROWS = 34, ART_W = 900;
let art = '';
for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
        const px = (c + 0.5) / COLS * ART_W, py = (r + 0.5) / ROWS * H;
        const [sx, sy] = toDesign(px, py);
        line += insideUnion(sx, sy) ? '#' : (stampHits(px, H - py) ? '*' : '.');
    }
    art += line + '\n';
}
console.log(art);
// B 方向�? 顶点表原样、你草图那一面）�?ASCII：笔画坐标按 y -> H-y 镜像
{
    let artB = '';
    for (let r = 0; r < ROWS; r++) {
        let line = '';
        for (let c = 0; c < COLS; c++) {
            const px = (c + 0.5) / COLS * ART_W, py = (r + 0.5) / ROWS * H;
            const sx = px / W - 0.5, sy = py / H - 0.5;   // B：存储空间直接对应（不翻�?            const hit = stampHits(px, H - py);            // 笔画仍按 authored(A) -> B 镜像
            line += insideUnion(sx, sy) ? '#' : (hit ? '*' : '.');
        }
        artB += line + '\n';
    }
    console.log('=== B 方向�? 草图那一面）===');
    console.log(artB);
}
POLYS.forEach((p, i) => {
    const xs = p.map(v => X(v)), ys = p.map(v => Y(v));
    console.log(`POLY${i}: x ${Math.min(...xs).toFixed(1)} .. ${Math.max(...xs).toFixed(1)}   y ${Math.min(...ys).toFixed(1)} .. ${Math.max(...ys).toFixed(1)}   (${p.length} �?`);
});

// ---- �?SVG ----
const VW = 900, VH = H + 120;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${VW + 80}" height="${VH}" viewBox="-40 -60 ${VW + 80} ${VH}">
<rect x="-40" y="-60" width="${VW + 80}" height="${VH}" fill="#0b0b0b"/>
<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#3a5a3a" stroke-width="1" stroke-dasharray="6 6"/>
<g fill="#6a6a6a" font-family="monospace" font-size="12">`;
for (let gx = 0; gx <= VW; gx += 100) svg += `<text x="${gx + 2}" y="-6">${gx}</text><line x1="${gx}" y1="-2" x2="${gx}" y2="${H}" stroke="#2a2a2a" stroke-width="0.5"/>`;
for (let gy = 0; gy <= H; gy += 50) svg += `<text x="-36" y="${gy + 4}">${gy}</text><line x1="-2" y1="${gy}" x2="${VW}" y2="${gy}" stroke="#2a2a2a" stroke-width="0.5"/>`;
svg += `</g>\n`;
POLYS.forEach(p => {
    const d = p.map((v, k) => `${k ? 'L' : 'M'}${X(v).toFixed(2)},${Y(v).toFixed(2)}`).join(' ') + ' Z';
    svg += `<path d="${d}" fill="#ffffff"/>\n`;
});
svg += `<g fill="none" stroke="#ffd166" stroke-linecap="round" stroke-linejoin="round">\n`;
for (const s of STROKES) svg += `<polyline points="${s.pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" stroke-width="${s.w}"/>\n`;
svg += `</g>\n`;
svg += `<text x="-36" y="${H + 34}" fill="#888" font-family="monospace" font-size="13">white = existing mark (POLY0 Z + POLY1 V/A)   yellow = new strokes: A crossbar + D bowl</text>\n</svg>\n`;

const out = path.join(__dirname, 'logo_draft.svg');
fs.writeFileSync(out, svg, 'utf8');
console.log(`已写�? ${out}`);

// ---- 另出两份"完整成品"SVG：与 shader 同向 / 上下镜像各一份，用来定坐标方�?----
const FULL_W = 900, FULL_H = Math.ceil(H);
function buildFull(flip) {
    const YY = v => (flip ? (0.5 - v[1]) : (v[1] + 0.5)) * H;
    const ys = y => (flip ? H - y : y);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${FULL_W}" height="${FULL_H}" viewBox="0 0 ${FULL_W} ${FULL_H}">\n<rect x="0" y="0" width="${FULL_W}" height="${FULL_H}" fill="#000000"/>\n`;
    POLYS.forEach(p => {
        const d = p.map((v, k) => `${k ? 'L' : 'M'}${X(v).toFixed(2)},${YY(v).toFixed(2)}`).join(' ') + ' Z';
        s += `<path d="${d}" fill="#ffffff"/>\n`;
    });
    s += `<g fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">\n`;
    for (const st of STROKES) s += `<polyline points="${st.pts.map(p => `${p[0].toFixed(1)},${ys(p[1]).toFixed(1)}`).join(' ')}" stroke-width="${st.w}"/>\n`;
    s += `</g>\n</svg>\n`;
    return s;
}
const outA = path.join(__dirname, 'logo_full.svg');            // �?shader 渲染同向�? shader 里翻转之后的样子�?fs.writeFileSync(outA, buildFull(true), 'utf8');
const outB = path.join(__dirname, 'logo_full_flip.svg');       // 上下镜像�? 直接读顶点表、不翻的样子�?fs.writeFileSync(outB, buildFull(false), 'utf8');
console.log(`已写�? ${outA} �?${outB}（同�?/ 上下镜像，用来定坐标方向）`);
