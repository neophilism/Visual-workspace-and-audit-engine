import {
  createConsent,
  withdrawPermission,
  sameRef,
  assertDigest,
} from "@accountability/consent-rights";
import {
  reviewDigest,
  validateOfferInput,
} from "@accountability/consent-rights/participant";
import type {
  ConsentOffer,
  ParticipantReview,
} from "@accountability/consent-rights/participant";
import {
  canonical,
  digest,
  invariant,
  refKey,
  requireScope,
  validTime,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace, renderWorkspace } from "./index.ts";
import type {
  VisualNode,
  VisualEvent,
  WorkspaceSnapshot,
  WorkStage,
} from "./index.ts";
const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
function reference(c: Context, ref: Ref): void {
  validateRef(ref);
  requireScope(c, ref);
}

/** Input is an authorized participant review, not proof of authentication or a legal consent determination. */
export function projectParticipantConsent(
  c: Context,
  input: ParticipantReview,
  stage: WorkStage,
): WorkspaceSnapshot {
  c = structuredClone(c);
  invariant(
    Buffer.byteLength(canonical(input)) <= 128 * 1024,
    "projection_too_large",
    "Participant review exceeds the private projection budget",
  );
  const {
    offer,
    consent,
    reviewDigest: suppliedDigest,
    responseOpen,
  } = structuredClone(input);
  reference(c, offer.ref);
  invariant(
    offer.ref.kind === "consent-offer" && offer.ref.id === offer.id,
    "invalid_offer",
    "Offer identity is inconsistent",
  );
  assertDigest(suppliedDigest);
  invariant(
    reviewDigest(offer) === suppliedDigest && typeof responseOpen === "boolean",
    "review_changed",
    "Exact review digest is required",
  );
  const created = validTime(offer.createdAt),
    now = validTime(c.now);
  invariant(
    created <= now,
    "invalid_offer",
    "Offer creation cannot follow the projection time",
  );
  validateOfferInput(
    {
      id: offer.id,
      subjectId: offer.subjectId,
      terms: offer.terms,
      disclosure: offer.disclosure,
      responseExpiresAt: offer.responseExpiresAt,
    },
    offer.createdAt,
  );
  reference(c, offer.terms.resource.ref);
  reference(c, offer.terms.evidence);
  // Validate terms with the accepted domain function; this creates no stored permission.
  createConsent(
    {
      ...c,
      actor: { id: offer.createdBy, kind: "human", roles: [] },
      now: offer.createdAt,
    },
    { ...offer.terms, id: "validation-only", subjectId: offer.subjectId },
  );
  invariant(
    ["offered", "accepted", "declined", "cancelled"].includes(offer.status),
    "invalid_offer",
    "Unknown offer state",
  );
  if (offer.status === "offered")
    invariant(
      offer.ref.revision === 1 &&
        offer.resolvedAt === null &&
        offer.resolvedBy === null &&
        offer.consent === null &&
        consent === null,
      "invalid_offer",
      "Unanswered offer contains a response",
    );
  else {
    invariant(
      responseOpen === false,
      "invalid_offer",
      "A resolved offer cannot be reported as open",
    );
    invariant(
      offer.ref.revision === 2 &&
        typeof offer.resolvedAt === "string" &&
        typeof offer.resolvedBy === "string" &&
        offer.resolvedBy.trim().length > 0,
      "invalid_offer",
      "Resolved offer metadata is required",
    );
    invariant(
      validTime(offer.resolvedAt) >= created &&
        validTime(offer.resolvedAt) <= now,
      "invalid_offer",
      "Response metadata is outside the observed interval",
    );
    if (offer.status !== "cancelled")
      invariant(
        validTime(offer.resolvedAt) < validTime(offer.responseExpiresAt),
        "invalid_offer",
        "Participant response followed its deadline",
      );
    if (offer.status !== "accepted")
      invariant(
        offer.consent === null && consent === null,
        "invalid_offer",
        "Decline or cancellation cannot contain consent",
      );
  }
  const nodes: VisualNode[] = [],
    events: VisualEvent[] = [];
  const byKey = new Map<string, VisualNode>();
  function add(node: VisualNode) {
    reference(c, node.ref);
    const key = refKey(node.ref),
      old = byKey.get(key);
    invariant(
      !old || digest(old.ref) === digest(node.ref),
      "reference_collision",
      "Ambiguous display reference",
    );
    if (old) return old;
    byKey.set(key, node);
    nodes.push(node);
    return node;
  }
  function source(ref: Ref, role: string) {
    invariant(
      !["consent-offer", "consent"].includes(ref.kind),
      "reference_collision",
      "Source uses a reserved permission kind",
    );
    const node = add({
      ref,
      label: ref.id,
      kind: "source",
      state: "exact-edition-reference",
      stage,
      dependencies: [],
      summary:
        "Referenced " +
        role +
        " edition; this view does not fetch or authenticate its bytes.",
      details: json({ reference: ref, roles: [role] }),
    });
    const details = node.details as { [key: string]: Json; roles: string[] };
    if (!details.roles.includes(role)) details.roles.push(role);
    node.summary =
      "Referenced " +
      details.roles.join(" and ") +
      " edition; this view does not fetch or authenticate its bytes.";
    return node;
  }
  const resource = source(offer.terms.resource.ref, "resource");
  resource.kind = "artifact";
  resource.details = json({
    resource: offer.terms.resource,
    reference: resource.ref,
    roles: ["resource"],
  });
  const evidence = source(offer.terms.evidence, "permission evidence");
  const dependencies = [
    ...new Map(
      [resource.ref, evidence.ref].map((ref) => [refKey(ref), ref]),
    ).values(),
  ];
  add({
    ref: offer.ref,
    label: "Consent offer " + offer.id,
    kind: "decision",
    state: offer.status,
    stage,
    dependencies,
    summary:
      "Exact disclosure and proposed terms. A proposal is not permission; acceptance does not grant rights or release authority.",
    details: json({
      offer,
      reviewDigest: suppliedDigest,
      reportedResponseOpen: responseOpen,
      responseOpenAtProjection:
        offer.status === "offered" && now < validTime(offer.responseExpiresAt),
      authorization:
        "Host must authorize this private review. A digest is not authentication.",
      notice:
        "No proof of comprehension, capacity, noncoercion or signature is inferred.",
    }),
  });
  events.push({
    id: digest({ offer: offer.ref, event: "creation-metadata" }),
    at: offer.createdAt,
    actorId: offer.createdBy,
    action: "offer.creation-recorded",
    resource: offer.ref,
    summary:
      "Creation metadata on this offer record; not an independently loaded audit event.",
  });
  if (offer.resolvedAt && offer.resolvedBy)
    events.push({
      id: digest({ offer: offer.ref, event: "response-metadata" }),
      at: offer.resolvedAt,
      actorId: offer.resolvedBy,
      action: "offer." + offer.status,
      resource: offer.ref,
      summary:
        "Resolution metadata on this offer record; no external effect is implied.",
    });
  if (offer.status === "accepted") {
    invariant(
      offer.consent && consent && offer.resolvedAt && offer.resolvedBy,
      "invalid_consent",
      "Accepted offer requires current consent and capture receipt",
    );
    reference(c, offer.consent.ref);
    reference(c, consent.ref);
    reference(c, consent.resource.ref);
    reference(c, consent.evidence);
    assertDigest(offer.consent.digest);
    const captured = createConsent(
      {
        ...c,
        actor: { id: offer.resolvedBy, kind: "human", roles: [] },
        now: offer.resolvedAt,
      },
      { ...offer.terms, id: offer.consent.ref.id, subjectId: offer.subjectId },
    );
    invariant(
      sameRef(captured.ref, offer.consent.ref) &&
        digest(captured) === offer.consent.digest,
      "capture_mismatch",
      "Capture receipt does not bind the exact accepted terms",
    );
    let expectedCurrent = captured;
    if (consent.withdrawnAt !== null) {
      const at = validTime(consent.withdrawnAt);
      invariant(
        at >= validTime(offer.resolvedAt) && at <= now,
        "invalid_consent",
        "Withdrawal metadata is outside the observed interval",
      );
      expectedCurrent = withdrawPermission(
        { ...c, now: consent.withdrawnAt },
        captured,
      );
    }
    invariant(
      digest(expectedCurrent) === digest(consent),
      "current_consent_mismatch",
      "Current consent differs from the supported exact capture/withdrawal history",
    );
    const state =
      consent.withdrawnAt !== null
        ? "withdrawn"
        : now >= validTime(consent.expiresAt)
          ? "expired"
          : now < validTime(consent.validFrom)
            ? "not-yet-valid"
            : "within-consent-window";
    const capture = add({
      ref: captured.ref,
      label: "Capture receipt " + captured.ref.id.slice(0, 16),
      kind: "decision",
      state: "capture-digest-checked",
      stage,
      dependencies: [offer.ref],
      summary:
        "Capture content reconstructed with the accepted domain profile and checked against the stored receipt digest; no independent storage lookup.",
      details: json({
        receipt: offer.consent,
        reconstructedCapture: captured,
        independentlyLoadedHistoricalBytes: false,
      }),
    });
    if (sameRef(captured.ref, consent.ref)) {
      capture.state = state;
      capture.details = json({
        receipt: offer.consent,
        currentConsent: consent,
        currentRevision: consent.ref.revision,
        independentlyLoadedHistoricalBytes: false,
        useAllowed:
          "Not evaluated. Separate rights, purpose, audience and release decisions remain required.",
      });
    } else
      add({
        ref: consent.ref,
        label: "Current consent",
        kind: "decision",
        state,
        stage,
        dependencies: [capture.ref],
        summary:
          "Current withdrawal is preserved. This record has no withdrawal actor; none is fabricated.",
        details: json({
          currentConsent: consent,
          withdrawalActor: null,
          useAllowed: "Not evaluated",
        }),
      });
    // Consent.withdrawnAt has no actor field. It must not become an invented attributed audit event.
  }
  const snapshot: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private participant consent review",
    capturedAt: c.now,
    nodes,
    events,
    agents: [],
  };
  layoutWorkspace(c, snapshot);
  return snapshot;
}
function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}
export function renderParticipantConsent(
  c: Context,
  input: ParticipantReview,
  stage: WorkStage,
): string {
  const snapshot = projectParticipantConsent(c, input, stage);
  const offer = (
    snapshot.nodes.find((node) => node.ref.kind === "consent-offer")!
      .details as { offer: unknown }
  ).offer as ConsentOffer;
  const section = `<section aria-label="Participant disclosure"><h2>Disclosure and proposed use</h2><p>This private audit view cannot accept consent or authorize use. Terms and current state are available in the linked record inspectors.</p><pre>${escape(offer.disclosure)}</pre></section>`;
  return renderWorkspace(c, snapshot).replace("<main>", "<main>" + section);
}
