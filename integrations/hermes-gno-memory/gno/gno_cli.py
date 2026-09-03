"""Subprocess bridge to the ``gno`` CLI for the Hermes memory provider.

Every GNO interaction goes through here: version pinning, ``gno recall
--json`` and ``gno remember --json``. The bridge never raises on the failure
modes a session must survive (binary missing, timeout, malformed JSON, GNO
below the pinned version, non-zero exit); each is reported as a
:class:`GnoCliError` with a stable ``kind`` so the provider can log it, tell
the model, and continue without memory.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

# fn-130 shipped the remember/recall contracts in GNO 1.41.0.
MIN_GNO_VERSION = "1.41.0"

# Stable error kinds. Tests and the provider branch on these, not on prose.
KIND_NOT_FOUND = "gno_not_found"
KIND_VERSION_UNSUPPORTED = "gno_version_unsupported"
KIND_TIMEOUT = "gno_timeout"
KIND_MALFORMED_JSON = "gno_malformed_json"
KIND_COMMAND_FAILED = "gno_command_failed"

_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


class GnoCliError(Exception):
    """A failed GNO call, classified by ``kind`` (one of the KIND_* values)."""

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        code: str = "",
        memory_code: str = "",
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.code = code
        self.memory_code = memory_code

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"error": self.message, "kind": self.kind}
        if self.code:
            payload["code"] = self.code
        if self.memory_code:
            payload["memoryCode"] = self.memory_code
        return payload


@dataclass(frozen=True)
class RememberRequest:
    """Inputs of one explicit store call (scopes come from provider config)."""

    text: str
    decision: str = ""  # "" (propose only), "add", or "supersede"
    predecessor_uri: str = ""
    predecessor_hash: str = ""
    source: str = ""


def parse_version(raw: str) -> Optional[tuple]:
    """Extract ``(major, minor, patch)`` from ``gno --version`` output."""
    match = _VERSION_RE.search(raw or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def version_at_least(found: str, minimum: str = MIN_GNO_VERSION) -> bool:
    found_tuple = parse_version(found)
    minimum_tuple = parse_version(minimum)
    if found_tuple is None or minimum_tuple is None:
        return False
    return found_tuple >= minimum_tuple


def resolve_gno_binary(configured: str = "") -> Optional[str]:
    """Locate the ``gno`` executable: explicit config path, else ``$PATH``."""
    candidate = (configured or "").strip()
    if candidate:
        return shutil.which(candidate) or None
    return shutil.which("gno")


class GnoCli:
    """Thin, timeout-bounded runner for ``gno`` subcommands."""

    def __init__(self, binary: Optional[str], *, timeout: float) -> None:
        self.binary = binary
        self.timeout = timeout

    # -- Low-level ------------------------------------------------------------

    def run(self, args: Sequence[str]) -> subprocess.CompletedProcess:
        if not self.binary:
            raise GnoCliError(
                KIND_NOT_FOUND,
                "gno binary not found; install GNO (npm install -g @gmickel/gno) "
                "or set gno_path in the provider config",
            )
        cmd = [self.binary, *args]
        try:
            return subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise GnoCliError(KIND_NOT_FOUND, f"gno binary not found: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise GnoCliError(
                KIND_TIMEOUT,
                f"gno {args[0]} timed out after {self.timeout:g}s",
            ) from exc

    def run_json(self, args: Sequence[str]) -> Dict[str, Any]:
        """Run a ``--json`` subcommand and return the parsed object.

        Non-zero exits carry GNO's ``{"error": {code, message, details}}``
        envelope on stdout; it is surfaced as ``KIND_COMMAND_FAILED`` with the
        CLI code and ``details.memoryCode`` attached. Unparseable stdout on
        either exit status is ``KIND_MALFORMED_JSON``.
        """
        proc = self.run(args)
        payload = _parse_json_object(proc.stdout)
        if proc.returncode != 0:
            if payload is not None and isinstance(payload.get("error"), dict):
                err = payload["error"]
                details = err.get("details") if isinstance(err.get("details"), dict) else {}
                raise GnoCliError(
                    KIND_COMMAND_FAILED,
                    str(err.get("message") or f"gno {args[0]} failed"),
                    code=str(err.get("code") or ""),
                    memory_code=str(details.get("memoryCode") or ""),
                )
            stderr = (proc.stderr or "").strip()
            raise GnoCliError(
                KIND_COMMAND_FAILED,
                f"gno {args[0]} exited {proc.returncode}: {stderr or 'no output'}",
            )
        if payload is None:
            raise GnoCliError(
                KIND_MALFORMED_JSON,
                f"gno {args[0]} returned malformed JSON",
            )
        return payload

    # -- Contract calls --------------------------------------------------------

    def check_version(self) -> str:
        """Return the installed version or raise below the pinned minimum."""
        proc = self.run(["--version"])
        raw = (proc.stdout or "").strip() or (proc.stderr or "").strip()
        parsed = parse_version(raw)
        if proc.returncode != 0 or parsed is None:
            raise GnoCliError(
                KIND_COMMAND_FAILED,
                f"could not read gno version (exit {proc.returncode}: {raw or 'no output'})",
            )
        found = ".".join(str(part) for part in parsed)
        if not version_at_least(found):
            raise GnoCliError(
                KIND_VERSION_UNSUPPORTED,
                f"gno {found} is below the minimum {MIN_GNO_VERSION} required "
                "for remember/recall; upgrade with npm install -g @gmickel/gno@latest",
            )
        return found

    def recall(
        self,
        query: str,
        *,
        scopes: Sequence[str],
        collection: str,
        caller: str,
        session: str,
        max_facts: int,
        max_tokens: int,
    ) -> Dict[str, Any]:
        args: List[str] = ["recall", query]
        args.extend(_scope_args(scopes))
        if collection:
            args.extend(["--collection", collection])
        args.extend(["--max-facts", str(max_facts), "--max-tokens", str(max_tokens)])
        args.extend(_identity_args(caller, session))
        args.append("--json")
        return self.run_json(args)

    def remember(
        self,
        request: RememberRequest,
        *,
        scopes: Sequence[str],
        collection: str,
        caller: str,
        session: str,
        receipt_path: str = "",
    ) -> Dict[str, Any]:
        args: List[str] = ["remember", request.text]
        args.extend(_scope_args(scopes))
        if collection:
            args.extend(["--collection", collection])
        if request.decision == "add":
            args.append("--add")
        elif request.decision == "supersede":
            args.extend(
                [
                    "--supersede",
                    request.predecessor_uri,
                    "--predecessor-hash",
                    request.predecessor_hash,
                ]
            )
        if request.source:
            args.extend(["--source", request.source])
        if receipt_path:
            # The latest recall receipt: lets GNO fence a recalled span that
            # comes back as a "new" fact (MEMORY_FENCED_REPLAY).
            args.extend(["--receipt", receipt_path])
        args.extend(_identity_args(caller, session))
        args.append("--json")
        return self.run_json(args)


def _scope_args(scopes: Sequence[str]) -> List[str]:
    args: List[str] = []
    for scope in scopes:
        args.extend(["--scope", scope])
    return args


def _identity_args(caller: str, session: str) -> List[str]:
    return ["--caller", caller, "--session", session]


def _parse_json_object(raw: str) -> Optional[Dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None
