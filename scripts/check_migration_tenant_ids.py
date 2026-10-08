#!/usr/bin/env python3
"""Block tenant-scoped migration columns typed as uuid.

RouteShift team ids are text values like team_ab12cd34. Historical migrations
019-022 created several team_id uuid columns before corrective migrations
034/037 made the live schema text; those exact legacy definitions are allowed
so the immutable migration history can still be scanned.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


MIGRATION_ROOT = Path("apps/proxy/src/db/migrations")
MIGRATION_RE = re.compile(r"^apps/proxy/src/db/migrations/.*\.sql$")
TENANT_UUID_RE = re.compile(
    r'(?:"(?P<quoted>\w*(?:team_id|tenant_id))"|(?P<bare>\b\w*(?:team_id|tenant_id)\b))'
    r"[^,;]*?\buuid\b",
    re.IGNORECASE,
)

# These exemptions are pinned to immutable historical one-line definitions.
# Reformatting migrations 019-022 breaks the line-pinned allowlist.
LEGACY_ALLOWED = {
    (
        "apps/proxy/src/db/migrations/019-optimize-findings.sql",
        11,
        "team_id uuid",
    ),
    (
        "apps/proxy/src/db/migrations/020-team-budgets.sql",
        15,
        "team_id uuid",
    ),
    (
        "apps/proxy/src/db/migrations/021-provider-keys-multi-key.sql",
        37,
        "team_id uuid",
    ),
    (
        "apps/proxy/src/db/migrations/022-model-aliases.sql",
        10,
        "team_id uuid",
    ),
}


@dataclass(frozen=True)
class Finding:
    path: str
    line_no: int
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
            "migration-tenant-id: unable to resolve repo root with "
            "`git rev-parse --show-toplevel`."
        ) from exc
    root = proc.stdout.strip()
    if not root:
        raise GateError("migration-tenant-id: git returned an empty repo root.")
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


def normalize_sql(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip()).lower()


def strip_sql_comments(lines: Iterable[tuple[int, str]]) -> Iterable[tuple[int, str]]:
    in_block = False
    for line_no, line in lines:
        out = []
        i = 0
        while i < len(line):
            if in_block:
                end = line.find("*/", i)
                if end == -1:
                    i = len(line)
                else:
                    in_block = False
                    i = end + 2
                continue
            line_comment = line.find("--", i)
            block_comment = line.find("/*", i)
            if line_comment != -1 and (block_comment == -1 or line_comment < block_comment):
                out.append(line[i:line_comment])
                i = len(line)
            elif block_comment != -1:
                out.append(line[i:block_comment])
                in_block = True
                i = block_comment + 2
            else:
                out.append(line[i:])
                i = len(line)
        yield line_no, "".join(out)


def collapse_sql_whitespace(parts: list[tuple[int, str]]) -> tuple[str, list[int]]:
    chars: list[str] = []
    line_map: list[int] = []
    last_was_space = True
    for line_no, part in parts:
        for char in part:
            if char.isspace():
                if not last_was_space and chars:
                    chars.append(" ")
                    line_map.append(line_no)
                    last_was_space = True
            else:
                chars.append(char)
                line_map.append(line_no)
                last_was_space = False
        if not last_was_space and chars:
            chars.append(" ")
            line_map.append(line_no)
            last_was_space = True
    while chars and chars[-1] == " ":
        chars.pop()
        line_map.pop()
    return "".join(chars), line_map


def iter_sql_statements(
    cleaned_lines: Iterable[tuple[int, str]],
) -> Iterable[tuple[int, str, list[int]]]:
    parts: list[tuple[int, str]] = []
    for line_no, line in cleaned_lines:
        start = 0
        for idx, char in enumerate(line):
            if char != ";":
                continue
            parts.append((line_no, line[start:idx]))
            statement, line_map = collapse_sql_whitespace(parts)
            if statement:
                yield line_map[0] if line_map else line_no, statement, line_map
            parts = []
            start = idx + 1
        parts.append((line_no, line[start:]))
    statement, line_map = collapse_sql_whitespace(parts)
    if statement:
        yield line_map[0] if line_map else 1, statement, line_map


def is_legacy_allowed(path: str, line_no: int, offender: str) -> bool:
    return (path, line_no, normalize_sql(offender)) in LEGACY_ALLOWED


def findings_for_statement(
    path: str,
    statement_start_line: int,
    statement: str,
    line_map: list[int],
    *,
    allow_legacy: bool,
) -> list[Finding]:
    findings: list[Finding] = []
    for match in TENANT_UUID_RE.finditer(statement):
        line_no = (
            line_map[match.start()]
            if match.start() < len(line_map)
            else statement_start_line
        )
        column = (match.group("quoted") or match.group("bare") or "").lower()
        if column == "layer_tenant_id":
            continue
        offender = match.group(0).strip()
        if allow_legacy and is_legacy_allowed(path, line_no, offender):
            continue
        findings.append(Finding(path=path, line_no=line_no, text=offender))
    return findings


def scan_files(paths: Iterable[Path], root: Path) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    scanned = 0
    for path in paths:
        resolved = resolve_input_path(path, root)
        rel = repo_relative(resolved, root)
        if not MIGRATION_RE.match(rel):
            continue
        try:
            raw_lines = resolved.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            continue
        scanned += 1
        numbered_lines = list(enumerate(raw_lines, start=1))
        for statement_start_line, statement, line_map in iter_sql_statements(
            strip_sql_comments(numbered_lines)
        ):
            findings.extend(
                findings_for_statement(
                    rel,
                    statement_start_line,
                    statement,
                    line_map,
                    allow_legacy=True,
                )
            )
    return findings, scanned


def parse_hunk_start(line: str) -> int | None:
    match = re.search(r"\+(\d+)", line)
    if not match:
        return None
    return int(match.group(1))


def scan_diff(diff_text: str) -> list[Finding]:
    findings: list[Finding] = []
    current_path = ""
    line_no: int | None = None
    pending_lines: list[tuple[int, str]] = []

    def flush_pending() -> None:
        nonlocal pending_lines
        if not current_path or not MIGRATION_RE.match(current_path):
            pending_lines = []
            return
        for statement_start_line, statement, line_map in iter_sql_statements(
            strip_sql_comments(pending_lines)
        ):
            findings.extend(
                findings_for_statement(
                    current_path,
                    statement_start_line,
                    statement,
                    line_map,
                    allow_legacy=False,
                )
            )
        pending_lines = []

    for raw in diff_text.splitlines():
        if raw.startswith("diff --git "):
            flush_pending()
            current_path = ""
            line_no = None
            continue
        if raw.startswith("+++ "):
            flush_pending()
            path = raw[4:].strip()
            current_path = path[2:] if path.startswith("b/") else ""
            continue
        if raw.startswith("@@"):
            line_no = parse_hunk_start(raw)
            continue
        if line_no is None:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            pending_lines.append((line_no, raw[1:]))
            line_no += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        else:
            line_no += 1
    flush_pending()
    return findings


def default_migration_paths(root: Path) -> list[Path]:
    migration_dir = root / MIGRATION_ROOT
    if not migration_dir.is_dir():
        raise GateError(
            f"migration-tenant-id: migrations directory not found at "
            f"{MIGRATION_ROOT}; refusing to pass a no-args scan."
        )
    paths = sorted(migration_dir.glob("*.sql"))
    if not paths:
        raise GateError(
            f"migration-tenant-id: zero migration files found under "
            f"{MIGRATION_ROOT}; refusing to pass."
        )
    return paths


def print_findings(findings: list[Finding]) -> None:
    if not findings:
        return
    print(
        "migration-tenant-id: BLOCKED - tenant-scoped team_id/tenant_id "
        "columns must be text, not uuid.",
        file=sys.stderr,
    )
    print(
        "RouteShift self-serve team ids are text values like team_ab12cd34; "
        "see migrations 034/037/038 and AGENTS.md.",
        file=sys.stderr,
    )
    for finding in findings:
        print(f"  {finding.path}:{finding.line_no}: {finding.text}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Migration files to scan. Defaults to all tracked migration files.",
    )
    parser.add_argument(
        "--diff",
        metavar="PATH",
        help="Scan added lines from a unified diff. Use '-' for stdin.",
    )
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
                        f"migration-tenant-id: given path does not exist: {given}"
                    )
            paths = args.paths or default_migration_paths(root)
            findings, scanned = scan_files(paths, root)
            if scanned == 0:
                # A backstop that scanned nothing must say so — never exit green.
                raise GateError(
                    "migration-tenant-id: zero migration files scanned "
                    f"(given paths must be under {MIGRATION_ROOT}); refusing to pass."
                )
    except GateError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print_findings(findings)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
