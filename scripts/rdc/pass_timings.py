"""Per-pass GPU cost of a RenderDoc capture.

Run with the Python bundled in qrenderdoc (system Python cannot import renderdoc):
  qrenderdoc.exe --python pass_timings.py

Capture: env RD_CAPTURE, else the first 111.rdc found near the script / cwd.
Outputs: <cap>_pass_timings.txt (table) and <cap>_passes.json (raw).

Note: Iris does not push debug markers on Vulkan, so passes have no names.
This script reports structure only: cost, draw count, attachment signature.
"""
import os, sys, json, traceback
import renderdoc as rd

LOGP = os.path.join(os.getcwd(), "_pass_timings.log")
_lines = []
def log(s):
    _lines.append(str(s))
    try:
        open(LOGP, "w", encoding="utf-8").write("\n".join(_lines))
    except Exception:
        pass

try:
    # locate repo root: qrenderdoc does not define __file__
    roots = []
    try:
        if sys.argv and str(sys.argv[0]).lower().endswith(".py"):
            roots.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))))
    except Exception:
        pass
    roots.append(os.getcwd())

    rdc = os.environ.get("RD_CAPTURE", "")
    if not rdc:
        for b in roots:
            cand = os.path.join(b, "111.rdc")
            if os.path.isfile(cand):
                rdc = cand
                break
    if not rdc or not os.path.isfile(rdc):
        raise SystemExit("capture not found; set RD_CAPTURE")

    stem = os.path.splitext(rdc)[0]
    log("capture: %s" % rdc)

    cap = rd.OpenCaptureFile()
    res = cap.OpenFile(rdc, "", None)
    log("OpenFile -> %s" % res)
    status, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    dur = {}
    for r in c.FetchCounters([rd.GPUCounter.EventGPUDuration]):
        try:
            dur[r.eventId] = float(r.value.d)
        except Exception:
            pass
    log("durations: %d" % len(dur))

    tex = {}
    for t in c.GetTextures():
        try:
            tex[str(t.resourceId)] = "%dx%d %s" % (t.width, t.height, t.format.Name())
        except Exception:
            pass

    flat = []
    def walk(lst):
        for a in lst:
            flat.append(a)
            walk(a.children)
    walk(c.GetRootActions())
    log("actions: %d" % len(flat))

    def flags_of(a):
        out = []
        for f in rd.ActionFlags:
            try:
                if a.flags & f:
                    out.append(f.name)
            except Exception:
                pass
        return out

    regions, cur = [], None
    for a in flat:
        fl = flags_of(a)
        if "BeginPass" in fl:
            cur = {"begin": a.eventId, "dur": 0.0, "draws": 0, "dispatches": 0,
                   "clears": 0, "copies": 0, "first": None, "kind": str(a.customName)}
            regions.append(cur)
            continue
        if "EndPass" in fl:
            if cur:
                cur["end"] = a.eventId
                cur = None
            continue
        if cur is None:
            continue
        cur["dur"] += dur.get(a.eventId, 0.0)
        if "Drawcall" in fl:
            cur["draws"] += 1
            if cur["first"] is None:
                cur["first"] = a.eventId
        elif "Dispatch" in fl:
            cur["dispatches"] += 1
            if cur["first"] is None:
                cur["first"] = a.eventId
        elif "Clear" in fl:
            cur["clears"] += 1
        elif "Copy" in fl:
            cur["copies"] += 1

    for r in regions:
        r["rt"], r["depth"] = [], ""
        if r["first"]:
            try:
                c.SetFrameEvent(r["first"], False)
                p = c.GetPipelineState()
                r["rt"] = [tex.get(str(x.resource), str(x.resource)) for x in p.GetOutputTargets()]
                r["depth"] = tex.get(str(p.GetDepthTarget().resource), "")
            except Exception as e:
                r["err"] = str(e)

    total = sum(r["dur"] for r in regions)
    out = ["total = %.3f ms (%.1f fps)" % (total * 1000, 1000.0 / (total * 1000) if total else 0), ""]
    for r in sorted(regions, key=lambda x: -x["dur"]):
        if r["dur"] * 1000 < 0.05:
            continue
        out.append("%8.3f ms %5.1f%% | draw=%-4d cs=%-2d clr=%-2d cp=%-2d | rt=%d %s | depth=%s | eid=%s" % (
            r["dur"] * 1000, (r["dur"] / total * 100) if total else 0,
            r["draws"], r["dispatches"], r["clears"], r["copies"],
            len(r["rt"]), ", ".join(r["rt"][:4]), r["depth"], r["begin"]))

    open(stem + "_pass_timings.txt", "w", encoding="utf-8").write("\n".join(out))
    json.dump({"total_ms": total * 1000, "regions": regions},
              open(stem + "_passes.json", "w", encoding="utf-8"), indent=1)
    log("done")
    c.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
