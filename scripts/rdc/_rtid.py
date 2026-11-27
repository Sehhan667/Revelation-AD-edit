"""Print attachment resource ids and save thumbnails (fixed TextureSave usage)."""
import os, json
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
PS = os.path.join(BASE, "_passes.json")
SHOTS = os.path.join(BASE, "_shots")
OUT = os.path.join(BASE, "_rtid.txt")
LOG = os.path.join(BASE, "_rtid_log.txt")

os.makedirs(SHOTS, exist_ok=True)
L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

p = json.load(open(PS, encoding="utf-8"))
regions = sorted(p["regions"], key=lambda r: -r["dur"])[:10]

try:
    cap = rd.OpenCaptureFile(); cap.OpenFile(RDC, '', None)
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("status=%s" % st)

    lines = []
    for i, r in enumerate(regions):
        eid = r.get("first_draw")
        if eid is None:
            continue
        c.SetFrameEvent(eid, False)
        pipe = c.GetPipelineState()
        rts = [str(d.resource) for d in pipe.GetOutputTargets()]
        dep = None
        try:
            dep = str(pipe.GetDepthTarget().resource)
        except Exception:
            pass
        lines.append("%2d eid=%-5s %7.3fms  rt=%s  depth=%s" % (i, eid, r["dur"] * 1000, rts, dep))

        rid = pipe.GetOutputTargets()[0].resource if len(pipe.GetOutputTargets()) else None
        if rid is not None:
            try:
                ts = rd.TextureSave()
                ts.resourceId = rid
                ts.destType = rd.FileType.PNG
                ts.alpha = rd.AlphaMapping.Preserve
                ts.destWidth = 480
                ts.destHeight = 0
                c.SaveTexture(ts, os.path.join(SHOTS, "%02d_eid%d.png" % (i, eid)))
                log("saved %d" % i)
            except Exception as e:
                log("save %d fail %r" % (i, e))

    open(OUT, "w", encoding="utf-8").write("\n".join(lines))
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)

os._exit(0)
