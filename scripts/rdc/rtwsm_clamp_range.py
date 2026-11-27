import math, random
BINS=256; S=2.75; SLOPE_MIN,SLOPE_MAX=0.05,32.0
def curve(u):
    r=max(abs(u),1e-5); inv=1.0/r
    return math.log((math.exp(S)-1.0)/inv+1.0)*inv/S
def warp_a(u): return max(-1.0,min(1.0,u*curve(u)))
def scale_a(u):
    h=1.0/(BINS-1); return max((warp_a(u+h)-warp_a(u-h))/(2.0*h),0.0)
def bc(i): return (i/(BINS-1))*2.0-1.0
random.seed(3); e=[]
for i in range(BINS):
    u=bc(i)
    v=(1.0+60.0*math.exp(-(u/0.30)**2))/(1.0+40.0*abs(u)**2)
    v*=(1.0+0.35*(random.random()-0.5)); e.append(max(v,1e-5))
m=sum(e)/BINS; rel=[x/m for x in e]
def build(k,lo,hi,iters=64):
    p=list(rel)
    for _ in range(iters):
        p=[0.25*p[max(i-1,0)]+0.5*p[i]+0.25*p[min(i+1,BINS-1)] for i in range(BINS)]
    def dens(i):
        a=scale_a(bc(i)); c=max(lo,min(hi,p[i])); return a*(1.0+(c-1.0)*k)
    tot=max(sum(dens(i) for i in range(BINS)),1e-5)
    su=2.0/BINS; mn,mx=SLOPE_MIN*su,SLOPE_MAX*su
    cum,prev,pos=0.0,-1.0,[]
    for i in range(BINS):
        cum+=dens(i); q=max(prev+mn,min(prev+mx,2.0*cum/tot-1.0)); pos.append(q); prev=q
    kx=2.0/max(pos[-1]-pos[0],1e-5); o=pos[0]; pos=[(x-o)*kx-1.0 for x in pos]
    sl=[x*(BINS-1)/2.0+(BINS-1)/2.0 for x in pos]
    d=[sl[i+1]-sl[i] for i in range(BINS-1)]
    return min(d),max(d),sum(d[BINS//2-BINS//8:BINS//2+BINS//8])/sum(d)
print("k=0 基准: 放大率 %.4f..%.2f  中心1/4域 %.1f%%"%(build(0.0,0.25,4.0)[0],build(0.0,0.25,4.0)[1],build(0.0,0.25,4.0)[2]*100))
print()
print("%-14s %-6s %s"%("clamp 界","k","中心1/4域占纹理 / 放大率范围"))
for lo,hi in ((0.25,4.0),(0.1,10.0)):
    for k in (0.25,0.5,1.0,2.0,4.0):
        a,b,q=build(k,lo,hi)
        print("[%4.2f,%5.1f] k=%-5s %5.1f%%   (%.4f..%6.2f)"%(lo,hi,k,q*100,a,b))
    print()
