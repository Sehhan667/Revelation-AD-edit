/*
 * comp_profile.js — 打印每个连通域逐行的左右边界，用来推断真实直边
 * 用法：node rdc_analysis/comp_profile.js [--step 8]
 */
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
const lit = (x, y) => x >= 0 && y >= 0 && x < W && y < H && im.px[(y * W + x) * im.ch] >= THR;

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
            if (!lit(nx, ny) || comp[ny * W + nx] >= 0) continue;
            comp[ny * W + nx] = id; st.push(nx, ny);
        }
    }
    comps.push({ id, n });
}
comps.sort((a, b) => b.n - a.n);
const STEP = parseInt(argOf('step', 8), 10);

for (const c of comps.slice(0, 2)) {
    console.log(`\n=== 域 id=${c.id}  ${c.n} px  逐行区间（每 ${STEP} 行）===`);
    for (let y = 0; y < H; y += STEP) {
        const segs = [];
        let s = -1;
        for (let x = 0; x < W; x++) {
            const mine = comp[y * W + x] === c.id;
            if (mine && s < 0) s = x; else if (!mine && s >= 0) { segs.push(`${s}-${x - 1}`); s = -1; }
        }
        if (s >= 0) segs.push(`${s}-${W - 1}`);
        if (segs.length) console.log(`  y=${String(y).padStart(4)}  ${segs.join(' | ')}`);
    }
}
