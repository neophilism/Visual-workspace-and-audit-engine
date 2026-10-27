# Visual audit boundary

The engine accepts an authorized private snapshot of exact resource revisions, dependency links, current agent assignments, activity summaries and audit timeline events. Every reference is checked against tenant/project scope. Missing dependencies, cycles, duplicate nodes, duplicated agent identities/labels and malformed leases are rejected. Graph layout is deterministic, limits columns, and places dependencies above dependents.

Active agent markers require a current visible task lease. Agent labels and summaries are projections; they are never authentication or raw model reasoning. Implementation, tested and live delivery stages remain distinct. A caller must supply those stages from actual evidence rather than estimates.

The renderer emits a standalone private HTML workspace with clickable/keyboard-operable SVG nodes, an accessible table, timeline and exact-record inspector. Text and embedded JSON are escaped, remote assets are not loaded, and reduced-motion preference is respected. The renderer is a private export, not a public publication gateway. The host must authorize exporting and securely serve any resulting private artifact.

Live subscriptions, moving agent interpolation across snapshots, authenticated inbox mutation/case screens, multilingual layouts and browser/accessibility acceptance remain planned. Current snapshots are trusted filtered projections supplied by authenticated adapters; this library is not an authorization server.

## Interaction verification and example

`docs/examples/private-workspace.html` is a generated, entirely fictional private export that can be opened locally. DOM interaction tests execute the generated inspector code, verify graph/table selection despite reordered input, exercise keyboard activation and close, and check that injected script terminators remain inert. Native dialog opening is stubbed in the DOM tests; real-browser, assistive-technology and live-host acceptance remain separate. The local environment currently has no available browser binary; a vendor download attempt failed, so no browser acceptance is claimed.

## Budget and release adapters

[Private operations projections](OPERATIONS.md) connect typed pinned budget and release snapshots to the graph, table, timeline and exact-record inspector. They preserve uncertainty and historical corrections, reject inconsistent bindings and expose no mutation or external transport.

## Correspondence inbox

[Private inbox](INBOX.md) implements the authorized read-only folder/search/conversation component using pinned Correspondence projections. It preserves unverified reply status and private defaults, excluding grants and credential handles. Compose, takeover controls and live authenticated commands remain pending.

## Private operator controls

[Operator controls](OPERATOR_CONTROLS.md) add an opt-in same-origin client and mounted private draft/flag/takeover component. They use the accepted Correspondence gateway, capture viewed revisions, block edits after uncertain responses and explicitly reconcile exact original commands. The offline inbox remains unchanged; live hosting and broader UI acceptance remain separate.

Operator controls also provide revision-bound pagination and two-stage new-conversation composition. Each stage retains its own outcome and idempotent command identity; an uncertain first-stage result requires explicit reconciliation and a separate user action before the draft stage. Host/browser acceptance and reload recovery remain separate.

## Acquisition coverage and recovery

[Private acquisition projections](ACQUISITION.md) expose collection-wide coverage alongside bounded item/attempt history, exact receipt references and unresolved consumed work. They retain containing storage revisions and explicitly disclose missing timeline metadata; no live worker or persistent agent runtime is inferred.

## Caption review

CAPTION_REVIEW.md describes exact-source reparsing and stored derivative checks for private timed transcript review. The readable transcript and graph/table inspectors share exact edition and byte anchors. It performs no playback/network calls and does not treat media offsets as wall-clock events.

Mounted operator controls also provide backend-projected folders and literal search with revision-bound paging, failure rollback and guards against discarding unsaved drafts during filter changes. Live hosting and browser/accessibility qualification remain separate.

## Participant consent audit

[Consent review](CONSENT_REVIEW.md) validates pinned-domain capture receipts and current withdrawal, presents literal disclosure plus shared graph/table inspectors, and separates offer metadata from independent audit evidence. It never infers a withdrawal actor or use/release authorization. Host, participant controls and browser/accessibility acceptance remain separate.
