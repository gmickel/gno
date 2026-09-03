#!/usr/bin/env python3
"""Fake ``gno`` binary for the provider unit suite.

Behaviour is selected by ``FAKE_GNO_MODE``; every invocation appends its argv
as one JSON line to ``FAKE_GNO_LOG`` so tests can assert the exact flag
mapping and, for the ambient-store negative, the absence of any write. A
``remember --receipt`` call also appends one JSON object line describing the
receipt file it was handed.
"""

from __future__ import annotations

import json
import os
import sys
import time

MODE = os.environ.get("FAKE_GNO_MODE", "ok")
LOG = os.environ.get("FAKE_GNO_LOG", "")
VERSION = os.environ.get("FAKE_GNO_VERSION", "1.43.0")

FACT = {
    "uri": "gno://memory/facts/2026-09-03/mem-10e4745c90d3b7ec.md",
    "docid": "d1",
    "recordId": "mem-10e4745c90d3b7ec",
    "text": "Deploys go out from the main branch only.",
    "scopes": ["project:gno"],
    "caller": "hermes",
    "session": "s1",
    "createdAt": "2026-09-03T10:14:52.118Z",
    "contentHash": "a" * 64,
    "supersedes": [],
}
LINEAGE = {
    "effectivePolicy": "local_only",
    "digest": "b" * 64,
    "sources": [{"collection": "memory", "policy": "local_only", "source": "explicit"}],
}
MATCHING = {"mode": "lexical", "threshold": 0.5}


def log(argv):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(argv) + "\n")


def flag(argv, name, default=""):
    return argv[argv.index(name) + 1] if name in argv else default


def recall(argv):
    facts = []
    if MODE != "empty":
        facts.append(
            dict(
                FACT,
                score=1.5,
                spanHash=FACT["contentHash"],
                egressLineage=LINEAGE,
                caller=flag(argv, "--caller"),
                session=flag(argv, "--session"),
            )
        )
    result = {
        "facts": facts,
        "receipt": {
            "caller": flag(argv, "--caller"),
            "session": flag(argv, "--session"),
            "issuedAt": FACT["createdAt"],
            "memoryIds": [f["recordId"] for f in facts],
            "spanHashes": [f["spanHash"] for f in facts],
            "digest": "c" * 64,
        },
        "budget": {
            "maxFacts": int(flag(argv, "--max-facts", "8")),
            "maxTokens": int(flag(argv, "--max-tokens", "512")),
            "usedTokens": 12,
            "omitted": 0,
        },
        "retrieval": {"mode": "lexical", "semanticUnavailable": "fake"},
    }
    if not facts:
        result["hint"] = "Nothing recalled yet; store facts with gno remember."
    return result


def remember(argv):
    if "--receipt" in argv:
        # Prove the receipt file was readable, well-formed, and private
        # while the command ran; the provider removes it afterwards.
        path = flag(argv, "--receipt")
        with open(path, encoding="utf-8") as fh:
            presented = json.load(fh)
        log(
            {
                "receipt": presented.get("receipt"),
                "path": path,
                "mode": oct(os.stat(path).st_mode & 0o777),
            }
        )
    record = dict(FACT, text=argv[1], caller=flag(argv, "--caller"), session=flag(argv, "--session"))
    written = {"absPath": "/tmp/fake.md", "sync": {"status": "completed"}, "matching": MATCHING}
    if "--add" in argv:
        return {"outcome": "added", "record": record, **written}
    if "--supersede" in argv:
        record["supersedes"] = [flag(argv, "--supersede")]
        record["recordId"] = "mem-ffffffffffffffff"
        return {"outcome": "superseded", "record": record, **written}
    candidate = dict(FACT, similarity=0.9, match="likely")
    return {"outcome": "candidates", "candidates": [candidate], "matching": MATCHING}


def main(argv):
    log(argv)
    if not argv:
        return 1
    cmd = argv[0]
    if cmd == "--version":
        print(VERSION)
        return 0
    if MODE == "timeout":
        time.sleep(30)
        return 0
    if MODE == "malformed":
        print("{not json")
        return 0
    if MODE == "fail":
        envelope = {
            "error": {
                "code": "VALIDATION",
                "message": "no scopes",
                "details": {"memoryCode": "MEMORY_SCOPES_REQUIRED"},
            }
        }
        print(json.dumps(envelope))
        return 1
    if cmd == "recall":
        print(json.dumps(recall(argv)))
        return 0
    if cmd == "remember":
        print(json.dumps(remember(argv)))
        return 0
    print("unknown command", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
