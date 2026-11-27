"""Disassemble the shaders of the top-cost events to fingerprint them."""
import os, json, traceback
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
EV = os.path.join(BASE, "_events2.json")
OUTD = os.path.join(BASE, "_disasm")
LOG = os.path.join(BASE, "_disasm_log.txt")

os.makedirs(OUTD, exist_ok=True)
L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

d = json.load(open(EV, encoding="utf-8"))
acts = sorted([a for a in d["actions"] if a["dur"] * 1000 >= 0.1], key=lambda a: -a["dur"])
targets = [a["eid"] for a in acts[:10]]
log("targets: %s" % targets)

try:
    cap = rd.OpenCaptureFile()
    cap.OpenFile(RDC, '', None)
    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    for eid in targets:
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
            try:
                txt = controller.DisassembleShader(pipe.GetGraphicsPipelineObject(), refl, "")
            except Exception:
                try:
                    txt = controller.DisassembleShader(pipe.GetComputePipelineObject(), refl, "")
                except Exception:
                    txt = "DISASM FAIL\n" + traceback.format_exc()
            p = os.path.join(OUTD, "%d_%s.spvasm" % (eid, tag))
            open(p, "w", encoding="utf-8", errors="replace").write(txt)
            log("%d %s -> %s (%d chars)" % (eid, tag, os.path.basename(p), len(txt)))
    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
