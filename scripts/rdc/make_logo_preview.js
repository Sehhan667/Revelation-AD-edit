/*
 * make_logo_preview.js — 从 StartupLogo.glsl 生成 SVG 预览 HTML（离线，开发用）
 *
 * 所有几何都**直接从 shader 文件里读**（LOGO_BOX_* / LOGO_PATH / AD_STROKES / 节奏常量），
 * 所以预览不可能和实机不一致：改了 shader 重跑本脚本即可。
 *
 * 输出：logo_preview.html（自包含，双击打开）
 *
 * 用法：node rdc_analysis/make_logo_preview.js [--out 路径]
 */
const fs = require('fs');
const path = require('path');

const PACK = path.resolve(__dirname, '..');
const GLSL_PATH = path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl');
const glsl = fs.readFileSync(GLSL_PATH, 'utf8');

function num(name) {
    const m = new RegExp(`#define\\s+${name}\\s+([-0-9.]+)`).exec(glsl);
    if (!m) throw new Error(`找不到 #define ${name}`);
    return parseFloat(m[1]);
}
function constInFn(name) {
    const m = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*([-0-9.]+)`).exec(glsl);
    if (!m) throw new Error(`找不到 const float ${name}`);
    return parseFloat(m[1]);
}

const BOX_W = num('LOGO_BOX_W');
const BOX_H = num('LOGO_BOX_H');
const AD_GAP = num('LOGO_AD_GAP');
const AD_H = num('LOGO_AD_H');
const MARK_FRAMES = num('LOGO_MARK_DRAW_FRAMES');
const AD_START = num('LOGO_AD_START_FRAME');
const AD_FRAMES = num('LOGO_AD_DRAW_FRAMES');
const GLYPH_COUNT = num('AD_GLYPH_COUNT');

// ---- 主字形：单个多边形 ----
const pb = /const vec2 LOGO_PATH\[(\d+)\] = vec2\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
if (!pb) throw new Error('找不到 LOGO_PATH 顶点表');
const PATH_COUNT = parseInt(pb[1], 10);
let PATH = [...pb[2].matchAll(/vec2\(([^)]+)\)/g)].map(m => m[1].split(',').map(s => parseFloat(s.trim())));
if (PATH.length !== PATH_COUNT) throw new Error(`LOGO_PATH ${PATH.length} ≠ ${PATH_COUNT}`);
if (PATH.length > 1 &&
    Math.abs(PATH[0][0] - PATH[PATH.length - 1][0]) < 1e-6 &&
    Math.abs(PATH[0][1] - PATH[PATH.length - 1][1]) < 1e-6) PATH = PATH.slice(0, -1);

// 归一化居中坐标 -> 设计框内源像素坐标
const toDesign = ([x, y]) => [(x + 0.5) * BOX_W, (y + 0.5) * BOX_H];

// ---- AD Edit 字模 ----
const ab = /const vec4 AD_STROKES\[(\d+)\] = vec4\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
if (!ab) throw new Error('找不到 AD_STROKES');
const AD = [...ab[2].matchAll(/vec4\(([^)]+)\)/g)].map(m => m[1].split(',').map(s => parseFloat(s.trim())));
if (AD.length !== GLYPH_COUNT * 6) throw new Error(`AD_STROKES ${AD.length} ≠ ${GLYPH_COUNT}×6`);

const AD_ASPECT = constInFn('aspect');
const AD_ADVANCE = constInFn('advance');
const AD_STROKE_HALF_REL = constInFn('strokeHalfRel');

const glyphW = AD_H * AD_ASPECT;
const totalW = ((GLYPH_COUNT - 1) * AD_ADVANCE + 1) * glyphW;
const adX0 = BOX_W * 0.5 - totalW * 0.5;
const adY0 = BOX_H + AD_GAP;
const adHalf = AD_STROKE_HALF_REL * AD_H;

const adGlyphs = [];
for (let g = 0; g < GLYPH_COUNT; g++) {
    const strokes = [];
    for (let s = 0; s < 6; s++) {
        const st = AD[g * 6 + s];
        if (Math.hypot(st[2] - st[0], st[3] - st[1]) < 1e-4) continue;
        strokes.push({
            x1: adX0 + g * AD_ADVANCE * glyphW + st[0] * glyphW,
            y1: adY0 + st[1] * AD_H,
            x2: adX0 + g * AD_ADVANCE * glyphW + st[2] * glyphW,
            y2: adY0 + st[3] * AD_H
        });
    }
    adGlyphs.push(strokes);
}

console.log(`shader 读出：设计框 ${BOX_W}×${BOX_H}，LOGO_PATH ${PATH.length} 顶点，AD 字模 ${GLYPH_COUNT} 字形`);
console.log(`             AD 布局 aspect=${AD_ASPECT} advance=${AD_ADVANCE} strokeHalfRel=${AD_STROKE_HALF_REL}`);

// ---- SVG 尺寸 ----
const contentH = BOX_H + AD_GAP + AD_H;
const pad = 20;
const svgW = BOX_W + pad * 2;
const svgH = contentH + pad * 2;
const dPath = 'M' + PATH.map(([x, y]) => {
    const p = toDesign([x, y]);
    return `${(p[0] + pad).toFixed(2)},${(p[1] + pad).toFixed(2)}`;
}).join('L') + 'Z';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Revelation 启动 Logo — 矢量预览</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0c; color: #d8d8dc;
    font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 26px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: #7d7d88; font-size: 12px; margin-bottom: 18px; }
  .stage { background: #000; border: 1px solid #23232b; border-radius: 10px; padding: 16px;
    display: flex; flex-direction: column; align-items: center; gap: 12px; }
  svg { display: block; width: 100%; max-width: 760px; height: auto; }
  .ad-stroke { stroke: #fff; fill: none; stroke-linecap: round; }
  .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px 18px; margin-top: 16px; }
  label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #9a9aa6; }
  input[type=range] { width: 100%; accent-color: #6ea8fe; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button { background: #1b1b22; color: #d8d8dc; border: 1px solid #30303a; border-radius: 7px;
    padding: 6px 13px; font-size: 13px; cursor: pointer; }
  button:hover { background: #24242e; }
  .badge { font-variant-numeric: tabular-nums; color: #6ea8fe; }
  code { background: #16161c; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .note { color: #7d7d88; font-size: 12px; margin-top: 14px; }
  table { border-collapse: collapse; font-size: 12px; margin-top: 10px; width: 100%; }
  th, td { border: 1px solid #23232b; padding: 4px 8px; text-align: left; }
  th { color: #9a9aa6; font-weight: 500; background: #14141a; }
  details { margin-top: 14px; }
  summary { cursor: pointer; color: #9a9aa6; font-size: 13px; }
</style>
</head>
<body>
  <h1>Revelation 启动 Logo — 矢量预览</h1>
  <div class="sub">几何直接从 <code>shaders/lib/post/StartupLogo.glsl</code> 读出，与实机渲染同一组常量。</div>

  <div class="stage">
    <svg id="logo" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
      <clipPath id="sweep"><rect id="sweepRect" x="0" y="0" width="${svgW}" height="${svgH}"/></clipPath>
      <g clip-path="url(#sweep)">
        <path id="mark" d="${dPath}" fill="#fff"/>
      </g>
      <g id="ad"></g>
    </svg>
    <div class="row">
      <button id="play">▶ 播放绘制动画</button>
      <button id="reset">重置</button>
      <span class="badge" id="frameLabel">frame —</span>
    </div>
  </div>

  <div class="controls">
    <label>绘制进度 <input type="range" id="progress" min="0" max="1" step="0.005" value="1"></label>
    <label>整体缩放 <input type="range" id="scale" min="0.5" max="3" step="0.05" value="1"></label>
    <label>上下位置 <input type="range" id="offset" min="-0.6" max="0.6" step="0.01" value="0"></label>
    <label>主字形不透明度 <input type="range" id="alpha" min="0" max="1" step="0.01" value="1"></label>
  </div>

  <details open>
    <summary>几何数据（这就是 shader 里的表，改它 = 改形状）</summary>
    <table>
      <tr><th>项</th><th>值</th></tr>
      <tr><td>设计框（源像素）</td><td>${BOX_W} × ${BOX_H}</td></tr>
      <tr><td>主字形顶点数</td><td>${PATH.length}</td></tr>
      <tr><td>AD 字号 / 间距</td><td>${AD_H} / ${AD_GAP}</td></tr>
      <tr><td>节奏（帧）</td><td>主字形 ${MARK_FRAMES}，文字 ${AD_START}→${AD_START + AD_FRAMES}</td></tr>
    </table>
    <table>
      <tr><th>#</th><th>归一化 (x, y)</th><th>设计框内 (px, py)</th></tr>
      ${PATH.map(([x, y], i) => {
        const p = toDesign([x, y]);
        return `<tr><td>${i}</td><td>${x.toFixed(4)}, ${y.toFixed(4)}</td><td>${p[0].toFixed(1)}, ${p[1].toFixed(1)}</td></tr>`;
      }).join('\n      ')}
    </table>
  </details>

  <div class="note">
    主字形是**单个多边形**（不是矩形拼的），斜边是干净的直线，放大也没有台阶。
    AD Edit 是矢量的线段 + 圆头。上面是原始分辨率（设计框 ${BOX_W}×${BOX_H} 源像素）。
  </div>

<script>
const MARK_FRAMES = ${MARK_FRAMES}, AD_START = ${AD_START}, AD_FRAMES = ${AD_FRAMES};
const AD_GLYPHS = ${JSON.stringify(adGlyphs)};
const AD_HALF = ${adHalf};
const PAD = ${pad}, BOX_H = ${BOX_H}, BOX_W = ${BOX_W}, AD_GAP = ${AD_GAP}, AD_H = ${AD_H};

const sweepRect = document.getElementById('sweepRect');
const adG = document.getElementById('ad');
const progressEl = document.getElementById('progress');
const scaleEl = document.getElementById('scale');
const offsetEl = document.getElementById('offset');
const alphaEl = document.getElementById('alpha');
const frameLabel = document.getElementById('frameLabel');
const markEl = document.getElementById('mark');

const AD_ELS = [];
AD_GLYPHS.forEach((strokes, g) => strokes.forEach((s, si) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  el.setAttribute('class', 'ad-stroke');
  el.setAttribute('stroke-width', (AD_HALF * 2).toFixed(2));
  el.setAttribute('x1', (s.x1 + PAD).toFixed(2));
  el.setAttribute('y1', (s.y1 + PAD).toFixed(2));
  el.setAttribute('x2', (s.x2 + PAD).toFixed(2));
  el.setAttribute('y2', (s.y2 + PAD).toFixed(2));
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  el.setAttribute('stroke-dasharray', len.toFixed(2));
  adG.appendChild(el);
  AD_ELS.push({ g, si, el, len });
}));

function render() {
  const p = parseFloat(progressEl.value);
  sweepRect.setAttribute('height', (PAD + BOX_H * p).toFixed(2));
  markEl.style.opacity = alphaEl.value;

  const total = MARK_FRAMES + AD_START + AD_FRAMES;
  const adLocal = Math.min(Math.max((p * total - AD_START) / Math.max(AD_FRAMES, 1), 0), 1);
  const gp = Math.min(Math.max(adLocal * AD_GLYPHS.length, 0), AD_GLYPHS.length);
  AD_ELS.forEach(({ g, si, el, len }) => {
    const glyphP = Math.min(Math.max(gp - g, 0), 1);
    const segP = Math.min(Math.max(glyphP * 5 - si, 0), 1);
    el.setAttribute('stroke-dashoffset', (len * (1 - segP)).toFixed(2));
    el.style.opacity = segP > 0 ? 1 : 0;
  });
}

function applyView() {
  const k = parseFloat(scaleEl.value);
  const off = parseFloat(offsetEl.value);
  const cx = PAD + BOX_W / 2, cy = PAD + (BOX_H + AD_GAP + AD_H) / 2;
  const t = 'translate(' + cx + ' ' + cy + ') scale(' + k + ') translate(' + (-cx) + ' ' + (-cy) + ') translate(0 ' + (off * 120) + ')';
  [markEl, adG].forEach(el => el.setAttribute('transform', t));
}

let raf = null;
function play() {
  if (raf) cancelAnimationFrame(raf);
  const total = MARK_FRAMES + AD_START + AD_FRAMES;
  let f = 0;
  const step = () => {
    progressEl.value = Math.min(f / total, 1);
    frameLabel.textContent = 'frame ' + Math.round(f) + ' / ' + total;
    render();
    f += 2;
    if (f <= total) raf = requestAnimationFrame(step);
    else frameLabel.textContent = '画完（' + total + ' 帧）';
  };
  step();
}
document.getElementById('play').onclick = play;
document.getElementById('reset').onclick = () => {
  if (raf) cancelAnimationFrame(raf);
  progressEl.value = 1;
  frameLabel.textContent = 'frame —';
  render();
};
[progressEl, alphaEl].forEach(el => el.addEventListener('input', render));
[scaleEl, offsetEl].forEach(el => el.addEventListener('input', applyView));

render();
applyView();
</script>
</body>
</html>
`;

const outArgIdx = process.argv.indexOf('--out');
const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : path.join(PACK, 'logo_preview.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(`\n已写出 ${path.relative(PACK, outPath)}（${(html.length / 1024).toFixed(1)} KB）`);
