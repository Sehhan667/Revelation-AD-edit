# --------------------------------------------------------------------------------
#     Revelation-AD-edit  -  modified derivative of "Revelation"
#     Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro
#
#     This file is an addition made for this derivative.
#     Copyright 2026 AnotherCream
#
#     Licensed under the Apache License, Version 2.0. See NOTICE at repo root.
# --------------------------------------------------------------------------------

# --------------------------------------------------------------------------------
#     Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro
#
#
# --------------------------------------------------------------------------------

# --------------------------------------------------------------------------------
#     Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro
#
#
# --------------------------------------------------------------------------------

# --------------------------------------------------------------------------------
#     Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro
#
#
# --------------------------------------------------------------------------------

# --------------------------------------------------------------------------------
#     Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro
#
#
# --------------------------------------------------------------------------------

# --------------------------------------------------------------------------------
#     Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro
#
#
# --------------------------------------------------------------------------------

# Human-in-the-loop FPS benchmark for the "GI-off still slower than 1.0.2b" regression.
#
# Usage: run this script, then follow the prompts while the game is open.
# The script only captures what you type; it does not touch the game.
#
# Procedure:
#   1. Open Minecraft, load the usual test world, stand at the fixed spot.
#   2. Switch shaderpack, wait for shader compile (10-30s) and stable FPS.
#   3. Watch the F3 FPS number for 30-60s, note min / typical / max.
#   4. Repeat for each row, answering the prompts.

function Step([string]$Msg) {
    Write-Host ""
    Write-Host ">>> $Msg" -ForegroundColor Cyan
    Read-Host "    [完成后回车继续]" | Out-Null
}

function Capture([string]$Name, [string]$Question) {
    $Answer = Read-Host "`n>>> $Question"
    Set-Variable -Name $Name -Value $Answer -Scope Script
}

Write-Host "== 帧率基准测量:GI 关闭性能回归 ==" -ForegroundColor Yellow

Step "1. 启动游戏,进入同一个存档,站到平时测试的固定位置(不要移动、不要转视角)。"
Step "2. 切到旧版 1.0.2b,等光影编译完(画面不再卡),然后等帧率稳定。"

Capture SCENE       "场景描述(视野里有什么:平原/森林/水面/建筑)?视野距离多少?"
Capture OLD_MIN     "旧版 1.0.2b:观察 30-60 秒,FPS 最低是多少?"
Capture OLD_TYPICAL "旧版 1.0.2b:FPS 稳定值(大多数时间)是多少?"
Capture OLD_MAX     "旧版 1.0.2b:FPS 最高是多少?"

Step "3. 切到新版(当前分支),关闭 Voxel GI,等待编译完成、帧率稳定。"

Capture NEW_MIN     "新版 GI关:FPS 最低是多少?"
Capture NEW_TYPICAL "新版 GI关:FPS 稳定值是多少?"
Capture NEW_MAX     "新版 GI关:FPS 最高是多少?"

Step "4. (可选)新版同时关掉体素化,再测一组,确认是否仍低。"

Capture NOVOX_MIN     "新版 GI关+体素化关:FPS 最低(不想测就填 n/a)?"
Capture NOVOX_TYPICAL "新版 GI关+体素化关:FPS 稳定值(不想测就填 n/a)?"

Write-Host ""
Write-Host "--- Captured ---" -ForegroundColor Green
Write-Host "SCENE=$SCENE"
Write-Host "OLD_MIN=$OLD_MIN"
Write-Host "OLD_TYPICAL=$OLD_TYPICAL"
Write-Host "OLD_MAX=$OLD_MAX"
Write-Host "NEW_MIN=$NEW_MIN"
Write-Host "NEW_TYPICAL=$NEW_TYPICAL"
Write-Host "NEW_MAX=$NEW_MAX"
Write-Host "NOVOX_MIN=$NOVOX_MIN"
Write-Host "NOVOX_TYPICAL=$NOVOX_TYPICAL"
