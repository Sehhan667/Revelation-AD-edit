import os, json
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
OUT = os.path.join(BASE, "_api.txt")
L = []
def log(s):
    L.append(str(s))
    try: open(OUT, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

try:
    cap = rd.OpenCaptureFile(); cap.OpenFile(RDC, '', None)
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("status=%s" % st)
    names = [a for a in dir(c) if not a.startswith("_")]
    log("\n".join(sorted(names)))
    log("\n--- Get* ---")
    log("\n".join([n for n in names if n.lower().startswith("get")]))
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)
os._exit(0)
