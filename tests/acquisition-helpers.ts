import {
  createCollection,
  startAcquisition,
  finishAcquisition,
} from "@accountability/discovery-acquisition/collection";
import type {
  ScheduleSnapshot,
  AcquisitionLease,
} from "@accountability/discovery-acquisition/scheduler";
import type { Capture } from "@accountability/discovery-acquisition";
import { hashBytes } from "../src/contracts.ts";
import type { Context } from "../src/contracts.ts";
export const c: Context = {
  tenantId: "t",
  projectId: "p",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "research",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
export const view = { ...c, now: "2026-01-01T00:02:00Z" };
export const receipt = {
  tenantId: "t",
  projectId: "p",
  kind: "evidence",
  id: "receipt",
  revision: 2,
};
export function fixture(): ScheduleSnapshot {
  let collection = createCollection(c, {
    id: "collection",
    sourcePolicy: {
      tenantId: "t",
      projectId: "p",
      id: "policy",
      allowedHosts: ["records.example"],
      enabled: true,
      expiresAt: "2026-01-02T00:00:00Z",
      maximumBytes: 1024,
      maximumRedirects: 1,
      userAgent: "secret-user-agent",
      accessBasis: "private deployment access basis",
    },
    items: ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      url: "https://records.example/" + id,
      expectedMediaType: "text/plain",
    })),
    refreshAfterMs: 60000,
  });
  const bytes = Buffer.from("Fictional document");
  const capture: Capture = {
    tenantId: "t",
    projectId: "p",
    sourcePolicyId: "policy",
    requestedUrl: collection.items[0]!.url,
    finalUrl: collection.items[0]!.url,
    retrievedAt: c.now,
    status: 200,
    contentType: "text/plain",
    sha256: hashBytes(bytes),
    bytes,
    redirects: [],
    etag: null,
    lastModified: null,
  };
  const leases: AcquisitionLease[] = [];
  for (const [index, item] of collection.items.slice(0, 4).entries()) {
    const id = "attempt-" + index;
    collection = startAcquisition(c, collection, item.id, id);
    const status =
      index < 2 ? "completed" : index === 2 ? "running" : "reconcile";
    if (index === 0)
      collection = finishAcquisition(
        { ...c, now: "2026-01-01T00:00:01Z" },
        collection,
        id,
        { capture, receiptId: receipt.id },
      );
    if (index === 1)
      collection = finishAcquisition(
        { ...c, now: "2026-01-01T00:01:01Z" },
        collection,
        id,
        { failureCode: "lease_expired_unconsumed" },
      );
    leases.push({
      token: "secret-lease-token-" + index,
      attemptId: id,
      itemId: item.id,
      actorId: "worker-" + index,
      actorKind: "service",
      leasedAt: c.now,
      expiresAt: "2026-01-01T00:01:00Z",
      status,
      receipt: index === 0 ? receipt : null,
    });
  }
  return {
    revision: 9,
    state: { schemaVersion: 1, enabled: true, collection, leases },
  };
}
