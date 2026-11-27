import os, traceback
import renderdoc as rd

RDC = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\111.rdc"
OUT = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_probe3.txt"
L = []
def log(s):
    L.append(str(s))
    try: open(OUT, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

try:
    cap = rd.OpenCaptureFile()
    cap.OpenFile(RDC, '', None)
    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    log("\n=== FetchCounters doc ===\n" + str(controller.FetchCounters.__doc__))
    log("\n=== DescribeCounter doc ===\n" + str(controller.DescribeCounter.__doc__))
    log("\n=== EnumerateCounters doc ===\n" + str(controller.EnumerateCounters.__doc__))

    cs = controller.EnumerateCounters()
    log("\ncounters n=%d type=%r" % (len(cs), type(cs[0])))
    for c in cs:
        try:
            d = controller.DescribeCounter(c)
            log("  %-28s id=%s unit=%s type=%s" % (d.name, c, d.unit, d.type))
        except Exception as e:
            log("  describe FAIL %r" % e)

    # 尝试直接抓 EventGPUDuration
    log("\n=== FetchCounters([EventGPUDuration]) ===")
    try:
        res = controller.FetchCounters([rd.GPUCounter.EventGPUDuration])
        log("len=%d ; head=%r" % (len(res), res[:6]))
        nz = [r for r in res if getattr(getattr(r, 'value', None), 'd', 0)]
        log("nonzero=%d" % len(nz))
    except Exception:
        log(traceback.format_exc())

    log("\n=== FetchCounters([Count]) test ===")
    try:
        res = controller.FetchCounters([rd.GPUCounter.VSInvocations])
        log("len=%d ; head=%r" % (len(res), res[:4]))
    except Exception:
        log(traceback.format_exc())

    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
