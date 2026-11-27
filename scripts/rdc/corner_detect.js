/*
 * corner_detect.js — 在精确边界环上按"形状尺度"检测真正的拐点
 *
 * 思路：像素边界每走一格就拐一次弯，直接找拐点会得到上千个假拐点。
 * 改为先按同一方向把连续的 1 像素步合并成"步段"，再在步段序列上找方向突变
 * （合计方向向量超过阈值才算真拐点），得到的就是 logo 的真实顶点。
 * 逐域栅格化自校验，IoU 必须接近 1。
 *
 * 用法：node rdc_analysis/corner_detect.js [--png ...] [--win 6] [--ang 8]
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
const im = readPNG(path.join(PACK, argOf('png', '1789124983903.png')));
const W = im.w, H = im.h, THR = 128;
const WIN = parseInt(argOf('win', 6), 10);      // 方向估计窗口（单位步数）
const ANG = parseFloat(argOf('ang', 8));        // 方向变化阈值（度）
const lum = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    const i = (y * W + x) * im.ch;
    return im.ch >= 3 ? Math.round(0.299 * im.px[i] + 0.587 * im.px[i + 1] + 0.114 * im.px[i + 2]) : im.px[i];
};
const lit = (x, y) => lum(x, y) >= THR;

// 连通域
const comp = new Int32Array(W * H).fill(-1);
const comps = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (comp[y * W + x] >= 0 || !lit(x, y)) continue;
    const id = comps.length; const st = [x, y]; comp[y * W + x] = id; let n = 0;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (lit(nx, ny) && comp[ny * W + nx] < 0) { comp[ny * W + nx] = id; st.push(nx, ny); }
        }
    }
    comps.push({ id, n });
}
const keepIds = new Set(comps.filter(c => c.n >= 400).map(c => c.id));

// 精确边界环
const edgeMap = new Map();
const key = (x, y) => y * (W + 1) + x;
const add = (x1, y1, x2, y2) => { const k = key(x1, y1); if (!edgeMap.has(k)) edgeMap.set(k, []); edgeMap.get(k).push([x2, y2]); };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!keepIds.has(comp[y * W + x])) continue;
    if (!lit(x, y - 1)) add(x, y, x + 1, y);
    if (!lit(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!lit(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!lit(x - 1, y)) add(x, y + 1, x, y);
}
const used = new Set();
const EK = (a, b, c, d) => `${a},${b}>${c},${d}`;
const rings = [];
for (const [sk, outs] of edgeMap) {
    for (const o of outs) {
        const sx = sk % (W + 1), sy = Math.floor(sk / (W + 1));
        if (used.has(EK(sx, sy, o[0], o[1]))) continue;
        const ring = [];
        let cx = sx, cy = sy, nx = o[0], ny = o[1], guard = 0;
        while (true) {
            ring.push([cx, cy]);
            used.add(EK(cx, cy, nx, ny));
            cx = nx; cy = ny;
            if (cx === sx && cy === sy) break;
            const cand = edgeMap.get(key(cx, cy));
            let next = null;
            if (cand) for (const c of cand) if (!used.has(EK(cx, cy, c[0], c[1]))) { next = c; break; }
            if (!next) break;
            nx = next[0]; ny = next[1];
            if (++guard > 4000000) break;
        }
        if (ring.length >= 4) rings.push(ring);
    }
}
console.log(`边界环 ${rings.length} 个，点数 ${rings.map(r => r.length).join(', ')}`);

// ---------- 方向突变检测 ----------
function detectCorners(ring) {
    const n = ring.length;
    // ring 中相邻点是单位步（正交），方向 = 下一步 - 当前点
    const corners = [];
    let i = 0;
    let guard = 0;
    while (i < n && guard++ < 100000) {
        // 当前段方向
        const d0 = [ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]];
        // 向前看 WIN 步，累计方向
        let acc = [0, 0];
        for (let k = 0; k < WIN; k++) {
            const a = ring[(i + k) % n], b = ring[(i + k + 1) % n];
            acc[0] += b[0] - a[0]; acc[1] += b[1] - a[1];
        }
        const nrm = Math.hypot(acc[0], acc[1]);
        const angCur = Math.atan2(acc[1], acc[0]);
        // 找到方向改变超过 ANG 的位置
        let j = i + 1, found = -1;
        while (j < i + n) {
            let a2 = [0, 0];
            for (let k = 0; k < WIN; k++) {
                const a = ring[(j + k) % n], b = ring[(j + k + 1) % n];
                a2[0] += b[0] - a[0]; a2[1] += b[1] - a[1];
            }
            if (Math.hypot(a2[0], a2[1]) > 1e-9) {
                let dAng = Math.atan2(a2[1], a2[0]) - angCur;
                while (dAng > Math.PI) dAng -= 2 * Math.PI;
                while (dAng < -Math.PI) dAng += 2 * Math.PI;
                if (Math.abs(dAng) * 180 / Math.PI > ANG) { found = j; break; }
            }
            j++;
        }
        if (found < 0) { corners.push(ring[i % n]); break; }
        // 拐点取 found 处（回退半个窗口，估计真实拐点位置）
        const idx = (found + Math.floor(WIN / 2)) % n;
        corners.push(ring[idx]);
        i = found + 1;
    }
    return corners;
}

function areaOf(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
    return a / 2;
}

const polys = [];
for (const r of rings) {
    const a = areaOf(r);
    if (a <= 0) { console.log(`  环面积 ${a.toFixed(1)} ≤ 0（顺时针/洞），跳过`); continue; }
    const c = detectCorners(r);
    console.log(`  环 ${r.length} 点 -> 拐点 ${c.length} 个  面积 ${a.toFixed(1)}`);
    console.log('    ' + c.map(([x, y]) => `(${x},${y})`).join(' '));
    polys.push(c);
}

// ---------- 栅格化自校验 ----------
function inside(x, y) {
    let ins = false;
    for (const p of polys) {
        let j = p.length - 1;
        for (let i = 0; i < p.length; i++) {
            const [xi, yi] = p[i], [xj, yj] = p[j];
            if ((yi > y) !== (yj > y)) {
                const xx = xi + (y - yi) / (yj - yi) * (xj - xi);
                if (x < xx) ins = !ins;
            }
            j = i;
        }
    }
    return ins;
}
let tp = 0, fp = 0, fn = 0;
const rows = [];
for (let y = 0; y < H; y++) {
    let line = '';
    for (let x = 0; x < W; x++) {
        const ref = keepIds.has(comp[y * W + x]);
        const mine = inside(x + 0.5, y + 0.5);
        if (ref && mine) tp++;
        else if (mine) { fp++; line += '+'; }
        else if (ref) { fn++; line += '-'; }
    }
    if (/[-+]/.test(line)) rows.push([y, line]);
}
console.log(`\n栅格化自校验：IoU=${(tp / (tp + fp + fn)).toFixed(5)}  漏 ${fn} px  多 ${fp} px`);
console.log(`  有差异的行 ${rows.length} 行`);
for (let i = 0; i < Math.min(rows.length, 24); i++) {
    const [y, line] = rows[i];
    // 只打印差异附近的片段
    const idxs = [...line].map((c, k) => c === '-' || c === '+' ? k : -1).filter(k => k >= 0);
    const lo = Math.max(0, idxs[0] - 3), hi = Math.min(W, idxs[idxs.length - 1] + 4);
    console.log(`    y=${y}  x${lo}..${hi}  ${line.slice(lo, hi)}`);
}
if (rows.length > 24) console.log('    ...');

fs.writeFileSync(path.resolve(__dirname, 'corner_result.json'), JSON.stringify(polys) + '\n');
console.log('\n已写出 corner_result.json');
