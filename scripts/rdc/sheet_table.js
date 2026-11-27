/*
 * sheet_table.js — 把 StartupLogo.glsl 里 **实际生效的** 字模逐个放大画出来（带标签），
 * 用来确认每个字形到底是哪个字母。和 glyph_sheet2.js 的区别：那个画的是字体源数据，
 * 这个画的是最终进 shader 的表，能抓出"生成环节取错下标/截断"的问题。
 * 用法：node rdc_analysis/sheet_table.js [--px 90]
 */
const fs = require('fs');
const path = require('path');
const { loadAdFont } = require('./ad_font');

const PACK = path.resolve(__dirname, '..');
const glslPath = path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl');
const glsl = fs.readFileSync(glslPath, 'utf8');
const font = loadAdFont(glslPath);

const argOf = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };
const PX = argOf('px', 90);
const YSCALE = PX / 1.1667;          // 归一化坐标里大写高约 1.1667

const labels = [.../const vec4 AD_STROKES[\s\S]*?\n\);/.exec(glsl)[0]
    .matchAll(/\/\/\s*"(.+)"\s*\n\s*vec4\(/g)].map(m => m[1]);

const CELL = PX * 1.5, ROWH = PX * 1.7;
const COLS = 7;
const rows = Math.ceil(font.GLYPH_COUNT / COLS);
const W = Math.ceil(COLS * CELL), H = Math.ceil(rows * ROWH);

let s = '';
for (let g = 0; g < font.GLYPH_COUNT; g++) {
    const cx = (g % COLS) * CELL, cy = Math.floor(g / COLS) * ROWH;
    s += `<g transform="translate(${(cx + 14).toFixed(1)},${(cy + 10).toFixed(1)})">`;
    s += `<text x="0" y="${(PX + 26).toFixed(0)}" fill="#6cf" font-size="14" font-family="monospace">#${g} ${labels[g] === ' ' ? 'SP' : labels[g]}</text>`;
    s += `<g transform="scale(${YSCALE.toFixed(4)})">`;
    for (let sl = 0; sl < font.SLOTS; sl++) {
        const st = font.strokes[g * font.SLOTS + sl];
        if (Math.hypot(st[2] - st[0], st[3] - st[1]) < 1e-4) continue;
        s += `<line x1="${st[0].toFixed(4)}" y1="${st[1].toFixed(4)}" x2="${st[2].toFixed(4)}" y2="${st[3].toFixed(4)}"/>`;
    }
    s += `</g></g>`;
}
const sw = (font.strokeHalf / font.AD_H * (font.AD_H)).toFixed(3);   // 归一化单位下的笔画宽度
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>表内字形</title>
<style>body{margin:0;background:#111}svg{display:block}
line{stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:${(0.096).toFixed(3)}}
</style></head><body>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/>${s}</svg>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'sheet_table.html'), html, 'utf8');
console.log(`已写出 sheet_table.html  ${W}x${H}   字形 ${font.GLYPH_COUNT} 个，SLOTS ${font.SLOTS}`);
console.log(`笔画半宽（归一化）= ${font.strokeHalf} / 字号 ${font.AD_H} = ${(font.strokeHalf / font.AD_H).toFixed(4)}`);
