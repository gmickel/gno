---
satisfies: [R2, R4, R7]
---
# fn-111-collection-egress-policies.2 Build conservative destination and network-zone classification

## Description
Deliver build conservative destination and network-zone classification as one implementation-sized increment.

**Size:** M
**Files:** `src/core/destination-classifier.ts`, `src/serve/security.ts`, `src/llm/http-policy.ts`, `test/egress/destination-classifier.test.ts`

### Approach
- Classify loopback/LAN/VPN-Tailscale/public/provider destinations across hostname, IPv4/IPv6, DNS answers, redirects, and explicit bind interfaces.
- Resolve and pin/recheck DNS per connection/redirect, reject mixed/public answers for restricted policy, and ignore forwarded proxy headers unless a future explicit proxy trust mode exists.
- Return conservative unknown/public when network state cannot be proven; do not treat a friendly hostname or auth token as LAN.

### Investigation targets
**Required** (read before coding):
- `src/serve/security.ts`
- `src/llm/httpEmbedding.ts`
- `src/llm/httpGeneration.ts`
- `src/llm/httpRerank.ts`
- `src/serve/server.ts`

**Optional** (reference as needed):
- `src/app/constants.ts`
## Acceptance
- [ ] Loopback/private/public/VPN/Tailscale/IPv4/IPv6/DNS-rebinding/redirect/proxy fixtures classify conservatively.
- [ ] TOCTOU or mixed DNS/redirect changes cannot upgrade a restricted decision.
- [ ] Classifier output and logs are stable/redacted and contain no credential or sensitive path.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
