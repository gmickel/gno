---
satisfies: [R7]
---

## Description
Update and deploy the canonical hosted website repo at `/Users/gordon/work/gno.sh` for the user-facing behavior and release-gate changes from this spec. This is a release blocker. Do not mark the spec complete, call the implementation shipped, tag/release, or hand off as done while the hosted website is stale for shipped behavior.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/**`, `/Users/gordon/work/gno/docs/**` as source references only

## Approach
- Treat `/Users/gordon/work/gno.sh` as the production website source. Do not use this repo's legacy `website/` tree as a substitute.
- Compare all in-repo docs/spec/changelog changes from tasks `.1` to `.4` against the public website. Update every affected product, install, docs/reference, troubleshooting, FAQ, and comparison page.
- Cover embedding fingerprints, doctor diagnostics/JSON, same-run embed retry behavior, package smoke/release gates, and any changed recovery command guidance.
- Keep website copy conservative: public docs must not claim behavior that is not implemented and verified in GNO.
- Build and deploy from `/Users/gordon/work/gno.sh` in the same delivery path when website changes are part of the shipped work.
- If deployment cannot happen, do not hide it. Record the blocker and exact remaining deploy/verification command in Flow evidence.

## Investigation targets
**Required**
- `AGENTS.md:383` — hosted website docs requirement.
- `AGENTS.md:389` — canonical hosted website repo path.
- `/Users/gordon/work/gno.sh` — production website source.
- `/Users/gordon/work/gno/docs/CLI.md` — source CLI behavior docs.
- `/Users/gordon/work/gno/docs/TROUBLESHOOTING.md` — source troubleshooting guidance.
- `/Users/gordon/work/gno/docs/INSTALLATION.md` — source doctor/install verification guidance.
- `/Users/gordon/work/gno/docs/PACKAGING.md` — source package/release verification guidance.
- `/Users/gordon/work/gno/CHANGELOG.md` — shipped behavior summary if user-visible.

**Optional**
- `/Users/gordon/work/gno/README.md` — high-level migration/release messaging.

## Key context
The instruction files say new features, CLI/MCP/API output changes, model behavior, and troubleshooting updates must also be reflected in `/Users/gordon/work/gno.sh` when they affect website docs, product pages, install pages, comparisons, or FAQs. This spec changes CLI diagnostics, embedding behavior, troubleshooting, install/release verification, and likely public docs. Website drift is user-visible drift.

## Acceptance
- [ ] `/Users/gordon/work/gno.sh` is audited against all user-facing changes from this spec, not just the obvious reference page.
- [ ] Hosted docs reflect shipped fingerprint diagnostics, retry behavior, doctor JSON/user guidance, and package smoke gate wherever user-facing.
- [ ] Hosted docs avoid claims that go beyond implemented GNO behavior.
- [ ] Website repo checks/build pass using that repo's package manager/runtime.
- [ ] Production deploy runs from `/Users/gordon/work/gno.sh` when the behavior is shipped.
- [ ] Live verification includes `curl -fsSI https://gno.sh`, remote `systemctl is-active gno-sh`, and remote git revision matching `origin/main` when deployed.
- [ ] If deploy is blocked, Flow evidence explicitly says the hosted website remains stale and lists the exact remaining command/verification steps.

## Done summary

_Not started._

## Evidence

_Not started._
