"""Resolve region attachments, dump a table, and save thumbnails for identification."""
import os, json
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
PS = os.path.join(BASE, "_passes.json")
SHOTS = os.path.join(BASE, "_shots")
TABLE = os.path.join(BASE, "_table.txt")
LOG = os.path.join(BASE, "_shots_log.txt")

os.makedirs(SHOTS, exist_ok=True)
L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

p = json.load(open(PS, encoding="utf-8"))
regions = sorted(p["regions"], key=lambda r: -r["dur"])

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

    def info(d):
        try:
            return lut.get(str(d.resource), str(d.resource))
        except Exception:
            return "?"

    lines = []
    for i, r in enumerate(regions):
        eid = r.get("first_draw")
        rts = []
        dep = None
        rid0 = None
        if eid is not None:
            try:
                c.SetFrameEvent(eid, False)
                pipe = c.GetPipelineState()
                for d in pipe.GetOutputTargets():
                    rts.append(info(d))
                    if rid0 is None:
                        rid0 = d.resource
                dep = info(pipe.GetDepthTarget())
            except Exception as e:
                rts.append("ERR:%s" % e)
        lines.append("%2d eid=%-5s %8.3fms draws=%-4d cs=%-2d | rt(%d): %s | depth: %s" % (
            i, eid, r["dur"] * 1000, r["draws"], r.get("dispatches", 0),
            len(rts), ", ".join(rts[:10]), dep))

        # thumbnail of first colour attachment
        if rid0 is not None and i < 14:
            try:
                ts = rd.TextureSave()
                ts.resourceId = rid0
                ts.mip = 0
                ts.slice = 0
                ts.sample = 0
                ts.destType = rd.FileType.PNG
                ts.alpha = rd.AlphaMapping.Preserve
                ts.destWidth = 512
                ts.destHeight = 0
                c.SaveTexture(ts, os.path.join(SHOTS, "%02d_eid%d.png" % (i, eid)))
            except Exception as e:
                log("save %d failed: %r" % (i, e))

    open(TABLE, "w", encoding="utf-8").write("\n".join(lines))
    log("table written")
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)

os._exit(0)
