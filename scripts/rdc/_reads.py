"""List sampled textures / storage images per region to identify the pass."""
import os, json
import renderdoc as rd

BASE = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit"
RDC = os.path.join(BASE, "111.rdc")
PS = os.path.join(BASE, "_passes.json")
EV = os.path.join(BASE, "_events2.json")
OUT = os.path.join(BASE, "_reads.txt")
LOG = os.path.join(BASE, "_reads_log.txt")

L = []
def log(s):
    L.append(str(s))
    try: open(LOG, "w", encoding="utf-8").write("\n".join(L))
    except Exception: pass

p = json.load(open(PS, encoding="utf-8"))
regions = sorted(p["regions"], key=lambda r: -r["dur"])[:8]
outside = sorted([a for a in p["outside"] if "Dispatch" in a["flags"]], key=lambda a: -a["dur"])[:8]

GBUF = {"ResourceId::188591", "ResourceId::188702", "ResourceId::188710", "ResourceId::188686"}

try:
    cap = rd.OpenCaptureFile(); cap.OpenFile(RDC, '', None)
    st, c = cap.OpenCapture(rd.ReplayOptions(), None)
    log("status=%s" % st)

    def collect(pipe, stage):
        s = set()
        try:
            for u in pipe.GetReadOnlyResources(stage):
                try:
                    s.add(str(u.descriptor.resource))
                except Exception:
                    s.add(str(u))
        except Exception as e:
            s.add("RO_ERR:%r" % e)
        try:
            for u in pipe.GetReadWriteResources(stage):
                try:
                    s.add("RW:" + str(u.descriptor.resource))
                except Exception:
                    s.add("RW?" + str(u))
        except Exception:
            pass
        return s

    lines = []
    for r in regions:
        eid = r.get("first_draw")
        if eid is None:
            continue
        c.SetFrameEvent(eid, False)
        pipe = c.GetPipelineState()
        fs = collect(pipe, rd.ShaderStage.Fragment)
        vs = collect(pipe, rd.ShaderStage.Vertex)
        hit = sorted([x for x in fs if x in GBUF])
        lines.append("== eid=%s %7.3fms draws=%d" % (eid, r["dur"] * 1000, r["draws"]))
        lines.append("   fs binds n=%d  gbuffer_reads=%s" % (len(fs), hit))
        lines.append("   fs: %s" % sorted(fs)[:28])
        lines.append("   vs n=%d" % len(vs))

    lines.append("\n#### DISPATCHES ####")
    for a in outside:
        c.SetFrameEvent(a["eid"], False)
        pipe = c.GetPipelineState()
        cs = collect(pipe, rd.ShaderStage.Compute)
        lines.append("== eid=%s %7.3fms" % (a["eid"], a["dur"] * 1000))
        lines.append("   cs binds n=%d : %s" % (len(cs), sorted(cs)[:28]))

    open(OUT, "w", encoding="utf-8").write("\n".join(lines))
    c.Shutdown(); cap.Shutdown()
except Exception as e:
    log("FATAL %r" % e)

os._exit(0)
