import os
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
OUT = os.path.join(BASE, "_out_probe.txt")
L = []
def log(s):
    L.append(str(s))
    try: open(OUT, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

try:
    cap = rd.OpenCaptureFile(); cap.OpenFile(RDC, '', None)
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("status=%s" % st)
    log("has SaveTexture: %s" % hasattr(c, "SaveTexture"))
    log("has SavePipelineState: %s" % hasattr(c, "SavePipelineState"))

    c.SetFrameEvent(2642, False)
    pipe = c.GetPipelineState()
    ots = pipe.GetOutputTargets()
    log("outputs n=%d" % len(ots))
    for t in ots:
        log("type=%r" % type(t))
        log("  repr=%r" % (t,))
        log("  dir=%s" % [a for a in dir(t) if not a.startswith("_")])
    try:
        dt = pipe.GetDepthTarget()
        log("depth type=%r dir=%s repr=%r" % (type(dt), [a for a in dir(dt) if not a.startswith("_")], dt))
    except Exception as e:
        log("depth err %r" % e)
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)
os._exit(0)
