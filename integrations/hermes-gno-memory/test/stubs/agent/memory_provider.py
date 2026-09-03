"""Minimal stand-in for hermes-agent's ``agent.memory_provider``.

Mirrors the subset of the ABC the provider relies on (verified against Hermes
v0.20.5): abstract ``name`` / ``is_available`` / ``initialize`` /
``get_tool_schemas`` plus the optional hooks with their default bodies.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class RecallStatus:
    provider_label: str
    count: int
    glyph: str = "🧠"


class MemoryProvider(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None: ...

    def unavailable_reason(self) -> str:
        return ""

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return ""

    def recall_status(self) -> Optional[RecallStatus]:
        return None

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages=None,
    ) -> None:
        return None

    @abstractmethod
    def get_tool_schemas(self) -> List[Dict[str, Any]]: ...

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        raise NotImplementedError(tool_name)

    def shutdown(self) -> None:
        return None

    def on_session_switch(self, new_session_id: str, **kwargs) -> None:
        return None

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return []

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        return None
