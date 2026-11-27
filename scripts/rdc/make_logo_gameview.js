/*
 * make_logo_gameview.js — 生成"实机尺寸"预览：把 logo 叠在一张假背景上，按真实比例渲染
 *
 * 为什么需要它：网页预览是 1:1 原始分辨率（设计框 600×283 源像素），看着很干净；
 * 但实机里 LOGO_HEIGHT=0.22 意味着主字形只占屏幕高度的 1/5 左右 —— 1080p 下约 238 px 高。
 * 按真实尺寸看一眼才能判断"能不能看"。
 *
 * 所有常量都从 shader 读（含字模），所以不会出现"预览和实机不一致"。
 *
 * 用法：node rdc_analysis/make_logo_gameview.js [--w 1920] [--h 1080]
 */
const fs = require('fs');
const path = require('path');
const { loadAdFont } = require('./ad_font');

const PACK = path.resolve(__dirname, '..');
const GLSL = path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl');
const glsl = fs.readFileSync(GLSL, 'utf8');
const num = n => {
    const m = new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl);
    if (!m) throw new Error(`找不到 #define ${n}`);
    return parseFloat(m[1]);
};

const BOX_W = num('LOGO_BOX_W'), BOX_H = num('LOGO_BOX_H');
const AD_GAP = num('LOGO_AD_GAP'), AD_H = num('LOGO_AD_H'), AD_INK_H = num('LOGO_AD_INK_H');
const LOGO_HEIGHT = num('LOGO_HEIGHT'), OFFSET_Y = num('LOGO_OFFSET_Y');
const FLIP_Y = num('LOGO_FLIP_Y');
const MARK_FRAMES = num('LOGO_MARK_DRAW_FRAMES'), AD_START = num('LOGO_AD_START_FRAME');
const AD_FADE = num('LOGO_AD_FADE_FRAMES'), DRAW_EASE = num('LOGO_DRAW_EASE');

const argOf = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };

// ---- 主字形多边形 ----
const POLY_COUNT = num('LOGO_POLY_COUNT');
const PATHS = [];
for (let i = 0; i < POLY_COUNT; i++) {
    const re = new RegExp(`const vec2 LOGO_POLY${i}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`);
    const m = re.exec(glsl);
    if (!m) throw new Error(`找不到 LOGO_POLY${i}`);
    let pts = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim())));
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) pts = pts.slice(0, -1);
    PATHS.push(pts);
}
const toDesign = ([x, y]) => [(x + 0.5) * BOX_W, (y + 0.5) * BOX_H];

// ---- 文字（共用 ad_font，避免各脚本各写一份解析）----
const font = loadAdFont(GLSL);

const VW = argOf('w', 1920), VH = argOf('h', 1080);

// 与 shader 的 StartupLogoMask 同一套换算
const pxPerUnit = LOGO_HEIGHT * VH / BOX_H;
// 与 shader 的 StartupLogoMask 同一套换算。contentH 必须含 LOGO_AD_INK_H：
// 字形圆角底部越过基线 16.7%，少算这一项预览的居中会比实机低约 3 屏幕像素。
const contentH = BOX_H + AD_GAP + AD_INK_H * AD_H;
const boxW = BOX_W * pxPerUnit, boxH = contentH * pxPerUnit;
const boxX = (VW - boxW) / 2;
const boxY = (VH - boxH) / 2 + OFFSET_Y * VH;

const dPath = PATHS.map(P => 'M' + P.map(([x, y]) => {
    const p = toDesign([x, y]);
    return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
}).join('L') + 'Z').join(' ');

const adLines = font.segments.map(s =>
    `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}"/>`
).join('\n            ');

// ---- 复刻 shader 的进度计算，用来预览任意一帧 ----
// 主字形：斜向扫掠（v = (x+y)/W，未扫到的隐藏）
// 文字：整体淡入
function ease(t) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), DRAW_EASE); }
const FRAME = argOf('frame', MARK_FRAMES + 10);      // 默认取"都画完"的一帧
const markP = ease(FRAME / MARK_FRAMES);
const adO = Math.max(0, Math.min(1, (FRAME - AD_START) / AD_FADE));
const vMax = (BOX_W + BOX_H) / BOX_W;
const sweepScreen = (-0.02) + (vMax + 0.02) * markP;   // 屏幕空间里的扫掠线（v' = (x+y')/W）

// 可见区域是**屏幕空间**的 v' <= sweep；但这里是在被镜像过的 <g> 内部裁剪，
// clip-path 的坐标会跟着一起镜像，所以要把边界倒回设计坐标：
//   屏幕 y' = contentH - y  =>  v' = (x + contentH - y)/W
//   条件 v' <= sweep  =>  y >= x + contentH - sweep*W
// 直接用设计坐标算，就不会被镜像绕进去（之前就是在这里搞反了，预览里动画是倒的）。
const clipId = 'markSweep';
const markClip = markP >= 0.9999 ? '' :
    `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><polygon points="` +
    `0,${(contentH - sweepScreen * BOX_W).toFixed(2)} ` +
    `${BOX_W.toFixed(2)},${(BOX_W + contentH - sweepScreen * BOX_W).toFixed(2)} ` +
    `${BOX_W.toFixed(2)},${contentH} 0,${contentH}"/></clipPath>`;
const markClipAttr = markP >= 0.9999 ? '' : ` clip-path="url(#${clipId})"`;

console.log(`实机尺寸：${VW}×${VH}，LOGO_HEIGHT=${LOGO_HEIGHT} → 主字形 ${(BOX_H * pxPerUnit).toFixed(0)}px 高、` +
    `${(BOX_W * pxPerUnit).toFixed(0)}px 宽（放大 ${pxPerUnit.toFixed(2)}×）；文字大写高 ${(AD_H * pxPerUnit).toFixed(1)}px`);
console.log(`设计框左上角：(${boxX.toFixed(1)}, ${boxY.toFixed(1)})  换算比例 ${scale2()}  LOGO_FLIP_Y=${FLIP_Y}`);
function scale2() { return pxPerUnit.toFixed(4); }
console.log(`文字线段 ${font.segments.length} 条，笔画宽 ${(font.strokeWidth * pxPerUnit).toFixed(2)}px`);
console.log(`节奏：主字形 ${MARK_FRAMES} 帧（缓动 ^${DRAW_EASE}），文字自第 ${AD_START} 帧起整体淡入 ${AD_FADE} 帧`);

const flipT = FLIP_Y ? `transform="translate(0,${contentH}) scale(1,-1)"` : '';

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>实机尺寸预览 ${VW}×${VH}</title>
<style>
  :root{color-scheme:dark} *{box-sizing:border-box}
  body{margin:0;background:#0a0a0c;color:#d8d8dc;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;padding:20px}
  h1{font-size:16px;margin:0 0 3px} .sub{color:#7d7d88;font-size:12px;margin-bottom:14px}
  .game{position:relative;width:${VW}px;height:${VH}px;overflow:hidden;border:1px solid #23232b;border-radius:8px}
  .game .sky{position:absolute;inset:0;background:linear-gradient(#4a6a8a,#9fb8cd 45%,#7f9a6a 46%,#4d6b3d 100%)}
  .game .clouds{position:absolute;inset:0;opacity:.55;
    background:radial-gradient(60% 30% at 25% 22%,#fff,transparent 70%),
               radial-gradient(50% 26% at 68% 14%,#fff,transparent 72%),
               radial-gradient(40% 22% at 85% 30%,#fff,transparent 70%)}
  .logo{position:absolute;left:${boxX.toFixed(2)}px;top:${boxY.toFixed(2)}px;width:${boxW.toFixed(2)}px;height:${boxH.toFixed(2)}px;overflow:visible}
  .ad{stroke:#fff;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-width:${font.strokeWidth.toFixed(3)};opacity:${adO.toFixed(3)}}
  .cap{color:#7d7d88;font-size:12px;margin:10px 0 0}
  .wrap{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
  .zoom{border:1px solid #23232b;border-radius:8px;background:#000;position:relative;overflow:hidden}
  .zoom svg{position:absolute;inset:0}
  code{color:#9fd0ff}
</style></head><body>
  <h1>实机尺寸预览 — ${VW}×${VH}</h1>
  <div class="sub">按 shader 的换算（<code>LOGO_HEIGHT=${LOGO_HEIGHT}</code>、<code>LOGO_OFFSET_Y=${OFFSET_Y}</code>、<code>LOGO_FLIP_Y=${FLIP_Y}</code>）渲染的 1:1 画面，背景是假的天空+地面，用来看真实可读性。</div>
  <div class="wrap">
    <div>
      <div class="game">
        <div class="sky"></div><div class="clouds"></div>
        <svg class="logo" viewBox="0 0 ${BOX_W} ${contentH}" xmlns="http://www.w3.org/2000/svg">
          <defs>${markClip}</defs>
          <g ${flipT}>
            <path d="${dPath}" fill="#fff" fill-rule="nonzero" fill-opacity="0.92"${markClipAttr}/>
            <g class="ad">${adLines}</g>
          </g>
        </svg>
      </div>
      <p class="cap">↑ 1:1 实际大小（主字形 ${(BOX_H * pxPerUnit).toFixed(0)}px 高）</p>
    </div>
    <div>
      <div class="zoom" style="width:${(boxW * 2).toFixed(0)}px;height:${(boxH * 2).toFixed(0)}px">
        <svg viewBox="0 0 ${BOX_W} ${contentH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="${BOX_W}" height="${contentH}" fill="#000"/>
          <g ${flipT}>
            <path d="${dPath}" fill="#fff" fill-rule="nonzero"/>
            <g class="ad">${adLines}</g>
          </g>
        </svg>
      </div>
      <p class="cap">↑ 放大 2 倍（看边缘细节）</p>
    </div>
  </div>
</body></html>
`;
const out = path.join(__dirname, 'logo_gameview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已写出 ${path.basename(out)}`);
