/* logo_from_sketch.js — 按截图草图读出的位置出 SVG（B = 草图/顶点表方向；A = 游戏方向）
 * 用法: node rdc_analysis/logo_from_sketch.js
 */
const fs = require('fs'), path = require('path');
const PACK = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(src)[1]);
const W = num('LOGO_BOX_W'), H = num('LOGO_BOX_H');
const POLY = [];
for (let i = 0; i < 2; i++) {
    const m = new RegExp(`const vec2 LOGO_POLY${i}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`).exec(src);
    let p = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(Number));
    const a = p[0], b = p[p.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) p = p.slice(0, -1);
    POLY.push(p);
}
const Q = (p0, p1, p2, n = 16) => { const o = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]); } return o; };

// 新笔画：**草图(B)方向**的设计坐标，直接按截图量出来
const STROKES = [
    { n: 'y 分叉（短横段）', w: 30, pts: [[152, 272], [300, 246]] },
    { n: '半圆弧', w: 45, pts: [[700, 100], [862, 100], ...Q([862, 100], [884, 100], [884, 182]), ...Q([884, 182], [884, 264], [862, 264]), [824, 264]] }
];
const FULL_W = 920, FULL_H = Math.ceil(H);
function build(flipB) {
    const Y = v => (flipB ? (v[1] + 0.5) : (0.5 - v[1])) * H;   // flipB=true -> B（草图方向）
    const ys = y => (flipB ? y : H - y);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${FULL_W}" height="${FULL_H}" viewBox="0 0 ${FULL_W} ${FULL_H}">\n<rect width="${FULL_W}" height="${FULL_H}" fill="#000"/>\n`;
    POLY.forEach(p => { s += `<path d="${p.map((v, k) => `${k ? 'L' : 'M'}${((v[0] + 0.5) * W).toFixed(2)},${Y(v).toFixed(2)}`).join(' ')} Z" fill="#fff"/>\n`; });
    s += `<g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">\n`;
    for (const st of STROKES) s += `<polyline points="${st.pts.map(p => `${p[0].toFixed(1)},${ys(p[1]).toFixed(1)}`).join(' ')}" stroke-width="${st.w}"/>\n`;
    return s + `</g>\n</svg>\n`;
}
fs.writeFileSync(path.join(__dirname, 'logo_sketch_B.svg'), build(true), 'utf8');   // 与草图同向（可比对）
fs.writeFileSync(path.join(__dirname, 'logo_sketch_A.svg'), build(false), 'utf8');  // 游戏里看到的方向
console.log('已写出 logo_sketch_B.svg（草图方向）与 logo_sketch_A.svg（游戏方向）');
