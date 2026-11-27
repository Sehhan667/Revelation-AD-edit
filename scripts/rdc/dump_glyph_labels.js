/*
 * dump_glyph_labels.js — 打印字模表里每个字形的注释标签与前两段，用来核对下标是否对
 * 用法：node rdc_analysis/dump_glyph_labels.js
 */
const fs = require('fs');
const path = require('path');
const PACK = path.resolve(__dirname, '..');
const g = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const m = /const vec4 AD_STROKES\[(\d+)\] = vec4\[\d+\]\(([\s\S]*?)\n\);/.exec(g);
if (!m) { console.error('找不到 AD_STROKES'); process.exit(1); }
const lines = m[0].split(/\r?\n/);
const labelRe = /^\s*\/\/\s*"(.+)"\s*$/;
let current = null;
const out = [];
for (const l of lines) {
    const lm = labelRe.exec(l);
    if (lm) { current = lm[1]; continue; }
    if (/vec4\(/.test(l) && current) { out.push({ g: current, first: l.trim() }); current = null; }
}
const SLOTS = parseInt(/#define\s+AD_GLYPH_SLOTS\s+(\d+)/.exec(g)[1], 10);
console.log(`声明 ${m[1]} 段，实际 ${[...m[2].matchAll(/vec4\(/g)].length} 段，字形 ${out.length} 个，SLOTS=${SLOTS}`);
out.forEach((o, i) => console.log(`  #${i} ${JSON.stringify(o.g).padEnd(8)} 首段 ${o.first}`));

// 每个字形有多少条非零段
const rows = [...m[2].matchAll(/vec4\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim())));
for (let gi = 0; gi < out.length; gi++) {
    let n = 0;
    for (let s = 0; s < SLOTS; s++) {
        const r = rows[gi * SLOTS + s];
        if (Math.hypot(r[2] - r[0], r[3] - r[1]) >= 1e-4) n++;
    }
    console.log(`  #${gi} ${JSON.stringify(out[gi].g).padEnd(8)} 非零段 ${n}`);
}
