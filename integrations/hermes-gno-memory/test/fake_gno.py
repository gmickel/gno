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
import subprocess
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


def receipt_private(path):
    if os.name != "nt":
        return os.stat(path).st_mode & 0o777 == 0o600
    # Query the actual DACL without starting PowerShell inside the provider's
    # two-second subprocess budget. ctypes is Python's standard Win32 bridge.
    import csv
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    get_security = advapi.GetNamedSecurityInfoW
    get_security.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
                             ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    get_security.restype = wintypes.DWORD
    to_sddl = advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW
    to_sddl.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                       ctypes.POINTER(wintypes.LPWSTR), ctypes.c_void_p]
    to_sddl.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    descriptor = ctypes.c_void_p()
    sddl = wintypes.LPWSTR()
    if get_security(path, 1, 4, None, None, None, None, ctypes.byref(descriptor)):
        return False
    try:
        if not to_sddl(descriptor, 1, 4, ctypes.byref(sddl), None):
            return False
        acl = sddl.value
        identity = subprocess.run(
            ["whoami.exe", "/user", "/fo", "csv", "/nh"],
            capture_output=True, text=True, check=True, timeout=1,
        )
        user_sid = next(csv.reader([identity.stdout.strip()]))[1]
        log({"receiptAcl": acl, "receiptUserSid": user_sid})
        return descriptor_is_private(descriptor, user_sid)
    finally:
        if sddl:
            kernel.LocalFree(ctypes.cast(sddl, ctypes.c_void_p))
        kernel.LocalFree(descriptor)


def descriptor_is_private(descriptor, user_sid):
    """Compare binary ACE identities, never SDDL display aliases such as LA."""
    import ctypes
    from ctypes import wintypes

    class AclSize(ctypes.Structure):
        _fields_ = [("count", wintypes.DWORD), ("used", wintypes.DWORD), ("free", wintypes.DWORD)]

    class AceHeader(ctypes.Structure):
        _fields_ = [("kind", wintypes.BYTE), ("flags", wintypes.BYTE), ("size", wintypes.WORD)]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    advapi.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    advapi.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int]
    advapi.GetAclInformation.restype = wintypes.BOOL
    advapi.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetAce.restype = wintypes.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    present, defaulted = wintypes.BOOL(), wintypes.BOOL()
    dacl = ctypes.c_void_p()
    if not advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
        return False
    if not present.value or not dacl.value:
        return False
    info = AclSize()
    if not advapi.GetAclInformation(dacl, ctypes.byref(info), ctypes.sizeof(info), 2) or not info.count:
        return False
    allowed = {user_sid, "S-1-5-18", "S-1-5-32-544"}
    for index in range(info.count):
        ace = ctypes.c_void_p()
        if not advapi.GetAce(dacl, index, ctypes.byref(ace)):
            return False
        header = ctypes.cast(ace, ctypes.POINTER(AceHeader)).contents
        # Only standard allow/deny ACEs are understood. Their SID begins after
        # the four-byte header and four-byte access mask.
        if header.kind not in (0, 1) or header.size < 16:
            return False
        sid = wintypes.LPWSTR()
        if not advapi.ConvertSidToStringSidW(ace.value + 8, ctypes.byref(sid)):
            return False
        try:
            if header.kind == 0 and sid.value not in allowed:
                return False
        finally:
            kernel.LocalFree(ctypes.cast(sid, ctypes.c_void_p))
    return True



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
                "private": receipt_private(path),
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
