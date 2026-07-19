"""Programmatic verifier for high-signal-chart-workflow.

Invocation: python verify_chart.py <chart.png> <chart.py>
Exit 0 on pass. Exit 1 on fail with one failed-check name per stdout line.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MIN_PNG_WIDTH = 1200
# PNG stores resolution as dots-per-meter; 300 DPI round-trips as ~299.9994.
MIN_DPI = 299.5
EXPECTED_ARGC = 3
_GRID_ALPHA_THRESHOLD = 0.3
_CN_COLOR_LEN = 2


def _check_png(path: Path) -> list[str]:
    failed: list[str] = []
    if not path.exists():
        return ["png_missing"]
    try:
        with Image.open(path) as img:
            img.verify()
        with Image.open(path) as img:
            width = img.width
            dpi = img.info.get("dpi", (0, 0))[0]
    except (UnidentifiedImageError, OSError):
        return ["png_invalid"]
    if width < MIN_PNG_WIDTH:
        failed.append("png_width_too_small")
    if dpi < MIN_DPI:
        failed.append("png_dpi_too_low")
    return failed


def _check_py_parseable(path: Path) -> list[str]:
    if not path.exists():
        return ["py_missing"]
    try:
        ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError:
        return ["py_unparseable"]
    return []


class _GridAndColorVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.default_gridlines = False
        self.raw_color = False

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        func = node.func
        attr = func.attr if isinstance(func, ast.Attribute) else None
        if attr == "grid":
            has_alpha_lt_threshold = any(
                kw.arg == "alpha"
                and isinstance(kw.value, ast.Constant)
                and isinstance(kw.value.value, int | float)
                and kw.value.value < _GRID_ALPHA_THRESHOLD
                for kw in node.keywords
            )
            first_positional_true = (
                bool(node.args)
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value is True
            )
            explicit_off = any(
                kw.arg == "visible"
                and isinstance(kw.value, ast.Constant)
                and kw.value.value is False
                for kw in node.keywords
            )
            no_args = (
                not node.args
                and not any(kw.arg == "alpha" for kw in node.keywords)
                and not explicit_off
            )
            if (first_positional_true or no_args) and not has_alpha_lt_threshold:
                self.default_gridlines = True
        for kw in node.keywords:
            if kw.arg == "color" and isinstance(kw.value, ast.Constant):
                v = kw.value.value
                if (
                    isinstance(v, str)
                    and len(v) == _CN_COLOR_LEN
                    and v.startswith("C")
                    and v[1].isdigit()
                ):
                    self.raw_color = True
        self.generic_visit(node)


class _StructureVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.has_title = False
        self.has_xlabel = False
        self.has_ylabel = False
        self.top_hidden = False
        self.right_hidden = False

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        func = node.func
        attr = func.attr if isinstance(func, ast.Attribute) else None
        if attr in {"set_title", "suptitle"} and self._nonempty_str_arg(node):
            self.has_title = True
        if attr == "set_xlabel" and self._nonempty_str_arg(node):
            self.has_xlabel = True
        if attr == "set_ylabel" and self._nonempty_str_arg(node):
            self.has_ylabel = True
        if attr == "set_visible" and isinstance(func, ast.Attribute):
            spine = self._spine_name(func.value)
            if spine and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value is False:
                if spine == "top":
                    self.top_hidden = True
                elif spine == "right":
                    self.right_hidden = True
        self.generic_visit(node)

    @staticmethod
    def _nonempty_str_arg(node: ast.Call) -> bool:
        if not node.args:
            return False
        a = node.args[0]
        return isinstance(a, ast.Constant) and isinstance(a.value, str) and bool(a.value.strip())

    @staticmethod
    def _spine_name(expr: ast.AST) -> str | None:
        if (
            isinstance(expr, ast.Subscript)
            and isinstance(expr.value, ast.Attribute)
            and expr.value.attr == "spines"
        ):
            sl = expr.slice
            if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
                return sl.value
        return None


class _OutputAndAnnotationVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.savefig_dpi_ok = False
        self.savefig_bbox_tight = False
        self.has_annotation = False

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        func = node.func
        attr = func.attr if isinstance(func, ast.Attribute) else None
        if attr == "savefig":
            dpi_val = None
            bbox_val = None
            for kw in node.keywords:
                if kw.arg == "dpi" and isinstance(kw.value, ast.Constant):
                    dpi_val = kw.value.value
                if kw.arg == "bbox_inches" and isinstance(kw.value, ast.Constant):
                    bbox_val = kw.value.value
            if isinstance(dpi_val, int | float) and dpi_val >= MIN_DPI:
                self.savefig_dpi_ok = True
            if bbox_val == "tight":
                self.savefig_bbox_tight = True
        if attr in {"annotate", "text"} and node.args:
            self.has_annotation = True
        self.generic_visit(node)


def _hygiene_checks(tree: ast.AST) -> list[str]:
    failed: list[str] = []
    gc = _GridAndColorVisitor()
    gc.visit(tree)
    if gc.default_gridlines:
        failed.append("default_gridlines_enabled")
    if gc.raw_color:
        failed.append("raw_matplotlib_color")
    sv = _StructureVisitor()
    sv.visit(tree)
    if not sv.has_title:
        failed.append("title_missing")
    if not sv.has_xlabel:
        failed.append("xlabel_missing")
    if not sv.has_ylabel:
        failed.append("ylabel_missing")
    if not sv.top_hidden:
        failed.append("top_spine_visible")
    if not sv.right_hidden:
        failed.append("right_spine_visible")
    oa = _OutputAndAnnotationVisitor()
    oa.visit(tree)
    if not oa.savefig_dpi_ok:
        failed.append("savefig_dpi_too_low")
    if not oa.savefig_bbox_tight:
        failed.append("savefig_missing_bbox_tight")
    if not oa.has_annotation:
        failed.append("annotation_missing")
    return failed


def run_checks(png_path: Path, py_path: Path) -> list[str]:
    """Return the list of failed check names. Empty list = pass."""
    failed: list[str] = []
    failed.extend(_check_png(png_path))
    py_fail = _check_py_parseable(py_path)
    failed.extend(py_fail)
    if py_fail:
        return failed
    tree = ast.parse(py_path.read_text(encoding="utf-8"))
    failed.extend(_hygiene_checks(tree))
    return failed


def main() -> int:
    if len(sys.argv) != EXPECTED_ARGC:
        print("usage: verify_chart.py <chart.png> <chart.py>", file=sys.stderr)
        return 2
    png_path = Path(sys.argv[1])
    py_path = Path(sys.argv[2])
    failed = run_checks(png_path, py_path)
    for name in failed:
        print(name)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
