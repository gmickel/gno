"""GNO memory provider for Hermes Agent.

Wires GNO's fn-130 memory contracts into the Hermes memory-provider slots:

* ``prefetch``            -> ``gno recall --json`` with the turn's query and the
                             scopes declared in the provider config
* ``gno_remember`` tool   -> ``gno remember --json`` (add / supersede), invoked
                             deliberately by the model; carries the session's
                             latest recall receipt (``--receipt``) so GNO can
                             fence a recalled span replayed as a new fact
* ``sync_turn``           -> NO GNO writes. Hermes calls it after every turn;
                             storing there would be ambient capture, which the
                             memory contract forbids.

Identity: ``caller`` comes from the provider config, ``session`` from the
Hermes session id handed to ``initialize`` / ``on_session_switch``.

GNO failures (binary missing, version below the pin, timeout, malformed JSON,
non-zero exit) are logged and surfaced to the model; the session continues
without memory.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, RecallStatus

from .gno_cli import (
    MIN_GNO_VERSION,
    GnoCli,
    GnoCliError,
    RememberRequest,
    resolve_gno_binary,
)

logger = logging.getLogger(__name__)

PROVIDER_NAME = "gno"
CONFIG_DIRNAME = "gno"
CONFIG_FILENAME = "config.json"
TOOL_REMEMBER = "gno_remember"

DEFAULT_CALLER = "hermes"
DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_FACTS = 8
DEFAULT_MAX_TOKENS = 512
_MAX_FACTS_LIMIT = 64
_MAX_TOKENS_LIMIT = 8192
_TIMEOUT_MIN = 1.0
_TIMEOUT_MAX = 120.0
_MAX_SCOPES = 8
_PREVIEW_CHARS = 80
_WRITE_DISABLED_CONTEXTS = {"cron", "flush", "subagent"}
_DECISIONS = ("propose", "add", "supersede")

REMEMBER_SCHEMA: Dict[str, Any] = {
    "name": TOOL_REMEMBER,
    "description": (
        "Store ONE durable fact in GNO memory. Call this only when the user "
        "states something worth keeping across sessions (a decision, a "
        "preference, a stable fact). Nothing is stored automatically. "
        "Scopes are fixed by the provider config. decision='propose' (default) "
        "writes nothing and returns matching existing facts; 'add' writes a new "
        "fact; 'supersede' replaces an existing fact and requires the "
        "predecessor's uri and contentHash from a recalled fact."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The fact, as one self-contained sentence.",
            },
            "decision": {
                "type": "string",
                "enum": list(_DECISIONS),
                "description": "propose (no write), add, or supersede.",
            },
            "predecessor_uri": {
                "type": "string",
                "description": "gno:// uri of the fact being superseded.",
            },
            "predecessor_hash": {
                "type": "string",
                "description": "contentHash of the fact being superseded.",
            },
            "source": {
                "type": "string",
                "description": "Optional free-text evidence for the fact.",
            },
        },
        "required": ["text"],
    },
}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def _config_path(hermes_home: str) -> Path:
    return Path(hermes_home) / CONFIG_DIRNAME / CONFIG_FILENAME


def _default_hermes_home() -> str:
    """Active HERMES_HOME before initialize() hands it over (profile-aware)."""
    try:
        from hermes_constants import get_hermes_home

        return str(get_hermes_home())
    except Exception:
        return os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")


def _read_config(hermes_home: str) -> Dict[str, Any]:
    path = _config_path(hermes_home)
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("GNO memory: could not parse %s", path, exc_info=True)
        return {}
    return raw if isinstance(raw, dict) else {}


def _parse_scopes(value: Any) -> List[str]:
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = [str(item) for item in value]
    else:
        parts = []
    scopes: List[str] = []
    for part in parts:
        scope = part.strip().lower()
        if scope and scope not in scopes:
            scopes.append(scope)
    return scopes[:_MAX_SCOPES]


def _bounded_int(value: Any, default: int, upper: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(upper, parsed))


def _bounded_float(value: Any, default: float, lower: float, upper: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(lower, min(upper, parsed))


def normalize_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Apply defaults and bounds to a raw provider config dict."""
    return {
        "scopes": _parse_scopes(raw.get("scopes")),
        "collection": str(raw.get("collection") or "").strip(),
        "caller": str(raw.get("caller") or "").strip() or DEFAULT_CALLER,
        "gno_path": str(raw.get("gno_path") or "").strip(),
        "timeout_seconds": _bounded_float(
            raw.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS, _TIMEOUT_MIN, _TIMEOUT_MAX
        ),
        "max_facts": _bounded_int(raw.get("max_facts"), DEFAULT_MAX_FACTS, _MAX_FACTS_LIMIT),
        "max_tokens": _bounded_int(raw.get("max_tokens"), DEFAULT_MAX_TOKENS, _MAX_TOKENS_LIMIT),
    }


def load_config(hermes_home: str) -> Dict[str, Any]:
    return normalize_config(_read_config(hermes_home))


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class GnoMemoryProvider(MemoryProvider):
    """Hermes memory provider backed by the ``gno`` CLI."""

    def __init__(self) -> None:
        self._hermes_home = _default_hermes_home()
        self._config = load_config(self._hermes_home)
        self._session_id = ""
        self._cli: Optional[GnoCli] = None
        self._gno_version = ""
        self._disabled_reason = ""
        self._write_enabled = True
        self._last_recall_count = 0
        self._last_receipt: Optional[Dict[str, Any]] = None
        self._lexical_warned = False

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    # -- Availability -----------------------------------------------------------

    def is_available(self) -> bool:
        # Config + binary presence only; no subprocess here (the version pin is
        # verified in initialize()). Config is re-read because setup may have
        # written it after this instance was constructed for discovery.
        self._config = load_config(self._hermes_home)
        return bool(self._config["scopes"]) and resolve_gno_binary(self._config["gno_path"]) is not None

    def unavailable_reason(self) -> str:
        self._config = load_config(self._hermes_home)
        if not self._config["scopes"]:
            return f"set at least one scope in {_config_path(self._hermes_home)}"
        if resolve_gno_binary(self._config["gno_path"]) is None:
            return "gno binary not found on PATH (npm install -g @gmickel/gno) or set gno_path"
        return ""

    # -- Lifecycle ----------------------------------------------------------------

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._hermes_home = str(kwargs.get("hermes_home") or self._hermes_home)
        self._config = load_config(self._hermes_home)
        self._session_id = session_id or ""
        self._write_enabled = kwargs.get("agent_context", "primary") not in _WRITE_DISABLED_CONTEXTS
        self._last_recall_count = 0
        self._last_receipt = None
        self._disabled_reason = ""
        self._cli = GnoCli(
            resolve_gno_binary(self._config["gno_path"]),
            timeout=self._config["timeout_seconds"],
        )
        if not self._config["scopes"]:
            self._disable("no scopes configured; recall and remember need explicit scopes")
            return
        try:
            self._gno_version = self._cli.check_version()
        except GnoCliError as exc:
            self._disable(exc.message)
            return
        logger.info("GNO memory provider ready (gno %s, scopes=%s)", self._gno_version, self._config["scopes"])

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        self._session_id = new_session_id or self._session_id
        self._last_recall_count = 0
        # Receipts are bound to the session that issued them.
        self._last_receipt = None

    def shutdown(self) -> None:
        self._cli = None

    def _disable(self, reason: str) -> None:
        self._disabled_reason = reason
        logger.warning("GNO memory provider disabled: %s (session continues without memory)", reason)

    @property
    def active(self) -> bool:
        return self._cli is not None and not self._disabled_reason

    # -- Prompt + recall ----------------------------------------------------------

    def system_prompt_block(self) -> str:
        if not self.active:
            return (
                "# GNO memory\n"
                f"Unavailable: {self._disabled_reason}. The session continues without memory."
            )
        scopes = ", ".join(self._config["scopes"])
        return (
            "# GNO memory\n"
            f"Active (gno {self._gno_version}). Scopes: {scopes}. Relevant facts are "
            "recalled into each turn automatically. Nothing is stored automatically: "
            f"to keep a fact across sessions, call {TOOL_REMEMBER} deliberately "
            "(propose first when unsure, add for a new fact, supersede to replace "
            "a recalled fact using its uri and contentHash)."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        self._last_recall_count = 0
        if not self.active or not (query or "").strip():
            return ""
        try:
            result = self._cli.recall(
                query.strip(),
                scopes=self._config["scopes"],
                collection=self._config["collection"],
                caller=self._config["caller"],
                session=session_id or self._session_id,
                max_facts=self._config["max_facts"],
                max_tokens=self._config["max_tokens"],
            )
        except GnoCliError as exc:
            logger.warning("GNO memory prefetch skipped: %s", exc.message)
            return ""
        self._warn_once_if_lexical_only(result)
        receipt = result.get("receipt")
        if isinstance(receipt, dict):
            self._last_receipt = receipt
        facts = result.get("facts")
        if not isinstance(facts, list) or not facts:
            return ""
        lines = [f"GNO memory (scopes: {', '.join(self._config['scopes'])}):"]
        for fact in facts:
            if not isinstance(fact, dict):
                continue
            text = str(fact.get("text") or "").strip()
            if not text:
                continue
            uri = str(fact.get("uri") or "")
            content_hash = str(fact.get("contentHash") or "")
            lines.append(f"- {text} [{uri}] (contentHash {content_hash})")
        self._last_recall_count = len(lines) - 1
        return "\n".join(lines) if self._last_recall_count else ""

    def _warn_once_if_lexical_only(self, result: Dict[str, Any]) -> None:
        # Lexical-only recall needs every query term to match, so question-
        # shaped turns ("What is the ...?") miss facts the vector leg would
        # find. Surface it once so the operator runs `gno embed <collection>`.
        retrieval = result.get("retrieval")
        if self._lexical_warned or not isinstance(retrieval, dict) or retrieval.get("mode") != "lexical":
            return
        self._lexical_warned = True
        logger.warning(
            "GNO recall is lexical-only (%s); natural-language turns may miss facts. "
            "Run `gno embed %s` so recall can use the vector leg.",
            retrieval.get("semanticUnavailable") or "no vectors",
            self._config["collection"] or "<collection>",
        )

    def recall_status(self) -> Optional[RecallStatus]:
        if self._last_recall_count <= 0:
            return None
        return RecallStatus(provider_label="GNO", count=self._last_recall_count)

    # -- Turn persistence: deliberately no GNO writes ------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", **kwargs: Any) -> None:
        # Hermes fires this after EVERY turn. GNO memory is explicit-only:
        # the only write path is the gno_remember tool. Nothing happens here.
        return None

    # -- Tools --------------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [json.loads(json.dumps(REMEMBER_SCHEMA))]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        if tool_name != TOOL_REMEMBER:
            return _tool_error(f"unknown GNO memory tool: {tool_name}")
        if not self.active:
            return _tool_error(f"GNO memory unavailable: {self._disabled_reason}")
        if not self._write_enabled:
            return _tool_error("GNO memory writes are disabled in this agent context")
        try:
            request = _parse_remember_args(args or {})
        except ValueError as exc:
            return _tool_error(str(exc))
        receipt_path = _write_receipt_file(self._last_receipt)
        try:
            result = self._cli.remember(
                request,
                scopes=self._config["scopes"],
                collection=self._config["collection"],
                caller=self._config["caller"],
                session=self._session_id,
                receipt_path=receipt_path,
            )
        except GnoCliError as exc:
            logger.warning("GNO memory remember failed: %s", exc.message)
            return json.dumps(exc.to_dict())
        finally:
            _remove_receipt_file(receipt_path)
        return json.dumps(_summarize_remember(result))

    # -- Setup ------------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "scopes",
                "description": "Comma-separated memory scopes for recall and remember (required)",
                "required": True,
            },
            {
                "key": "collection",
                "description": "memoryManaged collection name (optional when exactly one is configured)",
            },
            {"key": "caller", "description": "Caller identity recorded on every fact", "default": DEFAULT_CALLER},
            {"key": "gno_path", "description": "Path to the gno binary (default: PATH lookup)"},
            {
                "key": "timeout_seconds",
                "description": "Subprocess timeout per gno call",
                "type": "number",
                "default": DEFAULT_TIMEOUT_SECONDS,
            },
            {"key": "max_facts", "description": "Recall budget: facts", "type": "integer", "default": DEFAULT_MAX_FACTS},
            {
                "key": "max_tokens",
                "description": "Recall budget: tokens",
                "type": "integer",
                "default": DEFAULT_MAX_TOKENS,
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        path = _config_path(hermes_home)
        existing = _read_config(hermes_home)
        existing.update({k: v for k, v in (values or {}).items() if v is not None})
        if "scopes" in existing:
            existing["scopes"] = _parse_scopes(existing["scopes"])
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(existing, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        self._hermes_home = hermes_home
        self._config = normalize_config(existing)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tool_error(message: str) -> str:
    return json.dumps({"error": message})


def _write_receipt_file(receipt: Optional[Dict[str, Any]]) -> str:
    """Persist the latest recall receipt for ``gno remember --receipt``.

    ``mkstemp`` creates the file 0600; it lives only for the duration of the
    remember call. Returns "" when no recall has happened this session.
    """
    if not receipt:
        return ""
    fd, path = tempfile.mkstemp(prefix="hermes-gno-receipt-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"receipt": receipt}, fh)
    except OSError:
        _remove_receipt_file(path)
        logger.warning("GNO memory: could not write the recall receipt; storing without fence", exc_info=True)
        return ""
    return path


def _remove_receipt_file(path: str) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


def _parse_remember_args(args: Dict[str, Any]) -> RememberRequest:
    text = str(args.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    decision = str(args.get("decision") or "propose").strip().lower()
    if decision not in _DECISIONS:
        raise ValueError(f"decision must be one of {', '.join(_DECISIONS)}")
    predecessor_uri = str(args.get("predecessor_uri") or "").strip()
    predecessor_hash = str(args.get("predecessor_hash") or "").strip()
    if decision == "supersede" and not (predecessor_uri and predecessor_hash):
        raise ValueError("supersede requires predecessor_uri and predecessor_hash from a recalled fact")
    return RememberRequest(
        text=text,
        decision="" if decision == "propose" else decision,
        predecessor_uri=predecessor_uri,
        predecessor_hash=predecessor_hash,
        source=str(args.get("source") or "").strip(),
    )


def _fact_summary(fact: Dict[str, Any]) -> Dict[str, Any]:
    text = str(fact.get("text") or "")
    summary: Dict[str, Any] = {
        "uri": fact.get("uri", ""),
        "recordId": fact.get("recordId", ""),
        "contentHash": fact.get("contentHash", ""),
        "scopes": fact.get("scopes", []),
        "preview": text[:_PREVIEW_CHARS] + ("..." if len(text) > _PREVIEW_CHARS else ""),
    }
    if fact.get("supersedes"):
        summary["supersedes"] = fact["supersedes"]
    if "similarity" in fact:
        summary["similarity"] = fact["similarity"]
        summary["match"] = fact.get("match", "")
    return summary


def _summarize_remember(result: Dict[str, Any]) -> Dict[str, Any]:
    outcome = str(result.get("outcome") or "")
    summary: Dict[str, Any] = {"outcome": outcome}
    record = result.get("record")
    if isinstance(record, dict):
        summary["record"] = _fact_summary(record)
    candidates = result.get("candidates")
    if isinstance(candidates, list):
        summary["candidates"] = [_fact_summary(c) for c in candidates if isinstance(c, dict)]
        summary["hint"] = (
            "Nothing was written. Re-call with decision='add' to store a new fact, "
            "or decision='supersede' with a candidate's uri and contentHash to replace it."
        )
    return summary


def register(ctx: Any) -> None:
    ctx.register_memory_provider(GnoMemoryProvider())


__all__ = ["GnoMemoryProvider", "MIN_GNO_VERSION", "REMEMBER_SCHEMA", "load_config", "register"]
