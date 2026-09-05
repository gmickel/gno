# Publishing permissions, public revocation, and a usable Studio

## Conversation Evidence

1. Gordon: "i exported from the gno local serve (just a note), then uploaded on the live ~/work/gno.sh"
2. Gordon: "it was public by default"
3. Gordon: "the 'who can read this' doesn't overwrite what is in the exported file and there are no options to add that during export from the webui i think?"
4. Gordon: "i can't seem to delete it again on gno.sh?"
5. Gordon: "in the web ui the user will be able to select the permission mode on export, it can be overriden at import etc and public ones can be revoked."
6. Gordon: "also we need to clean up the publish page on gno.sh, ie. https://gno.sh/studio it is very user unfriendly right now"
7. Gordon, after revocation, with screenshots of the source sidebar and published ledger: "interesting that is sitll visible in this sidebar but not below, here ... might be a bug"

## Goal & Context
<!-- scope: business; source: paraphrase of evidence 1-6 -->

A person exporting a local note and uploading it to gno.sh must understand and control who can read it. Gordon encountered a public export with no local permission picker, a hosted visibility selector that did not override the uploaded JSON, and no usable way to revoke a public share. Fix that complete publishing journey and simplify Studio so choosing content, confirming access, publishing, and managing the result are understandable actions.

## Architecture & Data Models
<!-- scope: technical -->

- Local GNO produces a Publish Artifact with the permission mode selected during export. Hosted Studio reads that mode, allows an explicit override, and publishes with the effective mode the user reviewed. The work spans the GNO local Web UI and gno.sh. [paraphrase; evidence 1, 3, 5]
- Treat an uploaded file as a draft until the user confirms publication. Keep the artifact's original mode and the selected effective mode distinguishable; file selection alone must not make a note public. [inferred]
- Use the existing public, secret-link, invite-only, and encrypted modes. Reader visibility remains distinct from Egress Policy and owner authorization. A visibility override must not relax either boundary. [inferred]
- Revocation is a publication lifecycle operation covering the whole share, independent of visibility. It must be enforced by the serving system and reflected in Studio, not merely hide a link or button. Retain stored content for revocation; permanent deletion is a separate operation. [inferred]

## API Contracts
<!-- scope: technical -->

- Export accepts the selected permission mode and returns an artifact whose declared mode matches it. Keep existing explicit CLI and API mode choices working. [paraphrase; evidence 5]
- Import accepts an explicit effective permission choice for uploaded JSON as well as direct Markdown/text. Server validation and the publication result must agree with the reviewed choice; no silent fallback to public or silent retention of a conflicting artifact mode. [paraphrase; evidence 3, 5]
- Revocation requires authority over the selected share and reports success only after subsequent content requests are denied. Define request/response shapes in the existing interface contracts during implementation. [inferred]

## Edge Cases & Constraints
<!-- scope: technical -->

- A secret link means anyone holding the link can read the content; it is not encryption or membership-based access. Explain that distinction at selection time. [inferred]
- Permission changes must rebuild the affected projection and access metadata consistently, including secret tokens and public machine-readable metadata. Relabeling an encrypted payload does not convert it into plaintext, and relabeling plaintext does not encrypt it. [inferred]
- Encryption and any required decryption stay on the user's device. Where an import conversion cannot be supported safely, reject it before publication with a clear local re-export path. Never upload a passphrase or decrypted content to enable a server-side conversion. [inferred]
- Mixed-mode, multi-space imports must expose each space's effective access or explicitly block unsupported combinations before publishing. Append/overwrite must identify the existing target and reject permission conflicts without partial publication or creating an unintended second public copy. [inferred]
- Revocation covers reader pages, individual notes, search/discovery, machine-readable projections, and bundled asset delivery. Check cache behavior explicitly: future requests must not retrieve revoked content from application-controlled caches. Previously downloaded copies cannot be recalled; do not promise otherwise. [inferred]
- Repeated revocation is safe; refresh, retries, concurrent publish operations, and historical snapshots must not accidentally reactivate a revoked share. An intentional later publication requires a fresh, explicit publish action. Existing publications remain unchanged unless their owner acts on them. [inferred]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A user exporting a note or collection from the local Web UI can select the permission mode before downloading, and the artifact contains the selected mode. Errors: unsupported modes and missing encryption inputs prevent export and explain the correction; cancellation produces no export. [paraphrase; evidence 3, 5; error handling inferred]
- **R2:** A user importing a JSON Publish Artifact can see its declared access, override it, review the effective access, and publish a share that obeys that choice. The same access controls behave consistently for Markdown/text imports. Errors: invalid artifacts, unavailable modes, mixed-space conflicts, and append/overwrite conflicts are reported before publication; none silently fall back to public or ignore the selected mode. [paraphrase; evidence 3, 5; boundary handling inferred]
- **R3:** Permission overrides preserve actual access guarantees: secret-link results use secret access, invite-only results require authorized membership, and encrypted results remain client-encrypted. Errors: unsupported encryption conversions require local re-export and produce no share; an override cannot bypass ownership, entitlement, or Egress Policy checks. [inferred]
- **R4:** An authorized owner can revoke an existing public share from Studio, as well as supported private shares, and verify that its previously working content routes no longer serve content. Studio visibly reports the revoked state. Errors: unauthorized attempts make no change; repeated revocation remains revoked; failures are surfaced without false success; concurrent updates and historical snapshots do not bypass revocation. [paraphrase; evidence 4, 5; scope and error handling inferred]
- **R5:** Studio offers one understandable primary upload journey: select content, review content and access, explicitly publish, then see the resulting link and its permission mode. Relevant controls appear with the operation they affect; advanced owner, slug, append, and overwrite options do not dominate the basic single-note upload. File selection alone does not publish. Errors: validation failures preserve the draft and identify the actionable correction; upload/publish busy states prevent duplicate submissions. [paraphrase; evidence 6; concrete interaction design inferred]
- **R6:** Published-share management is easy to find from Studio and from the publication result, with clear status, current access, view/copy actions when active, and an accurately named revoke/unpublish action for public shares. Source cards distinguish a retained source from an active publication: an unpublished or revoked source may remain available, but its status and the reason it differs from the publication list are explicit. Revoked publications remain discoverable as revoked rather than simply disappearing without explanation. Summaries display readable text without raw Markdown formatting markers or unexplained mid-word truncation. The upload and management flows remain usable by keyboard and at desktop/mobile widths. Errors: revoked shares are not presented as active links; action failures remain visible beside the relevant share; no extra error surface beyond R2-R5. [paraphrase; evidence 4-7; interaction, summary formatting, and accessibility details inferred from the supplied screenshots]
- **R7:** New local Web UI exports start with secret-link selected and explain its audience; public publishing requires a visible, deliberate choice at export or import review. Existing artifacts show their actual declared mode rather than being silently rewritten on selection. Errors: absence of a valid effective choice blocks publication; account restrictions never force a silent switch to public. [inferred; proposed safer default prompted by evidence 2]

- **R8:** The hosted reader's Contents note links provide a clearly visible hover state across the clickable row. Keyboard focus is visible, and the currently open note has a persistent selected state that remains distinguishable from hover and focus. Preserve readable contrast and avoid layout shifts. Verify pointer hover, keyboard navigation, note switching, and touch use in the running reader; touch navigation must not depend on hover. The user reported missing hover feedback in the three-note bundle screenshot on 5 September 2026; the static screenshot alone does not verify the hover behavior. Hover feedback is user-requested; focus, selected-state distinction, and verification details are inferred acceptance checks. [paraphrase]

- **R9:** The access defaults respect the account entitlement: use secret-link when available, otherwise public for free accounts. This supersedes R7's universal secret-link default. Account restrictions must never silently downgrade an uploaded artifact to public. [paraphrase]
- **R10:** Owners can permanently delete their content as a separate operation from unpublishing. Define retained data, asset cleanup, failure handling, and independently published copies before implementation; do not present deletion alone as a GDPR-compliance guarantee. [paraphrase]
- **R11:** Studio opens with a compact content library showing publication status, with a prominent Publish action that opens the upload/review flow. [paraphrase]
- **R12:** Existing public, secret-link, and invite-only publications support access edits. Tightening access invalidates the previous broader access. Conversions into or out of encryption require a fresh local export rather than a hosted visibility toggle. [paraphrase]

## Boundaries
<!-- scope: business -->

- Scope is the local export, hosted import, public revocation, and Studio publishing/management experience, plus the hosted reader Contents navigation feedback in R8. [paraphrase; evidence 5-6; reader screenshot follow-up]
- Revocation removes hosted access without promising erasure of downloaded copies. Owner-initiated permanent deletion is included by the interview decision below. Account deletion, new permission modes, billing redesign, and a general site redesign remain outside this change. Abuse reporting and administrator takedown are deferred to fn-155. [inferred]
- Preserve explicit existing CLI/API defaults unless changing them is necessary for the captured behavior; the proposed safer default concerns the new Web UI choice. [inferred]

## Decision Context
<!-- scope: both -->

The export/import mismatch and missing public revocation were encountered in one real single-note publishing journey. Treat them and Studio cleanup as one coherent feature so the user can choose access, trust the resulting share, and withdraw it without editing JSON or requesting an operator takedown. [paraphrase; evidence 1-6]

The proposed interaction model separates selecting a file from publishing it. The proposed secret-link default avoids silently preparing public exports while leaving public publishing available through an explicit choice. These are design defaults inferred from the reported friction, not verbatim user decisions. [inferred]

During diagnosis, deployed JSON import retained the file's visibility while the public reader bypassed revocation checks. An operator takedown cleared the affected share's active publication pointer and marked its stored access revoked. Implementation must handle existing inactive targets without resurrecting them. This observation is implementation evidence, not an instruction to use that workaround as the permanent design. [inferred; verified during this conversation]

The follow-up screenshots show the retained imported source in the sidebar but no corresponding public ledger row. Source records and active publications are loaded separately; the ledger also filters out revoked private shares. Keeping source content is compatible with revocation, but silently hiding the publication state is confusing. The same screenshots show literal Markdown emphasis markers and a summary cut off inside a word, which belong in the Studio readability cleanup. [inferred; verified source inspection and user-supplied visual evidence]

## Strategy Alignment

Deliberate sharing with explicit access and owner control supports Controlled portability. Consistent export/import semantics support Coherent agent and application surfaces. [strategy:Controlled portability] [strategy:Coherent agent and application surfaces]

## Strategy Conflicts

No conflict identified with the current strategy. [inferred]

## Verification and Documentation

Run focused regression and contract checks for selected export modes, JSON import overrides, encryption boundaries, revocation authorization, and public/private reader denial. Exercise the actual local export and hosted import/revoke flows with isolated fixtures, including keyboard and mobile use. Capture running-app evidence; source inspection or a successful build alone is not acceptance. Follow both repositories' required checks and live QA gates. [inferred; project verification requirements]

Update the affected GNO user documentation and interface contracts together with hosted publishing documentation and Studio help. Explain mode precedence, secret-link semantics, supported encrypted conversions, and revocation limitations. [inferred; project documentation requirements]



## Interview Decisions and Remaining Questions

The following decisions supersede conflicting earlier capture assumptions. The interview remains open; this commit does not mark the spec ready.

- Gordon chose secret-link when the account supports it, otherwise public for free accounts. Current hosted entitlements gate private publishing to paid plans. Gordon delegated the local export UX decision; the selected design requires an explicit access choice when the local app cannot know the hosted plan, with plan availability explained beside the modes. Studio can use the known account entitlement for new-content defaults.
- Gordon included permanent owner deletion, accepted the library-first Studio layout, and agreed that tightening access must invalidate the old broader access.
- Gordon accepted editing ordinary visibility modes; encryption conversions remain a local re-export operation.
- Public abuse reports and administrator takedown are a separate follow-up in fn-155.

The last question round remains unanswered. Keep these proposals open rather than treating them as accepted:

1. Preserve an uploaded artifact's declared mode at review, with explicit change or upgrade for an unsupported mode, versus applying the account default. No silent public downgrade is allowed.
2. For matching content, offer an explicit update-versus-copy choice; whether ordinary content updates preserve the current link still needs confirmation.
3. Delete access immediately and show tracked background cleanup, including cleanup failures, versus waiting for full cleanup before reporting completion.
4. Delete the selected item and its history while preserving independently published copies and shared assets needed elsewhere, versus a separately confirmed wider deletion.
