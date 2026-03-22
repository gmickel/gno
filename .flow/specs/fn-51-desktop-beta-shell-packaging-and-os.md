# Desktop Beta: Shell Packaging and OS Integration

## Overview

Package GNO as a real desktop app with file associations, single-instance behavior, app protocol/deep links, and managed service startup.

## Difficulty

Hard.

## Why now

This is the first truly normie-visible desktop milestone, but it should only land after the service/runtime decisions are settled.

## Scope

- native shell wrapper
- service startup/shutdown management
- file associations for markdown/plaintext
- single-instance handoff
- deep-link/app protocol integration
- docs for install/open-file behavior

## Acceptance

- Users can install and open GNO like a normal desktop app.
- Opening an associated file or deep link routes into the existing workspace cleanly.
