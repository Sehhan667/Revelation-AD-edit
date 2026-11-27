"""Group the frame into render-pass / dispatch regions and report GPU cost."""
import os, json, traceback
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
EV = os.path.join(BASE, "_events2.json")
OUT = os.path.join(BASE, "_passes.json")
LOG = os.path.join(BASE, "_passes_log.txt")

L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

d = json.load(open(EV, encoding="utf-8"))
acts = d["actions"]

# ---- build regions from the flat event list ----
regions = []
cur = None
for a in acts:
    fl = a["flags"]
    if "BeginPass" in fl:
        cur = {"begin": a["eid"], "kind": a["name"], "items": [], "dur": 0.0,
               "draws": 0, "dispatches": 0, "clears": 0, "copies": 0, "resolves": 0,
               "first_draw": None}
        regions.append(cur)
        continue
    if "EndPass" in fl:
        if cur is not None:
            cur["end"] = a["eid"]
            cur = None
        continue
    if cur is not None:
        cur["dur"] += a["dur"]
        if "Drawcall" in fl:
            cur["draws"] += 1
            if cur["first_draw"] is None:
                cur["first_draw"] = a["eid"]
        elif "Dispatch" in fl:
            cur["dispatches"] += 1
            if cur["first_draw"] is None:
                cur["first_draw"] = a["eid"]
        elif "Clear" in fl:
            cur["clears"] += 1
        elif "Copy" in fl:
            cur["copies"] += 1
        elif "Resolve" in fl:
            cur["resolves"] += 1

# ---- actions outside any region (compute passes live here) ----
in_region = set()
for r in regions:
    in_region.add(r["begin"])
    if "end" in r:
        in_region.add(r["end"])

outside = []
inside_span = []
for r in regions:
    if "end" in r:
        inside_span.append((r["begin"], r["end"]))

def in_any(eid):
    for b, e in inside_span:
        if b < eid < e:
            return True
    return False

for a in acts:
    if a["eid"] in in_region or in_any(a["eid"]):
        continue
    if a["dur"] > 0:
        outside.append(a)

log("regions=%d outside_with_dur=%d" % (len(regions), len(outside)))

# ---- query attachments per region ----
try:
    cap = rd.OpenCaptureFile()
    cap.OpenFile(RDC, '', None)
    status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    log("OpenCapture -> %s" % status)

    def texinfo(rid):
        try:
            t = controller.GetTexture(rid)
            if t is None:
                return "?"
            return "%dx%d %s" % (t.width, t.height, t.format.Name())
        except Exception:
            return "?"

    for r in regions:
        eid = r["first_draw"]
        r["rt"] = []
        r["depth"] = None
        r["fs_rid"] = None
        r["cs_rid"] = None
        if eid is None:
            continue
        try:
            controller.SetFrameEvent(eid, False)
            pipe = controller.GetPipelineState()
            try:
                for t in pipe.GetOutputTargets():
                    r["rt"].append(texinfo(t))
            except Exception:
                pass
            try:
                dt = pipe.GetDepthTarget()
                if dt is not None:
                    r["depth"] = texinfo(dt)
            except Exception:
                pass
            try:
                refl = pipe.GetShaderReflection(rd.ShaderStage.Fragment)
                if refl is not None:
                    r["fs_rid"] = str(refl.resourceId)
            except Exception:
                pass
            try:
                refl = pipe.GetShaderReflection(rd.ShaderStage.Compute)
                if refl is not None:
                    r["cs_rid"] = str(refl.resourceId)
            except Exception:
                pass
        except Exception:
            r["err"] = traceback.format_exc().splitlines()[-1]

    json.dump({"regions": regions, "outside": outside}, open(OUT, "w", encoding="utf-8"), indent=1)
    log("written")
    controller.Shutdown()
    cap.Shutdown()
except Exception:
    log("FATAL\n" + traceback.format_exc())

os._exit(0)
