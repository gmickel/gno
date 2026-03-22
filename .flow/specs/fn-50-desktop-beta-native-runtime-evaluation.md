# Desktop Beta: Native Runtime Evaluation and Abstraction

## Overview

Evaluate the native shell/runtime options, including the Bun-based path you want to investigate, and define an abstraction boundary so the app shell can evolve without rewriting the workspace core.

## Difficulty

Hard.

## Why now

This is the first intentionally stack-dependent epic, and it should happen after the reusable workspace/service pieces are in place.

## Scope

- evaluate Bun-based desktop option vs Tauri/Electron/other contenders
- compare bundle size, startup, update path, file-association support, and signing/notarization fit
- define service/window/deep-link abstraction boundary
- record final recommendation in repo docs

## Acceptance

- We have a documented stack decision with explicit tradeoffs.
- The chosen runtime boundary does not leak desktop-framework specifics into core workspace logic.
