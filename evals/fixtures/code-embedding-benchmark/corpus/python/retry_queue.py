from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from time import sleep


@dataclass
class Job:
    id: str
    attempts: int = 0


class RetryQueue:
    def __init__(self, max_attempts: int = 5, backoff_seconds: float = 0.25):
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.pending: deque[Job] = deque()

    def enqueue(self, job: Job) -> None:
        self.pending.append(job)

    def process(self, handler) -> None:
        while self.pending:
            job = self.pending.popleft()
            try:
                handler(job)
            except Exception:
                job.attempts += 1
                if job.attempts < self.max_attempts:
                  sleep(self.backoff_seconds * job.attempts)
                  self.pending.append(job)
