/*
 * preview_text.js — 把 "AD Edit" 的字模按大字号画出来，单纯检查字形本身
 * （不受翻转/定位影响：这里刻意把字画成正向）
 * 用法：node rdc_analysis/preview_text.js [--px 64]
 */
const fs = require('fs');
const path = require('path');
const { loadAdFont } = require('./ad_font');

const PACK = path.resolve(__dirname, '..');
const font = loadAdFont(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'));

const argOf = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };
const PX = argOf('px', 64);          // 大写高 = 多少像素
const TEXT = (process.argv.find(a => a.startsWith('--text=')) || '--text=AD Edit').split('=')[1];

// 设计框坐标 -> 本图坐标：把设计 x0/y0 挪到左上留白处，按 PX/AD_H 缩放
const sc = PX / font.AD_H;
const PAD = 12;
const W = Math.ceil(font.totalW * sc) + PAD * 2;
const H = Math.ceil((font.AD_H * 2.0) * sc) + PAD * 2;

let lines = font.segments.map(s =>
    `<line x1="${(PAD + (s.x1 - font.x0) * sc).toFixed(2)}" y1="${(PAD + (s.y1 - font.y0) * sc).toFixed(2)}"` +
    ` x2="${(PAD + (s.x2 - font.x0) * sc).toFixed(2)}" y2="${(PAD + (s.y2 - font.y0) * sc).toFixed(2)}"/>`
);
const sw = (font.strokeHalf * 2 * sc).toFixed(2);
console.log(`文字 "${TEXT}"  字形 ${font.GLYPH_COUNT} 个  大写高 ${PX}px  笔画 ${sw}px  画布 ${W}x${H}`);
console.log(`字距：${font.advance.map(v => v.toFixed(3)).join(' / ')}   线段 ${font.segments.length} 条`);

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>字模预览</title>
<style>body{margin:0;background:#111;display:flex;flex-direction:column;gap:8px;padding:10px}
.p{background:#000;border:1px solid #333;align-self:flex-start}
line{stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:${sw}}
</style></head><body>
<div class="p"><svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${lines.join('')}</svg></div>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'text_preview.html'), html, 'utf8');
console.log('已写出 text_preview.html');
