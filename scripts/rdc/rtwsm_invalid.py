# WarpEntryInvalid 的判据 vs 表里真实出现的 scale
BINS=256; S=2.75
import math
def curve(u):
    r=max(abs(u),1e-5); inv=1.0/r
    return math.log((math.exp(S)-1.0)/inv+1.0)*inv/S
def warp(u): return max(-1.0,min(1.0,u*curve(u)))
def scale(u):
    h=1.0/(BINS-1)
    return max((warp(u+h)-warp(u-h))/(2.0*h),0.0)
def bc(i): return (i/(BINS-1))*2.0-1.0
sc=[scale(bc(i)) for i in range(BINS)]
print("解析底座 scale: %.3f .. %.3f  (WarpEntryInvalid 允许 <= 64.0)"%(min(sc),max(sc)))
# SELFTEST 的表 (u<=0 -> -0.75, u>0 -> u*0.25) 的 scale
pos=[(-0.75 if bc(i)<=0 else bc(i)*0.25) for i in range(BINS)]
h=2.0/(BINS-1)
sl=[max((pos[min(i+1,BINS-1)]-pos[max(i-1,0)])/(2.0*h),0.0) for i in range(BINS)]
bad=[i for i,v in enumerate(sl) if v>64.0]
print("SELFTEST 表 scale: %.1f .. %.1f  -> 被 WarpEntryInvalid 判为坏的第 %d/%d 项"%(min(sl),max(sl),len(bad),BINS))
print("  判坏区间: 第 %d..%d 项 (中心跳跃处), 右侧恒定 %.1f 也 >64"%(min(bad),max(bad),sl[BINS-1]))
# 内容驱动的表（rtwsm_visible 的结论：k=4 时放大率 0.047..9.89）
print()
print("内容驱动 warp 的局部 scale 上界估计: 放大率最大 9.89 (表项/输入bin) * (BINS-1)/2 = %.0f"%(9.89*255/2))
print("  => 内容 warp 真正生效时 scale 会轻松超过 64 -> 逐项回退成解析值 -> 画面 = k=0")
