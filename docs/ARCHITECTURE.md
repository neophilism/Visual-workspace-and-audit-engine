# Visual audit boundary

The engine accepts an authorized private snapshot of exact resource revisions, dependency links, current agent assignments, activity summaries and audit timeline events. Every reference is checked against tenant/project scope. Missing dependencies, cycles, duplicate nodes, duplicated agent identities/labels and malformed leases are rejected. Graph layout is deterministic, limits columns, and places dependencies above dependents.

Active agent markers require a current visible task lease. Agent labels and summaries are projections; they are never authentication or raw model reasoning. Implementation, tested and live delivery stages remain distinct. A caller must supply those stages from actual evidence rather than estimates.

The renderer emits a standalone private HTML workspace with clickable/keyboard-operable SVG nodes, an accessible table, timeline and exact-record inspector. Text and embedded JSON are escaped, remote assets are not loaded, and reduced-motion preference is respected. The renderer is a private export, not a public publication gateway. The host must authorize exporting and securely serve any resulting private artifact.

Live subscriptions, moving agent interpolation across snapshots, authenticated engine-specific inbox/case screens, multilingual layouts and browser/accessibility acceptance remain planned. Current snapshots are trusted filtered projections supplied by authenticated adapters; this library is not an authorization server.
