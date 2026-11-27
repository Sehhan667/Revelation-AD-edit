/*
 * show_params.js — 打印启动 logo 的全部可调参数（从 shader 里读，避免文档和代码不同步）
 * 用法：node rdc_analysis/show_params.js
 */
const fs = require('fs');
const path = require('path');
const PACK = path.resolve(__dirname, '..');
const g = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const f = fs.readFileSync(path.join(PACK, 'shaders', 'program', 'post', 'Final.frag'), 'utf8');

const KEYS = [
    ['LOGO_HEIGHT', '主字形高度（屏幕高度比例）'],
    ['LOGO_OFFSET_Y', '整体上下微调（屏幕高度比例，负=上移）'],
    ['LOGO_FLIP_Y', '屏幕上下翻转（1=翻转）'],
    ['LOGO_MARK_DRAW_FRAMES', '主字形绘制帧数'],
    ['LOGO_AD_START_FRAME', '文字开始帧（0 = 与主字形同时）'],
    ['LOGO_AD_FADE_FRAMES', '文字整体淡入帧数'],
    ['LOGO_DRAW_EASE', '主字形速度曲线指数（1=线性，2=先快后慢）'],
    ['LOGO_AD_GAP', '文字与主字形底边间距（源像素）'],
    ['LOGO_AD_H', '文字字号 = 大写高（源像素）'],
    ['LOGO_AD_STROKE', '文字笔画宽度（源像素）'],
];
console.log('=== StartupLogo.glsl ===');
for (const [k, desc] of KEYS) {
    const m = new RegExp(`#define\\s+${k}\\s+(-?[0-9.]+)`).exec(g);
    console.log(`  ${k.padEnd(24)} = ${(m ? m[1] : '(未找到)').padEnd(8)} ${desc}`);
}
console.log('=== program/post/Final.frag ===');
const m = /const int logoDuration = (\d+), logoFadeStart = (\d+)/.exec(f);
if (m) {
    console.log(`  ${'logoDuration'.padEnd(24)} = ${m[1].padEnd(8)} 总时长（帧）`);
    console.log(`  ${'logoFadeStart'.padEnd(24)} = ${m[2].padEnd(8)} 开始淡出的帧（画完到这里的间隔越长，停留越久）`);
}

// 时间轴
const num = k => parseFloat(new RegExp(`#define\\s+${k}\\s+(-?[0-9.]+)`).exec(g)[1]);
if (m) {
    const markEnd = num('LOGO_MARK_DRAW_FRAMES');
    const adStart = num('LOGO_AD_START_FRAME'), adEnd = adStart + num('LOGO_AD_FADE_FRAMES');
    const fadeStart = +m[2], fadeEnd = +m[1];
    const drawn = Math.max(markEnd, adEnd);
    const fps = 60;
    console.log('=== 时间轴（按 60fps）===');
    console.log(`  主字形绘制   0 ~ ${markEnd} 帧（缓动 ^${num('LOGO_DRAW_EASE')}，先快后慢）`);
    console.log(`  文字淡入     ${adStart} ~ ${adEnd} 帧（整行一起，无逐段描画）`);
    console.log(`  完全显示     ${drawn} ~ ${fadeStart} 帧（${((fadeStart - drawn) / fps).toFixed(2)} 秒）`);
    console.log(`  淡出         ${fadeStart} ~ ${fadeEnd} 帧（${((fadeEnd - fadeStart) / fps).toFixed(2)} 秒）`);
    console.log(`  总时长       ${(fadeEnd / fps).toFixed(2)} 秒`);
}
