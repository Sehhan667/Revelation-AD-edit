"""Dump every action of an .rdc capture (tree + GPU durations) to JSON.

Run with:
  qrenderdoc.exe --python _dump_events.py
"""
import os, sys, json, traceback
import renderdoc as rd

RDC = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\111.rdc"
OUT = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_events.json"
LOG = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_dump_log.txt"

log_lines = []
def log(msg):
    log_lines.append(str(msg))
    try:
        open(LOG, "w", encoding="utf-8").write("\n".join(log_lines))
    except Exception:
        pass

try:
    log("opening %s" % RDC)
    cap = rd.OpenCaptureFile()
    res = cap.OpenFile(RDC, '', None)
    log("OpenFile -> %s" % res)
    if res != rd.ResultCode.Succeeded:
        log("ERROR: cannot open capture")
        os._exit(1)

    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)
    if status != rd.ResultCode.Succeeded or controller is None:
        log("ERROR: cannot replay capture")
        os._exit(1)

    api = controller.GetAPIProperties()
    try:
        api_name = str(api.pipelineType)
    except Exception:
        api_name = "?"

    result = {
        "api": api_name,
        "driver": str(getattr(api, "localDriver", "")),
        "vendor": str(getattr(api, "localVendor", "")),
        "renderer": str(getattr(api, "localRenderer", "")),
        "actions": [],
        "frame_number": None,
        "capture_time": None,
    }
    try:
        result["frame_number"] = controller.GetFrameNumber()
    except Exception:
        pass
    try:
        result["capture_time"] = str(controller.GetCapture().GetTime())
    except Exception:
        pass

    # ---- counters: per-event GPU duration ----
    dur_by_event = {}
    try:
        counters = controller.EnumerateCounters()
        log("counters: %d" % len(counters))
        # find GPU-duration style counter
        candidates = []
        for c in counters:
            nm = str(getattr(c, "name", ""))
            if "Duration" in nm or "GPUDuration" in nm:
                candidates.append((nm, c))
        log("duration counters: %s" % [n for n, _ in candidates])
        target = None
        for nm, c in candidates:
            if "EventGPUDuration" in nm:
                target = c
                break
        if target is None and candidates:
            target = candidates[0][1]
        if target is not None:
            ids = []
            def collect(lst):
                for a in lst:
                    if a.eventId > 0:
                        ids.append(a.eventId)
                    collect(a.children)
            collect(controller.GetRootActions())
            log("fetching counters for %d events" % len(ids))
            vals = controller.FetchCounters(target, ids)
            for v in vals:
                try:
                    d = v.value.d
                except Exception:
                    d = 0.0
                dur_by_event[v.eventId] = float(d)
            log("counter values: %d" % len(dur_by_event))
    except Exception:
        log("counter fetch failed:\n" + traceback.format_exc())

    def flag_names(a):
        names = []
        try:
            for f in rd.ActionFlags:
                try:
                    if a.flags & f:
                        names.append(f.name)
                except Exception:
                    pass
        except Exception:
            pass
        return names

    def walk(lst, depth):
        for a in lst:
            rec = {
                "eventId": int(a.eventId),
                "actionId": int(getattr(a, "actionId", 0)),
                "name": str(a.customName) if a.customName else str(getattr(a, "customName", "")),
                "depth": depth,
                "duration": float(getattr(a, "duration", 0.0)),
                "gpu_counter": dur_by_event.get(a.eventId),
                "numIndices": int(getattr(a, "numIndices", 0)),
                "numInstances": int(getattr(a, "numInstances", 0)),
                "flags": flag_names(a),
            }
            try:
                rec["dispatch"] = [int(x) for x in a.dispatchDimension]
            except Exception:
                pass
            result["actions"].append(rec)
            walk(a.children, depth + 1)

    walk(controller.GetRootActions(), 0)
    log("actions: %d" % len(result["actions"]))

    open(OUT, "w", encoding="utf-8").write(json.dumps(result, indent=1))
    log("written %s" % OUT)

    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
