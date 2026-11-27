import os, sys, traceback

out = r"D:\Games\HMCL\somemcstuff\shaderpacks\Revelation-AD-edit\_probe_out.txt"
try:
    import renderdoc as rd
    s = "OK version=%s\n" % rd.GetVersionString()
    try:
        s += "pyrenderdoc=%r\n" % (pyrenderdoc,)
    except Exception as e:
        s += "no pyrenderdoc: %r\n" % e
except Exception:
    s = "FAIL\n" + traceback.format_exc()

try:
    open(out, "w", encoding="utf-8").write(s + "\n" + sys.version)
except Exception:
    pass
os._exit(0)
