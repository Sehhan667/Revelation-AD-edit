/*
 * flip_compare.js — 生成"翻转 / 不翻转"并排对照图，用来一次定死 LOGO_FLIP_Y 该取什么
 *
 * 为什么需要：片元坐标 gl_FragCoord 的 y 方向（上正还是下正）在离线没法直接验证，
 * 而推断过程容易绕进去。直接把两种取值的实机尺寸画面并排画出来，看一眼就知道哪个对。
 *
 * 用法：node rdc_analysis/flip_compare.js [--w 1920] [--h 1080]
 */
const fs = require('fs');
const path = require('path');

const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return process.argv[i + 1];
        if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
    }
    return d;
};
const PACK = path.resolve(__dirname, '..');
const glsl = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl)[1]);

const BOX_W = num('LOGO_BOX_W'), BOX_H = num('LOGO_BOX_H');
const AD_GAP = num('LOGO_AD_GAP'), AD_H = num('LOGO_AD_H');
const LOGO_HEIGHT = num('LOGO_HEIGHT'), OFFSET_Y = num('LOGO_OFFSET_Y');
const GLYPH_COUNT = num('AD_GLYPH_COUNT'), SLOTS = num('AD_GLYPH_SLOTS');
const POLY_COUNT = num('LOGO_POLY_COUNT');

const PATHS = [];
for (let i = 0; i < POLY_COUNT; i++) {
    const re = new RegExp(`const vec2 LOGO_POLY${i}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`);
    const m = re.exec(glsl);
    let pts = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim())));
    PATHS.push(pts);
}
const toDesign = ([x, y]) => [(x + 0.5) * BOX_W, (y + 0.5) * BOX_H];

const AD = (() => {
    const m = /const vec4 AD_STROKES\[(\d+)\] = vec4\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
    return [...m[2].matchAll(/vec4\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim())));
})();
const ADV = (() => {
    const m = /const float AD_ADVANCE\[(\d+)\] = float\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
    return m[2].split(',').map(s => parseFloat(s.trim()));
})();
const STROKE_HALF_REL = parseFloat(/const\s+float\s+strokeHalfRel\s*=\s*([-0-9.]+)/.exec(glsl)[1]);

const contentH = BOX_H + AD_GAP + AD_H;
const dPath = PATHS.map(P => 'M' + P.map(([x, y]) => {
    const d = toDesign([x, y]);
    return `${d[0].toFixed(2)},${d[1].toFixed(2)}`;
}).join('L') + 'Z').join(' ');

let adLines = [];
{
    let penX = BOX_W * 0.5 - ADV.reduce((a, b) => a + b, 0) * AD_H * 0.5;
    for (let g = 0; g < GLYPH_COUNT; g++) {
        const ox = penX; penX += ADV[g] * AD_H;
        for (let s = 0; s < SLOTS; s++) {
            const st = AD[g * SLOTS + s];
            if (Math.hypot(st[2] - st[0], st[3] - st[1]) < 1e-4) continue;
            adLines.push(`<line x1="${(ox + st[0] * AD_H).toFixed(2)}" y1="${(BOX_H + AD_GAP + st[1] * AD_H).toFixed(2)}" x2="${(ox + st[2] * AD_H).toFixed(2)}" y2="${(BOX_H + AD_GAP + st[3] * AD_H).toFixed(2)}"/>`);
        }
    }
}

const VW = parseInt(argOf('w', 1920), 10), VH = parseInt(argOf('h', 1080), 10);
const pxPerUnit = LOGO_HEIGHT * VH / BOX_H;
const boxW = BOX_W * pxPerUnit, boxH = contentH * pxPerUnit;
const boxX = (VW - boxW) / 2;
const boxY = (VH - boxH) / 2 + OFFSET_Y * VH;

// 两个候选：
//   A: LOGO_FLIP_Y = 0 —— p 直接用设计坐标（假设 gl_FragCoord.y 向下增）
//   B: LOGO_FLIP_Y = 1 —— p.y = contentH - p.y（假设 gl_FragCoord.y 向上增）
// 画面里 boxOrigin 的算法两者相同；区别只在设计坐标 y 是否镜像。
function panel(flip, label) {
    const t = flip
        ? `transform="translate(0,${contentH}) scale(1,-1)"`
        : '';
    return `
  <div class="col">
    <div class="lbl">${label}</div>
    <div class="game" style="width:${VW * 0.5}px;height:${VH * 0.5}px">
      <div class="sky"></div>
      <svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"
           style="position:absolute;inset:0">
        <g transform="translate(${boxX.toFixed(1)},${boxY.toFixed(1)}) scale(${pxPerUnit.toFixed(4)})">
          <g ${t}>
            <path d="${dPath}" fill="#fff" fill-rule="nonzero"/>
            <g class="ad">${adLines.join('')}</g>
          </g>
        </g>
      </svg>
    </div>
  </div>`;
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>LOGO_FLIP_Y 对照</title>
<style>
  body{margin:0;background:#0a0a0c;color:#d8d8dc;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;padding:16px}
  h1{font-size:16px;margin:0 0 4px} .sub{color:#8b8b96;font-size:12px;margin-bottom:12px}
  .row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
  .lbl{font-size:13px;color:#9fd0ff;margin-bottom:6px}
  .game{position:relative;overflow:hidden;border:1px solid #2a2a33;border-radius:6px}
  .sky{position:absolute;inset:0;background:linear-gradient(#4a6a8a,#9fb8cd 45%,#7f9a6a 46%,#4d6b3d 100%)}
  .ad{stroke:#fff;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-width:${(STROKE_HALF_REL * 2 * AD_H).toFixed(3)}}
</style></head><body>
  <h1>LOGO_FLIP_Y 对照 —— 哪个和实机一致？</h1>
  <div class="sub">两边只有"设计坐标 y 是否镜像"这一个差别，其余完全相同。看哪个方向的 <b>ZV 标志</b> 和游戏里一样。</div>
  <div class="row">
    ${panel(false, 'A：LOGO_FLIP_Y = 0')}
    ${panel(true, 'B：LOGO_FLIP_Y = 1（当前）')}
  </div>
</body></html>
`;
const out = path.join(__dirname, 'flip_compare.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已写出 ${path.basename(out)}   ${VW}x${VH} -> 每格 ${(VW * 0.5)}x${(VH * 0.5)}`);
console.log(`boxOrigin=(${boxX.toFixed(1)}, ${boxY.toFixed(1)})  pxPerUnit=${pxPerUnit.toFixed(4)}  contentH=${contentH.toFixed(2)}`);
