#!/usr/bin/env python3
"""Run a command under a peak-RSS and wall-time watchdog (fn-198 reproduction).

Polls the resident set size of the whole process tree every 100 ms, kills the
tree when it exceeds --max-rss-mb or --timeout seconds, and prints one JSON
line: {"exit": code, "killed": reason|null, "peak_rss_mb": n, "seconds": s}.
Linux only (reads /proc); used for bounded local reproductions, not in tests.

Usage: scripts/run-capped.py --max-rss-mb 6144 --timeout 120 -- <cmd> [args...]
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time


def tree_pids(root: int) -> list[int]:
    children: dict[int, list[int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
            children.setdefault(int(fields[1]), []).append(int(entry))
        except OSError:
            continue
    pids, stack = [], [root]
    while stack:
        pid = stack.pop()
        pids.append(pid)
        stack.extend(children.get(pid, []))
    return pids


def rss_mb(pids: list[int]) -> float:
    total = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/status") as handle:
                for line in handle:
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1])
                        break
        except OSError:
            continue
    return total / 1024


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-rss-mb", type=float, default=6144)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not cmd:
        parser.error("missing command")

    start = time.monotonic()
    proc = subprocess.Popen(cmd, start_new_session=True)
    peak, killed = 0.0, None
    while proc.poll() is None:
        current = rss_mb(tree_pids(proc.pid))
        peak = max(peak, current)
        elapsed = time.monotonic() - start
        if current > args.max_rss_mb:
            killed = f"rss>{args.max_rss_mb:.0f}MB"
        elif elapsed > args.timeout:
            killed = f"timeout>{args.timeout:.0f}s"
        if killed:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            break
        time.sleep(0.1)
    result = {
        "exit": proc.returncode,
        "killed": killed,
        "peak_rss_mb": round(peak),
        "seconds": round(time.monotonic() - start, 1),
    }
    print(json.dumps(result), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
