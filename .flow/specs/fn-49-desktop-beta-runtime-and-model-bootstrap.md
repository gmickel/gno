# Desktop Beta: Runtime and Model Bootstrap

## Overview

Define how a normie install gets the runtime and models it needs without manual Bun/model setup, while keeping disk and download behavior understandable.

## Difficulty

Hard.

## Why now

Distribution quality depends on deciding what is bundled, downloaded later, or shared between installs.

## Scope

- bundled vs on-demand runtime strategy
- bundled vs on-demand model strategy
- download UX, disk usage UX, cache management
- first-run bootstrap performance targets
- docs for footprint/troubleshooting

## Acceptance

- Installation and first-run model/runtime behavior is predictable and explainable.
- Disk/download tradeoffs are visible to users instead of implicit.
