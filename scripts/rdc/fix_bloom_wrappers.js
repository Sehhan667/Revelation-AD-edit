// 修复 bloom wrapper：上一次 node -e 里 PowerShell 把 replace 的 $1 展开成空串，OFFSET 行被删了。
const fs = require('fs');

const horizontal = [
    '#version 460 compatibility',
    '',
    '// Horizontal blur pass: colortex4 L0 canvas -> colortex19 (ping-pong)',
    '#define OFFSET ivec2(1, 0)',
    '#define BLOOM_PASS 0   // [B8] 0 = horizontal (colortex4 -> colortex19), 1 = vertical (colortex19 -> colortex4)',
    'layout (local_size_x = 128, local_size_y = 1) in;',
    '',
    '#include "/program/post/bloom/Blur.comp"',
    '',
].join('\n');

const vertical = [
    '#version 460 compatibility',
    '',
    '// Vertical blur pass: colortex19 -> colortex4 L0 canvas (ping-pong)',
    '#define OFFSET ivec2(0, 1)',
    '#define BLOOM_PASS 1   // [B8] 0 = horizontal (colortex4 -> colortex19), 1 = vertical (colortex19 -> colortex4)',
    'layout (local_size_x = 1, local_size_y = 128) in;',
    '',
    '#include "/program/post/bloom/Blur.comp"',
    '',
].join('\n');

for (const world of ['world0', 'world1', 'world-1']) {
    fs.writeFileSync(`shaders/${world}/composite20_a.csh`, horizontal, 'utf8');
    fs.writeFileSync(`shaders/${world}/composite21_a.csh`, vertical, 'utf8');
}
console.log('bloom wrappers rewritten (6 files)');
