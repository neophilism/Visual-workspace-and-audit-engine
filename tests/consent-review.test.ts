import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createConsent,
  withdrawPermission,
  exactBinding,
} from "@accountability/consent-rights";
import { reviewDigest } from "@accountability/consent-rights/participant";
import type {
  ConsentOffer,
  ParticipantReview,
} from "@accountability/consent-rights/participant";
import type { Context } from "../src/contracts.ts";
import { digest } from "../src/contracts.ts";
import {
  projectParticipantConsent,
  renderParticipantConsent,
} from "../src/consent-review.ts";

const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "reviewer", kind: "human", roles: ["viewer"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-03T00:00:00Z",
};
function fixture(
  state: ConsentOffer["status"] = "accepted",
): ParticipantReview {
  const resource = exactBinding(
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind: "image",
      id: "fictional-image",
      revision: 4,
    },
    { synthetic: true },
  );
  const terms = {
    resource,
    actions: ["reproduce" as const],
    purposes: ["education"],
    audiences: ["private"],
    validFrom: "2026-01-01T00:00:00Z",
    expiresAt: "2026-02-01T00:00:00Z",
    evidence: {
      ...resource.ref,
      kind: "permission-evidence",
      id: "disclosure",
      revision: 3,
    },
  };
  const offer: ConsentOffer = {
    id: "offer",
    subjectId: "subject",
    terms,
    disclosure:
      "Private educational review of a synthetic image. Participation is optional.",
    responseExpiresAt: "2026-01-10T00:00:00Z",
    ref: {
      ...resource.ref,
      kind: "consent-offer",
      id: "offer",
      revision: state === "offered" ? 1 : 2,
    },
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "manager",
    status: state,
    resolvedAt: state === "offered" ? null : "2026-01-02T00:00:00Z",
    resolvedBy: state === "offered" ? null : "participant",
    consent: null,
  };
  const capture =
    state === "accepted"
      ? createConsent(
          {
            ...c,
            actor: { ...c.actor, id: "participant" },
            now: offer.resolvedAt!,
          },
          { ...terms, id: "captured-consent", subjectId: "subject" },
        )
      : null;
  const accepted = {
    ...offer,
    consent: capture ? exactBinding(capture.ref, capture) : null,
  };
  return {
    offer: accepted,
    reviewDigest: reviewDigest(accepted),
    responseOpen: state === "offered",
    consent: capture,
    warnings: [],
  };
}
function rehash(review: ParticipantReview): ParticipantReview {
  return { ...review, reviewDigest: reviewDigest(review.offer) };
}

test("consent projection uses accepted domain capture/hash and preserves exact resource/evidence/consent revisions", () => {
  const review = fixture();
  const snapshot = projectParticipantConsent(c, review, "tested");
  assert.equal(snapshot.visibility, "private");
  assert.deepEqual(snapshot.agents, []);
  assert.equal(snapshot.nodes.length, 4);
  assert.deepEqual(
    snapshot.nodes
      .filter((n) => n.ref.kind === "image")
      .map((n) => n.ref.revision),
    [4],
  );
  assert.deepEqual(
    snapshot.nodes
      .filter((n) => n.ref.kind === "permission-evidence")
      .map((n) => n.ref.revision),
    [3],
  );
  const consent = snapshot.nodes.find((n) => n.ref.kind === "consent")!;
  assert.equal(consent.ref.revision, 1);
  assert.equal(consent.state, "within-consent-window");
  assert.match(JSON.stringify(consent.details), /Not evaluated/);
  assert.equal(snapshot.events.length, 2);
  assert.ok(snapshot.events.every((event) => event.resource.revision === 2));
  assert.equal(snapshot.events[0]!.actorId, "manager");
  assert.equal(snapshot.events[1]!.actorId, "participant");
  assert.equal(digest(review), digest(fixture())); // Input was not mutated.
});

test("withdrawal retains capture revision and hash, current revision and missing actor without false timeline attribution", () => {
  const review = fixture();
  const originalDigest = review.offer.consent!.digest;
  const current = withdrawPermission(
    { ...c, actor: { ...c.actor, id: "withdrawer-not-recorded" } },
    review.consent!,
  );
  const snapshot = projectParticipantConsent(
    c,
    { ...review, consent: current },
    "tested",
  );
  const permissions = snapshot.nodes.filter((n) => n.ref.kind === "consent");
  assert.deepEqual(
    permissions.map((n) => n.ref.revision),
    [1, 2],
  );
  assert.equal(permissions[0]!.state, "capture-digest-checked");
  assert.equal(permissions[1]!.state, "withdrawn");
  assert.equal(permissions[1]!.dependencies[0]!.revision, 1);
  assert.ok(JSON.stringify(permissions[0]!.details).includes(originalDigest));
  assert.match(
    JSON.stringify(permissions[0]!.details),
    /independentlyLoadedHistoricalBytes":false/,
  );
  assert.match(
    JSON.stringify(permissions[1]!.details),
    /withdrawalActor":null/,
  );
  assert.equal(snapshot.events.length, 2);
  assert.equal(
    snapshot.events.some((e) => e.action.includes("withdraw")),
    false,
  );
  assert.equal(
    JSON.stringify(snapshot).includes("withdrawer-not-recorded"),
    false,
  );
});

test("unanswered, expired, declined and cancelled offers remain proposals; consent windows do not become use authorization", () => {
  for (const state of ["offered", "declined", "cancelled"] as const) {
    const snapshot = projectParticipantConsent(
      c,
      fixture(state),
      "implemented",
    );
    assert.equal(
      snapshot.nodes.some((n) => n.ref.kind === "consent"),
      false,
    );
    assert.equal(
      snapshot.nodes.find((n) => n.ref.kind === "consent-offer")!.state,
      state,
    );
  }
  const offered = fixture("offered");
  const afterDeadline = projectParticipantConsent(
    { ...c, now: "2026-01-11T00:00:00Z" },
    offered,
    "tested",
  );
  const details = JSON.stringify(
    afterDeadline.nodes.find((n) => n.ref.kind === "consent-offer")!.details,
  );
  assert.match(details, /reportedResponseOpen":true/);
  assert.match(details, /responseOpenAtProjection":false/);
  const expired = projectParticipantConsent(
    { ...c, now: "2026-02-02T00:00:00Z" },
    fixture(),
    "tested",
  );
  assert.equal(
    expired.nodes.find((n) => n.ref.kind === "consent")!.state,
    "expired",
  );
});

test("scope digest terms actor time and contradictory histories reject before rendering", () => {
  const review = fixture();
  const changes: ParticipantReview[] = [
    { ...review, reviewDigest: "0".repeat(64) },
    rehash({ ...review, offer: { ...review.offer, disclosure: "changed" } }), // Capture is terms-bound; disclosure stays offer-bound, so this is separately valid.
    rehash({
      ...review,
      offer: {
        ...review.offer,
        ref: { ...review.offer.ref, projectId: "foreign" },
      },
    }),
    rehash({
      ...review,
      offer: {
        ...review.offer,
        terms: {
          ...review.offer.terms,
          evidence: { ...review.offer.terms.evidence, projectId: "foreign" },
        },
      },
    }),
    rehash({
      ...review,
      offer: {
        ...review.offer,
        terms: { ...review.offer.terms, actions: ["train"] },
      },
    }),
    { ...review, consent: { ...review.consent!, recordedBy: "other-person" } },
    {
      ...review,
      consent: {
        ...review.consent!,
        ref: { ...review.consent!.ref, revision: 3 },
      },
    },
    {
      ...review,
      consent: { ...review.consent!, withdrawnAt: "2026-01-01T00:00:00Z" },
    },
    {
      ...review,
      consent: {
        ...review.consent!,
        evidence: { ...review.consent!.evidence, tenantId: "foreign" },
      },
    },
    rehash({
      ...review,
      offer: {
        ...review.offer,
        consent: { ...review.offer.consent!, digest: "0".repeat(64) },
      },
    }),
    rehash({
      ...review,
      offer: { ...review.offer, resolvedAt: "2026-01-11T00:00:00Z" },
    }),
    rehash({ ...review, offer: { ...review.offer, status: "declined" } }),
  ];
  // A rehashed disclosure alone is an altered host assertion, not independently verifiable from a consent digest.
  assert.doesNotThrow(() =>
    projectParticipantConsent(c, changes[1]!, "tested"),
  );
  for (const [index, value] of changes.entries())
    if (index !== 1)
      assert.throws(
        () => projectParticipantConsent(c, value, "tested"),
        /./,
        String(index),
      );
  const offered = fixture("offered");
  const collision = rehash({
    ...offered,
    offer: {
      ...offered.offer,
      terms: { ...offered.offer.terms, evidence: offered.offer.ref },
    },
  });
  assert.throws(() => projectParticipantConsent(c, collision, "tested"), {
    code: "reference_collision",
  });
});

test("readable disclosure, graph and table share inert exact inspectors without networking or acceptance controls", () => {
  const review = fixture();
  const payload =
    '</pre><script>globalThis.pwned=1</script><img src="https://outside.example/x">';
  const value = rehash({
    ...review,
    offer: { ...review.offer, disclosure: payload },
  });
  const html = renderParticipantConsent(c, value, "tested");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
    },
  });
  const doc = dom.window.document;
  assert.equal(
    doc.querySelector('section[aria-label="Participant disclosure"] pre')!
      .textContent,
    payload,
  );
  assert.equal(
    doc.querySelectorAll("img,iframe,audio,video,form,input").length,
    0,
  );
  assert.equal((dom.window as unknown as { pwned?: number }).pwned, undefined);
  const data = JSON.parse(doc.getElementById("records")!.textContent!) as {
    nodes: { ref: { kind: string } }[];
  };
  const index = data.nodes.findIndex((n) => n.ref.kind === "consent-offer");
  const graph = doc.querySelector(`g[data-node="${index}"]`)!;
  graph.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  const fromGraph = doc.getElementById("detail")!.textContent;
  assert.ok(fromGraph?.includes(payload.replace(/"/g, '\\"')));
  (
    doc.querySelector(`button[data-node="${index}"]`) as HTMLButtonElement
  ).click();
  assert.equal(doc.getElementById("detail")!.textContent, fromGraph);
  assert.equal(doc.querySelectorAll("[data-agent]").length, 0);
  dom.window.close();
});

test("projection budget and closed-open contradictions fail; shared source edition coalesces with both roles", () => {
  assert.throws(
    () =>
      projectParticipantConsent(
        c,
        { ...fixture(), warnings: ["x".repeat(128 * 1024)] },
        "tested",
      ),
    { code: "projection_too_large" },
  );
  assert.throws(
    () =>
      projectParticipantConsent(
        c,
        { ...fixture(), responseOpen: true },
        "tested",
      ),
    { code: "invalid_offer" },
  );
  const offered = fixture("offered");
  const shared = rehash({
    ...offered,
    offer: {
      ...offered.offer,
      terms: {
        ...offered.offer.terms,
        evidence: offered.offer.terms.resource.ref,
      },
    },
  });
  const snapshot = projectParticipantConsent(c, shared, "tested");
  assert.equal(snapshot.nodes.length, 2);
  const source = snapshot.nodes.find((n) => n.ref.kind === "image")!;
  assert.match(source.summary, /resource and permission evidence/);
  assert.equal(
    snapshot.nodes.find((n) => n.ref.kind === "consent-offer")!.dependencies
      .length,
    1,
  );
});
