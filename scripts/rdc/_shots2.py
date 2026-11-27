"""Save attachments AFTER each pass finishes, to identify them correctly."""
import os
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
SHOTS = os.path.join(BASE, "_shots2")
os.makedirs(SHOTS, exist_ok=True)
LOG = os.path.join(BASE, "_shots2_log.txt")
L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

# (label, event to stand on AFTER the pass, resourceId)
JOBS = [
    ("shadow_after", 1280, "ResourceId::188724"),
    ("shadow_depth", 1280, "ResourceId::188718"),
    ("main_after_gbuffer", 2570, "ResourceId::188591"),
    ("final_color", 3060, "ResourceId::188591"),
    ("bloom_src", 2990, "ResourceId::188591"),
]

try:
    cap = rd.OpenCaptureFile(); cap.OpenFile(RDC, '', None)
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("status=%s" % st)
    lut = {}
    for t in c.GetTextures():
        lut[str(t.resourceId)] = t.resourceId

    for label, eid, rid in JOBS:
        try:
            c.SetFrameEvent(eid, False)
            ts = rd.TextureSave()
            ts.resourceId = lut[rid]
            ts.destType = rd.FileType.PNG
            ts.alpha = rd.AlphaMapping.Preserve
            ts.destWidth = 512
            ts.destHeight = 0
            c.SaveTexture(ts, os.path.join(SHOTS, "%s.png" % label))
            log("ok %s" % label)
        except Exception as e:
            log("fail %s: %r" % (label, e))
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)
os._exit(0)
