# fn-152.1 indexing polling lifecycle

Implementation: src/serve/public/components/IndexingProgress.tsx owns AbortController and both timers inside each effect. Requests carry signal; settlement checks signal before state, callbacks, or rescheduling. Cleanup aborts and clears only that lifetime's timers. Terminal responses stop elapsed timer. Restart clears old view status.

Focused regression: test/serve/public/components/IndexingProgress.dom.test.tsx; 8 pass, 49 assertions, bun test exit 0. Covers late running/completed/failed responses, network failure, abort rejection, null response; effect restart and old callback suppression; repeated remounts, single surviving loop, timer cancellation. /tmp/fn-152-tests.log. Targeted oxlint type-aware/type-check passes; oxfmt applied. Baseline adjacent BootstrapStatus suite: 4 pass /tmp/fn-152-baseline.log. Full shared gates owned by host.

Live surface: actual GNO Collections route served from current source using --dev, upstream http://127.0.0.1:43952; synthetic sync/job response proxy http://127.0.0.1:43953. Isolated config/index/cache /tmp/fn-152-qa; empty synthetic collection; GNO_OFFLINE=1. No indexing/native model/private corpus work. Agent-browser session fn152current, Chromium, viewport 1280x720.

1. Collections → Re-index All. qa-1 status held pending. Screenshot current-pending.png.
2. GNO button → Home (SPA navigation), explicitly release held server response, observe >2.5 seconds. current-after-navigation.json has one request and one response only. Screenshot current-away.png. Browser request aborted by cleanup; later synthetic server response is discarded.
3. Manage Collections → Re-index All. qa-2 polls at 1788565578344, 1788565579347, 1788565580349: one owned loop with 1003/1002 ms gaps. Screenshot current-returned.png visibly shows Indexing... 2s.
4. GNO button → Home, observe >2.5 seconds. current-final-network.json byte-identical to current-returned-network.json: zero extra requests after second cleanup.

Evidence: browser-network.txt, console.txt, errors.txt, current-*.png and current-*.json. errors.txt empty. Console has React DevTools info and expected HMR websocket disconnected warning because proxy does not forward websocket upgrades; no application exception. Deferred browser request cancellation is expected. Legacy prebuilt bundle baseline reproduced leak (after-navigation.json); current-source evidence uses current-* prefix, not baseline artifacts.

Public docs implication: leaving indexing progress view stops client status polling without canceling server indexing; returning and starting tracking owns a fresh loop. No API or polling interval changes. Host owns shared docs, commits, Flow completion and QA receipt. No formal review invoked, per user.
