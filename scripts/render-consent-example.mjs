import { writeFile } from "node:fs/promises";
import {
  createConsent,
  withdrawPermission,
  exactBinding,
} from "@accountability/consent-rights";
import { reviewDigest } from "@accountability/consent-rights/participant";
import { renderParticipantConsent } from "../dist/consent-review.js";
const c = {
  tenantId: "fictional",
  projectId: "consent-review",
  actor: { id: "reviewer", kind: "human", roles: ["viewer"] },
  purpose: "review",
  requestId: "example",
  now: "2026-01-03T00:00:00Z",
};
const resource = exactBinding(
  {
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind: "image",
    id: "synthetic-image",
    revision: 4,
  },
  { fictional: true },
);
const terms = {
  resource,
  actions: ["reproduce"],
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
const capture = createConsent(
  {
    ...c,
    actor: { ...c.actor, id: "participant" },
    now: "2026-01-02T00:00:00Z",
  },
  { ...terms, id: "fictional-consent", subjectId: "fictional-subject" },
);
const offer = {
  id: "fictional-offer",
  subjectId: "fictional-subject",
  terms,
  disclosure:
    "This fictional image was offered for optional, private educational review. This example shows a captured consent that was later withdrawn. The view cannot grant permission or publish anything.",
  responseExpiresAt: "2026-01-10T00:00:00Z",
  ref: {
    ...resource.ref,
    kind: "consent-offer",
    id: "fictional-offer",
    revision: 2,
  },
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: "manager",
  status: "accepted",
  resolvedAt: "2026-01-02T00:00:00Z",
  resolvedBy: "participant",
  consent: exactBinding(capture.ref, capture),
};
const review = {
  offer,
  reviewDigest: reviewDigest(offer),
  responseOpen: false,
  consent: withdrawPermission(c, capture),
  warnings: [],
};
await writeFile(
  new URL("../docs/examples/private-consent-review.html", import.meta.url),
  renderParticipantConsent(c, review, "tested"),
);
