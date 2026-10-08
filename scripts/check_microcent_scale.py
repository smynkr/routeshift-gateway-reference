#!/usr/bin/env python3
"""Reject stale RouteShift microcent scale instructions.

The canonical money unit is 1 USD = 100_000_000 microcents. This checker only
flags stale USD-scale claims, not the correct fact that 1 cent = 1_000_000
microcents.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


INCLUDED_SUFFIXES = {
    ".cjs",
    ".js",
    ".json",
    ".jsonc",
    ".md",
    ".mdx",
    ".mjs",
    ".py",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}
SKIP_PREFIXES = (
    ".git/",
    ".turbo/",
    "apps/dashboard/.next/",
    "node_modules/",
)
EXEMPT_PATHS = {
    "docs/wiki/known-false.md",
}
ALLOWED_PATTERNS = (
    (
        "correct number-first microcents-to-USD prose",
        re.compile(
            r"(?:100,000,000|100000000|100_000_000)\W+microcents\W{0,32}"
            r"(?:=|equals)\W{0,32}(?:\b1\s+usd\b|\busd\b)",
            re.IGNORECASE,
        ),
    ),
)
STALE_PATTERNS = (
    (
        "wrong USD-to-microcent prose",
        re.compile(
            r"(?:\b1\s+usd\b|\busd\b)\W{0,24}(?:=|is|equals|:)?\W{0,24}"
            r"(?:1,000,000|1000000|1_000_000)\W+microcents\b",
            re.IGNORECASE,
        ),
    ),
    (
        "wrong microcents-per-USD prose",
        re.compile(
            r"(?:1,000,000|1000000|1_000_000)\W+microcents\W{0,32}"
            r"(?:per|/)\W{0,8}\busd\b",
            re.IGNORECASE,
        ),
    ),
    (
        "wrong number-first microcents-to-USD prose",
        re.compile(
            r"(?:1,000,000|1000000|1_000_000)\W+microcents\W{0,32}"
            r"(?:=|equals)\W{0,32}(?:\b1\s+usd\b|\busd\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "wrong MICROCENTS_TO_USD constant",
        re.compile(
            r"\bMICROCENTS_TO_USD\b\s*[:=]\s*(?:1_000_000|1000000|1,000,000)\b",
            re.IGNORECASE,
        ),
    ),
)


@dataclass(frozen=True)
class Finding:
    path: str
    line_no: int
    label: str
    text: str


class GateError(Exception):
    pass


def repo_root() -> Path:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise GateError(
            "microcent-scale: unable to resolve repo root with "
            "`git rev-parse --show-toplevel`."
        ) from exc
    root = proc.stdout.strip()
    if not root:
        raise GateError("microcent-scale: git returned an empty repo root.")
    return Path(root)


def resolve_input_path(path: Path, root: Path) -> Path:
    if path.is_absolute():
        return path
    cwd_candidate = (Path.cwd() / path).resolve()
    if cwd_candidate.exists():
        return cwd_candidate
    return (root / path).resolve()


def repo_relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def included(path: str) -> bool:
    if path in EXEMPT_PATHS:
        return False
    if path.startswith(SKIP_PREFIXES):
        return False
    return Path(path).suffix.lower() in INCLUDED_SUFFIXES


def allowed_spans(line: str) -> list[tuple[int, int]]:
    return [
        match.span()
        for _, pattern in ALLOWED_PATTERNS
        for match in pattern.finditer(line)
    ]


def span_is_allowed(span: tuple[int, int], allowed: list[tuple[int, int]]) -> bool:
    start, end = span
    return any(allowed_start <= start and end <= allowed_end for allowed_start, allowed_end in allowed)


def scan_line(path: str, line_no: int, line: str) -> list[Finding]:
    findings: list[Finding] = []
    allowed = allowed_spans(line)
    for label, pattern in STALE_PATTERNS:
        for match in pattern.finditer(line):
            if span_is_allowed(match.span(), allowed):
                continue
            findings.append(
                Finding(path=path, line_no=line_no, label=label, text=line.strip())
            )
            break
    return findings


def tracked_files(root: Path) -> list[Path]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise GateError("microcent-scale: unable to list tracked files with git.") from exc
    return [root / line for line in proc.stdout.splitlines() if included(line)]


def scan_files(paths: Iterable[Path], root: Path) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    scanned = 0
    for path in paths:
        resolved = resolve_input_path(path, root)
        rel = repo_relative(resolved, root)
        if not included(rel):
            continue
        try:
            lines = resolved.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            continue
        scanned += 1
        for line_no, line in enumerate(lines, start=1):
            findings.extend(scan_line(rel, line_no, line))
    return findings, scanned


def parse_hunk_start(line: str) -> int | None:
    match = re.search(r"\+(\d+)", line)
    return int(match.group(1)) if match else None


def scan_diff(diff_text: str) -> list[Finding]:
    findings: list[Finding] = []
    current_path = ""
    line_no: int | None = None
    for raw in diff_text.splitlines():
        if raw.startswith("+++ "):
            path = raw[4:].strip()
            current_path = path[2:] if path.startswith("b/") else ""
            continue
        if raw.startswith("@@"):
            line_no = parse_hunk_start(raw)
            continue
        if line_no is None:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            if included(current_path):
                findings.extend(scan_line(current_path, line_no, raw[1:]))
            line_no += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        else:
            line_no += 1
    return findings


def print_findings(findings: list[Finding]) -> None:
    if not findings:
        return
    print(
        "microcent-scale: BLOCKED - RouteShift uses 1 USD = 100_000_000 "
        "microcents.",
        file=sys.stderr,
    )
    for finding in findings:
        print(
            f"  {finding.path}:{finding.line_no}: {finding.label}: {finding.text}",
            file=sys.stderr,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--diff", metavar="PATH", help="Scan added lines from a unified diff.")
    args = parser.parse_args()

    try:
        root = repo_root()
        if args.diff:
            diff_text = (
                sys.stdin.read()
                if args.diff == "-"
                else resolve_input_path(Path(args.diff), root).read_text()
            )
            findings = scan_diff(diff_text)
        else:
            for given in args.paths:
                if not resolve_input_path(given, root).exists():
                    raise GateError(
                        f"microcent-scale: given path does not exist: {given}"
                    )
            paths = args.paths or tracked_files(root)
            findings, scanned = scan_files(paths, root)
            if scanned == 0:
                # A backstop that scanned nothing must say so — never exit green.
                raise GateError(
                    "microcent-scale: zero files scanned; refusing to pass."
                )
    except GateError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print_findings(findings)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
