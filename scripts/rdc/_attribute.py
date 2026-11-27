"""Attribute the most expensive events to shaders / render targets."""
import os, json, traceback
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
EV = os.path.join(BASE, "_events2.json")
OUT = os.path.join(BASE, "_attrib.json")
LOG = os.path.join(BASE, "_attrib_log.txt")

L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

d = json.load(open(EV, encoding="utf-8"))
acts = d["actions"]
THR_MS = 0.015
cand = [a for a in acts if a["dur"] * 1000.0 >= THR_MS]
cand.sort(key=lambda a: -a["dur"])
log("candidates: %d (>= %.3f ms)" % (len(cand), THR_MS))

try:
    cap = rd.OpenCaptureFile()
    cap.OpenFile(RDC, '', None)
    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    STAGES = [("vs", rd.ShaderStage.Vertex), ("hs", rd.ShaderStage.Hull),
              ("ds", rd.ShaderStage.Domain), ("gs", rd.ShaderStage.Geometry),
              ("fs", rd.ShaderStage.Fragment), ("cs", rd.ShaderStage.Compute)]

    def rname(rid):
        try:
            n = controller.GetResourceName(rid)
            return n if n else str(rid)
        except Exception:
            return str(rid)

    out = []
    for idx, a in enumerate(cand):
        eid = a["eid"]
        rec = {"eid": eid, "dur_ms": a["dur"] * 1000.0, "flags": a["flags"],
               "api_name": a["name"], "stages": {}, "rt": [], "depth": None,
               "pipeline": None}
        try:
            controller.SetFrameEvent(eid, False)
            pipe = controller.GetPipelineState()
            for tag, st in STAGES:
                try:
                    refl = pipe.GetShaderReflection(st)
                except Exception:
                    refl = None
                if refl is None:
                    continue
                ep = ""
                rid = None
                try: ep = refl.entryPoint
                except Exception: pass
                try: rid = refl.resourceId
                except Exception: pass
                rec["stages"][tag] = {"entry": ep, "rid": str(rid) if rid else "",
                                      "name": rname(rid) if rid else ""}
            try:
                for t in pipe.GetOutputTargets():
                    rid = getattr(t, "resourceId", t)
                    try:
                        if rid == rd.ResourceId.Null():
                            continue
                    except Exception:
                        pass
                    rec["rt"].append(rname(rid))
            except Exception:
                pass
            try:
                dt = pipe.GetDepthTarget()
                rid = getattr(dt, "resourceId", None)
                if rid is not None:
                    rec["depth"] = rname(rid)
            except Exception:
                pass
            try:
                rec["pipeline"] = rname(pipe.GetGraphicsPipelineObject())
            except Exception:
                pass
        except Exception:
            rec["error"] = traceback.format_exc().splitlines()[-1]
        out.append(rec)
        if idx % 10 == 0:
            log("  %d/%d" % (idx, len(cand)))

    json.dump(out, open(OUT, "w", encoding="utf-8"), indent=1)
    log("written %d records" % len(out))
    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
