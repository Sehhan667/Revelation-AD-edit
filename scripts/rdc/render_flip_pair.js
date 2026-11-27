/*
 * render_flip_pair.js — 用"几何本身正确"的那套定义，渲染 FLIP_Y=0 / 1 两种结果并排图，
 * 两种情况的画面都按"屏幕坐标 y 向下"画（也就是玩家看到的样子）。
 *
 * 结论依据：LOGO_FLIP_Y=0 时实机是"图案倒 + 文字跑到图案上方"，
 * 而 FLIP_Y=1 时图案正、文字在下方。两种症状必须同时对上才算改对。
 *
 * 用法：node rdc_analysis/render_flip_pair.js [--w 1920] [--h 1080]
 */
const fs = require('fs');
const path = require('path');
const { loadAdFont } = require('./ad_font');

const PACK = path.resolve(__dirname, '..');
const GLSL = path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl');
const glsl = fs.readFileSync(GLSL, 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl)[1]);

const BOX_W = num('LOGO_BOX_W'), BOX_H = num('LOGO_BOX_H');
const AD_GAP = num('LOGO_AD_GAP'), AD_H = num('LOGO_AD_H');
const LOGO_HEIGHT = num('LOGO_HEIGHT'), OFFSET_Y = num('LOGO_OFFSET_Y');
const POLY_COUNT = num('LOGO_POLY_COUNT');
const font = loadAdFont(GLSL);

const PATHS = [];
for (let i = 0; i < POLY_COUNT; i++) {
    const m = new RegExp(`const vec2 LOGO_POLY${i}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`).exec(glsl);
    PATHS.push([...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim()))));
}
const toDesign = ([x, y]) => [(x + 0.5) * BOX_W, (y + 0.5) * BOX_H];
const dPath = PATHS.map(P => 'M' + P.map(([x, y]) => {
    const p = toDesign([x, y]);
    return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
}).join('L') + 'Z').join(' ');
const adLines = font.segments.map(s =>
    `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}"/>`
).join('');

const argOf = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };
const VW = argOf('w', 1920), VH = argOf('h', 1080);
const SC = argOf('scale', 0.5);

const contentH = BOX_H + AD_GAP + AD_H;
const pxPerUnit = LOGO_HEIGHT * VH / BOX_H;
const boxW = BOX_W * pxPerUnit, boxH = contentH * pxPerUnit;
const boxX = (VW - boxW) / 2;
const boxY = (VH - boxH) / 2 + OFFSET_Y * VH;

// 把"设计框 + 是否镜像"画进一个固定尺寸的格子里
function panel(flip, label, note) {
    const t = flip ? `translate(0,${contentH}) scale(1,-1)` : '';
    // 用外层 div 定位设计框在画面中的位置，再由 SVG 的 viewBox 铺满整屏
    return `<div class="col">
  <div class="lbl">${label}</div>
  <div class="game" style="width:${(VW * SC).toFixed(0)}px;height:${(VH * SC).toFixed(0)}px">
    <div class="sky"></div>
    <svg viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0">
      <g transform="translate(${boxX.toFixed(2)},${boxY.toFixed(2)}) scale(${pxPerUnit.toFixed(4)})">
        <g transform="${t}">
          <path d="${dPath}" fill="#fff" fill-rule="nonzero"/>
          <g class="ad">${adLines}</g>
        </g>
      </g>
    </svg>
  </div>
  <div class="note">${note}</div>
</div>`;
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>翻转对照</title>
<style>
 body{margin:0;background:#0a0a0c;color:#d8d8dc;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;padding:16px}
 h1{font-size:16px;margin:0 0 4px} .sub{color:#8b8b96;font-size:12px;margin-bottom:12px}
 .row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
 .lbl{font-size:14px;color:#9fd0ff;margin-bottom:6px;font-weight:600}
 .note{font-size:12px;color:#8b8b96;margin-top:6px;max-width:${(VW * SC).toFixed(0)}px}
 .game{position:relative;overflow:hidden;border:1px solid #2a2a33;border-radius:6px}
 .sky{position:absolute;inset:0;background:linear-gradient(#4a6a8a,#9fb8cd 45%,#7f9a6a 46%,#4d6b3d 100%)}
 .ad{stroke:#fff;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-width:${font.strokeWidth.toFixed(3)}}
</style></head><body>
<h1>LOGO_FLIP_Y 对照 —— 哪个和实机一致？</h1>
<div class="sub">两边其余完全相同，只有"设计坐标 y 是否镜像"这一处差别。看 ZV 标志的方向。</div>
<div class="row">
 ${panel(false, 'A：LOGO_FLIP_Y = 0', '上一版实机就是这个 —— 你说"图案上下反转"，而且文字跑到了图案上方。')}
 ${panel(true, 'B：LOGO_FLIP_Y = 1（当前）', '设计坐标做了一次 y 镜像，图案正过来，文字回到图案下方。')}
</div>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'flip_pair.html'), html, 'utf8');
console.log(`已写出 flip_pair.html  每格 ${(VW * SC).toFixed(0)}x${(VH * SC).toFixed(0)}`);
console.log(`boxOrigin=(${boxX.toFixed(1)}, ${boxY.toFixed(1)})  pxPerUnit=${pxPerUnit.toFixed(4)}`);
