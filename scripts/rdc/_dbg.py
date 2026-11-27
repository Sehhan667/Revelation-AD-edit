"""Inspect shader debug info (source file names) and attachments per region."""
import os, json, traceback
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
PS = os.path.join(BASE, "_passes.json")
EV = os.path.join(BASE, "_events2.json")
OUT = os.path.join(BASE, "_dbg.json")
LOG = os.path.join(BASE, "_dbg_log.txt")

L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

pdata = json.load(open(PS, encoding="utf-8"))
regions = pdata["regions"]
ev = json.load(open(EV, encoding="utf-8"))
acts = {a["eid"]: a for a in ev["actions"]}

try:
    cap = rd.OpenCaptureFile()
    cap.OpenFile(RDC, '', None)
    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    def shader_files(refl):
        out = []
        try:
            di = refl.debugInfo
            if di is None:
                return out
            for f in di.files:
                out.append(str(getattr(f, "filename", f)))
        except Exception as e:
            out.append("ERR:%r" % e)
        return out

    def att(rid):
        try:
            t = controller.GetTexture(rid)
            if t is None:
                return "none"
            return "%dx%d fmt=%s" % (t.width, t.height, t.format.Name())
        except Exception as e:
            return "ERR:%s" % e

    report = []
    # regions: use first_draw (or first dispatch)
    for r in sorted(regions, key=lambda r: -r["dur"])[:16]:
        eid = r.get("first_draw")
        rec = {"eid": eid, "dur_ms": r["dur"] * 1000, "kind": r["kind"],
               "draws": r["draws"], "rt_n": len(r.get("rt", [])), "files": []}
        if eid is None:
            report.append(rec); continue
        try:
            controller.SetFrameEvent(eid, False)
            pipe = controller.GetPipelineState()
            for tag, st in [("vs", rd.ShaderStage.Vertex), ("fs", rd.ShaderStage.Fragment),
                            ("cs", rd.ShaderStage.Compute)]:
                try:
                    refl = pipe.GetShaderReflection(st)
                except Exception:
                    refl = None
                if refl is None:
                    continue
                rec["files"].append([tag, shader_files(refl)])
            rts = []
            try:
                for t in pipe.GetOutputTargets():
                    rts.append(att(t))
            except Exception:
                pass
            rec["rt"] = rts
            try:
                rec["depth"] = att(pipe.GetDepthTarget())
            except Exception:
                pass
        except Exception:
            rec["err"] = traceback.format_exc().splitlines()[-1]
        report.append(rec)

    # outside dispatches
    outs = sorted([a for a in pdata["outside"] if "Dispatch" in a["flags"]], key=lambda a: -a["dur"])
    disp = []
    for a in outs[:14]:
        rec = {"eid": a["eid"], "dur_ms": a["dur"] * 1000, "files": []}
        try:
            controller.SetFrameEvent(a["eid"], False)
            pipe = controller.GetPipelineState()
            for tag, st in [("cs", rd.ShaderStage.Compute)]:
                try:
                    refl = pipe.GetShaderReflection(st)
                except Exception:
                    refl = None
                if refl is not None:
                    rec["files"].append([tag, shader_files(refl)])
        except Exception:
            rec["err"] = traceback.format_exc().splitlines()[-1]
        disp.append(rec)

    json.dump({"regions": report, "dispatches": disp}, open(OUT, "w", encoding="utf-8"), indent=1)
    log("written")
    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
