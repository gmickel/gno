---
title: peek serve detection is pid-file only; foreground serve reads as down
date: "2026-08-29"
track: bug
category: integration
problem_type: integration
symptoms: peek serve detection is pid-file only; foreground serve reads as down
root_cause: (unspecified)
resolution_type: fix
---

QA fn-119 P2 observation: gno peek reports serve running:false for a FOREGROUND gno serve because only --detach writes the pid file (pinned contract: pid-file liveness, never an HTTP probe; spec/cli.md peek section). Evidence: serve answered HTTP 200 on :3000 while peek returned {running:false,url:null}. Consequence for fn-120 (Omarchy plugin): always start serve via 'gno serve --detach'; never interpret running:false as 'port free' — a foreground serve may hold the resident-runtime lock and a second serve will fail with 'Resident runtime already active'.
