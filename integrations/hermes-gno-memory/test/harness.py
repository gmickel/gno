#!/usr/bin/env python3
"""Drive the GNO memory provider through Hermes's lifecycle for the unit suite.

Reads one JSON scenario from argv[1] (``{"hermes_home", "session_id",
"agent_context", "steps": [...]}``), runs each step against a fresh provider
with the stubbed ``agent.memory_provider`` on ``sys.path``, and prints the
per-step results as a JSON array. ``bun test`` spawns this and asserts on the
output, so the provider is exercised exactly as Hermes would call it.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "stubs"))  # agent.memory_provider stand-in
sys.path.insert(0, str(HERE.parent))  # makes ``gno`` importable as a package

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

import gno  # noqa: E402  (after sys.path setup)


class _Ctx:
    def __init__(self):
        self.provider = None

    def register_memory_provider(self, provider):
        self.provider = provider


def run(scenario):
    ctx = _Ctx()
    gno.register(ctx)
    provider = ctx.provider
    results = []
    for step in scenario.get("steps", []):
        op = step["op"]
        if op == "available":
            results.append({"available": provider.is_available(), "reason": provider.unavailable_reason()})
        elif op == "initialize":
            provider.initialize(
                scenario.get("session_id", "sess-1"),
                hermes_home=scenario["hermes_home"],
                platform="cli",
                agent_context=scenario.get("agent_context", "primary"),
            )
            results.append({"active": provider.active})
        elif op == "prompt":
            results.append({"prompt": provider.system_prompt_block()})
        elif op == "prefetch":
            text = provider.prefetch(step.get("query", ""), session_id=step.get("session_id", ""))
            status = provider.recall_status()
            results.append({"text": text, "count": status.count if status else None})
        elif op == "schemas":
            results.append({"schemas": provider.get_tool_schemas()})
        elif op == "tool":
            raw = provider.handle_tool_call(step.get("name", gno.TOOL_REMEMBER), step.get("args", {}))
            results.append({"raw": raw, "result": json.loads(raw)})
        elif op == "sync_turn":
            provider.sync_turn(step.get("user", "u"), step.get("assistant", "a"), session_id="s", messages=[])
            results.append({"synced": True})
        elif op == "switch":
            provider.on_session_switch(step["session_id"])
            results.append({"switched": step["session_id"]})
        elif op == "save_config":
            provider.save_config(step["values"], scenario["hermes_home"])
            results.append({"saved": True})
        else:
            raise SystemExit(f"unknown op {op}")
    return results


if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.argv[1]))))
