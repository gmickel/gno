# fn-78-future-external-retrieval-eval-corpus.1 Import external retrieval eval fixtures safely

## Description

Curate external retrieval eval fixtures, including QMD-derived hard-query examples where appropriate, into GNO's eval/benchmark ecosystem.

This task is about evaluation signal, not model training. Start by auditing candidate fixtures for licensing, provenance, duplicate coverage, and noise. Then add only the cases that expose meaningful retrieval behavior GNO should protect.

## Acceptance

- [ ] Audit candidate external fixtures and record source/provenance/licensing constraints.
- [ ] Compare candidate cases against existing `evals/fixtures/*` and avoid duplicates.
- [ ] Import only high-signal cases with clear expected documents or relevance judgments.
- [ ] Keep fixtures small enough for local eval speed and deterministic CI/local runs.
- [ ] Add cases to `evals/` or future `gno bench` example fixtures depending on best fit.
- [ ] Update `spec/evals.md`, `evals/README.md`, and `research/finetune/README.md` if fixture provenance or usage changes.
- [ ] Run relevant eval/test commands and record metric impact.
- [ ] If noisy QMD fine-tune data is considered, filter generic boilerplate and document the filter; do not import raw majority corpora into evals.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
