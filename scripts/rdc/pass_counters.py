"""Sum per-pass hardware counters (PS/VS invocations, samples) for one event range."""
import os, sys, json, traceback
import renderdoc as rd

LOGP = os.path.join(os.getcwd(), "_counters.log")
_lines = []
def log(s):
    _lines.append(str(s))
    try:
        open(LOGP, "w", encoding="utf-8").write("\n".join(_lines))
    except Exception:
        pass

try:
    rdc = os.environ.get("RD_CAPTURE", os.path.join(os.getcwd(), "111.rdc"))
    lo = int(os.environ.get("EID_LO", "1555"))
    hi = int(os.environ.get("EID_HI", "2570"))

    cap = rd.OpenCaptureFile()
    log("open -> %s" % cap.OpenFile(rdc, "", None))
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("replay -> %s" % st)

    ids = []
    def walk(lst):
        for a in lst:
            if a.flags & rd.ActionFlags.Drawcall and lo <= a.eventId <= hi:
                ids.append(a.eventId)
            walk(a.children)
    walk(c.GetRootActions())
    log("draws in [%d,%d] = %d" % (lo, hi, len(ids)))

    names = ["PSInvocations", "SamplesPassed", "VSInvocations", "RasterizedPrimitives"]
    sums = {}
    for nm in names:
        try:
            counter = getattr(rd.GPUCounter, nm)
        except Exception:
            continue
        total = 0.0
        hits = 0
        for r in c.FetchCounters([counter]):
            if r.eventId in ids:
                v = 0.0
                for fld in ("u64", "u32", "d", "f"):
                    try:
                        v = float(getattr(r.value, fld))
                        if v:
                            break
                    except Exception:
                        continue
                total += v
                hits += 1
        log("  (%s: %d events matched)" % (nm, hits))
        sums[nm] = total
        log("%s = %.0f" % (nm, total))

    screen = 1920.0 * 1080.0
    log("screen pixels = %.0f" % screen)
    if sums.get("PSInvocations"):
        log("overdraw = %.2fx" % (sums["PSInvocations"] / screen))
    c.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
