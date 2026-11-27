"""Resolve attachments of each render-pass region to real dimensions/formats."""
import os, json
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
PS = os.path.join(BASE, "_passes.json")
OUT = os.path.join(BASE, "_rt.json")
LOG = os.path.join(BASE, "_rt_log.txt")

L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

p = json.load(open(PS, encoding="utf-8"))
regions = p["regions"]

try:
    cap = rd.OpenCaptureFile(); cap.OpenFile(RDC, '', None)
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("status=%s" % st)

    lut = {}
    for t in c.GetTextures():
        try:
            lut[str(t.resourceId)] = "%dx%d %s" % (t.width, t.height, t.format.Name())
        except Exception:
            pass
    log("textures=%d" % len(lut))

    def info(rid):
        return lut.get(str(rid), "?")

    for r in regions:
        eid = r.get("first_draw")
        r["rtinfo"] = []
        r["depthinfo"] = None
        if eid is None:
            continue
        try:
            c.SetFrameEvent(eid, False)
            pipe = c.GetPipelineState()
            for t in pipe.GetOutputTargets():
                r["rtinfo"].append(info(t))
            try:
                r["depthinfo"] = info(pipe.GetDepthTarget())
            except Exception:
                pass
        except Exception as e:
            r["rterr"] = str(e)

    json.dump(regions, open(OUT, "w", encoding="utf-8"), indent=1)
    log("written")
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)

os._exit(0)
