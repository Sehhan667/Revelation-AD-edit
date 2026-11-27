/*
 * make_trace_compare.js — 把"描出来的多边形"和"原图掩膜"画在一起做对照
 *
 * 左：原图掩膜（从 logo_gray.txt 读）
 * 中：描出来的多边形（logo_polys.json）
 * 右：叠加（绿=都对，红=只在原图，蓝=只在多边形）
 *
 * 用途：一眼看出描摹丢了什么 / 多了什么。之前的锯齿、顶栏断裂都是这样定位的。
 */
const fs = require('fs');
const path = require('path');

const PACK = path.resolve(__dirname, '..');
const txt = fs.readFileSync(path.join(__dirname, 'logo_gray.txt'), 'utf8').split(/\r?\n/).filter(l => l.length);
const [W, H] = txt[0].split(/\s+/).map(Number);
const lum = new Uint8Array(W * H);
for (let y = 0; y < H; y++) { const r = txt[y + 1]; for (let x = 0; x < W; x++) lum[y * W + x] = parseInt(r.substr(x * 2, 2), 16); }

// 最大连通域
const lab = new Int32Array(W * H).fill(-1);
let best = { id: -1, n: 0 }, id = 0; const st = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lum[y * W + x] < 128 || lab[y * W + x] >= 0) continue;
    let n = 0; st.length = 0; st.push(x, y); lab[y * W + x] = id;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (lum[ny * W + nx] < 128 || lab[ny * W + nx] >= 0) continue;
            lab[ny * W + nx] = id; st.push(nx, ny);
        }
    }
    if (n > best.n) best = { id, n }; id++;
}
let X0 = W, X1 = -1, Y0 = H, Y1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lab[y * W + x] === best.id) {
    if (x < X0) X0 = x; if (x > X1) X1 = x; if (y < Y0) Y0 = y; if (y > Y1) Y1 = y;
}
const BW = X1 - X0 + 1, BH = Y1 - Y0 + 1;
const polys = JSON.parse(fs.readFileSync(path.join(__dirname, 'logo_polys.json'), 'utf8'));

// 多边形坐标是"设计框内坐标"，回到图像坐标要 +X0 / +Y0
const IN = (px, py) => {
    const x = px + X0 + 0.5, y = py + Y0 + 0.5;
    let inside = false;
    for (const p of polys) {
        let j = p.length - 1;
        for (let i = 0; i < p.length; i++) {
            const [xi, yi] = p[i], [xj, yj] = p[j];
            if ((yi > y) !== (yj > y)) {
                const xx = xi + (y - yi) / (yj - yi) * (xj - xi);
                if (x < xx) inside = !inside;
            }
            j = i;
        }
    }
    return inside;
};

const step = 4;
const cols = Math.ceil(BW / step), rows = Math.ceil(BH / step);
let tp = 0, fp = 0, fn = 0;
const left = [], mid = [], right = [];
for (let r = 0; r < rows; r++) {
    let a = '', b = '', c = '';
    for (let cc = 0; cc < cols; cc++) {
        const px = cc * step, py = r * step;
        const ref = lab[(Y0 + py) * W + (X0 + px)] === best.id;
        const mine = IN(px, py);
        if (ref && mine) tp++; else if (mine) fp++; else if (ref) fn++;
        a += ref ? '#' : ' ';
        b += mine ? '#' : ' ';
        c += ref && mine ? '#' : ref ? 'r' : mine ? 'b' : ' ';
    }
    left.push(a); mid.push(b); right.push(c);
}

console.log(`IoU ${(tp / (tp + fp + fn)).toFixed(4)}  召回 ${(tp / (tp + fn)).toFixed(4)}  精确率 ${(tp / (tp + fp)).toFixed(4)}`);
console.log(`图像 ${W}x${H}，主字形 bbox ${BW}x${BH} @(${X0},${Y0})，每格 ${step}px`);
console.log('\n  === 原图掩膜 ==='.padEnd(46) + '  === 描出的多边形 ==='.padEnd(46) + '  === 叠加(#都对 r只有原图 b只有多边形) ===');
for (let r = 0; r < rows; r++) {
    console.log('  ' + left[r].padEnd(42) + '  ' + mid[r].padEnd(42) + '  ' + right[r]);
}
