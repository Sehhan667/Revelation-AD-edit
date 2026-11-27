# -*- coding: utf-8 -*-
# 用"探针已证明存在"的真实毛糙 profile，比较 clamp vs CompressRel 在**生产路径**（过 CDF+SLOPE）
# 下的宏观重分配：中心 1/4 输入域占掉多少比例的阴影图纹理。
import math, random
BINS=256; S=2.75; SLOPE_MIN,SLOPE_MAX=0.05,32.0
def curve(u):
    r=max(abs(u),1e-5); inv=1.0/r
    return math.log((math.exp(S)-1.0)/inv+1.0)*inv/S
def warp_a(u): return max(-1.0,min(1.0,u*curve(u)))
def scale_a(u):
    h=1.0/(BINS-1); return max((warp_a(u+h)-warp_a(u-h))/(2.0*h),0.0)
def bc(i): return (i/(BINS-1))*2.0-1.0
def raw():
    random.seed(3); e=[]
    for i in range(BINS):
        u=bc(i)
        v=(1.0+60.0*math.exp(-(u/0.30)**2))/(1.0+40.0*abs(u)**2)
        v*= (1.0+0.35*(random.random()-0.5))
        e.append(max(v,1e-5))
    m=sum(e)/BINS; return [x/m for x in e]
def compress(r): return 2.0**math.tanh(math.log2(max(r,1e-6))*0.5)
def build(rel,k,mode,iters):
    p=list(rel)
    for _ in range(iters):
        p=[0.25*p[max(i-1,0)]+0.5*p[i]+0.25*p[min(i+1,BINS-1)] for i in range(BINS)]
    def dens(i):
        a=scale_a(bc(i))
        c=max(0.25,min(4.0,p[i])) if mode=="clamp" else compress(p[i])
        return a*(1.0+(c-1.0)*k)
    tot=max(sum(dens(i) for i in range(BINS)),1e-5)
    su=2.0/BINS; mn,mx=SLOPE_MIN*su,SLOPE_MAX*su
    cum,prev,pos=0.0,-1.0,[]
    for i in range(BINS):
        cum+=dens(i); q=max(prev+mn,min(prev+mx,2.0*cum/tot-1.0)); pos.append(q); prev=q
    kx=2.0/max(pos[-1]-pos[0],1e-5); o=pos[0]
    pos=[(x-o)*kx-1.0 for x in pos]
    sl=[x*(BINS-1)/2.0+(BINS-1)/2.0 for x in pos]
    d=[sl[i+1]-sl[i] for i in range(BINS-1)]
    q=sum(d[BINS//2-BINS//8:BINS//2+BINS//8])/sum(d)
    return min(d),max(d),q
rel=raw()
base=build(rel,0.0,"clamp",64)
print("k=0 基准: 放大率 %.4f..%.2f  中心1/4域占纹理 %.1f%%"%(base[0],base[1],base[2]*100))
print()
print("%-6s %-6s %-22s %s"%("平滑","k","模式","中心1/4域占纹理 (相对基准)"))
for iters in (64,256):
    for k in (0.5,1.0,4.0):
        for mode,tag in (("clamp","clamp[0.25,4]"),("compress","CompressRel(tanh)")):
            lo,hi,q=build(rel,k,mode,iters)
            print("%-6d %-6s %-22s %5.1f%%  (%+5.1f pt)   放大率 %.4f..%.2f"%(iters,k,tag,q*100,(q-base[2])*100,lo,hi))
    print()
