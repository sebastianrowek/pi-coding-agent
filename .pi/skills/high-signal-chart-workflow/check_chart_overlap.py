#!/usr/bin/env python3
"""
Deterministic chart-overlap verifier.

Runs a matplotlib chart script (without writing its PNG), introspects every
text, line, and patch artist on every figure produced, and reports overlaps:

  1. text-vs-text: any two visible Text bboxes intersect.
  2. text-vs-axis-tick: a non-tick Text bbox overlaps a tick label bbox.
  3. text-vs-data-line: a Text bbox overlaps a Line2D path that is plausibly
     a data series (not a gridline, spine, zero-rule, or annotation arrow).

Outputs JSON: {"passed": bool, "violations": [...]}.

Usage:
  python check_chart_overlap.py path/to/chart.py [--cwd REPO_ROOT] [--json] [--verbose]
"""

from __future__ import annotations

import argparse
import json
import os
import runpy
import sys
import traceback
from contextlib import contextmanager
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.figure  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Patch  # noqa: E402
from matplotlib.text import Text, Annotation  # noqa: E402
from matplotlib.transforms import Bbox  # noqa: E402


def bbox_overlap_area(a: Bbox, b: Bbox) -> float:
    x0 = max(a.x0, b.x0)
    y0 = max(a.y0, b.y0)
    x1 = min(a.x1, b.x1)
    y1 = min(a.y1, b.y1)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    return (x1 - x0) * (y1 - y0)


def bbox_iou(a: Bbox, b: Bbox) -> float:
    inter = bbox_overlap_area(a, b)
    if inter == 0:
        return 0.0
    area_a = max(0.0, (a.x1 - a.x0)) * max(0.0, (a.y1 - a.y0))
    area_b = max(0.0, (b.x1 - b.x0)) * max(0.0, (b.y1 - b.y0))
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def text_visible(t: Text) -> bool:
    if not t.get_visible():
        return False
    s = t.get_text()
    return bool(s and s.strip())


def is_tick_label(t: Text, ax) -> bool:
    return t in ax.get_xticklabels() or t in ax.get_yticklabels()


def tick_is_offscreen(t: Text, ax) -> bool:
    """A tick label whose tick position falls outside the axes' visible
    data range is invisible at render time even though matplotlib still
    holds a Text object for it. Treat those as not present."""
    try:
        xticklabels = ax.get_xticklabels()
        if t in xticklabels:
            ticks = ax.get_xticks()
            idx = xticklabels.index(t)
            if idx < len(ticks):
                lo, hi = sorted(ax.get_xlim())
                return ticks[idx] < lo or ticks[idx] > hi
        yticklabels = ax.get_yticklabels()
        if t in yticklabels:
            ticks = ax.get_yticks()
            idx = yticklabels.index(t)
            if idx < len(ticks):
                lo, hi = sorted(ax.get_ylim())
                return ticks[idx] < lo or ticks[idx] > hi
    except Exception:
        return False
    return False


def is_axis_label_or_title(t: Text, ax) -> bool:
    return t is ax.xaxis.label or t is ax.yaxis.label or t is ax.title


def line_is_axis_decoration(line: Line2D, ax) -> bool:
    """Heuristic: is this Line2D non-data (gridline, axhline/axvline, marker-only)?"""
    ls = line.get_linestyle()
    if ls == "None":
        return True
    xy = line.get_xydata()
    if xy is None or len(xy) <= 2:
        # axhline/axvline have exactly 2 points (or sometimes more in newer
        # matplotlib, but always a single horizontal/vertical span). Treat as
        # decoration.
        return True
    # Non-solid + dim = gridline.
    if ls in (":", "--", "-.") and (line.get_alpha() or 1.0) < 0.6:
        return True
    # Faded thin lines (alpha < 0.2) are also reference guides.
    if (line.get_alpha() or 1.0) < 0.2:
        return True
    return False


def text_only_bbox(t: Text, renderer):
    """Get the bbox of just the rendered text glyphs.

    For matplotlib Annotation, `get_window_extent` returns the union of the
    text bbox AND the arrow connector path. We want only the text portion so
    that text-vs-text overlap math doesn't over-fire on annotations with
    long arrows pointing across the chart.
    """
    try:
        # Call Text's get_window_extent even on an Annotation instance.
        return Text.get_window_extent(t, renderer=renderer)
    except Exception:
        try:
            return t.get_window_extent(renderer=renderer)
        except Exception:
            return None


def clip_segment_to_bbox(p0, p1, bbox: Bbox):
    """Clip a line segment to a bbox. Returns clipped (p0, p1) or None if
    fully outside. Liang-Barsky."""
    x0, y0 = p0
    x1, y1 = p1
    dx, dy = x1 - x0, y1 - y0
    bx0, by0, bx1, by1 = bbox.x0, bbox.y0, bbox.x1, bbox.y1
    p = [-dx, dx, -dy, dy]
    q = [x0 - bx0, bx1 - x0, y0 - by0, by1 - y0]
    t_enter, t_leave = 0.0, 1.0
    for pi, qi in zip(p, q):
        if pi == 0:
            if qi < 0:
                return None
            continue
        t = qi / pi
        if pi < 0:
            if t > t_leave:
                return None
            if t > t_enter:
                t_enter = t
        else:
            if t < t_enter:
                return None
            if t < t_leave:
                t_leave = t
    if t_enter > t_leave:
        return None
    cx0 = x0 + t_enter * dx
    cy0 = y0 + t_enter * dy
    cx1 = x0 + t_leave * dx
    cy1 = y0 + t_leave * dy
    return ((cx0, cy0), (cx1, cy1))


def line_segments_in_display(line: Line2D, renderer) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    xy = line.get_xydata()
    if xy is None or len(xy) < 2:
        return []
    trans = line.get_transform()
    pts = trans.transform(xy)
    segs = []
    for i in range(len(pts) - 1):
        p0 = (float(pts[i][0]), float(pts[i][1]))
        p1 = (float(pts[i + 1][0]), float(pts[i + 1][1]))
        # Filter out NaNs.
        if any(map(lambda v: v != v, [*p0, *p1])):
            continue
        segs.append((p0, p1))
    return segs


def segment_intersects_bbox(p0, p1, bbox: Bbox) -> bool:
    x0, y0 = p0
    x1, y1 = p1
    bx0, by0, bx1, by1 = bbox.x0, bbox.y0, bbox.x1, bbox.y1
    # Quick reject.
    if max(x0, x1) < bx0 or min(x0, x1) > bx1:
        return False
    if max(y0, y1) < by0 or min(y0, y1) > by1:
        return False
    # Either endpoint inside the bbox.
    if (bx0 <= x0 <= bx1 and by0 <= y0 <= by1) or (bx0 <= x1 <= bx1 and by0 <= y1 <= by1):
        return True
    # Segment crosses any of the 4 bbox edges? Liang-Barsky-style check.
    dx, dy = x1 - x0, y1 - y0

    def clip(p, q):
        if p == 0:
            return q >= 0, 0.0, 1.0
        t = q / p
        if p < 0:
            return True, t, None  # enters
        return True, None, t  # leaves

    t_enter, t_leave = 0.0, 1.0
    for p, q in [(-dx, x0 - bx0), (dx, bx1 - x0), (-dy, y0 - by0), (dy, by1 - y0)]:
        if p == 0:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            t_enter = max(t_enter, t)
        else:
            t_leave = min(t_leave, t)
        if t_enter > t_leave:
            return False
    return True


@contextmanager
def patched_io(target_dir: Path):
    """Block side-effecting outputs from chart scripts (savefig, show)."""
    orig_savefig = matplotlib.figure.Figure.savefig
    orig_show = plt.show
    saved = []

    def patched_savefig(self, fname=None, *args, **kwargs):
        # Compute layout so renderer-dependent positions are correct,
        # but do NOT actually write the PNG.
        try:
            self.canvas.draw()
        except Exception:
            pass
        saved.append(self)

    def patched_show(*a, **kw):
        return None

    matplotlib.figure.Figure.savefig = patched_savefig
    plt.show = patched_show
    try:
        yield saved
    finally:
        matplotlib.figure.Figure.savefig = orig_savefig
        plt.show = orig_show


def collect_violations_for_fig(
    fig,
    *,
    text_overlap_min_area_frac: float = 0.15,
    text_on_line_min_path_px: float = 12.0,
):
    renderer = fig.canvas.get_renderer()
    violations = []

    # Pre-index every axes' tick label and axis-label/title text artists so we
    # can classify Text objects found at the figure level (matplotlib tick
    # labels report `.axes is None` even though they belong to an Axes).
    tick_to_ax = {}
    axislabel_or_title_to_ax = {}
    for ax in fig.axes:
        for t in list(ax.get_xticklabels()) + list(ax.get_yticklabels()):
            tick_to_ax[id(t)] = ax
        for t in (ax.xaxis.label, ax.yaxis.label, ax.title):
            axislabel_or_title_to_ax[id(t)] = ax

    text_records = []
    seen_ids = set()
    for child in fig.findobj(match=Text, include_self=False):
        if id(child) in seen_ids:
            continue
        seen_ids.add(id(child))
        if not text_visible(child):
            continue
        owning_ax = child.axes
        bbox = text_only_bbox(child, renderer)
        if bbox is None or bbox.width <= 0 or bbox.height <= 0:
            continue
        if id(child) in tick_to_ax:
            ax_for_tick = tick_to_ax[id(child)]
            if tick_is_offscreen(child, ax_for_tick):
                continue
            kind = "tick"
            owning_ax = ax_for_tick
        elif id(child) in axislabel_or_title_to_ax:
            kind = "axis_label"
            owning_ax = axislabel_or_title_to_ax[id(child)]
        elif owning_ax is None:
            kind = "figtext"
        elif isinstance(child, Annotation):
            kind = "annotation"
        else:
            kind = "text"
        text_records.append({
            "obj": child,
            "bbox": bbox,
            "kind": kind,
            "ax": owning_ax,
            "label": (child.get_text() or "").strip(),
        })

    # Deduplicate tick labels that twin axes (twinx/twiny) duplicate at the
    # same pixel position: keep one of each (label_text, rounded-bbox-center)
    # pair when both copies are ticks.
    def _tick_key(r):
        b = r["bbox"]
        cx = round((b.x0 + b.x1) / 2, 0)
        cy = round((b.y0 + b.y1) / 2, 0)
        return (r["label"], cx, cy)

    deduped = []
    seen_tick_keys = set()
    for r in text_records:
        if r["kind"] == "tick":
            key = _tick_key(r)
            if key in seen_tick_keys:
                continue
            seen_tick_keys.add(key)
        deduped.append(r)
    text_records = deduped

    # 1) Pairwise text-vs-text overlap.
    # Fail rule: the overlap occupies at least `text_overlap_min_area_frac` of
    # the smaller text's own bbox. This filters out sliver collisions from
    # matplotlib's line-height padding (which can produce 1-3 px tall overlaps
    # between adjacent rows in a tight grid layout).
    seen_pairs = set()
    for i in range(len(text_records)):
        for j in range(i + 1, len(text_records)):
            a, b = text_records[i], text_records[j]
            if a["obj"] is b["obj"]:
                continue
            area = bbox_overlap_area(a["bbox"], b["bbox"])
            if area <= 0:
                continue
            area_a = (a["bbox"].x1 - a["bbox"].x0) * (a["bbox"].y1 - a["bbox"].y0)
            area_b = (b["bbox"].x1 - b["bbox"].x0) * (b["bbox"].y1 - b["bbox"].y0)
            min_area = max(1e-6, min(area_a, area_b))
            frac = area / min_area
            if frac < text_overlap_min_area_frac:
                continue
            key = (id(a["obj"]), id(b["obj"]))
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            kinds = tuple(sorted([a["kind"], b["kind"]]))
            iou = bbox_iou(a["bbox"], b["bbox"])
            violations.append({
                "type": "text_text_overlap",
                "severity": "fail",
                "kinds": list(kinds),
                "iou": round(iou, 4),
                "overlap_px": round(area, 1),
                "overlap_frac_of_smaller": round(frac, 3),
                "a": {"kind": a["kind"], "label": a["label"][:120], "bbox": list(map(round_, [a["bbox"].x0, a["bbox"].y0, a["bbox"].x1, a["bbox"].y1]))},
                "b": {"kind": b["kind"], "label": b["label"][:120], "bbox": list(map(round_, [b["bbox"].x0, b["bbox"].y0, b["bbox"].x1, b["bbox"].y1]))},
            })

    # 2) Text-on-line overlap (skip ticks and axis labels: they sit at the spine).
    candidate_texts = [r for r in text_records if r["kind"] in ("text", "annotation")]
    # figtext (titles, subtitles, footers) typically sits outside the axes so a
    # bbox-based line check produces false positives from data extending beyond
    # the axes clip rect. Exclude unless the chart designer puts annotations as
    # fig.text inside the data region (rare).
    for ax in fig.axes:
        # Display bbox of the visible plot area; line segments are visually
        # clipped to this rectangle by matplotlib at render time.
        try:
            ax_bbox = ax.get_window_extent(renderer=renderer)
        except Exception:
            continue
        for line in ax.findobj(match=Line2D, include_self=False):
            if not line.get_visible():
                continue
            if line_is_axis_decoration(line, ax):
                continue
            segs = line_segments_in_display(line, renderer)
            if not segs:
                continue
            # Clip every segment to the axes display bbox; off-clip portions
            # are not painted and so cannot collide with text visually.
            clipped = []
            for p0, p1 in segs:
                c = clip_segment_to_bbox(p0, p1, ax_bbox)
                if c is not None:
                    clipped.append(c)
            if not clipped:
                continue
            for t in candidate_texts:
                if t["ax"] is not ax:
                    continue
                bbox = t["bbox"]
                pad = 2.0
                padded = Bbox.from_extents(bbox.x0 + pad, bbox.y0 + pad, bbox.x1 - pad, bbox.y1 - pad)
                if padded.width <= 0 or padded.height <= 0:
                    continue
                # Sum length of line path that lies inside the padded text bbox.
                inside_len = 0.0
                hit_count = 0
                for p0, p1 in clipped:
                    inside = clip_segment_to_bbox(p0, p1, padded)
                    if inside is None:
                        continue
                    (ix0, iy0), (ix1, iy1) = inside
                    seg_len = ((ix1 - ix0) ** 2 + (iy1 - iy0) ** 2) ** 0.5
                    if seg_len <= 0:
                        continue
                    inside_len += seg_len
                    hit_count += 1
                if inside_len < text_on_line_min_path_px:
                    continue
                violations.append({
                    "type": "text_on_line",
                    "severity": "fail",
                    "segments_crossing": hit_count,
                    "inside_path_px": round(inside_len, 1),
                    "text": {"kind": t["kind"], "label": t["label"][:120], "bbox": list(map(round_, [bbox.x0, bbox.y0, bbox.x1, bbox.y1]))},
                    "line": {
                        "label": (line.get_label() or "").strip()[:120],
                        "color": _color_name(line.get_color()),
                        "linestyle": line.get_linestyle(),
                        "alpha": line.get_alpha(),
                    },
                })

    return violations


def round_(v):
    return round(float(v), 1)


def _color_name(c):
    try:
        return str(c)
    except Exception:
        return "?"


def run_chart(chart_path: Path, cwd: Path | None):
    chart_path = chart_path.resolve()
    workdir = cwd.resolve() if cwd else chart_path.parent
    old_cwd = os.getcwd()
    os.chdir(workdir)
    try:
        with patched_io(workdir) as saved:
            try:
                runpy.run_path(str(chart_path), run_name="__main__")
            except SystemExit:
                pass
            except Exception:
                traceback.print_exc(file=sys.stderr)
                raise
            figs = saved
            if not figs:
                # Fall back to anything matplotlib opened.
                figs = [plt.figure(num) for num in plt.get_fignums()]
            # Deduplicate while preserving order.
            seen = set()
            deduped = []
            for f in figs:
                if id(f) in seen:
                    continue
                seen.add(id(f))
                deduped.append(f)
            return deduped
    finally:
        os.chdir(old_cwd)


def main():
    ap = argparse.ArgumentParser(description="Check a matplotlib chart script for label/annotation overlaps.")
    ap.add_argument("chart", type=Path, help="Path to the chart .py script.")
    ap.add_argument("--cwd", type=Path, default=None, help="Working directory to run the script in (default: chart's parent).")
    ap.add_argument("--json", action="store_true", help="Print JSON only.")
    ap.add_argument("--verbose", action="store_true", help="Include extra debug info on figures inspected.")
    args = ap.parse_args()

    if not args.chart.exists():
        print(f"chart file not found: {args.chart}", file=sys.stderr)
        sys.exit(2)

    figs = run_chart(args.chart, args.cwd)
    all_violations = []
    for idx, fig in enumerate(figs):
        try:
            fig.canvas.draw()
        except Exception:
            pass
        v = collect_violations_for_fig(fig)
        for item in v:
            item["figure_index"] = idx
        all_violations.extend(v)
        plt.close(fig)

    passed = len(all_violations) == 0
    result = {
        "passed": passed,
        "n_figures": len(figs),
        "n_violations": len(all_violations),
        "violations": all_violations,
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{'PASS' if passed else 'FAIL'}: {len(all_violations)} violation(s) across {len(figs)} figure(s)")
        for v in all_violations:
            if v["type"] == "text_text_overlap":
                print(f"  TEXT-TEXT [{','.join(v['kinds'])}] iou={v['iou']} px={v['overlap_px']}")
                print(f"    A ({v['a']['kind']}): {v['a']['label']!r}")
                print(f"    B ({v['b']['kind']}): {v['b']['label']!r}")
            elif v["type"] == "text_on_line":
                print(f"  TEXT-ON-LINE segs={v['segments_crossing']} line_label={v['line']['label']!r}")
                print(f"    text ({v['text']['kind']}): {v['text']['label']!r}")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
