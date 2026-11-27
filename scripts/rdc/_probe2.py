import os, sys, json, traceback
import renderdoc as rd

RDC = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\111.rdc"
OUT = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_probe2.txt"
L = []
def log(s):
    L.append(str(s))
    try: open(OUT, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

try:
    log("=== ReplayOptions 字段 ===")
    o = rd.ReplayOptions()
    log(", ".join([a for a in dir(o) if not a.startswith("_")]))

    log("\n=== GPUCounter 枚举 ===")
    try:
        log(", ".join([c.name for c in rd.GPUCounter]))
    except Exception as e:
        log("enum fail %r" % e)

    cap = rd.OpenCaptureFile()
    log("\nOpenFile -> %s" % cap.OpenFile(RDC, '', None))

    opts = rd.ReplayOptions()
    try:
        opts.forceGPUTiming = True
        log("set forceGPUTiming=True OK")
    except Exception as e:
        log("forceGPUTiming not settable: %r" % e)

    status, controller = cap.OpenCapture(opts, None)
    log("OpenCapture -> %s" % status)
    if status == rd.ResultCode.Succeeded and controller is not None:
        log("\n=== 可用计数器 ===")
        for c in controller.EnumerateCounters():
            log("  %s | unit=%s | type=%s" % (getattr(c, "name", "?"), getattr(c, "unit", "?"), getattr(c, "type", "?")))
        # 试抓一个 draw 的 counter
        def first_draw(lst):
            for a in lst:
                if a.flags & rd.ActionFlags.Drawcall:
                    return a
                r = first_draw(a.children)
                if r: return r
            return None
        a = first_draw(controller.GetRootActions())
        if a is not None:
            log("\nfirst draw eventId=%d name=%r" % (a.eventId, a.customName))
            cs = controller.EnumerateCounters()
            for c in cs:
                try:
                    v = controller.FetchCounters(c, [a.eventId])
                    log("  %s -> %r" % (getattr(c, "name", "?"), v))
                except Exception as e:
                    log("  %s FAIL %r" % (getattr(c, "name", "?"), e))
        controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
