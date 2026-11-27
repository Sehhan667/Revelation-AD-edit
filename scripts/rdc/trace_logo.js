/*
 * trace_logo.js — 从干净 logo 图描出真实轮廓，简化成顶点表，并**自校验**
 *
 * 教训（这一版为什么要重写）：
 *   1) 只保留一个连通域会丢掉另一段笔画；
 *   2) 没有"把重建多边形栅格化回去和原掩膜比对"的步骤，所以错了很久没发现。
 * 现在：直接读 PNG → 8 邻接连通域 → Moore 轮廓 → Douglas–Peucker → 栅格化自校验（IoU + ASCII 差异图）。
 *
 * 用法：node rdc_analysis/trace_logo.js [--png 1789124983903.png] [--tol 1.5] [--thr 128]
 */
const fs = require('fs');
const path = require('path');
const { readPNG } = require('./png_read');

const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return process.argv[i + 1];
        if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
    }
    return d;
};
const PACK = path.resolve(__dirname, '..');
const PNG = argOf('png', '1789124983903.png');
const TOL = parseFloat(argOf('tol', 1.5));
const THR = parseInt(argOf('thr', 128), 10);

const im = readPNG(path.resolve(PACK, PNG));
const gray = new Uint8Array(im.w * im.h);
for (let i = 0, n = im.w * im.h; i < n; i++) {
    const p = i * im.ch;
    gray[i] = im.ch >= 3 ? Math.round(0.299 * im.px[p] + 0.587 * im.px[p + 1] + 0.114 * im.px[p + 2]) : im.px[p];
}
const W = im.w, H = im.h;
const lit = (x, y) => x >= 0 && y >= 0 && x < W && y < H && gray[y * W + x] >= THR;

// ---------- 连通域（8 邻接：笔画在斜角处是斜着连的）----------
const comp = new Int32Array(W * H).fill(-1);
const comps = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (comp[y * W + x] >= 0 || !lit(x, y)) continue;
    const id = comps.length;
    const st = [x, y]; comp[y * W + x] = id;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (!lit(nx, ny) || comp[ny * W + nx] >= 0) continue;
            comp[ny * W + nx] = id; st.push(nx, ny);
        }
    }
    comps.push({ id, n, x0, y0, x1, y1 });
}
console.log(`读入 ${PNG} (${W}x${H})  阈值 ${THR}`);
comps.slice().sort((a, b) => b.n - a.n).slice(0, 10)
    .forEach(c => console.log(`  id=${c.id}  ${c.n} px  bbox x ${c.x0}..${c.x1}  y ${c.y0}..${c.y1}`));

const MIN_BLOB = 400;
const keep = comps.filter(c => c.n >= MIN_BLOB);
const keepIds = new Set(keep.map(c => c.id));
const BX0 = Math.min(...keep.map(c => c.x0)), BX1 = Math.max(...keep.map(c => c.x1));
const BY0 = Math.min(...keep.map(c => c.y0)), BY1 = Math.max(...keep.map(c => c.y1));
console.log(`保留 ${keep.length} 个域，整体 bbox x ${BX0}..${BX1} (${BX1 - BX0 + 1})  y ${BY0}..${BY1} (${BY1 - BY0 + 1})`);

// ---------- Moore 轮廓跟踪 ----------
function traceComponent(cid) {
    let sx = -1, sy = -1;
    outer: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
        if (comp[y * W + x] === cid) { sx = x; sy = y; break outer; }
    const DX = [1, 0, -1, -1, -1, 0, 1, 1];
    const DY = [0, 1, 1, 1, 0, -1, -1, -1];
    const pts = [];
    let cx = sx, cy = sy, dir = 6, guard = 0;
    do {
        pts.push([cx, cy]);
        let found = false;
        for (let k = 0; k < 8; k++) {
            const d = (dir + 6 + k) % 8;
            const nx = cx + DX[d], ny = cy + DY[d];
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && comp[ny * W + nx] === cid) {
                cx = nx; cy = ny; dir = d; found = true; break;
            }
        }
        if (!found) break;
        if (++guard > 4000000) { console.warn('  轮廓跟踪超出步数上限'); break; }
    } while (!(cx === sx && cy === sy));
    return pts;
}

function dp(points, tol) {
    if (points.length < 3) return points.slice();
    const keepF = new Uint8Array(points.length);
    keepF[0] = keepF[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [i0, i1] = stack.pop();
        if (i1 <= i0 + 1) continue;
        const [x0, y0] = points[i0], [x1, y1] = points[i1];
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1e-9;
        let maxD = -1, maxI = -1;
        for (let i = i0 + 1; i < i1; i++) {
            const [px, py] = points[i];
            const d = Math.abs((px - x0) * dy - (py - y0) * dx) / len;
            if (d > maxD) { maxD = d; maxI = i; }
        }
        if (maxD > tol) { keepF[maxI] = 1; stack.push([i0, maxI], [maxI, i1]); }
    }
    return points.filter((_, i) => keepF[i]);
}

const polys = [];
for (const c of keep) {
    const raw = traceComponent(c.id);
    if (raw.length < 8) { console.log(`  id=${c.id} 轮廓点太少(${raw.length})，跳过`); continue; }
    const s = dp(raw, TOL);
    polys.push(s);
    console.log(`  id=${c.id}: 原始轮廓 ${raw.length} 点 -> 简化 ${s.length} 点`);
}

// ---------- 自校验 ----------
function insidePolys(x, y) {
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
}
let tp = 0, fp = 0, fn = 0;
const diff = [];
const PAD = 4;
for (let y = BY0 - PAD; y <= BY1 + PAD; y++) {
    let row = '';
    for (let x = BX0 - PAD; x <= BX1 + PAD; x++) {
        const inRange = y >= 0 && y < H && x >= 0 && x < W;
        const ref = inRange && comp[y * W + x] >= 0 && keepIds.has(comp[y * W + x]);
        const mine = insidePolys(x + 0.5, y + 0.5);
        if (ref && mine) { tp++; row += '#'; }
        else if (mine) { fp++; row += '+'; }
        else if (ref) { fn++; row += '-'; }
        else row += '.';
    }
    diff.push(row);
}
console.log(`\n栅格化自校验：IoU=${(tp / (tp + fp + fn)).toFixed(4)}  召回=${(tp / (tp + fn)).toFixed(4)}  精确率=${(tp / (tp + fp)).toFixed(4)}`);
console.log(`  漏(应为白却空 '-') ${fn} px   多(应为黑却白 '+') ${fp} px`);

if (fp + fn === 0) console.log('  无差异像素');
else {
    const badRows = diff.map((r, i) => [i, (r.match(/[-+]/g) || []).length]).filter(([, n]) => n > 0);
    console.log(`  有差异的行数 ${badRows.length}（共 ${diff.length} 行）`);
    console.log(`\n差异区域（每 10 行抽样；# 重合  - 漏  + 多）：`);
    let shown = 0;
    for (let i = 0; i < diff.length; i += 10) {
        if (shown++ > 60) { console.log('  ...（省略）'); break; }
        console.log(`  y=${BY0 - PAD + i}  ${diff[i].slice(0, 190)}`);
    }
}

// ---------- 输出归一化顶点 ----------
const BW = BX1 - BX0 + 1, BH = BY1 - BY0 + 1;
const norm = polys.map(p => p.map(([x, y]) => [(x - BX0) / BW - 0.5, (y - BY0) / BH - 0.5]));
console.log(`\n设计框 ${BW} x ${BH}（源图像素）`);
norm.forEach((p, i) => {
    console.log(`-- 多边形 ${i}：${p.length} 点`);
    console.log('  ' + p.map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join('  '));
    console.log('  设计坐标: ' + p.map(([x, y]) => `${((x + 0.5) * BW).toFixed(1)},${((y + 0.5) * BH).toFixed(1)}`).join('  '));
});
fs.writeFileSync(path.resolve(__dirname, 'logo_polys.json'),
    JSON.stringify({ box: { x0: BX0, y0: BY0, w: BW, h: BH }, polys: norm }, null, 1) + '\n');
console.log(`\n已写出 logo_polys.json（含 ${polys.length} 个多边形）`);
