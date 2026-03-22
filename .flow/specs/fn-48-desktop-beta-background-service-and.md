# Desktop Beta: Background Service and Watch Hardening

## Overview

Harden the service layer behind the workspace so it behaves predictably across larger folders, long-running sessions, sleep/wake cycles, and desktop-style app lifecycles.

## Difficulty

Medium to hard.

## Why now

This is the main reliability prerequisite before native packaging and wider team rollout.

## Scope

- watcher reliability and dedupe hardening
- sleep/wake/network-drive edge cases
- background service lifecycle
- backlog/indexing state visibility
- resilience tests and observability

## Acceptance

- Long-running sessions remain trustworthy.
- Users get accurate indexing state and fewer "why didn't it refresh" incidents.
