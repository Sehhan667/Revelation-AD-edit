# -*- coding: utf-8 -*-
u"""
 -------------------------------------------------------------------------------
    Revelation-AD-edit 性能导出脚本（RenderDoc 内置 Python）
    ------------------------------------------------------------------
    作用：从 RenderDoc 打开的一帧抓帧里，遍历 action 树，按 pass 聚合 GPU 耗时，
          导出 JSON 基线（含单帧总耗时 + 逐 pass 耗时 + 占比），供 compare.js 做
          A/B diff / 汇报。

    运行方式（两种任选其一）：
      1) 交互：qrenderdoc 打开 .rdc →
               Tools -> Python Shell → 输入  exec(open(r"...\rdc_export.py", encoding="utf-8").read())
         （脚本会自动用当前的 controller）
      2) 半自动：qrenderdoc 打开 .rdc 时传 --python：
               qrenderdoc "capture.rdc" --python "scripts/perf/rdc_export.py --out baseline.json"
         （若脚本发现全局 controller，直接用它；否则按传入的 --rdc 离线打开）

    输出 JSON 结构（compare.js 约定）：
      {
        "name":  <--out 前的描述 或 -n 参数>,
        "frame": <当前 target frame>,
        "total_us": <单帧 GPU 总耗时 μs>,
        "passes": [ { "name": "DeferredLight", "us": 2300.5 }, ... ]
      }

    GPU 时序说明：RenderDoc 每个 action 的 GPU 时间只有在对 capture 做 timing
    replay 之后才有意义；本脚本优先尝试 action.GetDuration(start_us, end_us)，
    若该 API 在当前版本不可用，则退化为只导出"每 pass 的 action 数量"（count），
    并置 us = -1 —— 此时 compare 的耗时对比无效，但 pass 结构 / 采样量变化仍可看。

    [2026-09-21] 首次在本机跑通后，请把"成功走的哪条 API / 有无 -1 行"反馈给
    小鲸鱼，据此把脚本固化成稳定版，并可在 qrenderdoc 里一键全自动抓对比帧。
 -------------------------------------------------------------------------------
"""
from __future__ import print_function
import json, os, sys


def _resolve_controller():
    """优先用 qrenderdoc 当前已打开的 replay 控制器，否则返回 None。"""
    # 方式 A：qrenderdoc 交互 console / --python 注入的全局 controller
    if 'controller' in globals():
        c = globals().get('controller')
        if c is not None:
            return c
    # 方式 B：pyrenderdoc 环境常见的全局约定
    if 'app' in globals():
        app = globals().get('app')
        try:
            c = app.GetCapture()
            if c is not None:
                return c
        except Exception:
            pass
    return None


def _init_replay_offline(rdc_path):
    """离线方式：用 renderdoc 模块自行打开 capture 并做 LocalReplay。"""
    import renderdoc as rd
    env = rd.GlobalEnvironment() if hasattr(rd, 'GlobalEnvironment') else None
    rd.InitialiseReplay(env)
    cap = rd.OpenCaptureFile()
    status = cap.OpenFile(rdc_path, 'rdc', None)
    if status != rd.ResultCode.Succeeded:
        print('OpenFile failed: %s' % (status,))
        return None
    ctrl = cap.LocalReplay()
    return ctrl


def export_controller(controller, out_json, name=None):
    root = controller.GetRootAction()

    # ---- 拿到用于计时的时间区间（微秒） ----
    start_us = 0.0
    end_us = 0.0
    try:
        # RenderDoc 提供 timeline/最旧 benchmark 区间；取整帧 0..max
        # 更稳：遍历所有 action 收集最大结束时间戳（若有写得出的 timestamp 字段）
        timestamps = []
        def collect_ts(a):
            for ch in a.children:
                collect_ts(ch)
            # 尝试读取 begin/end 时间戳（字段名在不同版本可能不同）
            for attr in ('timestamp', 'microseconds', 'endTimestamp'):
                if hasattr(a, attr):
                    try:
                        v = getattr(a, attr)
                        if hasattr(v, '__iter__') and not isinstance(v, str):
                            v = list(v)
                            if len(v) >= 2 and isinstance(v[0], (int, float)):
                                timestamps.extend([float(v[0]), float(v[1])])
                    except Exception:
                        pass
        collect_ts(root)
        if timestamps:
            start_us = min(timestamps)
            end_us = max(timestamps)
    except Exception:
        pass

    # ---- 遍历 action 树，按 pass 名聚合 ----
    agg = {}      # name -> [us,...]（多次出现累加样本）
    counts = {}   # name -> action 数（兜底指标）
    have_time = True

    def recurse(action):
        nonlocal have_time
        for ch in (getattr(action, 'children', None) or []):
            recurse(ch)
        try:
            name = action.name
        except Exception:
            name = action.GetName() if hasattr(action, 'GetName') else 'unknown'
        if not name:
            name = '<anonymous>'
        counts[name] = counts.get(name, 0) + 1
        # 尝试 GPU 时长
        d = None
        for call in (lambda: action.GetDuration(start_us, end_us),):
            try:
                d = call()
                break
            except Exception:
                continue
        if d is None:
            # 无 GetDuration：尝试 GetDuration(start, end) 带位置参数
            try:
                d = action.GetDuration(0.0, end_us - start_us)
            except Exception:
                pass
        if d is None:
            d = -1.0
            have_time = False
        agg.setdefault(name, []).append(d)

    recurse(root)

    # ---- 汇总成 pass 表 ----
    passes = []
    total_us = 0.0
    for name, samples in agg.items():
        us = max(0.0, max(samples)) if have_time else -1.0  # action 时常取最大值（该 pass 总成本）
        # 更合理：多帧/多 action 同一 pass 累加 = 该 pass 本帧总耗时
        us = sum(max(0.0, s) for s in samples) if have_time else -1.0
        passes.append({"name": name, "us": us})
        if have_time:
            total_us += us
    # 若拿不到时间，退化为 count 视角（仍给结构信息）
    if not have_time:
        for name, cnt in counts.items():
            for p in passes:
                if p["name"] == name:
                    p["action_count"] = cnt
    passes.sort(key=lambda p: -p["us"])

    frame = -1
    try:
        frame = controller.GetTargetFrames()[controller.get_current_frame()].eventId if hasattr(controller, 'get_current_frame') else None
    except Exception:
        try:
            frame = controller.GetCurrentFrame() if hasattr(controller, 'GetCurrentFrame') else None
        except Exception:
            frame = None

    doc = {
        "name": name or "frame_export",
        "frame": frame,
        "total_us": round(total_us, 1) if have_time else None,
        "have_gpu_time": have_time,
        "passes": passes,
    }

    if out_json:
        with open(out_json, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        print('[rdc_export] wrote -> %s' % out_json)
    else:
        print(json.dumps(doc, ensure_ascii=False, indent=2))
    return doc


def _main(argv):
    out_json = None
    name = None
    rdc = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--out', '-o') and i + 1 < len(argv):
            out_json = argv[i + 1]; i += 2; continue
        if a in ('--name', '-n') and i + 1 < len(argv):
            name = argv[i + 1]; i += 2; continue
        if a in ('--rdc', '-r') and i + 1 < len(argv):
            rdc = argv[i + 1]; i += 2; continue
        i += 1

    controller = _resolve_controller()
    if controller is None and rdc:
        controller = _init_replay_offline(rdc)
    if controller is None:
        print('未找到可用的 replay 控制器。若在 qrenderdoc 控制台运行请确认已打开 capture；'
              '脚本方式请传 --rdc <capture.rdc>。', file=sys.stderr)
        return 1
    export_controller(controller, out_json, name)
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))