"""Dump action tree + per-event GPU duration from an .rdc capture."""
import os, json, traceback
import renderdoc as rd

RDC = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\111.rdc"
OUT = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_events2.json"
LOG = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_dump2_log.txt"

L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

try:
    cap = rd.OpenCaptureFile()
    log("OpenFile -> %s" % cap.OpenFile(RDC, '', None))
    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    # ---- GPU duration per event ----
    dur = {}
    try:
        res = controller.FetchCounters([rd.GPUCounter.EventGPUDuration])
        for r in res:
            try:
                dur[r.eventId] = float(r.value.d)
            except Exception:
                pass
        log("EventGPUDuration entries=%d" % len(dur))
    except Exception:
        log("duration fetch failed:\n" + traceback.format_exc())

    # counter unit
    unit = "?"
    try:
        d = controller.DescribeCounter(rd.GPUCounter.EventGPUDuration)
        unit = "%s / %s" % (d.name, d.unit)
    except Exception:
        pass
    log("unit: %s" % unit)

    def flags_of(a):
        out = []
        for f in rd.ActionFlags:
            try:
                if a.flags & f:
                    out.append(f.name)
            except Exception:
                pass
        return out

    recs = []
    def walk(lst, depth, path):
        for a in lst:
            name = str(a.customName) if a.customName else ""
            rec = {
                "eid": int(a.eventId),
                "name": name,
                "d": depth,
                "dur": dur.get(a.eventId, 0.0),
                "flags": flags_of(a),
                "path": path,
            }
            try:
                rec["nIdx"] = int(a.numIndices)
                rec["nInst"] = int(a.numInstances)
            except Exception:
                pass
            recs.append(rec)
            np = path + "/" + (name if name else "?")
            walk(a.children, depth + 1, np)

    walk(controller.GetRootActions(), 0, "")
    log("actions=%d" % len(recs))

    json.dump({"unit": unit, "actions": recs}, open(OUT, "w", encoding="utf-8"), indent=1)
    log("written")

    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
