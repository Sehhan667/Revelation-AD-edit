BINS=256
# W(i)=u*0.5+0.125*r, u=2i/(BINS-1)-1, r in [0,1]
pos=[( (i/(BINS-1))*2.0-1.0 )*0.5 + 0.125*1.0 for i in range(BINS)]   # 取 rel 最大时的偏离
h=2.0/(BINS-1)
sc=[max((pos[min(i+1,BINS-1)]-pos[max(i-1,0)])/(2.0*h),0.01) for i in range(BINS)]
print("探针表 W 范围: %.3f .. %.3f   scale 范围: %.1f .. %.1f  (合法区间 0.01..64)"%(min(pos),max(pos),min(sc),max(sc)))
bad=[i for i in range(BINS) if pos[i]==0.0 and sc[i]==0.0 or abs(pos[i])>1.05 or sc[i]<0.01 or sc[i]>64.0]
print("被判坏的表项: %d/256"%len(bad))
