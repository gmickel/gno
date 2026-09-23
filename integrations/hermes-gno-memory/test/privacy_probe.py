"""Exercise receipt privacy checks against native permissions and SID aliases."""
import csv
import json
import os
import subprocess
import tempfile
from pathlib import Path

from fake_gno import descriptor_is_private, receipt_private


def run():
    if os.name != "nt":
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "receipt.json"
            path.write_text("{}")
            path.chmod(0o600)
            assert receipt_private(str(path))
            path.chmod(0o644)
            assert not receipt_private(str(path))
        return {"native": "posix", "cases": 2}

    import ctypes
    from ctypes import wintypes

    identity = subprocess.run(["whoami.exe", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True)
    user_sid = next(csv.reader([identity.stdout.strip()]))[1]
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    convert.restype = wintypes.BOOL
    # A foreign domain's RID500 must never match the current user, even when
    # the local current user's SID displays as the SDDL alias LA.
    foreign_sid = "S-1-5-21-111-222-333-500"
    assert foreign_sid != user_sid
    cases = [
        (f"D:P(A;;FA;;;{user_sid})", True),
        ("D:P(A;;FA;;;SY)(A;;FA;;;BA)", True),
        (f"D:P(A;;FA;;;{foreign_sid})", False),
        ("D:P(A;;FA;;;WD)", False),
        ("D:NO_ACCESS_CONTROL", False),
        ("D:", False),
        # A valid object-specific allow ACE must fail closed even for this user.
        (f"D:P(OA;;FA;11111111-2222-3333-4444-555555555555;;{user_sid})", False),
    ]
    for sddl, expected in cases:
        descriptor = ctypes.c_void_p()
        if not convert(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            assert descriptor_is_private(descriptor, user_sid) == expected, sddl
        finally:
            kernel.LocalFree(descriptor)
    return {"native": "windows", "cases": len(cases)}


if __name__ == "__main__":
    print(json.dumps(run()))
