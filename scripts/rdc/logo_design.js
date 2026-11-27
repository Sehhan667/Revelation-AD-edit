/* logo_design.js — 按已有 logo 的规律（笔宽/倾角）设计新增两笔，出完整 SVG + ASCII 自查
 * 坐标方向 B = 顶点表/草图方向；A = 游戏方向（上下镜像）
 */
const fs = require('fs'), path = require('path');
const PACK = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const num = n => parseFloat(new RegExp('#define\\s+' + n + '\\s+([-0-9.]+)').exec(src)[1]);
const W = num('LOGO_BOX_W'), H = num('LOGO_BOX_H');
const POLY = [];
for (let i = 0; i < 2; i++) {
    const m = new RegExp('const vec2 LOGO_POLY' + i + '\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);').exec(src);
    let q = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(Number));
    const a = q[0], b = q[q.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) q = q.slice(0, -1);
    POLY.push(q);
}
const XB = v => (v[0] + 0.5) * W, YB = v => (v[1] + 0.5) * H;     // B 方向
const bbox = pts => ({ x0: Math.min(...pts.map(p => p[0])), x1: Math.max(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), y1: Math.max(...pts.map(p => p[1])) });
const Pb = POLY.map(q => q.map(v => [XB(v), YB(v)]));
const bV = bbox(Pb[1]);
console.log('V(墨团3对应) B 方向包围盒: x ' + bV.x0.toFixed(0) + '..' + bV.x1.toFixed(0) + '  y ' + bV.y0.toFixed(0) + '..' + bV.y1.toFixed(0));

// ---- 规律（从顶点表量出）----
const SW = 45;                       // 笔画宽（Z 横条/J 的短边量出来约 41~47）
const SLANT = 0.62;                  // 倾角：x 随 y 的斜率（V 右腿 Δx/Δy ≈ 0.62，斜体）

// ---- 新增两笔（B 方向设计；都悬空、不接触 ZV）----
// 1) y 型小分叉：放在 V 开口内、中下部；两臂朝上、干朝下；整体顺斜体方向
const jx = (bV.x0 + bV.x1) / 2, jy = bV.y0 + (bV.y1 - bV.y0) * 0.62;          // 分叉结点
const ARM = 92;                                                                // 臂长
const FORK = [
    [[jx - 18, jy], [jx - 18 - ARM * SLANT * 0.75, jy - ARM]],                 // 左臂（朝左上）
    [[jx + 30, jy], [jx + 30 + ARM * SLANT * 0.75, jy - ARM]],                 // 右臂（朝右上）
    [[jx - 18, jy], [jx + 26, jy + 96]]                                        // 干（朝右下，顺斜体）
];
// 2) 半个圆弧：V 右侧悬空，开口朝左，高度与 V 相同，宽度按规律取 V 宽的 0.62
const gap = 52;
const ax0 = bV.x1 + gap, ay0 = bV.y0, ay1 = bV.y1;
const aw = (bV.x1 - bV.x0) * 0.62, ar = (ay1 - ay0) / 2;
const ARC = [];
for (let i = 0; i <= 24; i++) {
    const t = i / 24, ang = -Math.PI / 2 + Math.PI * t;                        // -90°..+90°
    ARC.push([ax0 + aw * 0.5 + aw * 0.5 * Math.cos(ang + Math.PI), (ay0 + ay1) / 2 + ar * Math.sin(ang)]);
}
const STROKES = [
    ...FORK.map(p => ({ p, w: SW })),
    { p: ARC, w: SW }
];

// ---- SVG ----
const VW = Math.ceil(ax0 + aw + SW), VH = Math.ceil(H);
function svg(flip) {
    const Y = v => (flip ? (0.5 - v[1]) * H : v[1]);
    const X = v => v[0];
    const ys = y => (flip ? H - y : y);
    let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + VW + '" height="' + VH + '" viewBox="0 0 ' + VW + ' ' + VH + '">\n<rect width="' + VW + '" height="' + VH + '" fill="#000"/>\n';
    POLY.forEach((q, i) => {
        const d = q.map((v, k) => (k ? 'L' : 'M') + X(Pb[i][k]).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
        s += '<path d="' + d + ' Z" fill="#fff"/>\n';
    });
    s += '<g fill="none" stroke="#fff" stroke-width="' + SW + '" stroke-linecap="butt">\n';
    for (const st of STROKES) s += '<polyline points="' + st.p.map(q => q[0].toFixed(1) + ',' + ys(q[1]).toFixed(1)).join(' ') + '"/>\n';
    return s + '</g>\n</svg>\n';
}
fs.writeFileSync(path.join(__dirname, 'logo_full_B.svg'), svg(false), 'utf8');
fs.writeFileSync(path.join(__dirname, 'logo_full_A.svg'), svg(true), 'utf8');
console.log('已写出 logo_full_B.svg（草图方向）与 logo_full_A.svg（游戏方向），画布 ' + VW + 'x' + VH);

// ---- ASCII 自查（B 方向；笔画用 * 表示）----
const hit = (px, py) => STROKES.some(st => {
    for (let i = 0; i < st.p.length - 1; i++) {
        const a = st.p[i], b = st.p[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey || 1e-9;
        const t = Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey) / L2));
        const dx = px - (a[0] + t * ex), dy = py - (a[1] + t * ey);
        if (dx * dx + dy * dy <= (st.w / 2) * (st.w / 2)) return true;
    }
    return false;
});
const inPoly = (px, py) => { let ins = false; for (const P of Pb) { let h = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) h = !h; } if (h) ins = !ins; } return ins; };
const COLS = 108, ROWS = 30;
let art = '';
for (let r = 0; r < ROWS; r++) { let ln = ''; for (let c = 0; c < COLS; c++) { const px = (c + 0.5) / COLS * VW, py = (r + 0.5) / ROWS * H; ln += inPoly(px, py) ? '#' : (hit(px, py) ? '*' : '.'); } art += ln + '\n'; }
console.log(art);
